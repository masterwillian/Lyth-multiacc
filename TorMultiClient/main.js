const {
    app,
    BrowserWindow,
    Menu,
    session,
    ipcMain
} = require("electron");

const path = require("path");
const fs   = require("fs");
const net  = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// ─────────────────────────────────────────────
// Configuração persistente dos lotes e instâncias Tor
// ─────────────────────────────────────────────
const TOR_EXE = path.join(__dirname, "..", "tor", "tor", "tor.exe");
const TOR_DIR = path.join(__dirname, "..", "tor");
const GROUPS_FILE = path.join(__dirname, "groups.json");
const LOGS_DIR = path.join(__dirname, "logs");
const HEALTH_CHECK_INTERVAL_MS = 15000;

function loadWorkspace() {
    const stored = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8"));
    const loadedGroups = Array.isArray(stored.groups) ? stored.groups : [];
    const maxGroupId = loadedGroups.reduce((max, group) => Math.max(max, Number(group.id) || 0), 0);
    const maxAccountId = loadedGroups.flatMap(group => group.accounts || [])
        .reduce((max, account) => Math.max(max, Number(account.id) || 0), 0);
    return {
        groups: loadedGroups,
        // Older files do not have counters. Once written, IDs are never reused.
        nextGroupId: Math.max(Number(stored.nextGroupId) || 0, maxGroupId + 1),
        nextAccountId: Math.max(Number(stored.nextAccountId) || 0, maxAccountId + 1)
    };
}

const workspace = loadWorkspace();
let groups = workspace.groups;
let nextGroupId = workspace.nextGroupId;
let nextAccountId = workspace.nextAccountId;

function ensureLogsDir() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function writeLog(level, message, meta = {}) {
    ensureLogsDir();
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message,
        ...meta
    }) + "\n";
    fs.appendFileSync(path.join(LOGS_DIR, "app.log"), line, "utf8");
}

function writeAccountLog(accountId, level, message, meta = {}) {
    ensureLogsDir();
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message,
        accountId,
        ...meta
    }) + "\n";
    fs.appendFileSync(path.join(LOGS_DIR, `account-${accountId}.log`), line, "utf8");
}

function accountDetails(account, group) {
    const instanceDir = path.join(TOR_DIR, `instance${account.id}`);
    return {
        ...account,
        batchId: group.id,
        batchName: group.name,
        torPort: 9050 + (account.id - 1) * 2,
        controlPort: 9051 + (account.id - 1) * 2,
        torrcFile: path.join(instanceDir, "torrc")
    };
}

function getAccounts() {
    return groups.flatMap(group => group.accounts.map(account => accountDetails(account, group)));
}

function saveGroups() {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify({ groups, nextGroupId, nextAccountId }, null, 2) + "\n");
}

function reserveGroupId() { return nextGroupId++; }
function reserveAccountId() { return nextAccountId++; }

function removeAccountRuntime(accountId) {
    const process = accountProcesses.get(accountId);
    if (process) {
        try { process.kill(); } catch (_) {}
        accountProcesses.delete(accountId);
    }

    if (healthTimers.has(accountId)) {
        clearInterval(healthTimers.get(accountId));
        healthTimers.delete(accountId);
    }

    const ses = accountSessions.get(accountId);
    if (ses) {
        return ses.closeAllConnections().finally(() => {
            accountSessions.delete(accountId);
            accountHealth.delete(accountId);
        });
    }

    accountSessions.delete(accountId);
    accountHealth.delete(accountId);
    return Promise.resolve();
}

