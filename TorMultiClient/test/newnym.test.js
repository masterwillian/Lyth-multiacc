const test = require("node:test");
const assert = require("node:assert/strict");
const { rotateIdentity } = require("../src/newnym");

test("reports successful signal, verified route and changed IP", async () => {
    const routes = [
        { reachable: true, isTor: true, ip: "1.1.1.1" },
        { reachable: true, isTor: true, ip: "2.2.2.2" }
    ];
    const result = await rotateIdentity({
        getRoute: async () => routes.shift(),
        signalNewnym: async () => {},
        resetConnections: async () => {},
        wait: async () => {}
    });

    assert.equal(result.signalSucceeded, true);
    assert.equal(result.routeVerified, true);
    assert.equal(result.previousIP, "1.1.1.1");
    assert.equal(result.currentIP, "2.2.2.2");
    assert.equal(result.ipChanged, true);
});

test("does not claim an IP change when the exit remains the same", async () => {
    const result = await rotateIdentity({
        getRoute: async () => ({ reachable: true, isTor: true, ip: "1.1.1.1" }),
        signalNewnym: async () => {},
        resetConnections: async () => {},
        wait: async () => {}
    });
    assert.equal(result.signalSucceeded, true);
    assert.equal(result.routeVerified, true);
    assert.equal(result.ipChanged, false);
    assert.match(result.message, /manteve o mesmo IP/);
});

test("separates NEWNYM signal success from route verification failure", async () => {
    let calls = 0;
    const result = await rotateIdentity({
        getRoute: async () => {
            calls += 1;
            if (calls === 1) return { reachable: true, isTor: true, ip: "1.1.1.1" };
            throw new Error("route unavailable");
        },
        signalNewnym: async () => {},
        resetConnections: async () => {},
        wait: async () => {}
    });
    assert.equal(result.signalSucceeded, true);
    assert.equal(result.routeVerified, false);
    assert.equal(result.previousIP, "1.1.1.1");
    assert.equal(result.currentIP, null);
    assert.equal(result.ipChanged, null);
    assert.match(result.error, /route unavailable/);
});

test("reports a failed NEWNYM signal without claiming route verification", async () => {
    const result = await rotateIdentity({
        getRoute: async () => ({ reachable: true, isTor: true, ip: "1.1.1.1" }),
        signalNewnym: async () => { throw new Error("control failed"); },
        resetConnections: async () => { throw new Error("must not run"); },
        wait: async () => {}
    });
    assert.equal(result.signalSucceeded, false);
    assert.equal(result.routeVerified, false);
    assert.equal(result.previousIP, "1.1.1.1");
    assert.match(result.error, /control failed/);
});
