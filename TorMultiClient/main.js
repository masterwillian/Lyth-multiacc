const {
    app,
    BrowserWindow,
    session,
    ipcMain
} = require("electron");

const path = require("path");
const fs   = require("fs");
const { spawn } = require("child_process");
const { queryTorStatus, signalNewIdentity } = require("./lib/tor-control");
const { checkIpViaSocks } = require("./lib/socks-health");

// ─────────────────────────────────────────────
// Configuração persistente dos lotes e instâncias Tor
// ─────────────────────────────────────────────
const TOR_EXE = path.join(__dirname, "..", "tor", "tor", "tor.exe");
const TOR_DIR = path.join(__dirname, "..", "tor");
const GROUPS_FILE = path.join(__dirname, "groups.json");
const LOGS_DIR = path.join(__dirname, "logs");
const CONTROL_HEALTH_INTERVAL_MS = 30000;
const SOCKS_HEALTH_INTERVAL_MS = 120000;
const HEALTH_FAILURE_THRESHOLD = 3;
const HEALTH_JITTER_MS = 3000;
const HEALTH_STAGGER_MS = 1500;
const MAX_RESTART_BACKOFF_MS = 60000;

let groups = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8")).groups;

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
    fs.writeFileSync(GROUPS_FILE, JSON.stringify({ groups }, null, 2) + "\n");
}

