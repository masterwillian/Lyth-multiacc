# Phase 3 — Electron security hardening

## Privileged shell

The Lyth window runs with `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. Its preload exposes `window.lyth`, a frozen API grouped into
application, workspace, profile, Tor, health, and storage operations.
It does not expose `ipcRenderer` or a generic invoke primitive.

Every IPC call verifies that it came from the current Lyth window at the exact
local `index.html` URL. IDs, counts, strings, booleans, URLs, bookmarks, IPs, and
collection sizes are validated in the main process. Invalid or unauthorized
requests are rejected with a validation error.

The shell has a Content Security Policy. It loads scripts only from the local
application, does not make shell network connections, and no longer loads Google
Fonts. Inline CSS remains allowed because the current UI is still a single HTML
file with inline and dynamically assigned styles.

## Browser surfaces

Lyth still uses Electron `<webview>` in this phase. A `will-attach-webview`
policy accepts only `persist:account-<id>` partitions that exist in the SQLite
profile registry and only HTTP, HTTPS, or the initial `about:blank` URL. It
removes a supplied preload and forces Node integration off, context isolation
on, sandbox on, web security on, and mixed-content execution off.

The Lyth shell cannot navigate away from its entry point and cannot open popup
windows. Attached browser guests may navigate over HTTP(S), but unsafe schemes
and all popup requests are denied. `allowpopups` is not used. Session permission
requests are denied by default for both the shell and profile sessions.

Bookmark rendering now uses DOM nodes and event listeners. Stored URLs are no
longer interpolated into executable inline HTML.

## Scope and limitations

This phase hardens the existing webview architecture; it does not migrate to
`WebContentsView`. Denying all site permissions means sites cannot use camera,
microphone, geolocation, notifications, or other Electron permission-gated APIs.
A future permission UI can add explicit per-profile grants. The CSP still needs
`style-src 'unsafe-inline'` until styles are extracted from the current UI.

These controls isolate the application shell and restrict Electron capabilities.
They do not make remote sites trusted and do not claim fingerprint anonymity.