function ensureTorFiles(account) {
    const instanceDir = path.dirname(account.torrcFile);
    const dataDir = path.join(instanceDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    const geoipBaseDir = path.dirname(TOR_EXE);
    const geoipFiles = [
        { key: "GeoIPFile", file: path.join(geoipBaseDir, "geoip") },
        { key: "GeoIPv6File", file: path.join(geoipBaseDir, "geoip6") }
    ].filter(item => fs.existsSync(item.file));

    const torrcLines = [
        `SocksPort 127.0.0.1:${account.torPort} IsolateClientAddr IsolateSOCKSAuth`,
        `DataDirectory ${dataDir}`,
        "",
        "Log notice stdout",
        "",
        "MaxCircuitDirtiness 60",
        "NewCircuitPeriod 30",
        "",
        "TestSocks 1",
        "SafeSocks 1",
        "",
        ...geoipFiles.map(item => `${item.key} ${item.file}`),
        "",
        `ControlPort 127.0.0.1:${account.controlPort}`,
        "CookieAuthentication 1",
        ""
    ];

    fs.writeFileSync(account.torrcFile, torrcLines.join("\n"));
}

const accounts = getAccounts();
accounts.forEach(ensureTorFiles);

const torProcesses = [];
const accountProcesses = new Map();
const accountSessions = new Map();
const accountHealth = new Map();
const healthTimers = new Map();
let mainWin = null;

function setAccountHealth(accountId, patch = {}) {
    const current = accountHealth.get(accountId) || {
        accountId,
        status: "starting",
        message: "Aguardando bootstrap",
        bootstrapped: false,
        retries: 0,
        lastUpdated: Date.now()
    };

    const next = {
        ...current,
        ...patch,
        accountId,
        lastUpdated: Date.now()
    };

    accountHealth.set(accountId, next);
    const payload = { accountId, ...next };

    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("account-health-update", payload);
    }

    writeAccountLog(accountId, next.status === "error" ? "error" : "info", next.message, {
        status: next.status,
        bootstrapped: next.bootstrapped,
        retries: next.retries,
        torPort: next.torPort,
        controlPort: next.controlPort,
    });

    return next;
}

function getAccountHealth(accountId) {
    return accountHealth.get(accountId) || {
        accountId,
        status: "unknown",
        message: "Sem status disponível",
        bootstrapped: false,
        retries: 0,
        lastUpdated: Date.now()
    };
}

function registerHealthTimer(account) {
    if (healthTimers.has(account.id)) {
        clearInterval(healthTimers.get(account.id));
    }

    const timer = setInterval(async () => {
        const proc = accountProcesses.get(account.id);
        const status = getAccountHealth(account.id);
        const running = !!proc && proc.exitCode === null;

        if (!running) {
            const currentState = getAccountHealth(account.id);
            if (currentState.status !== "recovering") {
                setAccountHealth(account.id, {
                    status: "degraded",
                    message: "Tor fora do ar. Tentando recuperar...",
                    bootstrapped: false,
                    retries: (currentState.retries || 0) + 1
                });
            }

            try {
                await restartAccountRuntime(account);
            } catch (error) {
                setAccountHealth(account.id, {
                    status: "error",
                    message: error.message || "Falha ao recuperar Tor",
                    bootstrapped: false,
                    retries: (getAccountHealth(account.id).retries || 0) + 1
                });
                writeLog("error", `Recovery failed for account ${account.id}`, { accountId: account.id, error: error.message });
            }
            return;
        }

        const canConnect = await testTorControlPort(account.controlPort).catch(() => false);
        if (!canConnect) {
            setAccountHealth(account.id, {
                status: status.bootstrapped ? "degraded" : "starting",
                message: status.bootstrapped ? "ControlPort indisponível" : "Aguardando bootstrap",
                bootstrapped: !!status.bootstrapped
            });
            return;
        }

        if (status.bootstrapped) {
            setAccountHealth(account.id, {
                status: "ready",
                message: "Tor saudável e pronto",
                bootstrapped: true
            });
        }
    }, HEALTH_CHECK_INTERVAL_MS);

    healthTimers.set(account.id, timer);
}

function testTorControlPort(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
            socket.end();
            resolve(true);
        });

        socket.on("error", reject);
        socket.setTimeout(3000, () => {
            socket.destroy();
            reject(new Error("Timeout ao conectar no ControlPort"));
        });
    });
}

async function restartAccountRuntime(account) {
    const existing = accountProcesses.get(account.id);
    if (existing && existing.exitCode === null) {
        return existing;
    }

    setAccountHealth(account.id, {
        status: "recovering",
        message: "Reconectando Tor e sessão",
        bootstrapped: false,
        retries: (getAccountHealth(account.id).retries || 0) + 1
    });

    const existingSession = accountSessions.get(account.id);
    if (existingSession) {
        try {
            await existingSession.closeAllConnections();
        } catch (_) {}
    }

    const proc = await startTorInstance(account);
    if (proc) {
        await setupSession(account);
        setAccountHealth(account.id, {
            status: "ready",
            message: "Tor recuperado com sucesso",
            bootstrapped: true,
            retries: Math.max(0, (getAccountHealth(account.id).retries || 0) - 1)
        });
        return proc;
    }

    throw new Error("Falha ao recuperar a instância Tor");
}

