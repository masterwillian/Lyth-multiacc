const assert = require("node:assert/strict");
const test = require("node:test");
const { hasExpectedSocksProxy, isVerifiedReady, shouldAllowRequest } = require("../lib/network-gate");
const fs = require("node:fs");
const path = require("node:path");

test("só considera pronta uma conta com circuito, proxy e IP confirmados", () => {
    const complete = {
        status: "ready",
        bootstrapped: true,
        circuitEstablished: true,
        proxyConfigured: true,
        currentIP: "203.0.113.10"
    };

    assert.equal(isVerifiedReady(complete), true);
    for (const field of ["bootstrapped", "circuitEstablished", "proxyConfigured", "currentIP"]) {
        assert.equal(isVerifiedReady({ ...complete, [field]: field === "currentIP" ? null : false }), false);
    }
    assert.equal(isVerifiedReady({ ...complete, status: "degraded" }), false);
});

test("exige o endpoint SOCKS exato da conta", () => {
    assert.equal(hasExpectedSocksProxy("SOCKS5 127.0.0.1:9050", 9050), true);
    assert.equal(hasExpectedSocksProxy("SOCKS 127.0.0.1:9050", 9050), true);
    assert.equal(hasExpectedSocksProxy("SOCKS5 127.0.0.1:19050", 9050), false);
    assert.equal(hasExpectedSocksProxy("SOCKS5 127.0.0.1:90501", 9050), false);
    assert.equal(hasExpectedSocksProxy("DIRECT", 9050), false);
});

test("bloqueia tráfego externo até a conta ser autorizada", () => {
    const allowed = new Set();
    const verificationUrls = new Map();

    for (const url of ["https://example.com", "http://example.com", "wss://example.com/socket"]) {
        assert.equal(shouldAllowRequest(url, 7, allowed, verificationUrls), false);
    }
    assert.equal(shouldAllowRequest("about:blank", 7, allowed, verificationUrls), true);

    allowed.add(7);
    assert.equal(shouldAllowRequest("https://example.com", 7, allowed, verificationUrls), true);
});

test("durante validação libera somente o endpoint de IP autorizado", () => {
    const allowed = new Set();
    const probe = "https://api.ipify.org/?format=json&hub_bliw=nonce-known";
    const verificationUrls = new Map([[7, probe]]);

    assert.equal(shouldAllowRequest(probe, 7, allowed, verificationUrls), true);
    assert.equal(shouldAllowRequest("https://api.ipify.org/?format=json&hub_bliw=other", 7, allowed, verificationUrls), false);
    assert.equal(shouldAllowRequest("http://api.ipify.org/?format=json", 7, allowed, verificationUrls), false);
    assert.equal(shouldAllowRequest("https://example.com", 7, allowed, verificationUrls), false);
    assert.equal(shouldAllowRequest("https://api.ipify.org.evil.example/", 7, allowed, verificationUrls), false);
});

test("cria a sessão sem cache e prepara o proxy antes da janela", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");
    const bootMain = main.slice(main.indexOf("app.whenReady().then"));
    const sessionSetup = bootMain.indexOf("await setupSession(account)");
    const windowCreation = bootMain.indexOf("mainWin = createMainWindow()");

    assert.match(main, /session\.fromPartition\(partition, \{ cache: false \}\)/);
    assert.match(main, /ses\.clearCache\(\)/);
    assert.ok(sessionSetup >= 0 && sessionSetup < windowCreation);
});

test("invalida operações pertencentes a uma geração antiga da conta", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "..", "main.js"), "utf8");

    assert.match(main, /function assertAccountGeneration\(accountId, generation\)/);
    assert.match(main, /async function setupSession\(account, generation = nextAccountGeneration\(account\.id\)\)/);
    assert.match(main, /function startTorInstance\(account, generation = currentAccountGeneration\(account\.id\)\)/);
    assert.match(main, /function isCurrentRuntime\(\)/);
    assert.match(main, /currentAccountGeneration\(account\.id\) === generation\s+&& accountProcesses\.get\(account\.id\) === proc/);
    assert.match(main, /assertAccountGeneration\(account\.id, generation\);\s+return currentIP/);
    assert.match(main, /networkVerificationUrls\.get\(account\.id\) === verificationUrl/);
    assert.match(main, /identityOperations\.has\(account\.id\)/);
});
