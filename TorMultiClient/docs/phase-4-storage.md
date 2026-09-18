# Phase 4 — SQLite storage architecture

## Database ownership

SQLite is now the authoritative domain store. Lyth uses the `node:sqlite`
implementation bundled with Electron and creates `lyth.sqlite3` in Electron's
`userData` directory. Foreign keys, WAL journaling, a busy timeout, transactions,
and numbered schema migrations are enabled by `LythDatabase`.

Schema version 1 contains:

- `groups` and `profiles`
- `profile_identity` for the later identity phase
- `proxy_config`, with `secret_reference` instead of a password field
- `ip_history`, `bookmarks`, and `navigation_history`
- `settings`, `events`, and `schema_migrations`

`WorkspaceStore` owns queries and mutations. Group/profile creation, ID
allocation, updates, and renderer-data imports use transactions. `main.js` keeps
only a refreshed in-memory view used to start runtimes; it no longer writes
`groups.json`.

## Legacy migration

On the first database start, Lyth reads and validates the existing `groups.json`,
copies it byte-for-byte to `groups.pre-sqlite-backup.json` in `userData`, imports
groups and profiles in one transaction, preserves the stored ID counters, and
records the completed import in `settings`. Reopening the application does not
duplicate data. The original JSON file is never modified or removed.

The renderer performs a separate one-time import of durable legacy localStorage
values: overview order, last profile URL, URL history, IP history, and bookmarks.
After the main process accepts the import, those known keys are removed from
localStorage. Subsequent writes go through the validated preload API to SQLite.
Persistent website cookies, storage, and sessions remain in each existing
`persist:account-<id>` Electron partition and are not moved or deleted.

Removing a profile or group deletes its domain metadata and related history from
SQLite after the explicit user action. It deliberately preserves the Chromium
partition and Tor runtime directory. No proxy secrets are currently stored.

## Limitations

The store uses synchronous SQLite calls in the main process. Current operations
are small and bounded, but a later high-volume event store may need a worker or an
asynchronous database boundary. `node:sqlite` emits an experimental warning in
the Node/Electron versions currently bundled with the project. Schema placeholders
for profile identity and proxy configuration do not implement the Phase 5 identity
model or third-party proxy credentials.
