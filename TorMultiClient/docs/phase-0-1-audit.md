# Phase 0–1 audit

## Current architecture

The Electron main process owns workspace JSON persistence, one persistent Electron
partition per account, one Tor child process per active account, health timers,
route verification, and Tor ControlPort operations. The renderer owns the visual
workspace and keeps URL history, bookmarks, IP history, and overview ordering in
`localStorage`. The preload exposes a narrow operation-oriented IPC bridge.

The active route is:

`account -> persist:account-<id> session -> SOCKS5 port -> Tor process`

Account IDs currently determine SOCKS and ControlPort pairs. Tor runtime data is
kept under `tor/instance<id>/data`. Removing an account only removes it from the
workspace; its persistent Chromium and Tor data are preserved.

## Phase 1 changes

- Removed the fake DoH request header. DNS continues to follow Chromium's SOCKS
  proxy behavior.
- Removed periodic cookie deletion so persistent partitions remain persistent.
- Removed random cross-browser user agents and the unused random fingerprint
  script. Electron now uses its actual Chromium-compatible identity.
- Removed the custom domain blocker because it blocked complete services such as
  Facebook, Vimeo, and Yahoo. A filter-list implementation can be introduced as
  a separate subsystem later.
- Made the per-account process map authoritative, killed failed bootstrap
  processes, handled spawn failures, serialized recovery, and cleaned process
  references on exit.
- Added deterministic cleanup for renderer timers and per-account keyboard
  listeners.
- Bounded global and per-account logs to two 5 MiB files each.
- Made `package.json` the version source and switched first-run installation to
  `npm ci`.

## Security findings for Phase 3

The application shell already uses `contextIsolation: true` and
`nodeIntegration: false`, but still enables `webviewTag` and disables the
renderer sandbox. The next security phase should validate every
`will-attach-webview` event, restrict partitions to known profiles, remove unsafe
web preferences, enforce shell navigation and window-open policies, validate IPC
senders and payloads, and then test enabling `sandbox: true`.

The renderer also builds bookmark menus with inline HTML handlers and interpolated
stored URLs. That should be replaced with DOM nodes and event listeners before a
strict Content Security Policy is enabled. Migrating browser surfaces behind a
manager remains a prerequisite for a later `WebContentsView` migration.

## Deferred phases

SQLite migration, persistent profile identity, a full runtime state machine,
layered route health checks, explicit profile-data maintenance, browser-engine
abstraction, and broader integration tests remain intentionally deferred until
this stabilization phase has been exercised on Windows.

Bundled Tor reports version 0.4.9.11. Its executable and pluggable transports were
not modified during this phase.