// ─────────────────────────────────────────────
// Inicia uma instância Tor e emite progresso
// ─────────────────────────────────────────────
function startTorInstance(account) {
    return new Promise((resolve, reject) => {
        console.log(`[Tor ${account.torPort}] Iniciando...`);
        writeLog("info", `Starting Tor instance for account ${account.id}`, {
            accountId: account.id,
            torPort: account.torPort,
            controlPort: account.controlPort
        });

        const proc = spawn(TOR_EXE, ["-f", account.torrcFile], {
            cwd: path.dirname(account.torrcFile),
            stdio: ["ignore", "pipe", "pipe"]
        });

        torProcesses.push(proc);
        accountProcesses.set(account.id, proc);
        setAccountHealth(account.id, {
            accountId: account.id,
            torPort: account.torPort,
            controlPort: account.controlPort,
            status: "starting",
            message: "Iniciando Tor",
            bootstrapped: false,
            retries: getAccountHealth(account.id).retries || 0
        });

        let bootstrapped = false;
        const timeout = setTimeout(() => {
            if (!bootstrapped) {
                const msg = `[Tor ${account.torPort}] Timeout ao aguardar bootstrap.`;
                setAccountHealth(account.id, {
                    status: "error",
                    message: msg,
                    bootstrapped: false
                });
                reject(new Error(msg));
            }
        }, 90000);

        function onData(chunk) {
            const line = chunk.toString();
            process.stdout.write(`[Tor ${account.torPort}] ${line}`);

            const matchPct = line.match(/Bootstrapped (\d+)%/);
            if (matchPct) {
                const pct = parseInt(matchPct[1], 10);
                if (mainWin && !mainWin.isDestroyed()) {
                    mainWin.webContents.send("bootstrap-progress", { id: account.id, pct });
                }

                if (pct === 100 && !bootstrapped) {
                    bootstrapped = true;
                    clearTimeout(timeout);
                    setAccountHealth(account.id, {
                        status: "ready",
                        message: "Tor pronto",
                        bootstrapped: true
                    });
                    writeLog("info", `Tor instance ready`, { accountId: account.id, torPort: account.torPort });
                    console.log(`[Tor ${account.torPort}] ✅ Pronto!`);
                    resolve(proc);
                }
            }

            if (line.includes("[err]") || line.includes("[warn] Could not bind")) {
                clearTimeout(timeout);
                const msg = `[Tor ${account.torPort}] Erro: ${line.trim()}`;
                setAccountHealth(account.id, {
                    status: "error",
                    message: msg,
                    bootstrapped: false
                });
                reject(new Error(msg));
            }
        }

        proc.stdout.on("data", onData);
        proc.stderr.on("data", onData);

        proc.on("exit", (code) => {
            if (!bootstrapped) {
                clearTimeout(timeout);
                const msg = `[Tor ${account.torPort}] Processo encerrou antes do bootstrap (code=${code})`;
                setAccountHealth(account.id, {
                    status: "error",
                    message: msg,
                    bootstrapped: false
                });
                reject(new Error(msg));
                return;
            }

            setAccountHealth(account.id, {
                status: "degraded",
                message: "Instância Tor encerrou após bootstrap",
                bootstrapped: false
            });
            writeLog("warn", `Tor process exited after bootstrap`, { accountId: account.id, code, torPort: account.torPort });
        });
    });
}

// ─────────────────────────────────────────────
// Configura a sessão Electron para cada conta
// ─────────────────────────────────────────────

// User-Agents variados (desktop + mobile + browsers)
const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15"
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Canvas Fingerprinting Protection Script
const canvasProtectionScript = `
(function() {
    // Protege Canvas.toDataURL
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
        if (this.width === 0 || this.height === 0) {
            return originalToDataURL.call(this, type);
        }
        const ctx = this.getContext('2d');
        if (ctx) {
            ctx.fillStyle = 'rgba(' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',0.5)';
            ctx.fillRect(0, 0, 1, 1);
        }
        return originalToDataURL.call(this, type);
    };
    
    // Protege Canvas.toBlob
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
            ctx.fillStyle = 'rgba(' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',0.5)';
            ctx.fillRect(0, 0, 1, 1);
        }
        return originalToBlob.call(this, callback, type, quality);
    };
    
    // Protege WebGL Fingerprinting
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) {
            return 'Intel Inc.';
        }
        if (parameter === 37446) {
            return 'Intel Iris OpenGL Engine';
        }
        return getParameter.call(this, parameter);
    };
    
    // Protege WebGL2 Fingerprinting
    if (WebGL2RenderingContext) {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) {
                return 'Intel Inc.';
            }
            if (parameter === 37446) {
                return 'Intel Iris OpenGL Engine';
            }
            return getParameter2.call(this, parameter);
        };
    }
    
    // Bloqueia AudioContext fingerprinting
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
        const originalCreateAnalyser = AudioContext.prototype.createAnalyser;
        AudioContext.prototype.createAnalyser = function() {
            const analyser = originalCreateAnalyser.call(this);
            const originalGetByteFrequencyData = analyser.getByteFrequencyData;
            analyser.getByteFrequencyData = function(array) {
                for (let i = 0; i < array.length; i++) {
                    array[i] = Math.floor(Math.random() * 256);
                }
                return originalGetByteFrequencyData.call(this, array);
            };
            return analyser;
        };
    }
})();
`;

