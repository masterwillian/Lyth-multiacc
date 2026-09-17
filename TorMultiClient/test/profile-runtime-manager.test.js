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
