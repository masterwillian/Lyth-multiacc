const fs = require("fs");
const path = require("path");
const { LythDatabase } = require("./database");
const { normalizeWorkspace } = require("../workspace");

function now() { return new Date().toISOString(); }

function validateLegacyWorkspace(stored) {
    if (!stored || typeof stored !== "object" || !Array.isArray(stored.groups)) {
        throw new Error("Legacy groups.json has an invalid workspace shape");
    }
    const groupIds = new Set();
    const profileIds = new Set();
    for (const group of stored.groups) {
        const groupId = Number(group?.id);
        if (!Number.isSafeInteger(groupId) || groupId < 1 || groupIds.has(groupId) || !Array.isArray(group.accounts)) {
            throw new Error("Legacy groups.json contains an invalid or duplicate group");
        }
        groupIds.add(groupId);
        for (const profile of group.accounts) {
            const profileId = Number(profile?.id);
            if (!Number.isSafeInteger(profileId) || profileId < 1 || profileIds.has(profileId)) {
                throw new Error("Legacy groups.json contains an invalid or duplicate profile");
            }
            profileIds.add(profileId);
        }
    }
    return { groupCount: groupIds.size, profileCount: profileIds.size };
}

class WorkspaceStore {
    constructor({ databasePath, legacyPath, backupPath = `${legacyPath}.pre-sqlite-backup` }) {
        this.database = new LythDatabase(databasePath);
        this.db = this.database.db;
        this.legacyPath = legacyPath;
        this.backupPath = backupPath;
        try {
            this.importLegacyWorkspace();
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    getSetting(key, fallback = null) {
        const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
        if (!row) return fallback;
        try { return JSON.parse(row.value_json); } catch { return fallback; }
    }

    setSetting(key, value) {
        this.db.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
            .run(key, JSON.stringify(value), now());
    }

    importLegacyWorkspace() {
        if (this.getSetting("legacy_workspace_imported", false)) return false;
        const existing = Number(this.db.prepare("SELECT COUNT(*) AS count FROM groups").get().count);
        if (existing > 0 || !fs.existsSync(this.legacyPath)) {
            this.setSetting("legacy_workspace_imported", true);
            return false;
        }
        const raw = fs.readFileSync(this.legacyPath, "utf8");
        const parsed = JSON.parse(raw);
        const expected = validateLegacyWorkspace(parsed);
        const workspace = normalizeWorkspace(parsed);
        if (!fs.existsSync(this.backupPath)) fs.copyFileSync(this.legacyPath, this.backupPath);
        this.database.transaction(() => {
            for (const group of workspace.groups) {
                const timestamp = now();
                this.db.prepare("INSERT INTO groups(id,name,tag,note,created_at,updated_at) VALUES (?,?,?,?,?,?)")
                    .run(group.id, String(group.name || `Lote ${group.id}`), String(group.tag || ""), String(group.note || ""), timestamp, timestamp);
                for (const profile of group.accounts || []) {
                    this.db.prepare("INSERT INTO profiles(id,group_id,name,partition,created_at,updated_at) VALUES (?,?,?,?,?,?)")
                        .run(profile.id, group.id, String(profile.name || `Conta ${profile.id}`), `persist:account-${profile.id}`, timestamp, timestamp);
                }
            }
            this.setSetting("next_group_id", workspace.nextGroupId);
            this.setSetting("next_profile_id", workspace.nextAccountId);
            const importedGroups = Number(this.db.prepare("SELECT COUNT(*) AS count FROM groups").get().count);
            const importedProfiles = Number(this.db.prepare("SELECT COUNT(*) AS count FROM profiles").get().count);
            if (importedGroups !== expected.groupCount || importedProfiles !== expected.profileCount) {
                throw new Error("Legacy workspace validation failed after import");
            }
            this.setSetting("legacy_workspace_imported", true);
        });
        return true;
    }

    getWorkspace() {
        const groups = this.db.prepare("SELECT id,name,tag,note FROM groups ORDER BY id").all().map(row => ({
            ...row,
            accounts: this.db.prepare("SELECT id,name FROM profiles WHERE group_id=? ORDER BY id").all(row.id)
        }));
        const maxGroupId = groups.reduce((max, group) => Math.max(max, Number(group.id)), 0);
        const profiles = this.db.prepare("SELECT id FROM profiles").all();
        const maxProfileId = profiles.reduce((max, profile) => Math.max(max, Number(profile.id)), 0);
        return {
            groups,
            nextGroupId: Math.max(Number(this.getSetting("next_group_id", 1)), maxGroupId + 1),
            nextAccountId: Math.max(Number(this.getSetting("next_profile_id", 1)), maxProfileId + 1)
        };
    }

    createGroup({ name, accountCount }) {
        return this.database.transaction(() => {
            const groupId = Number(this.getSetting("next_group_id", 1));
            let nextProfileId = Number(this.getSetting("next_profile_id", 1));
            const timestamp = now();
            this.db.prepare("INSERT INTO groups(id,name,tag,note,created_at,updated_at) VALUES (?,?,?,?,?,?)")
                .run(groupId, name || `Lote ${groupId}`, "", "", timestamp, timestamp);
            const accounts = [];
            for (let index = 0; index < accountCount; index++) {
                const id = nextProfileId++;
                const profile = { id, name: `Conta ${id}` };
                this.db.prepare("INSERT INTO profiles(id,group_id,name,partition,created_at,updated_at) VALUES (?,?,?,?,?,?)")
                    .run(id, groupId, profile.name, `persist:account-${id}`, timestamp, timestamp);
                accounts.push(profile);
            }
            this.setSetting("next_group_id", groupId + 1);
            this.setSetting("next_profile_id", nextProfileId);
            return { id: groupId, name: name || `Lote ${groupId}`, tag: "", note: "", accounts };
        });
    }

    updateGroup({ groupId, name, tag, note }) {
        const result = this.db.prepare("UPDATE groups SET name=?,tag=?,note=?,updated_at=? WHERE id=?")
            .run(name, tag, note, now(), groupId);
        if (!result.changes) throw new Error("Lote não encontrado");
        return this.getWorkspace().groups.find(group => Number(group.id) === groupId);
    }

    deleteGroup(groupId) {
        const profiles = this.db.prepare("SELECT id FROM profiles WHERE group_id=?").all(groupId).map(row => Number(row.id));
        const result = this.db.prepare("DELETE FROM groups WHERE id=?").run(groupId);
        if (!result.changes) throw new Error("Lote não encontrado");
        return profiles;
    }

    addProfile(groupId) {
        return this.database.transaction(() => {
            const group = this.db.prepare("SELECT id,name FROM groups WHERE id=?").get(groupId);
            if (!group) throw new Error("Lote não encontrado");
            const id = Number(this.getSetting("next_profile_id", 1));
            const timestamp = now();
            const name = `Conta ${id}`;
            this.db.prepare("INSERT INTO profiles(id,group_id,name,partition,created_at,updated_at) VALUES (?,?,?,?,?,?)")
                .run(id, groupId, name, `persist:account-${id}`, timestamp, timestamp);
            this.setSetting("next_profile_id", id + 1);
            return { id, name, batchId: groupId, batchName: group.name, partition: `persist:account-${id}` };
        });
    }

    renameProfile(profileId, name) {
        const result = this.db.prepare("UPDATE profiles SET name=?,updated_at=? WHERE id=?").run(name, now(), profileId);
        if (!result.changes) throw new Error("Conta não encontrada");
        return { id: profileId, name };
    }

    removeProfile(profileId) {
        const result = this.db.prepare("DELETE FROM profiles WHERE id=?").run(profileId);
        if (!result.changes) throw new Error("Conta não encontrada");
    }

    hasProfile(profileId) {
        return Boolean(this.db.prepare("SELECT 1 FROM profiles WHERE id=?").get(profileId));
    }

    profileUiData() {
        const result = {};
        for (const profile of this.db.prepare("SELECT id,last_url FROM profiles").all()) {
            const id = Number(profile.id);
            result[id] = {
                lastUrl: profile.last_url,
                bookmarks: this.db.prepare("SELECT url,title,created_at AS date FROM bookmarks WHERE profile_id=? ORDER BY id").all(id),
                urlHistory: this.db.prepare("SELECT url FROM navigation_history WHERE profile_id=? ORDER BY visited_at DESC, id DESC LIMIT 50").all(id).map(row => row.url),
                ipHistory: this.db.prepare("SELECT ip FROM ip_history WHERE profile_id=? ORDER BY observed_at DESC, id DESC LIMIT 50").all(id).map(row => row.ip)
            };
        }
        return result;
    }

    setLastUrl(profileId, url) {
        this.db.prepare("UPDATE profiles SET last_url=?,last_used_at=?,updated_at=? WHERE id=?").run(url, now(), now(), profileId);
    }

    addNavigationHistory(profileId, url) {
        this.database.transaction(() => {
            this.db.prepare("DELETE FROM navigation_history WHERE profile_id=? AND url=?").run(profileId, url);
            this.db.prepare("INSERT INTO navigation_history(profile_id,url,visited_at) VALUES (?,?,?)").run(profileId, url, now());
            this.db.prepare(`DELETE FROM navigation_history WHERE profile_id=? AND id NOT IN
                (SELECT id FROM navigation_history WHERE profile_id=? ORDER BY visited_at DESC LIMIT 50)`).run(profileId, profileId);
        });
    }

    replaceBookmarks(profileId, bookmarks) {
        this.database.transaction(() => {
            this.db.prepare("DELETE FROM bookmarks WHERE profile_id=?").run(profileId);
            const insert = this.db.prepare("INSERT INTO bookmarks(profile_id,url,title,created_at) VALUES (?,?,?,?)");
            for (const bookmark of bookmarks) insert.run(profileId, bookmark.url, bookmark.title, bookmark.date || now());
        });
    }

    addIpHistory(profileId, ip, routeType = "tor") {
        this.database.transaction(() => {
            this.db.prepare("DELETE FROM ip_history WHERE profile_id=? AND ip=?").run(profileId, ip);
            this.db.prepare("INSERT INTO ip_history(profile_id,ip,observed_at,route_type) VALUES (?,?,?,?)").run(profileId, ip, now(), routeType);
            this.db.prepare(`DELETE FROM ip_history WHERE profile_id=? AND id NOT IN
                (SELECT id FROM ip_history WHERE profile_id=? ORDER BY observed_at DESC LIMIT 50)`).run(profileId, profileId);
        });
    }

    importRendererData(payload) {
        if (this.getSetting("legacy_renderer_data_imported", false)) return false;
        this.database.transaction(() => {
            for (const [profileIdText, data] of Object.entries(payload.profiles || {})) {
                const profileId = Number(profileIdText);
                if (!this.hasProfile(profileId)) continue;
                if (data.lastUrl) this.setLastUrl(profileId, data.lastUrl);
                for (const url of [...(data.urlHistory || [])].reverse()) this.addNavigationHistory(profileId, url);
                if (data.bookmarks?.length) this.replaceBookmarks(profileId, data.bookmarks);
                for (const ip of [...(data.ipHistory || [])].reverse()) this.addIpHistory(profileId, ip, "legacy");
            }
            if (payload.overviewOrder?.length) this.setSetting("overview_order", payload.overviewOrder);
            this.setSetting("legacy_renderer_data_imported", true);
        });
        return true;
    }

    close() { this.database.close(); }
}

module.exports = { WorkspaceStore, validateLegacyWorkspace };
