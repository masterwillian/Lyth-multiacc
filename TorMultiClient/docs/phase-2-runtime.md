# Phase 2 — profile runtime

## Ownership

`ProfileRuntimeManager` is the authoritative registry and contains exactly one
`ProfileRuntime` for each configured profile. A runtime owns its Tor child handle,
persistent Electron session reference, health timer, retry/backoff data, current
operation, state, and structured health snapshot. `main.js` does not mirror these
resources in independent maps.

The normal lifecycle is:

`STOPPED -> STARTING -> BOOTSTRAPPING -> READY`

Failures use `DEGRADED`, `TOR_FAILED`, `PROXY_FAILED`, `ROUTE_FAILED`,
`LEAK_DETECTED`, and `ERROR`; recovery uses `RECOVERING`. Invalid transitions
throw. State transitions are sent to the renderer and written to the structured
profile log with `state` and `previousState`.

## Layered health snapshot

`runtime.snapshot().health` is serializable and reports these separate layers:

1. `process`: whether the owned Tor child is alive.
2. `bootstrap`: completion, percentage, and last observation.
3. `controlPort`: TCP availability on the expected loopback ControlPort.
4. `socks`: TCP availability on the expected loopback SOCKS port.
5. `session`: whether the runtime owns an Electron Session.
6. `proxy`: expected proxy, effective `session.resolveProxy()` result, and whether
   they match.
7. `route`: reachability, public IP, reason, timestamp, and error from a request
   made by the actual Electron Session.
8. `torRoute`: whether the Tor Project endpoint recognized that route as Tor.

Process, ports, session, and proxy are checked every 15 seconds. The external
route is checked on startup, recovery, NEWNYM, explicit user refresh, and at most
once every five minutes during ordinary monitoring. Overlapping health checks are
suppressed.

## Fail-closed routing

A persistent partition is put offline before proxy configuration. It returns
online only after Electron accepts the fixed SOCKS proxy and existing connections
are closed. If proxy setup fails, the partition remains offline. If Tor later
fails, Chromium retains the fixed proxy and receives a proxy error instead of a
silent direct fallback.

The runtime checks the effective proxy with `session.resolveProxy()` and marks a
mismatch as `PROXY_FAILED`. External verification distinguishes an unreachable
route (`ROUTE_FAILED`) from a reachable route that is not recognized as Tor
(`LEAK_DETECTED`). These checks describe the HTTP route; they do not claim complete
DNS, WebRTC, or fingerprint anonymity.

## Operations, recovery, and cleanup

Start calls for the same profile coalesce. Conflicting operations such as NEWNYM
and restart are rejected rather than sharing an unrelated result. Stop interrupts
Tor immediately and then waits for the current operation before closing session
connections. Start, stop, and destroy are idempotent.

Internal failures must be observed twice before automatic restart. Failed starts
remain registered and keep a health timer, so they are visible and recoverable.
Recovery uses exponential backoff from five seconds up to five minutes. A
successful recovery resets the backoff and forces external route verification.

Tor bootstrap failure and timeout kill the child. Stop removes Tor stream/process
listeners, clears bootstrap timeouts and health timers, closes Electron session
connections, and releases runtime references. Application shutdown intercepts
`before-quit`, awaits `stopAll()`, and only then allows Electron to exit.

Runtime removal preserves the persistent Chromium partition and Tor data
directory. Destructive profile-data operations remain explicit future work.

## Partial startup and NEWNYM

Profiles start independently. One broken existing profile does not close the app
or stop healthy profiles. New groups and newly added profiles remain persisted if
one runtime fails; the failed runtime stays registered and exposes its failure to
the existing status UI.

NEWNYM is serialized with other profile operations. Its result separately reports:

- `signalSucceeded`
- `routeVerified`
- `previousIP`
- `currentIP` / compatibility alias `newIP`
- `ipChanged` / compatibility alias `changed`
- `isTor`, `error`, and a user-facing `message`

A successful signal does not promise a changed exit IP. Route verification after
the signal is retried through the Electron Session and can fail independently.

## Tests and remaining limitations

Deterministic tests cover layered snapshots, external-check throttling, route
failure, automatic recovery, operation conflicts, idempotency, partial startup,
fail-closed proxy order, NEWNYM result semantics, listener/timer cleanup, and
manager-wide shutdown.

The runtime still starts every profile during application boot; cold/warm/active
lazy activation is future performance work. Port allocation remains derived from
profile IDs and only runtime bind errors detect conflicts. External health relies
on the Tor Project check endpoint, so an endpoint outage produces `ROUTE_FAILED`
without claiming a direct leak. Electron partitions and Tor data are intentionally
preserved after ordinary profile removal.