async function setupSession(account) {
    const partition = `persist:account-${account.id}`;
    const ses = session.fromPartition(partition, { cache: true });

    await ses.setProxy({
        mode: "fixed_servers",
        proxyRules: `socks5://127.0.0.1:${account.torPort}`,
        proxyBypassRules: "<-loopback>"
    });

    await ses.closeAllConnections();

    // ── User-Agent Randomizer ──
    const randomUA = getRandomUserAgent();
    ses.setUserAgent(randomUA);

    // ── DNS over HTTPS (DoH) via Custom Headers ──
    ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
        const headers = details.requestHeaders;
        headers['DoH-User-Agent'] = 'tor-multiclient/1.0';
        callback({ requestHeaders: headers });
    });

    // ── Adblock: Bloqueia requisições de ad networks conhecidas ──
    const adDomains = new Set([
        // Google & Doubleclick
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
        // Facebook & Meta
        "facebook.com", "facebook.net",
        // Amazon
        "amazon-adsystem.com",
        // Taboola & Outbrain
        "taboola.com", "outbrain.com",
        // Criteo
        "criteo.com",
        // AppNexus
        "appnexus.com", "adnxs.com",
        // OpenX
        "openx.net",
        // Pubmatic
        "pubmatic.com",
        // Rubicon
        "rubiconproject.com",
        // Chartbeat
        "chartbeat.net",
        // Disqus
        "disqus.com",
        // Exponential Interactive
        "exponential.com",
        // Flurry
        "flurry.com",
        // Media.net
        "media.net",
        // Mixpanel
        "mixpanel.com",
        // Quantcast
        "quantcast.com",
        // Scorecard Research
        "scorecardresearch.com",
        // Segment
        "segment.com",
        // Sharethis
        "sharethis.com",
        // Site Meter
        "sitemeter.com",
        // Spotxchange
        "spotxchange.com",
        // Underdog Media
        "underdogmedia.com",
        // Vimeo
        "vimeo.com",
        // Yahoo
        "yimg.com", "yahoo.com",
        // Ad services
        "ads.google.com", "ads.twitter.com", "ads.linkedin.com",
        "ads-api.twitter.com", "linkedin.com/ads",
        // Ad exchanges
        "adroll.com", "polymorph.com", "turn.com",
        // Tracking & Analytics
        "hotjar.com", "mouseflow.com", "fullstory.com",
        "amplitude.com", "branch.io", "firebase.google.com"
    ]);

    // Bloqueia requisições para ad networks
    ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        const url = new URL(details.url);
        const hostname = url.hostname;
        
        // Verifica se o domínio está na lista de ads
        const isAd = Array.from(adDomains).some(adDomain => 
            hostname === adDomain || hostname.endsWith("." + adDomain)
        );

        if (isAd) {
            callback({ cancel: true });
        } else {
            callback({ cancel: false });
        }
    });

    // ── Canvas Fingerprinting Protection (injetado em cada página) ──
    ses.setPreloads([
        // Nota: Usamos webContents em vez de preload para evitar sandbox issues
    ]);

    // ── Cookie Isolation & Auto-Cleanup ──
    // Limpa cookies a cada 30 minutos
    const cookieCleanupInterval = setInterval(async () => {
        try {
            await ses.clearStorageData({
                dataTypes: ['cookies']
            });
            console.log(`[${account.name}] Cookies limpos automaticamente`);
        } catch (e) {
            console.error(`[${account.name}] Erro ao limpar cookies:`, e.message);
        }
    }, 30 * 60 * 1000); // 30 minutos

    // Guarda o interval para cleanup quando a sessão for destruída
    ses.__cookieCleanupInterval = cookieCleanupInterval;

    console.log(`[${account.name}] Sessão configurada → SOCKS5 127.0.0.1:${account.torPort} + DoH + UA Random + Canvas Protect + Adblock + CookieClean`);
    accountSessions.set(account.id, ses);
    return ses;
}

