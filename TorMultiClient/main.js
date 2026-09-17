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
const { normalizeWorkspace } = require("./src/workspace");
const { buildTorrc } = require("./src/tor-config");
const { launchTorProcess } = require("./src/tor-process");
const { ProfileRuntime } = require("./src/profile-runtime");
const { ProfileRuntimeManager } = require("./src/profile-runtime-manager");
const { rotateIdentity } = require("./src/newnym");
const { configureFailClosedSession, inspectSessionProxy } = require("./src/session-routing");

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
const EXTERNAL_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const RESTART_BACKOFF_BASE_MS = 5000;
const RESTART_BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function loadWorkspace() {
    return normalizeWorkspace(JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8")));
}

const workspace = loadWorkspace();
let groups = workspace.groups;
let nextGroupId = workspace.nextGroupId;
let nextAccountId = workspace.nextAccountId;

function ensureLogsDir() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function appendBoundedLog(file, line) {
    try {
        if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
            const previous = `${file}.1`;
            if (fs.existsSync(previous)) fs.unlinkSync(previous);
            fs.renameSync(file, previous);
        }
        fs.appendFileSync(file, line, "utf8");
    } catch (error) {
        console.error(`Falha ao gravar log ${file}:`, error.message);
    }
}

function writeLog(level, message, meta = {}) {
    ensureLogsDir();
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message,
        ...meta
    }) + "\n";
    appendBoundedLog(path.join(LOGS_DIR, "app.log"), line);
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
    appendBoundedLog(path.join(LOGS_DIR, `account-${accountId}.log`), line);
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

function ensureTorFiles(account) {
    const instanceDir = path.dirname(account.torrcFile);
    const dataDir = path.join(instanceDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(account.torrcFile, buildTorrc({
        torPort: account.torPort,
        controlPort: account.controlPort,
        dataDir,
        torExecutable: TOR_EXE
    }));
}

const accounts = getAccounts();
accounts.forEach(ensureTorFiles);

let mainWin = null;

function publishRuntimeState(payload, previousState, event = "runtime-state-transition") {
    const { accountId } = payload;
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("account-health-update", payload);
    }
    if (event === "runtime-state-transition") {
        writeAccountLog(accountId, payload.status === "error" ? "error" : "info", payload.message, {
            event,
            state: payload.state,
            previousState,
            status: payload.status,
            bootstrapped: payload.bootstrapped,
            retries: payload.retries,
            torPort: payload.torPort,
            controlPort: payload.controlPort
        });
    }
}

const runtimeManager = new ProfileRuntimeManager(profile => new ProfileRuntime(profile, {
    healthIntervalMs: HEALTH_CHECK_INTERVAL_MS,
    externalHealthIntervalMs: EXTERNAL_HEALTH_INTERVAL_MS,
    restartBackoffBaseMs: RESTART_BACKOFF_BASE_MS,
    restartBackoffMaxMs: RESTART_BACKOFF_MAX_MS,
    setIntervalFn: setInterval,
    clearIntervalFn: clearInterval,
    launchTor: (currentProfile, hooks) => launchTorProcess(currentProfile, {
        torExecutable: TOR_EXE,
        ...hooks,
        onOutput: text => process.stdout.write(`[Tor ${currentProfile.torPort}] ${text}`)
    }),
    createSession: createProfileSession,
    inspectSessionProxy,
    verifyExternalRoute: fetchExternalRoute,
    checkControlPort: port => testTcpPort(port),
    checkSocksPort: port => testTcpPort(port),
    onBootstrap: (profileId, percent) => {
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("bootstrap-progress", { id: profileId, pct: percent });
        }
    },
    onStateChange: publishRuntimeState,
    onCleanupError: error => writeLog("warn", "Runtime cleanup failed", { error: error.message })
}));

function testTcpPort(port) {
    return new Promise(resolve => {
        let settled = false;
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(true);
        });
        socket.once("error", error => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(false);
        });
        socket.setTimeout(3000, () => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(false);
        });
    });
}

// ─────────────────────────────────────────────
// Configura a sessão Electron para cada conta
// ─────────────────────────────────────────────

async function createProfileSession(account) {
    const partition = `persist:account-${account.id}`;
    const ses = session.fromPartition(partition, { cache: true });

    await configureFailClosedSession(ses, account);

    console.log(`[${account.name}] Sessão Chromium persistente configurada → SOCKS5 127.0.0.1:${account.torPort}`);
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

async function fetchExternalRoute(ses) {
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
            return { reachable: true, ip, isTor: payload.IsTor === true, checkedAt: Date.now() };
        } catch (error) {
            lastError = error;
            if (attempt < 2) await wait(500 * (attempt + 1));
        } finally {
            clearTimeout(timeout);
        }
    }
    throw new Error(`Não foi possível verificar a rota Chromium: ${lastError?.message || "erro de rede"}`);
}

