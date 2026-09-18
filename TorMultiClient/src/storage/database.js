const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS = [{
    version: 1,
    sql: `
CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, name TEXT NOT NULL, partition TEXT NOT NULL UNIQUE, last_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE profile_identity (profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, identity_json TEXT, fingerprint_seed TEXT, updated_at TEXT NOT NULL);
CREATE TABLE proxy_config (profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, type TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT, secret_reference TEXT, updated_at TEXT NOT NULL);
CREATE TABLE ip_history (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, ip TEXT NOT NULL, observed_at TEXT NOT NULL, route_type TEXT NOT NULL, UNIQUE(profile_id, ip));
CREATE TABLE bookmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(profile_id, url));
CREATE TABLE navigation_history (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, url TEXT NOT NULL, visited_at TEXT NOT NULL, UNIQUE(profile_id, url));
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, level TEXT NOT NULL, component TEXT NOT NULL, profile_id INTEGER, group_id INTEGER, event TEXT NOT NULL, state TEXT, previous_state TEXT, error_code TEXT, message TEXT NOT NULL);
CREATE INDEX profiles_group_idx ON profiles(group_id);
CREATE INDEX ip_history_profile_idx ON ip_history(profile_id, observed_at DESC);
CREATE INDEX navigation_history_profile_idx ON navigation_history(profile_id, visited_at DESC);
`
}];

class LythDatabase {
    constructor(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.file = file;
        this.db = new DatabaseSync(file);
        this.transactionDepth = 0;
        this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
        this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
        this.migrate();
    }

    migrate() {
        const applied = new Set(this.db.prepare("SELECT version FROM schema_migrations").all().map(row => Number(row.version)));
        for (const migration of MIGRATIONS) {
            if (applied.has(migration.version)) continue;
            this.transaction(() => {
                this.db.exec(migration.sql);
                this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
                    .run(migration.version, new Date().toISOString());
            });
        }
    }

    transaction(action) {
        const nested = this.transactionDepth > 0;
        const savepoint = `lyth_nested_${this.transactionDepth}`;
        this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
        this.transactionDepth++;
        try {
            const result = action();
            this.transactionDepth--;
            this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
            return result;
        } catch (error) {
            this.transactionDepth--;
            this.db.exec(nested
                ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`
                : "ROLLBACK");
            throw error;
        }
    }

    close() { this.db.close(); }
}

module.exports = { LythDatabase, MIGRATIONS };