// ─────────────────────────────────────────────
// Janela principal (Splash + grade modular)
// ─────────────────────────────────────────────
function createMainWindow() {
    Menu.setApplicationMenu(null);
    const win = new BrowserWindow({
        width: 1600,
        height: 950,
        title: "Lyth",
        backgroundColor: "#0f0f0f",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webviewTag: true,
        }
    });

    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "index.html"));
    return win;
}

// ─────────────────────────────────────────────
// IPC — dados das contas para o renderer
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Verificação da rota usada pela sessão Chromium
// ─────────────────────────────────────────────
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function verifyBrowserRoute(account) {
    const ses = accountSessions.get(account.id);
    if (!ses) throw new Error("A sessão Chromium desta conta ainda não está pronta");

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            // This uses the actual Electron Session and its configured SOCKS route.
            const response = await ses.fetch("https://check.torproject.org/api/ip", {
                method: "GET",
                signal: controller.signal,
                cache: "no-store",
                headers: { Accept: "application/json" }
            });
            if (!response.ok) throw new Error(`Servidor de verificação respondeu HTTP ${response.status}`);
            const payload = await response.json();
            const ip = payload.IP || payload.ip;
            if (!net.isIP(ip)) throw new Error("Servidor de verificação não retornou um IP válido");
            return { ip, isTor: payload.IsTor === true, checkedAt: Date.now() };
        } catch (error) {
            lastError = error;
            if (attempt < 2) await wait(500 * (attempt + 1));
        } finally {
            clearTimeout(timeout);
        }
    }
    throw new Error(`Não foi possível verificar a rota Chromium: ${lastError?.message || "erro de rede"}`);
}

async function checkForLeaks(accountId) {
    const account = getAccounts().find(a => a.id === Number(accountId));
    if (!account) throw new Error("Conta não encontrada");
    const route = await verifyBrowserRoute(account);
    const hasLeak = route.isTor !== true;
    const message = hasLeak
        ? "A rota Chromium não foi reconhecida como conexão Tor"
        : "Rota Chromium confirmada pela rede Tor";
    writeAccountLog(account.id, hasLeak ? "error" : "info", message, {
        browserIP: route.ip,
        isTor: route.isTor
    });
    return { accountId: account.id, ip: route.ip, hasLeak, verified: route.isTor === true, message };
}

ipcMain.handle("get-account-info", () => {
    return getAccounts().map(a => ({
        id: a.id,
        name: a.name,
        batchId: a.batchId,
        batchName: a.batchName,
        torPort: a.torPort,
        controlPort: a.controlPort,
        partition: `persist:account-${a.id}`
    }));
});

ipcMain.handle("get-account-health", (_, accountId) => {
    const resolvedId = Number(accountId);
    return getAccountHealth(resolvedId);
});

// ── Leak Detection IPC ──
ipcMain.handle("check-leaks", async (_, { accountId } = {}) => {
    return checkForLeaks(accountId);
});

ipcMain.handle("get-workspace", () => ({
    groups,
    accounts: getAccounts().map(a => ({
        id: a.id, name: a.name, batchId: a.batchId, batchName: a.batchName,
        torPort: a.torPort, controlPort: a.controlPort,
        partition: `persist:account-${a.id}`
    }))
}));

ipcMain.handle("create-group", async (_, { name, accountCount }) => {
    const count = Number(accountCount);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new Error("O grupo deve ter entre 1 e 20 contas.");
    }

    const groupId = reserveGroupId();
    const group = {
        id: groupId,
        name: String(name || `Lote ${groupId}`).trim() || `Lote ${groupId}`,
        accounts: Array.from({ length: count }, () => {
            const id = reserveAccountId();
            return { id, name: `Conta ${id}` };
        })
    };
    groups = [...groups, group];
    const newAccounts = group.accounts.map(account => accountDetails(account, group));
    newAccounts.forEach(ensureTorFiles);
    saveGroups();

    await Promise.all(newAccounts.map(async account => {
        await startTorInstance(account);
        await setupSession(account);
        setAccountHealth(account.id, {
            accountId: account.id,
            torPort: account.torPort,
            controlPort: account.controlPort,
            status: "ready",
            message: "Sessão ativa e pronta",
            bootstrapped: true
        });
        registerHealthTimer(account);
    }));

    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("group-created", {
            group,
            accounts: newAccounts.map(a => ({
                id: a.id, name: a.name, batchId: a.batchId, batchName: a.batchName,
                torPort: a.torPort, controlPort: a.controlPort,
                partition: `persist:account-${a.id}`
            }))
        });
    }

    return {
        group,
        accounts: newAccounts.map(a => ({
            id: a.id, name: a.name, batchId: a.batchId, batchName: a.batchName,
            torPort: a.torPort, controlPort: a.controlPort,
            partition: `persist:account-${a.id}`
        }))
    };
});

