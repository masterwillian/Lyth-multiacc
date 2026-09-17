# Phase 2 — profile runtime

## Ownership

`ProfileRuntimeManager` contains exactly one `ProfileRuntime` for each active
profile. A runtime owns the profile's Tor child handle, persistent Electron
session, health timer, state, retry count, and in-flight operation. `main.js` no
longer mirrors those resources in independent maps.

The lifecycle is:

`STOPPED -> STARTING -> BOOTSTRAPPING -> READY`

Failures and recovery use explicit `TOR_FAILED`, `PROXY_FAILED`, `DEGRADED`,
`ROUTE_FAILED`, `LEAK_DETECTED`, `RECOVERING`, and `ERROR` states. Invalid state
transitions throw instead of silently producing contradictory status.

Each transition emits a renderer-compatible status and a structured log record
containing `state` and `previousState`.

## Operations and cleanup

Start, restart, stop, destroy, and NEWNYM are serialized per profile. Concurrent
recovery attempts reuse the current operation. A failed Tor bootstrap kills its
child process; a failed proxy setup also tears down the Tor handle. Destroying a
runtime clears its health timer, stops Tor, closes session connections, and removes
the runtime from the manager.

Group creation now behaves transactionally at runtime level: if any new profile
fails to start, every runtime created for that group is destroyed and the group is
removed from workspace persistence.

Persistent Chromium partitions and Tor data directories are deliberately not
deleted by runtime cleanup. Removing a profile continues to preserve browser and
Tor profile data until explicit destructive profile-data operations are added.

## Boundaries

The manager currently starts every configured profile during application boot.
The runtime API makes later cold, warm, and active lifecycle levels possible, but
lazy activation is deferred. Layered SOCKS, route, and browser health scheduling
also remains a later phase; Phase 2 retains the existing ControlPort health cadence
while preventing overlapping checks and recovery operations.
