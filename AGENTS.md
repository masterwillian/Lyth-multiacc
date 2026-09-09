# TorMultiClient agent instructions

This repository contains a Windows Electron application that manages isolated
Chromium sessions, each routed through a separate Tor instance.

## Start every substantial task

1. Read `README.md`, `CHANGELOG.md`, and the relevant files under
   `TorMultiClient/`.
2. Read `docs/MEMORY_PROTOCOL.md`.
3. If the local `.memory/` bridge exists, read `.memory/INDEX.md`,
   `.memory/CURRENT_STATE.md`, `.memory/DECISIONS.md`, and
   `.memory/KNOWN_ISSUES.md` before planning changes.
4. Inspect `git status` and preserve unrelated user changes.

## Team workflow

- For complex bugs or changes that can be divided independently, use the root
  agent as coordinator and delegate bounded investigations to subagents.
- Good read-only lanes are architecture/flow tracing, tests/reproduction, and
  security/privacy review.
- Assign one writer for each file or module. Other agents must remain read-only
  on that area until the writer finishes.
- After implementation, use an independent reviewer for meaningful changes.
- Do not delegate trivial documentation edits or tightly coupled work where
  coordination would cost more than it saves.

## Project constraints

- Keep every account's Tor process, SOCKS port, ControlPort, data directory, and
  Electron partition isolated.
- Never weaken proxy isolation, cookie separation, ControlPort authentication,
  or intentional shutdown handling.
- Treat claims about anonymity, DNS, WebRTC, fingerprinting, and IP rotation as
  security claims requiring direct evidence.
- Never commit runtime Tor state, cookies, credentials, logs, account data, or
  Obsidian personal notes.
- Keep navigation persistence compatible with HTTP/HTTPS URLs and prevent
  internal pages such as `about:blank` from replacing a saved user URL.

## Validation

- Install dependencies in `TorMultiClient/` with `npm install` when needed.
- Run automated checks with `npm test` from `TorMultiClient/`.
- For navigation, proxy, Tor bootstrap, or Electron lifecycle changes, also
  document the relevant manual verification.
- Do not broaden testing after relevant checks pass unless failures or unresolved
  risks justify it.

## Completion

- Update `CHANGELOG.md` for user-visible behavior changes.
- Update relevant project documentation when behavior or architecture changes.
- Update the local Obsidian memory through `.memory/` when it exists, following
  `docs/MEMORY_PROTOCOL.md`.
- A task is complete only when implementation, relevant validation, and durable
  notes agree.
