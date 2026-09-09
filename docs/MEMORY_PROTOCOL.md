# Persistent memory protocol

The project uses an external Obsidian vault as human-readable, durable memory.
The local `.memory/` directory is a junction to the project's folder inside that
vault and is intentionally ignored by Git.

## Read order

At the start of a substantial task, read:

1. `.memory/INDEX.md`
2. `.memory/CURRENT_STATE.md`
3. `.memory/DECISIONS.md`
4. `.memory/KNOWN_ISSUES.md`
5. the most recent relevant entry in `.memory/Sessions/`

If `.memory/` is absent, continue using repository documentation. The external
memory must never be required to build, test, or run the application.

## Write rules

At the end of meaningful work:

- update `CURRENT_STATE.md` with verified present-tense facts;
- record durable architectural choices in `DECISIONS.md`;
- add or close actionable problems in `KNOWN_ISSUES.md`;
- update `ROADMAP.md` only when priorities change;
- create a short session note containing outcome, evidence, tests, commit, and
  next step.

Do not copy raw chat transcripts. Summarize only information that will matter in
a future task.

## Source of truth

When information conflicts, use this order:

1. code and runtime configuration;
2. reproducible test results;
3. recorded decisions;
4. current-state notes;
5. historical session notes.

Correct stale memory when evidence changes. Date uncertain or time-sensitive
claims and label assumptions explicitly.

## Privacy

Never store passwords, API keys, OAuth tokens, cookies, SSH keys, personal
account content, browser session data, Tor identity data, or unredacted logs in
the vault.

