const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WorkspaceStore } = require("../src/storage/workspace-store");

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lyth-storage-"));
    const legacyPath = path.join(directory, "groups.json");
    const backupPath = path.join(directory, "groups.backup.json");
    const databasePath = path.join(directory, "lyth.sqlite3");
    const legacy = {
        groups: [{ id: 4, name: "Existing", tag: "x", accounts: [{ id: 9, name: "Profile" }] }],
        nextGroupId: 8,
        nextAccountId: 15
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    return { directory, legacyPath, backupPath, databasePath, legacy };
}

test("migrates legacy JSON once, preserves it and creates an exact backup", () => {
    const files = fixture();
    const original = fs.readFileSync(files.legacyPath, "utf8");
    const store = new WorkspaceStore(files);
    const workspace = store.getWorkspace();
    assert.equal(workspace.groups[0].accounts[0].id, 9);
    assert.equal(workspace.nextGroupId, 8);
    assert.equal(workspace.nextAccountId, 15);
    assert.equal(fs.readFileSync(files.legacyPath, "utf8"), original);
    assert.equal(fs.readFileSync(files.backupPath, "utf8"), original);
    store.close();

    const reopened = new WorkspaceStore(files);
    assert.equal(reopened.getWorkspace().groups.length, 1);
    reopened.close();
});

test("rejects malformed legacy data before creating a migration backup", () => {
    const files = fixture();
    fs.writeFileSync(files.legacyPath, JSON.stringify({
        groups: [{ id: 1, accounts: [{ id: 2 }, { id: 2 }] }]
    }));
    assert.throws(() => new WorkspaceStore(files), /duplicate profile/);
    assert.equal(fs.existsSync(files.backupPath), false);
});

test("persists transactional group and profile operations", () => {
    const files = fixture();
    const store = new WorkspaceStore(files);
    const group = store.createGroup({ name: "New", accountCount: 2 });
    assert.equal(group.id, 8);
    assert.deepEqual(group.accounts.map(profile => profile.id), [15, 16]);
    const added = store.addProfile(group.id);
    store.renameProfile(added.id, "Renamed");
    store.updateGroup({ groupId: group.id, name: "Changed", tag: "tag", note: "note" });
    assert.equal(store.getWorkspace().groups.find(item => item.id === group.id).accounts.at(-1).name, "Renamed");
    store.removeProfile(added.id);
    assert.equal(store.deleteGroup(group.id).length, 2);
    store.close();
});

test("imports renderer durable data once and stores it in profile tables", () => {
    const files = fixture();
    const store = new WorkspaceStore(files);
    assert.equal(store.importRendererData({
        overviewOrder: [9],
        profiles: { 9: {
            lastUrl: "https://example.com/",
            urlHistory: ["https://example.com/new", "https://example.com/old"],
            ipHistory: ["1.1.1.1", "2.2.2.2"],
            bookmarks: [{ url: "https://example.com/", title: "Example", date: "2024-01-01T00:00:00.000Z" }]
        } }
    }), true);
    assert.equal(store.importRendererData({ overviewOrder: [], profiles: {} }), false);
    const ui = store.profileUiData()[9];
    assert.equal(ui.lastUrl, "https://example.com/");
    assert.deepEqual(ui.urlHistory, ["https://example.com/new", "https://example.com/old"]);
    assert.deepEqual(ui.ipHistory, ["1.1.1.1", "2.2.2.2"]);
    assert.equal(ui.bookmarks[0].title, "Example");
    assert.deepEqual(store.getSetting("overview_order"), [9]);
    store.close();
});