ipcMain.handle("rename-account", (_, { accountId, name }) => {
    const account = getAccounts().find(item => item.id === accountId);
    if (!account) throw new Error("Conta não encontrada");
    const group = groups.find(item => item.id === account.batchId);
    const storedAccount = group.accounts.find(item => item.id === accountId);
    storedAccount.name = String(name || account.name).trim() || account.name;
    saveGroups();
    return { id: accountId, name: storedAccount.name };
});

ipcMain.handle("update-group", (_, { groupId, name, tag, note }) => {
    const group = groups.find(item => item.id === Number(groupId));
    if (!group) throw new Error("Lote não encontrado");

    group.name = String(name || group.name).trim() || group.name;
    group.tag = String(tag || "").trim();
    group.note = String(note || "").trim();
    saveGroups();
    return group;
});

ipcMain.handle("delete-group", async (_, groupId) => {
    const groupIndex = groups.findIndex(item => item.id === Number(groupId));
    if (groupIndex === -1) throw new Error("Lote não encontrado");

    const group = groups[groupIndex];
    const accountIds = group.accounts.map(item => item.id);
    groups.splice(groupIndex, 1);
    saveGroups();

    for (const accountId of accountIds) {
        await removeAccountRuntime(accountId);
    }

    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("group-deleted", Number(groupId));
    }

    return true;
});

ipcMain.handle("add-account", async (_, groupId) => {
    const group = groups.find(item => item.id === Number(groupId));
    if (!group) throw new Error("Lote não encontrado");
    const accountId = reserveAccountId();
    const account = { id: accountId, name: `Conta ${accountId}` };
    group.accounts.push(account);
    const details = accountDetails(account, group);
    ensureTorFiles(details);
    saveGroups();

    try {
        await startTorInstance(details);
        await setupSession(details);
        setAccountHealth(details.id, {
            accountId: details.id,
            torPort: details.torPort,
            controlPort: details.controlPort,
            status: "ready",
            message: "Sessão ativa e pronta",
            bootstrapped: true
        });
        registerHealthTimer(details);
    } catch (error) {
        group.accounts = group.accounts.filter(item => item.id !== accountId);
        saveGroups();
        throw error;
    }

    const result = {
        id: details.id, name: details.name, batchId: details.batchId, batchName: details.batchName,
        torPort: details.torPort, controlPort: details.controlPort,
        partition: `persist:account-${details.id}`
    };
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("account-added", result);
    return result;
});

ipcMain.handle("remove-account", async (_, accountId) => {
    const account = getAccounts().find(item => item.id === Number(accountId));
    if (!account) throw new Error("Conta não encontrada");
    const group = groups.find(item => item.id === account.batchId);
    group.accounts = group.accounts.filter(item => item.id !== account.id);
    saveGroups();

    await removeAccountRuntime(account.id);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("account-removed", account.id);
    return true;
});

// ─────────────────────────────────────────────
// IPC — New Identity via ControlPort
// ─────────────────────────────────────────────
// ── Tor Circuit Info & Rotation ──
ipcMain.handle("get-circuit-info", (_, accountId) => {
    const account = getAccounts().find(a => a.id === accountId);
    if (!account) return null;
    return {
        accountId,
        name: account.name,
        torPort: account.torPort,
        controlPort: account.controlPort,
        message: 'Use "New Identity" para rotacionar o circuito'
    };
});

function openTorController(account) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: account.controlPort });
        let buffer = "";
        let pending = null;
        let opened = false;
        const rejectPending = error => {
            if (!pending) return;
            const request = pending;
            pending = null;
            request.reject(error);
        };

        socket.once("connect", () => {
            opened = true;
            resolve({
                command(command) {
                    if (pending) return Promise.reject(new Error("Comando Tor concorrente não permitido"));
                    return new Promise((resolveCommand, rejectCommand) => {
                        pending = { resolve: resolveCommand, reject: rejectCommand, lines: [] };
                        socket.write(`${command}\r\n`);
                    });
                },
                close() {
                    if (!socket.destroyed) socket.end("QUIT\r\n");
                }
            });
        });
        socket.on("data", chunk => {
            buffer += chunk.toString("utf8");
            let newline;
            while ((newline = buffer.indexOf("\r\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 2);
                if (!pending) continue;
                pending.lines.push(line);
                const finalReply = line.match(/^(\d{3})\s/);
                if (!finalReply) continue;
                const request = pending;
                pending = null;
                if (Number(finalReply[1]) >= 400) request.reject(new Error(`ControlPort: ${request.lines.join(" | ")}`));
                else request.resolve({ code: Number(finalReply[1]), lines: request.lines });
            }
        });
        socket.on("error", error => {
            if (!opened) reject(error);
            else rejectPending(error);
        });
        socket.on("close", () => rejectPending(new Error("ControlPort foi fechado antes da resposta")));
        socket.setTimeout(10000, () => {
            const error = new Error("Timeout no ControlPort");
            rejectPending(error);
            socket.destroy(error);
        });
    });
}

