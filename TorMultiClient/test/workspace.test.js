const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeWorkspace } = require("../src/workspace");

test("allocates IDs after the highest legacy IDs", () => {
    const workspace = normalizeWorkspace({
        groups: [
            { id: 2, accounts: [{ id: 5 }] },
            { id: 9, accounts: [{ id: 12 }] }
        ]
    });

    assert.equal(workspace.nextGroupId, 10);
    assert.equal(workspace.nextAccountId, 13);
});

test("never moves persisted counters backwards", () => {
    const workspace = normalizeWorkspace({
        groups: [{ id: 2, accounts: [{ id: 5 }] }],
        nextGroupId: 20,
        nextAccountId: 30
    });

    assert.equal(workspace.nextGroupId, 20);
    assert.equal(workspace.nextAccountId, 30);
});