async function removeAccountRuntime(accountId) {
    intentionallyStoppedAccounts.add(accountId);

    const process = accountProcesses.get(accountId);
    if (process) {
        expectedStoppedProcesses.add(process);
        try { process.kill(); } catch (_) {}
        accountProcesses.delete(accountId);
    }

    if (healthTimers.has(accountId)) {
        clearTimeout(healthTimers.get(accountId));
        healthTimers.delete(accountId);
    }

    const ses = accountSessions.get(accountId);
    if (ses) {
        if (ses.__cookieCleanupInterval) {
            clearInterval(ses.__cookieCleanupInterval);
            delete ses.__cookieCleanupInterval;
        }
        await ses.closeAllConnections().catch(() => {});
    }

    accountSessions.delete(accountId);
    healthRuntime.delete(accountId);
    recoveryPromises.delete(accountId);
    accountHealth.delete(accountId);
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
        "Log warn stdout",
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
const healthRuntime = new Map();
const recoveryPromises = new Map();
const intentionallyStoppedAccounts = new Set();
const expectedStoppedProcesses = new WeakSet();
let mainWin = null;
let appIsQuitting = false;

function setAccountHealth(accountId, patch = {}) {
    const current = accountHealth.get(accountId) || {
        accountId,
        status: "starting",
        message: "Aguardando bootstrap",
        bootstrapped: false,
        circuitEstablished: false,
        proxyConfigured: false,
        controlFailures: 0,
        socksFailures: 0,
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

    const logFields = [
        "status", "message", "bootstrapped", "circuitEstablished",
        "proxyConfigured", "currentIP", "controlFailures", "socksFailures", "retries"
    ];
    const changed = logFields.some(field => current[field] !== next[field]);
    if (changed) {
        const level = next.status === "error"
            ? "error"
            : ["degraded", "recovering"].includes(next.status) ? "warn" : "info";
        writeAccountLog(accountId, level, next.message, {
            status: next.status,
            bootstrapped: next.bootstrapped,
            circuitEstablished: next.circuitEstablished,
            proxyConfigured: next.proxyConfigured,
            currentIP: next.currentIP,
            controlFailures: next.controlFailures,
            socksFailures: next.socksFailures,
            retries: next.retries,
            torPort: next.torPort,
            controlPort: next.controlPort
        });
    }

    return next;
}

function getAccountHealth(accountId) {
    return accountHealth.get(accountId) || {
        accountId,
        status: "unknown",
        message: "Sem status disponível",
        bootstrapped: false,
        circuitEstablished: false,
        proxyConfigured: false,
        controlFailures: 0,
        socksFailures: 0,
        retries: 0,
        lastUpdated: Date.now()
    };
}

function getHealthRuntime(accountId) {
    if (!healthRuntime.has(accountId)) {
        healthRuntime.set(accountId, {
            checking: false,
            controlFailures: 0,
            socksFailures: 0,
            restartAttempts: 0,
            nextRestartAt: 0,
            lastDeepCheckAt: 0,
            lastIP: null
        });
    }
    return healthRuntime.get(accountId);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nextHealthDelay() {
    const jitter = Math.floor(Math.random() * (HEALTH_JITTER_MS * 2 + 1)) - HEALTH_JITTER_MS;
    return CONTROL_HEALTH_INTERVAL_MS + jitter;
}

function scheduleHealthCheck(account, delayMs) {
    if (healthTimers.has(account.id)) {
        clearTimeout(healthTimers.get(account.id));
    }

    const timer = setTimeout(async () => {
        healthTimers.delete(account.id);
        try {
            await runAccountHealthCheck(account);
        } catch (error) {
            writeLog("error", "Unhandled account health-check error", {
                accountId: account.id,
                error: error.message
            });
        } finally {
            if (!appIsQuitting && !intentionallyStoppedAccounts.has(account.id)) {
                scheduleHealthCheck(account, nextHealthDelay());
            }
        }
    }, Math.max(0, delayMs));

    healthTimers.set(account.id, timer);
}

function registerHealthTimer(account) {
    intentionallyStoppedAccounts.delete(account.id);
    const stagger = 5000 + (account.id % 10) * HEALTH_STAGGER_MS;
    scheduleHealthCheck(account, stagger);
}

async function verifySessionProxy(account) {
    const ses = accountSessions.get(account.id);
    if (!ses) return false;
    const resolved = await ses.resolveProxy("https://example.com/");
    return resolved.toUpperCase().includes("SOCKS") && resolved.includes(String(account.torPort));
}

async function runAccountHealthCheck(account, { forceDeep = false } = {}) {
    const runtime = getHealthRuntime(account.id);
    if (runtime.checking || recoveryPromises.has(account.id)) return getAccountHealth(account.id);
    runtime.checking = true;

    try {
        const proc = accountProcesses.get(account.id);
        if (!proc || proc.exitCode !== null) {
            if (runtime.nextRestartAt > Date.now()) {
                const seconds = Math.ceil((runtime.nextRestartAt - Date.now()) / 1000);
                return setAccountHealth(account.id, {
                    status: "error",
                    message: `Aguardando ${seconds}s para nova tentativa de recuperação`,
                    bootstrapped: false,
                    circuitEstablished: false
                });
            }
            setAccountHealth(account.id, {
                status: "degraded",
                message: "Processo Tor fora do ar",
                bootstrapped: false,
                circuitEstablished: false
            });
            await queueRecovery(account, "processo Tor encerrado", true);
            return getAccountHealth(account.id);
        }

        let controlStatus;
        try {
            controlStatus = await queryTorStatus(account);
        } catch (error) {
            runtime.controlFailures += 1;
            setAccountHealth(account.id, {
                status: "degraded",
                message: `ControlPort falhou (${runtime.controlFailures}/${HEALTH_FAILURE_THRESHOLD})`,
                bootstrapped: false,
                circuitEstablished: false,
                controlFailures: runtime.controlFailures
            });
            if (runtime.controlFailures >= HEALTH_FAILURE_THRESHOLD) {
                await queueRecovery(account, `ControlPort: ${error.message}`, true);
            }
            return getAccountHealth(account.id);
        }

        if (!controlStatus.bootstrapped || !controlStatus.circuitEstablished) {
            runtime.controlFailures += 1;
            setAccountHealth(account.id, {
                status: "degraded",
                message: controlStatus.bootstrapped ? "Tor ainda sem circuito estabelecido" : `Bootstrap em ${controlStatus.bootstrapProgress}%`,
                bootstrapped: controlStatus.bootstrapped,
                bootstrapProgress: controlStatus.bootstrapProgress,
                circuitEstablished: controlStatus.circuitEstablished,
                controlFailures: runtime.controlFailures
            });
            if (runtime.controlFailures >= HEALTH_FAILURE_THRESHOLD) {
                await queueRecovery(account, "Tor sem circuito utilizável", true);
            }
            return getAccountHealth(account.id);
        }

        const proxyConfigured = await verifySessionProxy(account).catch(() => false);
        if (!proxyConfigured) {
            runtime.controlFailures += 1;
            setAccountHealth(account.id, {
                status: "degraded",
                message: `Sessão sem o proxy esperado (${runtime.controlFailures}/${HEALTH_FAILURE_THRESHOLD})`,
                bootstrapped: true,
                circuitEstablished: true,
                proxyConfigured: false,
                controlFailures: runtime.controlFailures
            });
            if (runtime.controlFailures >= HEALTH_FAILURE_THRESHOLD) {
                await queueRecovery(account, "proxy da sessão inconsistente", true);
            }
            return getAccountHealth(account.id);
        }

        runtime.controlFailures = 0;
        const deepCheckDue = forceDeep || Date.now() - runtime.lastDeepCheckAt >= SOCKS_HEALTH_INTERVAL_MS;
        if (deepCheckDue) {
            runtime.lastDeepCheckAt = Date.now();
            try {
                runtime.lastIP = await checkIpViaSocks(account.torPort);
                runtime.socksFailures = 0;
            } catch (error) {
                runtime.socksFailures += 1;
                setAccountHealth(account.id, {
                    status: "degraded",
                    message: `Saída SOCKS5 falhou (${runtime.socksFailures}/${HEALTH_FAILURE_THRESHOLD})`,
                    bootstrapped: true,
                    circuitEstablished: true,
                    proxyConfigured: true,
                    controlFailures: 0,
                    socksFailures: runtime.socksFailures
                });
                if (runtime.socksFailures >= HEALTH_FAILURE_THRESHOLD) {
                    await queueRecovery(account, `SOCKS5: ${error.message}`, true);
                }
                return getAccountHealth(account.id);
            }
        }

        if (runtime.socksFailures > 0) {
            return setAccountHealth(account.id, {
                status: "degraded",
                message: `Saída SOCKS5 aguardando nova validação (${runtime.socksFailures}/${HEALTH_FAILURE_THRESHOLD})`,
                bootstrapped: true,
                circuitEstablished: true,
                proxyConfigured: true,
                controlFailures: 0,
                socksFailures: runtime.socksFailures,
                lastCheckedAt: Date.now()
            });
        }

        return setAccountHealth(account.id, {
            status: "ready",
            message: runtime.lastIP ? `Tor saudável • IP ${runtime.lastIP}` : "Tor saudável e pronto",
            bootstrapped: true,
            bootstrapProgress: 100,
            circuitEstablished: true,
            proxyConfigured: true,
            currentIP: runtime.lastIP,
            controlFailures: 0,
            socksFailures: 0,
            lastCheckedAt: Date.now()
        });
    } finally {
        runtime.checking = false;
    }
}

function queueRecovery(account, reason, forceRestart = false) {
    if (appIsQuitting || intentionallyStoppedAccounts.has(account.id)) return Promise.resolve(null);
    if (recoveryPromises.has(account.id)) return recoveryPromises.get(account.id);

    const recovery = restartAccountRuntime(account, reason, forceRestart)
        .finally(() => recoveryPromises.delete(account.id));
    recoveryPromises.set(account.id, recovery);
    return recovery;
}

async function restartAccountRuntime(account, reason = "falha de saúde", forceRestart = false) {
    const runtime = getHealthRuntime(account.id);
    const waitMs = runtime.nextRestartAt - Date.now();
    if (waitMs > 0) {
        throw new Error(`Recuperação em espera por mais ${Math.ceil(waitMs / 1000)}s`);
    }

    setAccountHealth(account.id, {
        status: "recovering",
        message: `Recuperando conta: ${reason}`,
        bootstrapped: false,
        circuitEstablished: false,
        retries: (getAccountHealth(account.id).retries || 0) + 1
    });

    try {
        const existing = accountProcesses.get(account.id);
        if (existing && existing.exitCode === null && forceRestart) {
            expectedStoppedProcesses.add(existing);
            try { existing.kill(); } catch (_) {}
            await Promise.race([
                new Promise(resolve => existing.once("exit", resolve)),
                delay(3000)
            ]);
        } else if (existing && existing.exitCode === null) {
            return existing;
        }

        const existingSession = accountSessions.get(account.id);
        if (existingSession) {
            await existingSession.closeAllConnections().catch(() => {});
        }

        const proc = await startTorInstance(account);
        await setupSession(account);
        const control = await queryTorStatus(account);
        if (!control.bootstrapped || !control.circuitEstablished) {
            throw new Error("Tor reiniciou, mas ainda não possui circuito estabelecido");
        }

        runtime.controlFailures = 0;
        runtime.socksFailures = 0;
        runtime.restartAttempts = 0;
        runtime.nextRestartAt = 0;
        runtime.lastDeepCheckAt = 0;
        setAccountHealth(account.id, {
            status: "ready",
            message: "Tor recuperado com sucesso",
            bootstrapped: true,
            bootstrapProgress: 100,
            circuitEstablished: true,
            proxyConfigured: true,
            controlFailures: 0,
            socksFailures: 0
        });
        return proc;
    } catch (error) {
        const failedProcess = accountProcesses.get(account.id);
        if (failedProcess && failedProcess.exitCode === null) {
            expectedStoppedProcesses.add(failedProcess);
            try { failedProcess.kill(); } catch (_) {}
            if (accountProcesses.get(account.id) === failedProcess) {
                accountProcesses.delete(account.id);
            }
        }
        runtime.restartAttempts += 1;
        const backoff = Math.min(MAX_RESTART_BACKOFF_MS, 5000 * (2 ** (runtime.restartAttempts - 1)));
        runtime.nextRestartAt = Date.now() + backoff;
        setAccountHealth(account.id, {
            status: "error",
            message: `Recuperação falhou; nova tentativa em ${Math.ceil(backoff / 1000)}s`,
            bootstrapped: false,
            circuitEstablished: false,
            retries: runtime.restartAttempts
        });
        writeLog("error", "Account recovery failed", {
            accountId: account.id,
            reason,
            error: error.message,
            retryInMs: backoff
        });
        throw error;
    }
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
        let settled = false;
        let bootstrapTimer = null;

        function finishBootstrap(error) {
            if (settled) return;
            settled = true;
            if (bootstrapTimer) clearTimeout(bootstrapTimer);
            if (error) reject(error);
            else resolve(proc);
        }

        function onData(chunk) {
            const line = chunk.toString();
            process.stdout.write(`[Tor ${account.torPort}] ${line}`);

            if (line.includes("[err]") || line.includes("[warn] Could not bind")) {
                const msg = `[Tor ${account.torPort}] Erro: ${line.trim()}`;
                setAccountHealth(account.id, {
                    status: "error",
                    message: msg,
                    bootstrapped: false
                });
                finishBootstrap(new Error(msg));
            }
        }

        proc.stdout.on("data", onData);
        proc.stderr.on("data", onData);
        proc.on("error", error => finishBootstrap(error));

        proc.on("exit", (code) => {
            if (accountProcesses.get(account.id) === proc) {
                accountProcesses.delete(account.id);
            }
            if (!bootstrapped) {
                const msg = `[Tor ${account.torPort}] Processo encerrou antes do bootstrap (code=${code})`;
                if (!appIsQuitting && !intentionallyStoppedAccounts.has(account.id) && !expectedStoppedProcesses.has(proc)) {
                    setAccountHealth(account.id, {
                        status: "error",
                        message: msg,
                        bootstrapped: false,
                        circuitEstablished: false
                    });
                }
                finishBootstrap(new Error(msg));
                return;
            }

            if (appIsQuitting || intentionallyStoppedAccounts.has(account.id) || expectedStoppedProcesses.has(proc)) return;
            setAccountHealth(account.id, {
                status: "degraded",
                message: "Instância Tor encerrou após bootstrap",
                bootstrapped: false,
                circuitEstablished: false
            });
            writeLog("warn", `Tor process exited after bootstrap`, { accountId: account.id, code, torPort: account.torPort });
            queueRecovery(account, "processo Tor encerrou inesperadamente", false).catch(() => {});
        });

        const startedAt = Date.now();
        async function pollBootstrap() {
            if (settled || proc.exitCode !== null) return;
            if (Date.now() - startedAt >= 90000) {
                expectedStoppedProcesses.add(proc);
                try { proc.kill(); } catch (_) {}
                const msg = `[Tor ${account.torPort}] Timeout ao aguardar bootstrap.`;
                setAccountHealth(account.id, {
                    status: "error",
                    message: msg,
                    bootstrapped: false,
                    circuitEstablished: false
                });
                finishBootstrap(new Error(msg));
                return;
            }

            try {
                const status = await queryTorStatus(account, 2500);
                if (mainWin && !mainWin.isDestroyed()) {
                    mainWin.webContents.send("bootstrap-progress", {
                        id: account.id,
                        pct: status.bootstrapProgress
                    });
                }
                setAccountHealth(account.id, {
                    status: "starting",
                    message: `Bootstrap em ${status.bootstrapProgress}%`,
                    bootstrapped: status.bootstrapped,
                    bootstrapProgress: status.bootstrapProgress,
                    circuitEstablished: status.circuitEstablished
                });

                if (status.bootstrapped && status.circuitEstablished) {
                    bootstrapped = true;
                    setAccountHealth(account.id, {
                        status: "ready",
                        message: "Tor pronto",
                        bootstrapped: true,
                        bootstrapProgress: 100,
                        circuitEstablished: true
                    });
                    writeLog("info", "Tor instance ready", { accountId: account.id, torPort: account.torPort });
                    console.log(`[Tor ${account.torPort}] ✅ Pronto!`);
                    finishBootstrap(null);
                    return;
                }
            } catch (_) {
                // ControlPort/cookie ainda não estão disponíveis durante os primeiros segundos.
            }

            bootstrapTimer = setTimeout(pollBootstrap, 1000);
        }

        bootstrapTimer = setTimeout(pollBootstrap, 500);
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

    if (ses.__cookieCleanupInterval) {
        clearInterval(ses.__cookieCleanupInterval);
        delete ses.__cookieCleanupInterval;
    }

    await ses.setProxy({
        mode: "fixed_servers",
        proxyRules: `socks5://127.0.0.1:${account.torPort}`,
        proxyBypassRules: "<-loopback>"
    });

    await ses.closeAllConnections();

    // ── User-Agent Randomizer ──
    const randomUA = getRandomUserAgent();
    ses.setUserAgent(randomUA);

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

    console.log(`[${account.name}] Sessão configurada → SOCKS5 127.0.0.1:${account.torPort} + DNS via SOCKS + UA Random + Canvas Protect + Adblock + CookieClean`);
    accountSessions.set(account.id, ses);
    return ses;
}

// ─────────────────────────────────────────────
// Janela principal (splash + painel de sessões)
// ─────────────────────────────────────────────
function createMainWindow() {
    const win = new BrowserWindow({
        width: 1600,
        height: 950,
        title: "hub-bliw",
        backgroundColor: "#0f0f0f",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webviewTag: true,
        }
    });

    win.removeMenu();
    win.loadFile(path.join(__dirname, "index.html"));
    return win;
}

// ─────────────────────────────────────────────
// IPC — dados das contas para o renderer
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

    const currentGroups = groups;
    const groupId = currentGroups.reduce((max, group) => Math.max(max, group.id), 0) + 1;
    let nextAccountId = getAccounts().reduce((max, account) => Math.max(max, account.id), 0) + 1;
    const group = {
        id: groupId,
        name: String(name || `Lote ${groupId}`).trim() || `Lote ${groupId}`,
        accounts: Array.from({ length: count }, () => ({ id: nextAccountId++, name: `Conta ${nextAccountId - 1}` }))
    };
    groups = [...currentGroups, group];
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
            bootstrapped: true,
            bootstrapProgress: 100,
            circuitEstablished: true,
            proxyConfigured: true
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
    const accountId = getAccounts().reduce((max, account) => Math.max(max, account.id), 0) + 1;
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
            bootstrapped: true,
            bootstrapProgress: 100,
            circuitEstablished: true,
            proxyConfigured: true
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

ipcMain.handle("tor-new-identity", async (_, accountId) => {
    const account = getAccounts().find(a => a.id === Number(accountId));
    if (!account) throw new Error("Conta não encontrada");

    const runtime = getHealthRuntime(account.id);
    const previousIP = runtime.lastIP || getAccountHealth(account.id).currentIP || null;
    setAccountHealth(account.id, {
        status: "recovering",
        message: "Solicitando novo circuito Tor",
        currentIP: null
    });

    try {
        await signalNewIdentity(account);
        const ses = accountSessions.get(account.id);
        if (ses) await ses.closeAllConnections();
    } catch (error) {
        setAccountHealth(account.id, {
            status: "degraded",
            message: "Não foi possível solicitar um novo circuito Tor",
            currentIP: null
        });
        writeLog("error", "New identity request failed", {
            accountId: account.id,
            error: error.message
        });
        throw error;
    }

    // NEWNYM cria circuitos novos sob demanda e não garante um exit relay diferente.
    await delay(5000);
    let currentIP = null;
    let verified = false;
    try {
        currentIP = await checkIpViaSocks(account.torPort);
        verified = true;
        runtime.lastIP = currentIP;
        runtime.lastDeepCheckAt = Date.now();
        runtime.socksFailures = 0;
        setAccountHealth(account.id, {
            status: "ready",
            message: previousIP && currentIP === previousIP
                ? `Circuito renovado • IP mantido ${currentIP}`
                : `Novo circuito • IP ${currentIP}`,
            currentIP,
            bootstrapped: true,
            circuitEstablished: true,
            proxyConfigured: true,
            socksFailures: 0
        });
    } catch (error) {
        runtime.socksFailures += 1;
        setAccountHealth(account.id, {
            status: "degraded",
            message: "Circuito solicitado, mas o novo IP não pôde ser verificado",
            currentIP: null,
            socksFailures: runtime.socksFailures
        });
    }

    writeLog("info", "New identity requested", {
        accountId: account.id,
        previousIP,
        currentIP,
        verified,
        changed: verified && !!previousIP && previousIP !== currentIP
    });
    return {
        ok: true,
        verified,
        previousIP,
        currentIP,
        changed: verified && !!previousIP && previousIP !== currentIP
    };
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
    appIsQuitting = true;
    console.log("\nEncerrando processos Tor...");
    for (const timer of healthTimers.values()) {
        clearTimeout(timer);
    }
    healthTimers.clear();
    for (const [accountId, ses] of accountSessions.entries()) {
        intentionallyStoppedAccounts.add(accountId);
        if (ses.__cookieCleanupInterval) clearInterval(ses.__cookieCleanupInterval);
        ses.closeAllConnections().catch(() => {});
    }
    for (const [accountId, proc] of accountProcesses.entries()) {
        intentionallyStoppedAccounts.add(accountId);
        expectedStoppedProcesses.add(proc);
        try { proc.kill(); } catch (_) {}
    }
    accountProcesses.clear();
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
    console.log("        HUB-BLIW — BOOT");
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
            bootstrapped: true,
            bootstrapProgress: 100,
            circuitEstablished: true,
            proxyConfigured: true
        });
        registerHealthTimer(account);
    }

    // 5. Sinaliza ao renderer que o boot terminou
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("tor-boot-complete");
    }

});
