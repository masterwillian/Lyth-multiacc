const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { launchTorProcess } = require("../src/tor-process");

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    return child;
}

test("kills the Tor child when bootstrap fails", async () => {
    const child = fakeChild();
    const handle = launchTorProcess(
        { torPort: 9100, torrcFile: "C:\\runtime\\torrc" },
        {
            torExecutable: "tor.exe",
            bootstrapTimeoutMs: 1_000,
            spawnProcess: () => child
        }
    );

    child.stderr.emit("data", Buffer.from("[warn] Could not bind to 127.0.0.1:9100"));
    await assert.rejects(handle.ready, /Could not bind/);
    assert.equal(child.killed, true);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.listenerCount("error"), 0);
});

test("stop is idempotent and rejects an interrupted bootstrap", async () => {
    const child = fakeChild();
    let kills = 0;
    child.kill = () => { child.killed = true; kills += 1; };
    const handle = launchTorProcess(
        { torPort: 9100, torrcFile: "C:\\runtime\\torrc" },
        { torExecutable: "tor.exe", spawnProcess: () => child }
    );

    handle.stop();
    handle.stop();
    await assert.rejects(handle.ready, /interrompida/);
    assert.equal(kills, 1);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
});
