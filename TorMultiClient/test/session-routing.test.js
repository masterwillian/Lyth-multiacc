const test = require("node:test");
const assert = require("node:assert/strict");
const { configureFailClosedSession, inspectSessionProxy } = require("../src/session-routing");

test("keeps networking offline until the fixed SOCKS proxy is configured", async () => {
    const calls = [];
    const ses = {
        enableNetworkEmulation(options) { calls.push(["offline", options.offline]); },
        async setProxy(options) { calls.push(["proxy", options]); },
        async closeAllConnections() { calls.push(["close"]); },
        disableNetworkEmulation() { calls.push(["online"]); }
    };
    await configureFailClosedSession(ses, { torPort: 9100 });
    assert.deepEqual(calls.map(item => item[0]), ["offline", "proxy", "close", "online"]);
    assert.equal(calls[1][1].mode, "fixed_servers");
    assert.equal(calls[1][1].proxyRules, "socks5://127.0.0.1:9100");
});

test("remains offline when proxy configuration fails", async () => {
    let disabled = false;
    const ses = {
        enableNetworkEmulation() {},
        async setProxy() { throw new Error("proxy failed"); },
        async closeAllConnections() {},
        disableNetworkEmulation() { disabled = true; }
    };
    await assert.rejects(configureFailClosedSession(ses, { torPort: 9100 }), /proxy failed/);
    assert.equal(disabled, false);
});

test("verifies the effective Electron proxy against the profile port", async () => {
    const matching = await inspectSessionProxy(
        { resolveProxy: async () => "SOCKS5 127.0.0.1:9100" },
        { torPort: 9100 }
    );
    const direct = await inspectSessionProxy(
        { resolveProxy: async () => "DIRECT" },
        { torPort: 9100 }
    );
    assert.equal(matching.configured, true);
    assert.equal(direct.configured, false);
});
