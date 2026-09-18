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
const { buildTorrc } = require("./src/tor-config");
const { launchTorProcess } = require("./src/tor-process");
const { ProfileRuntime } = require("./src/profile-runtime");
const { ProfileRuntimeManager } = require("./src/profile-runtime-manager");
const { rotateIdentity } = require("./src/newnym");
const { configureFailClosedSession, inspectSessionProxy } = require("./src/session-routing");
const { WorkspaceStore } = require("./src/storage/workspace-store");
const validation = require("./src/security/ipc-validation");
const { hardenSession, installWindowPolicies, isTrustedShellUrl } = require("./src/security/electron-security");

app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// ─────────────────────────────────────────────
// Configuração persistente dos lotes e instâncias Tor
// ─────────────────────────────────────────────
const TOR_EXE = path.join(__dirname, "..", "tor", "tor", "tor.exe");
const TOR_DIR = path.join(__dirname, "..", "tor");
const GROUPS_FILE = path.join(__dirname, "groups.json");
const DATABASE_FILE = path.join(app.getPath("userData"), "lyth.sqlite3");
const LOGS_DIR = path.join(__dirname, "logs");
const HEALTH_CHECK_INTERVAL_MS = 15000;
const EXTERNAL_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const RESTART_BACKOFF_BASE_MS = 5000;
const RESTART_BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const workspaceStore = new WorkspaceStore({
    databasePath: DATABASE_FILE,
    legacyPath: GROUPS_FILE,
    backupPath: path.join(app.getPath("userData"), "groups.pre-sqlite-backup.json")
});
let workspace = workspaceStore.getWorkspace();
let groups = workspace.groups;

function refreshWorkspace() {
    workspace = workspaceStore.getWorkspace();
    groups = workspace.groups;
    return workspace;
}

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
    hardenSession(ses);

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
            sandbox: true,
            webviewTag: true,
        }
    });

    win.setMenuBarVisibility(false);
    const indexPath = path.join(__dirname, "index.html");
    hardenSession(win.webContents.session);
    installWindowPolicies(win, {
        indexPath,
        isKnownPartition(partition) {
            const match = /^persist:account-(\d+)$/.exec(partition);
            return Boolean(match && workspaceStore.hasProfile(Number(match[1])));
        },
        onBlocked(details) {
            writeLog("warn", "Blocked Electron navigation capability", {
                component: "security",
                ...details
            });
        }
    });
    win.webContents.on("console-message", details => {
        const numericLevel = Number(details.level);
        const isWarning = details.level === "warning" || (Number.isFinite(numericLevel) && numericLevel === 2);
        const isError = details.level === "error" || (Number.isFinite(numericLevel) && numericLevel > 2);
        if (!isWarning && !isError) return;
        writeLog(isError ? "error" : "warn", "Renderer console message", {
            component: "renderer",
            error: details.message,
            line: details.lineNumber,
            source: details.sourceId
        });
    });
    win.webContents.on("render-process-gone", (_event, details) => {
        writeLog("error", "Renderer process exited", { component: "renderer", reason: details.reason, exitCode: details.exitCode });
    });
    win.loadFile(indexPath);
    return win;
}

function assertTrustedIpcSender(event) {
    const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || "";
    const trusted = mainWin && !mainWin.isDestroyed()
        && event.sender === mainWin.webContents
        && isTrustedShellUrl(senderUrl, path.join(__dirname, "index.html"));
    if (!trusted) throw new validation.ValidationError("Remetente IPC não autorizado");
}

function handleSecure(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
        try {
            assertTrustedIpcSender(event);
            return await handler(event, ...args);
        } catch (error) {
            writeLog(error instanceof validation.ValidationError ? "warn" : "error", "IPC operation failed", {
                component: "ipc",
                event: channel,
                errorCode: error.code || error.name,
                error: error.message
            });
            throw error;
        }
    });
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

