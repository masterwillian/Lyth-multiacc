const test = require("node:test");
const assert = require("node:assert/strict");
const { ProfileRuntimeManager } = require("../src/profile-runtime-manager");

test("keeps one authoritative runtime per profile", async () => {
    let destroyed = 0;
    const manager = new ProfileRuntimeManager(profile => ({
        profile,
        async destroy() { destroyed += 1; },
        async stop() {}
    }));

    const first = manager.ensure({ id: 3, name: "old" });
    const second = manager.ensure({ id: 3, name: "new" });
    assert.equal(first, second);
    assert.equal(second.profile.name, "new");

    await manager.destroy(3);
    assert.equal(manager.get(3), undefined);
    assert.equal(destroyed, 1);
});

test("starts profiles independently and keeps failed runtimes registered", async () => {
    const manager = new ProfileRuntimeManager(profile => ({
        profile,
        async start() {
            if (profile.id === 2) throw new Error("profile 2 failed");
            return this;
        },
        async destroy() {},
        async stop() {},
        snapshot() { return { accountId: profile.id }; }
    }));
    const results = await manager.startAll([{ id: 1 }, { id: 2 }, { id: 3 }]);

    assert.deepEqual(results.map(item => item.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.equal(manager.get(1) !== undefined, true);
    assert.equal(manager.get(2) !== undefined, true);
    assert.equal(manager.get(3) !== undefined, true);
    assert.match(results[1].error.message, /profile 2 failed/);
});

test("stopAll waits for every runtime even when one stop fails", async () => {
    const stopped = [];
    const manager = new ProfileRuntimeManager(profile => ({
        profile,
        async stop() {
            stopped.push(profile.id);
            if (profile.id === 2) throw new Error("stop failed");
        }
    }));
    manager.ensure({ id: 1 });
    manager.ensure({ id: 2 });
    manager.ensure({ id: 3 });

    const results = await manager.stopAll();
    assert.deepEqual(stopped.sort(), [1, 2, 3]);
    assert.equal(results[1].status, "rejected");
});