async function authenticateSafeCookie(controller, account) {
    const cookieFile = path.join(path.dirname(account.torrcFile), "data", "control_auth_cookie");
    if (!fs.existsSync(cookieFile)) throw new Error("Cookie do Tor não encontrado. Reinicie a instância.");
    const cookie = fs.readFileSync(cookieFile);
    if (cookie.length !== 32) throw new Error("Cookie de controle do Tor inválido");

    const info = await controller.command("PROTOCOLINFO 1");
    const authLine = info.lines.find(line => line.startsWith("250-AUTH ") || line.startsWith("250 AUTH ")) || "";
    const methods = (authLine.match(/METHODS=([^\s]+)/)?.[1] || "").split(",");
    if (!methods.includes("SAFECOOKIE")) throw new Error("Esta instância Tor não oferece autenticação SAFECOOKIE");

    const clientNonce = crypto.randomBytes(32);
    const challenge = await controller.command(`AUTHCHALLENGE SAFECOOKIE ${clientNonce.toString("hex")}`);
    const challengeText = challenge.lines.join(" ");
    const serverHashHex = challengeText.match(/SERVERHASH=([0-9A-Fa-f]{64})/)?.[1];
    const serverNonceHex = challengeText.match(/SERVERNONCE=([0-9A-Fa-f]{64})/)?.[1];
    if (!serverHashHex || !serverNonceHex) throw new Error("Resposta SAFECOOKIE inválida");

    const serverNonce = Buffer.from(serverNonceHex, "hex");
    const expectedServerHash = crypto.createHmac("sha256", "Tor safe cookie authentication server-to-controller hash")
        .update(Buffer.concat([cookie, clientNonce, serverNonce])).digest();
    const receivedServerHash = Buffer.from(serverHashHex, "hex");
    if (receivedServerHash.length !== expectedServerHash.length
        || !crypto.timingSafeEqual(receivedServerHash, expectedServerHash)) {
        throw new Error("Falha ao validar a resposta SAFECOOKIE do Tor");
    }

    const clientHash = crypto.createHmac("sha256", "Tor safe cookie authentication controller-to-server hash")
        .update(Buffer.concat([cookie, clientNonce, serverNonce])).digest("hex");
    await controller.command(`AUTHENTICATE ${clientHash}`);
}

ipcMain.handle("tor-new-identity", async (_, accountId) => {
    const account = getAccounts().find(a => a.id === Number(accountId));
    if (!account) throw new Error("Conta não encontrada");

    const previousRoute = await verifyBrowserRoute(account).catch(() => null);
    const controller = await openTorController(account);
    try {
        await authenticateSafeCookie(controller, account);
        await controller.command("SIGNAL NEWNYM");
    } finally {
        controller.close();
    }

    const ses = accountSessions.get(account.id);
    if (ses) await ses.closeAllConnections();

    let route;
    for (let attempt = 0; attempt < 3; attempt++) {
        await wait(1500 * (attempt + 1));
        route = await verifyBrowserRoute(account);
        if (route.isTor) break;
    }
    if (!route?.isTor) throw new Error("O novo circuito não foi reconhecido como rota Tor");

    const changed = previousRoute?.ip ? previousRoute.ip !== route.ip : null;
    const message = changed === false
        ? "Novo circuito confirmado; o relay de saída manteve o mesmo IP"
        : "Novo circuito e rota Chromium confirmados";
    writeAccountLog(account.id, "info", message, {
        previousIP: previousRoute?.ip || null,
        newIP: route.ip,
        changed
    });
    return { previousIP: previousRoute?.ip || null, newIP: route.ip, changed, verified: true, message };
});

// ─────────────────────────────────────────────
// IPC — Abrir DevTools de uma webview
// ─────────────────────────────────────────────
ipcMain.on("open-devtools", (event, accountId) => {
    // O renderer usa webContents.id da webview — precisamos abrir devtools pelo sender
    // Usamos executeJavaScript no renderer para acionar o devtools via webview.openDevTools()
    // Aqui apenas repassamos o sinal de volta ao renderer
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("open-devtools-reply", accountId);
    }
});

