const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");
const { EventEmitter } = require("events");
const validation = require("../src/security/ipc-validation");
const { isSafeGuestUrl, isTrustedShellUrl, hardenSession, installWindowPolicies } = require("../src/security/electron-security");

test("IPC validation rejects malformed IDs, oversized text and unsafe URLs", () => {
    assert.throws(() => validation.id("0"), validation.ValidationError);
    assert.throws(() => validation.id("1.2"), validation.ValidationError);
    assert.throws(() => validation.text("x".repeat(41), { max: 40 }), validation.ValidationError);
    assert.throws(() => validation.webUrl("javascript:alert(1)"), validation.ValidationError);
    assert.equal(validation.webUrl("https://example.com"), "https://example.com/");
});

test("guest navigation only accepts HTTP(S) and an explicit blank page", () => {
    assert.equal(isSafeGuestUrl("https://example.com/path"), true);
    assert.equal(isSafeGuestUrl("about:blank"), true);
    assert.equal(isSafeGuestUrl("file:///etc/passwd"), false);
    assert.equal(isSafeGuestUrl("javascript:alert(1)"), false);
});

test("the privileged shell only trusts its exact local entry point", () => {
    const indexPath = path.resolve("index.html");
    assert.equal(isTrustedShellUrl(pathToFileURL(indexPath).href, indexPath), true);
    assert.equal(isTrustedShellUrl(pathToFileURL(path.resolve("preload.js")).href, indexPath), false);
    assert.equal(isTrustedShellUrl("https://example.com", indexPath), false);
});

test("webview attachment rejects unknown partitions and strips privileges", () => {
    class Contents extends EventEmitter {
        setWindowOpenHandler(handler) { this.openHandler = handler; }
    }
    const contents = new Contents();
    contents.session = {
        setPermissionRequestHandler(handler) { this.requestHandler = handler; },
        setPermissionCheckHandler(handler) { this.checkHandler = handler; }
    };
    const win = { webContents: contents };
    installWindowPolicies(win, {
        indexPath: path.resolve("index.html"),
        isKnownPartition: partition => partition === "persist:account-1"
    });

    let prevented = false;
    contents.emit("will-attach-webview", { preventDefault() { prevented = true; } }, {}, {
        partition: "persist:account-999",
        src: "https://example.com"
    });
    assert.equal(prevented, true);

    const preferences = { preload: "evil.js", nodeIntegration: true, sandbox: false };
    contents.emit("will-attach-webview", { preventDefault() { throw new Error("unexpected rejection"); } }, preferences, {
        partition: "persist:account-1",
        src: "https://example.com"
    });
    assert.equal(preferences.preload, undefined);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.webSecurity, true);
    assert.deepEqual(contents.openHandler({ url: "https://example.com" }), { action: "deny" });

    hardenSession(contents.session);
    assert.equal(contents.session.checkHandler({}, "geolocation", "https://example.com"), false);
    let permissionResult;
    contents.session.requestHandler({}, "camera", result => { permissionResult = result; });
    assert.equal(permissionResult, false);
});