handleSecure("get-account-health", (_, accountId) => {
    const resolvedId = validation.id(accountId, "accountId");
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
handleSecure("check-leaks", async (_, input) => {
    const { accountId, force = false } = validation.object(input, "verificação de rota");
    const payload = { accountId, force };
    return checkForLeaks(validation.id(payload.accountId, "accountId"), payload.force === undefined ? false : validation.boolean(payload.force, "force"));
});

handleSecure("get-workspace", () => ({
    groups,
    accounts: getAccounts().map(a => ({
        id: a.id, name: a.name, batchId: a.batchId, batchName: a.batchName,
        torPort: a.torPort, controlPort: a.controlPort,
        partition: `persist:account-${a.id}`
    })),
    uiState: {
        overviewOrder: workspaceStore.getSetting("overview_order", []),
        profiles: workspaceStore.profileUiData()
    }
}));

handleSecure("get-app-version", () => app.getVersion());

function validateBookmarks(value) {
    if (!Array.isArray(value) || value.length > 200) throw new validation.ValidationError("favoritos inválidos");
    return value.map(item => {
        const bookmark = validation.object(item, "favorito");
        return {
            url: validation.webUrl(bookmark.url),
            title: validation.text(bookmark.title || bookmark.url, { label: "título", max: 300 }),
            date: typeof bookmark.date === "string" && !Number.isNaN(Date.parse(bookmark.date)) ? bookmark.date : new Date().toISOString()
        };
    });
}

handleSecure("storage-import-legacy-renderer", (_, input) => {
    const payload = validation.object(input, "dados locais");
    const profiles = {};
    const entries = Object.entries(validation.object(payload.profiles || {}, "perfis"));
    if (entries.length > 1000) throw new validation.ValidationError("perfis locais demais");
    for (const [profileIdText, raw] of entries) {
        const profileId = validation.id(profileIdText, "profileId");
        const data = validation.object(raw, "dados do perfil");
        const ips = validation.stringArray(data.ipHistory || [], { label: "histórico de IP", maxItems: 50, itemMax: 45 });
        if (ips.some(ip => !net.isIP(ip))) throw new validation.ValidationError("histórico de IP inválido");
        profiles[profileId] = {
            lastUrl: validation.optionalWebUrl(data.lastUrl),
            urlHistory: validation.stringArray(data.urlHistory || [], { label: "histórico de URL", maxItems: 50 }).map(url => validation.webUrl(url)),
            ipHistory: ips,
            bookmarks: validateBookmarks(data.bookmarks || [])
        };
    }
    return workspaceStore.importRendererData({
        overviewOrder: validation.idArray(payload.overviewOrder || []),
        profiles
    });
});

handleSecure("storage-set-overview-order", (_, order) => {
    workspaceStore.setSetting("overview_order", validation.idArray(order));
    return true;
});

handleSecure("storage-set-last-url", (_, input) => {
    const payload = validation.object(input);
    workspaceStore.setLastUrl(validation.id(payload.profileId, "profileId"), validation.webUrl(payload.url));
    return true;
});

handleSecure("storage-add-navigation-history", (_, input) => {
    const payload = validation.object(input);
    workspaceStore.addNavigationHistory(validation.id(payload.profileId, "profileId"), validation.webUrl(payload.url));
    return true;
});

handleSecure("storage-replace-bookmarks", (_, input) => {
    const payload = validation.object(input);
    workspaceStore.replaceBookmarks(validation.id(payload.profileId, "profileId"), validateBookmarks(payload.bookmarks));
    return true;
});

handleSecure("storage-add-ip-history", (_, input) => {
    const payload = validation.object(input);
    const ip = validation.text(payload.ip, { label: "IP", max: 45 });
    if (!net.isIP(ip)) throw new validation.ValidationError("IP inválido");
    workspaceStore.addIpHistory(validation.id(payload.profileId, "profileId"), ip, "tor");
    return true;
});

handleSecure("create-group", async (_, input) => {
    const payload = validation.object(input, "grupo");
    const count = validation.count(payload.accountCount);
    const groupName = payload.name === undefined || String(payload.name).trim() === ""
        ? ""
        : validation.text(payload.name, { label: "nome do lote", max: 40 });
    const group = workspaceStore.createGroup({ name: groupName, accountCount: count });
    refreshWorkspace();
    const groupId = Number(group.id);
    const newAccounts = group.accounts.map(account => accountDetails(account, group));
    newAccounts.forEach(ensureTorFiles);

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

handleSecure("rename-account", (_, input) => {
    const payload = validation.object(input, "conta");
    const accountId = validation.id(payload.accountId, "accountId");
    const name = validation.text(payload.name, { label: "nome da conta", max: 80 });
    const result = workspaceStore.renameProfile(accountId, name);
    refreshWorkspace();
    return result;
});

handleSecure("update-group", (_, input) => {
    const payload = validation.object(input, "lote");
    const updated = workspaceStore.updateGroup({
        groupId: validation.id(payload.groupId, "groupId"),
        name: validation.text(payload.name, { label: "nome do lote", max: 40 }),
        tag: validation.text(payload.tag || "", { label: "tag", max: 30, allowEmpty: true }),
        note: validation.text(payload.note || "", { label: "nota", max: 1000, allowEmpty: true })
    });
    refreshWorkspace();
    return updated;
});

handleSecure("delete-group", async (_, groupId) => {
    const resolvedGroupId = validation.id(groupId, "groupId");
    const accountIds = workspaceStore.deleteGroup(resolvedGroupId);
    refreshWorkspace();

    const cleanup = await Promise.allSettled(accountIds.map(accountId => runtimeManager.destroy(accountId)));
    const cleanupFailures = cleanup.filter(result => result.status === "rejected");
    if (cleanupFailures.length) {
        writeLog("warn", "Some profile runtimes failed to clean up after group deletion", {
            component: "profiles",
            groupId: resolvedGroupId,
            failures: cleanupFailures.map(result => result.reason?.message || "unknown")
        });
    }

    return true;
});

handleSecure("add-account", async (_, groupId) => {
    const resolvedGroupId = validation.id(groupId, "groupId");
    const added = workspaceStore.addProfile(resolvedGroupId);
    refreshWorkspace();
    const group = groups.find(item => Number(item.id) === resolvedGroupId);
    const account = group.accounts.find(item => Number(item.id) === Number(added.id));
    const details = accountDetails(account, group);
    ensureTorFiles(details);

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

handleSecure("remove-account", async (_, accountId) => {
    const resolvedAccountId = validation.id(accountId, "accountId");
    const account = getAccounts().find(item => item.id === resolvedAccountId);
    if (!account) throw new Error("Conta não encontrada");
    workspaceStore.removeProfile(account.id);
    refreshWorkspace();

    await runtimeManager.destroy(account.id);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("account-removed", account.id);
    return true;
});

// ─────────────────────────────────────────────
// IPC — New Identity via ControlPort
// ─────────────────────────────────────────────
// ── Tor Circuit Info & Rotation ──
handleSecure("get-circuit-info", (_, accountId) => {
    const resolvedAccountId = validation.id(accountId, "accountId");
    const account = getAccounts().find(a => a.id === resolvedAccountId);
    if (!account) return null;
    return {
        accountId: resolvedAccountId,
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

handleSecure("tor-new-identity", async (_, accountId) => {
    const resolvedAccountId = validation.id(accountId, "accountId");
    const account = getAccounts().find(a => a.id === resolvedAccountId);
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
// Encerramento limpo
// ─────────────────────────────────────────────
let shutdownPromise = null;
let quitAfterShutdown = false;
let storageClosed = false;

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
        if (!storageClosed) {
            workspaceStore.close();
            storageClosed = true;
        }
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