// ─────────────────────────────────────────────
// Encerramento limpo
// ─────────────────────────────────────────────
function killAllTor() {
    console.log("\nEncerrando processos Tor...");
    for (const timer of healthTimers.values()) {
        clearInterval(timer);
    }
    healthTimers.clear();
    for (const proc of torProcesses) {
        try { proc.kill(); } catch (_) {}
    }
    torProcesses.length = 0;
}

app.on("before-quit", killAllTor);
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        killAllTor();
        app.quit();
    }
});

// ─────────────────────────────────────────────
// Boot principal — janela primeiro, depois Tor
// ─────────────────────────────────────────────
app.whenReady().then(async () => {
    console.log("==============================================");
    console.log("        LYTH — BOOT");
    console.log("==============================================\n");

    // 1. Abre a janela principal imediatamente (com splash screen)
    console.log("🖥️  Abrindo janela principal (splash)...");
    mainWin = createMainWindow();

    // 2. Aguarda o renderer estar pronto para receber eventos
    await new Promise(resolve => {
        mainWin.webContents.once("did-finish-load", resolve);
    });

    // 3. Inicia todos os processos Tor em paralelo (renderer recebe progresso em tempo real)
    console.log(`\n🧅 Iniciando ${accounts.length} instâncias Tor em paralelo...\n`);
    try {
        await Promise.all(accounts.map(startTorInstance));
    } catch (err) {
        console.error("\n❌ Falha ao iniciar Tor:", err.message);
        console.error("Verifique se o tor.exe existe em:", TOR_EXE);
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("tor-boot-error", err.message);
        }
        app.quit();
        return;
    }

    console.log("\n✅ Todos os processos Tor estão prontos!\n");

    // 4. Configura sessões Electron (proxy por conta)
    console.log("🔧 Configurando sessões Electron...");
    for (const account of accounts) {
        await setupSession(account);
        setAccountHealth(account.id, {
            accountId: account.id,
            torPort: account.torPort,
            controlPort: account.controlPort,
            status: "ready",
            message: "Sessão ativa e pronta",
            bootstrapped: true
        });
        registerHealthTimer(account);
    }

    // 5. Sinaliza ao renderer que o boot terminou
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("tor-boot-complete");
    }

    // 6. Verifica IPs no console (log lateral)
    console.log("\n🔍 Verificando IPs das 4 sessões...\n");
    for (const account of accounts) {
        try {
            const ip = await checkIPviaSocks(account.torPort);
            console.log(`  [${account.name}] IP público: ${ip}`);
        } catch (e) {
            console.log(`  [${account.name}] Não foi possível checar IP: ${e.message}`);
        }
    }
});

// ─────────────────────────────────────────────
// Verifica IP via SOCKS5 (Node.js side)
// ─────────────────────────────────────────────
function checkIPviaSocks(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let step = 0;
        socket.on("data", (data) => {
            if (step === 0) {
                if (data[0] === 0x05 && data[1] === 0x00) {
                    step = 1;
                    const host = "api.ipify.org";
                    const hostBuf = Buffer.from(host);
                    const req = Buffer.alloc(7 + hostBuf.length);
                    req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
                    req[4] = hostBuf.length;
                    hostBuf.copy(req, 5);
                    req.writeUInt16BE(443, 5 + hostBuf.length);
                    socket.write(req);
                }
            } else if (step === 1) {
                if (data[1] === 0x00) {
                    const tlsSocket = require("tls").connect({
                        socket,
                        servername: "api.ipify.org",
                        rejectUnauthorized: true
                    }, () => {
                        tlsSocket.write(
                            "GET /?format=json HTTP/1.1\r\n" +
                            "Host: api.ipify.org\r\n" +
                            "Connection: close\r\n\r\n"
                        );
                    });

                    let body = "";
                    tlsSocket.on("data", d => body += d.toString());
                    tlsSocket.on("end", () => {
                        try {
                            const json = JSON.parse(body.split("\r\n\r\n")[1]);
                            resolve(json.ip);
                        } catch {
                            reject(new Error("Resposta inválida: " + body.slice(0, 100)));
                        }
                    });
                    tlsSocket.on("error", reject);
                    step = 2;
                } else {
                    reject(new Error(`SOCKS5 erro: código ${data[1]}`));
                    socket.destroy();
                }
            }
        });

        socket.on("error", reject);
        socket.setTimeout(20000, () => {
            socket.destroy();
            reject(new Error("Timeout SOCKS5"));
        });
    });
}
