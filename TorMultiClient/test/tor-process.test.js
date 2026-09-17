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
});
