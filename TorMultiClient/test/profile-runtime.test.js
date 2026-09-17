const test = require("node:test");
const assert = require("node:assert/strict");
const { ProfileRuntime } = require("../src/profile-runtime");
const { RuntimeState } = require("../src/runtime-states");

function profile(id = 7) {
    return { id, name: `Conta ${id}`, torPort: 9062, controlPort: 9063 };
}

function readyTor() {
    const process = { exitCode: null, killed: false };
    return {
        process,
        ready: Promise.resolve(process),
        stop() { process.killed = true; }
    };
}

function dependencies(overrides = {}) {
    const timers = new Set();
    const deps = {
        healthIntervalMs: 15_000,
        externalHealthIntervalMs: 300_000,
        restartBackoffBaseMs: 0,
        restartBackoffMaxMs: 0,
        setIntervalFn(callback) {
            const timer = { callback };
            timers.add(timer);
            return timer;
        },
        clearIntervalFn(timer) { timers.delete(timer); },
        launchTor: () => readyTor(),
        createSession: async () => ({ closeAllConnections: async () => {} }),
        checkControlPort: async () => true,
        checkSocksPort: async () => true,
        inspectSessionProxy: async (_session, currentProfile) => ({
            configured: true,
            expected: `socks5://127.0.0.1:${currentProfile.torPort}`,
            actual: `SOCKS5 127.0.0.1:${currentProfile.torPort}`
        }),
        verifyExternalRoute: async () => ({ reachable: true, isTor: true, ip: "185.1.1.1" }),
        ...overrides
    };
    return { deps, timers };
}

test("owns a serializable eight-layer health snapshot", async () => {
    const { deps, timers } = dependencies();
    let closed = 0;
    deps.createSession = async () => ({ closeAllConnections: async () => { closed += 1; } });
    const runtime = new ProfileRuntime(profile(), deps);

    await runtime.start();
    const snapshot = runtime.snapshot();
    assert.equal(snapshot.state, RuntimeState.READY);
    assert.equal(snapshot.health.process.alive, true);
    assert.equal(snapshot.health.bootstrap.complete, true);
    assert.equal(snapshot.health.controlPort.available, true);
    assert.equal(snapshot.health.socks.available, true);
    assert.equal(snapshot.health.session.available, true);
    assert.equal(snapshot.health.proxy.configured, true);
    assert.equal(snapshot.health.route.reachable, true);
    assert.equal(snapshot.health.torRoute.recognized, true);
    assert.doesNotThrow(() => JSON.stringify(snapshot));
    assert.equal(timers.size, 1);

    await runtime.destroy();
    assert.equal(runtime.state, RuntimeState.STOPPED);
    assert.equal(runtime.tor, null);
    assert.equal(runtime.session, null);
    assert.equal(timers.size, 0);
    assert.equal(closed, 1);
});

test("keeps a failed bootstrap recoverable and fail-closed session attached", async () => {
    const { deps, timers } = dependencies({
        launchTor: () => ({
            process: { exitCode: null, killed: false },
            ready: Promise.reject(new Error("bootstrap failed")),
            stop() {}
        })
    });
    const runtime = new ProfileRuntime(profile(), deps);

    await assert.rejects(runtime.start(), /bootstrap failed/);
    assert.equal(runtime.state, RuntimeState.TOR_FAILED);
    assert.equal(runtime.session !== null, true);
    assert.equal(runtime.health.proxy.configured, true);
    assert.equal(timers.size, 1);
    await runtime.destroy();
    assert.equal(timers.size, 0);
});

test("marks route failures without losing healthy internal layers", async () => {
    const { deps } = dependencies({
        verifyExternalRoute: async () => { throw new Error("route endpoint unavailable"); }
    });
    const runtime = new ProfileRuntime(profile(), deps);
    await runtime.start();

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.state, RuntimeState.ROUTE_FAILED);
    assert.equal(snapshot.health.process.alive, true);
    assert.equal(snapshot.health.socks.available, true);
    assert.equal(snapshot.health.route.reachable, false);
    assert.equal(snapshot.health.torRoute.recognized, null);
    await runtime.destroy();
});

test("does not spam external route verification", async () => {
    let now = 10_000;
    let routeChecks = 0;
    const { deps } = dependencies({
        now: () => now,
        externalHealthIntervalMs: 300_000,
        verifyExternalRoute: async () => {
            routeChecks += 1;
            return { reachable: true, isTor: true, ip: "185.1.1.1" };
        }
    });
    const runtime = new ProfileRuntime(profile(), deps);
    await runtime.start();
    assert.equal(routeChecks, 1);

    await runtime.verifyExternalRoute({ reason: "periodic" });
    assert.equal(routeChecks, 1);
    now += 300_001;
    await runtime.verifyExternalRoute({ reason: "periodic" });
    assert.equal(routeChecks, 2);
    await runtime.destroy();
});

test("recovers after repeated cheap-check failure without restart storms", async () => {
    const torHandles = [readyTor(), readyTor()];
    let launches = 0;
    const { deps } = dependencies({ launchTor: () => torHandles[launches++] });
    const runtime = new ProfileRuntime(profile(), deps);
    await runtime.start();
    torHandles[0].process.exitCode = 1;

    await runtime._checkHealth();
    assert.equal(launches, 1);
    assert.equal(runtime.state, RuntimeState.DEGRADED);
    await runtime._checkHealth();
    assert.equal(launches, 2);
    assert.equal(runtime.state, RuntimeState.READY);
    await runtime.destroy();
});

test("coalesces identical starts but rejects conflicting operations", async () => {
    let releaseStart;
    const startGate = new Promise(resolve => { releaseStart = resolve; });
    const tor = readyTor();
    tor.ready = startGate.then(() => tor.process);
    const { deps } = dependencies({ launchTor: () => tor });
    const runtime = new ProfileRuntime(profile(), deps);

    const first = runtime.start();
    const second = runtime.start();
    assert.equal(first, second);
    await assert.rejects(runtime.runOperation("newnym", async () => {}), /Operação conflitante/);
    releaseStart();
    await first;
    await runtime.destroy();
});

test("stop terminates Tor and clears resources during another operation", async () => {
    const tor = readyTor();
    const { deps, timers } = dependencies({ launchTor: () => tor });
    const runtime = new ProfileRuntime(profile(), deps);
    await runtime.start();

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const operation = runtime.runOperation("newnym", () => gate);
    const stopping = runtime.stop();
    assert.equal(tor.process.killed, true);
    release();
    await operation;
    await stopping;
    assert.equal(runtime.state, RuntimeState.STOPPED);
    assert.equal(timers.size, 0);
});

test("start, stop and destroy are idempotent", async () => {
    let launches = 0;
    const { deps } = dependencies({ launchTor: () => { launches += 1; return readyTor(); } });
    const runtime = new ProfileRuntime(profile(), deps);
    await runtime.start();
    await runtime.start();
    assert.equal(launches, 1);
    await runtime.stop();
    await runtime.stop();
    await runtime.destroy();
    await runtime.destroy();
    assert.equal(runtime.state, RuntimeState.STOPPED);
});

test("rejects contradictory state transitions", () => {
    const runtime = new ProfileRuntime(profile(), dependencies().deps);
    assert.throws(() => runtime.transition(RuntimeState.READY, "invalid"), /inválida/);
});