async function checkForLeaks(accountId, force = false) {
    const account = getAccounts().find(a => a.id === Number(accountId));
    if (!account) throw new Error("Conta não encontrada");
    const runtime = runtimeManager.get(account.id);
    if (!runtime) throw new Error("Runtime da conta não está ativo");
    const route = await runtime.verifyExternalRoute({ force, reason: force ? "manual" : "renderer-refresh" });
    const hasLeak = route.isTor !== true;
    const message = !route.reachable
        ? `A rota Chromium não respondeu: ${route.error || "erro de rede"}`
        : hasLeak
        ? "A rota Chromium não foi reconhecida como conexão Tor"
        : "Rota Chromium confirmada pela rede Tor";
    writeAccountLog(account.id, hasLeak ? "error" : "info", message, {
        browserIP: route.ip,
        isTor: route.isTor
    });
    return { accountId: account.id, ip: route.ip, hasLeak, reachable: route.reachable, verified: route.isTor === true, message };
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
    return runtimeManager.get(resolvedId)?.snapshot() || {
        accountId: resolvedId,
        state: "STOPPED",
        status: "unknown",
        message: "Sem runtime ativo",
        bootstrapped: false,
        retries: 0,
        lastUpdated: Date.now()
    };
});

// ── Leak Detection IPC ──
ipcMain.handle("check-leaks", async (_, { accountId, force = false } = {}) => {
    return checkForLeaks(accountId, force === true);
});

ipcMain.handle("get-workspace", () => ({
    groups,
    accounts: getAccounts().map(a => ({
        id: a.id, name: a.name, batchId: a.batchId, batchName: a.batchName,
        torPort: a.torPort, controlPort: a.controlPort,
        partition: `persist:account-${a.id}`
    }))
}));

ipcMain.handle("get-app-version", () => app.getVersion());

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

    const startup = await runtimeManager.startAll(newAccounts);
    const failures = startup.filter(item => item.status === "rejected");
    if (failures.length) {
        writeLog("warn", "Some profiles failed during group startup", {
            groupId,
            failedProfileIds: failures.map(item => item.profile.id),
            errors: failures.map(item => item.error?.message || "unknown")
        });
    }

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
        await runtimeManager.destroy(accountId);
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

    await runtimeManager.ensure(details).start().catch(error => {
        writeLog("warn", "New profile runtime failed to start and remains recoverable", {
            accountId: details.id,
            error: error.message
        });
    });

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

    await runtimeManager.destroy(account.id);
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
    const runtime = runtimeManager.get(account.id);
    if (!runtime) throw new Error("Runtime da conta não está ativo");

    return runtime.runOperation("newnym", async () => {
        const result = await rotateIdentity({
            getRoute: reason => runtime.verifyExternalRoute({ force: true, reason }),
            signalNewnym: async () => {
                const controller = await openTorController(account);
                try {
                    await authenticateSafeCookie(controller, account);
                    await controller.command("SIGNAL NEWNYM");
                } finally {
                    controller.close();
                }
            },
            resetConnections: () => runtime.session?.closeAllConnections() || Promise.resolve(),
            wait
        });
        writeAccountLog(account.id, result.signalSucceeded ? "info" : "error", result.message, result);
        return result;
    });
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
let shutdownPromise = null;
let quitAfterShutdown = false;

function stopAllRuntimes() {
    if (shutdownPromise) return shutdownPromise;
    console.log("\nEncerrando runtimes de perfil...");
    shutdownPromise = runtimeManager.stopAll();
    return shutdownPromise;
}

app.on("before-quit", event => {
    if (quitAfterShutdown) return;
    event.preventDefault();
    void stopAllRuntimes().finally(() => {
        quitAfterShutdown = true;
        app.quit();
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
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

    // 3. Inicia um runtime autoritativo por perfil em paralelo.
    console.log(`\n🧅 Iniciando ${accounts.length} runtimes de perfil em paralelo...\n`);
    const startup = await runtimeManager.startAll(accounts);
    const failed = startup.filter(item => item.status === "rejected");
    console.log(`\n✅ ${startup.length - failed.length} runtimes prontos; ${failed.length} com falha recuperável.\n`);

    // 4. Sinaliza ao renderer que o boot terminou
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("tor-boot-complete");
    }

});
