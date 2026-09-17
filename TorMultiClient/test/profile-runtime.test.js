const test = require("node:test");
const assert = require("node:assert/strict");
const { ProfileRuntime } = require("../src/profile-runtime");
const { RuntimeState } = require("../src/runtime-states");

function profile() {
    return { id: 7, name: "Conta 7", torPort: 9062, controlPort: 9063 };
}

function readyTor() {
    const process = { exitCode: null, killed: false };
    return {
        process,
        ready: Promise.resolve(process),
        stop() { process.killed = true; }
    };
}

test("owns Tor, session, health timer and explicit state transitions", async () => {
    const transitions = [];
    let closed = 0;
    const runtime = new ProfileRuntime(profile(), {
        healthIntervalMs: 60_000,
        launchTor: () => readyTor(),
        createSession: async () => ({ closeAllConnections: async () => { closed += 1; } }),
        checkControlPort: async () => true,
        onStateChange: state => transitions.push(state.state)
    });

    await runtime.start();
    assert.equal(runtime.state, RuntimeState.READY);
    assert.deepEqual(transitions, [RuntimeState.STARTING, RuntimeState.BOOTSTRAPPING, RuntimeState.READY]);

    await runtime.destroy();
    assert.equal(runtime.state, RuntimeState.STOPPED);
    assert.equal(runtime.tor, null);
    assert.equal(runtime.session, null);
    assert.equal(runtime.healthTimer, null);
    assert.equal(closed, 1);
});

test("failed bootstrap kills resources and enters TOR_FAILED", async () => {
    let stopped = false;
    const runtime = new ProfileRuntime(profile(), {
        healthIntervalMs: 60_000,
        launchTor: () => ({
            process: { exitCode: null, killed: false },
            ready: Promise.reject(new Error("bootstrap failed")),
            stop() { stopped = true; }
        }),
        createSession: async () => { throw new Error("must not run"); },
        checkControlPort: async () => true
    });

    await assert.rejects(runtime.start(), /bootstrap failed/);
    assert.equal(runtime.state, RuntimeState.TOR_FAILED);
    assert.equal(runtime.tor, null);
    assert.equal(stopped, true);
});

test("serializes concurrent operations for a profile", async () => {
    const runtime = new ProfileRuntime(profile(), {
        healthIntervalMs: 60_000,
        launchTor: () => readyTor(),
        createSession: async () => ({ closeAllConnections: async () => {} }),
        checkControlPort: async () => true
    });
    await runtime.start();

    let releases;
    const gate = new Promise(resolve => { releases = resolve; });
    const first = runtime.runOperation(async () => { await gate; return "done"; });
    const second = runtime.restart();
    assert.equal(first, second);
    releases();
    assert.equal(await second, "done");
    await runtime.destroy();
});

test("stop terminates Tor even while another operation is running", async () => {
    const tor = readyTor();
    const runtime = new ProfileRuntime(profile(), {
        healthIntervalMs: 60_000,
        launchTor: () => tor,
        createSession: async () => ({ closeAllConnections: async () => {} }),
        checkControlPort: async () => true
    });
    await runtime.start();

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const operation = runtime.runOperation(() => gate);
    const stopping = runtime.stop();
    assert.equal(tor.process.killed, true);
    release();
    await operation;
    await stopping;
    assert.equal(runtime.state, RuntimeState.STOPPED);
});

test("rejects contradictory state transitions", () => {
    const runtime = new ProfileRuntime(profile(), {});
    assert.throws(() => runtime.transition(RuntimeState.READY, "invalid"), /inválida/);
});
