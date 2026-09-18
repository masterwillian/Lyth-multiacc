const path = require("path");
const { fileURLToPath } = require("url");

const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);

function isSafeGuestUrl(value, { allowBlank = true } = {}) {
    if (allowBlank && value === "about:blank") return true;
    try { return SAFE_WEB_PROTOCOLS.has(new URL(value).protocol); } catch { return false; }
}

function isTrustedShellUrl(value, indexPath) {
    try {
        const url = new URL(value);
        return url.protocol === "file:" && path.resolve(fileURLToPath(url)) === path.resolve(indexPath);
    } catch {
        return false;
    }
}

function hardenSession(ses) {
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
}

function installWindowPolicies(win, { indexPath, isKnownPartition, onBlocked }) {
    const report = (event, details = {}) => onBlocked?.({ event, ...details });
    win.webContents.setWindowOpenHandler(details => {
        report("shell-popup-blocked", { url: details.url });
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
        if (isTrustedShellUrl(url, indexPath)) return;
        event.preventDefault();
        report("shell-navigation-blocked", { url });
    });
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
        const validPartition = typeof params.partition === "string" && isKnownPartition(params.partition);
        if (!validPartition || !isSafeGuestUrl(params.src)) {
            event.preventDefault();
            report("webview-attachment-blocked", { partition: params.partition, url: params.src });
            return;
        }
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.allowRunningInsecureContent = false;
    });
    win.webContents.on("did-attach-webview", (_event, guest) => {
        guest.setWindowOpenHandler(details => {
            report("guest-popup-blocked", { url: details.url });
            return { action: "deny" };
        });
        guest.on("will-navigate", (event, url) => {
            if (isSafeGuestUrl(url)) return;
            event.preventDefault();
            report("guest-navigation-blocked", { url });
        });
    });
}

module.exports = { isSafeGuestUrl, isTrustedShellUrl, hardenSession, installWindowPolicies };
