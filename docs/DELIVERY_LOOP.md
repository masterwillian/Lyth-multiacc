# Goal Mode delivery loop

This protocol standardizes long-running Codex work for TorMultiClient. Use it
with Goal Mode when a task is larger than one normal turn and has a verifiable
end state. Do not use Goal Mode for unrelated backlogs, trivial edits, or tasks
whose next step depends primarily on a user decision.

## 1. Goal contract

Before implementation, write a single goal containing all of the following:

- **Outcome:** the observable result to deliver.
- **Scope:** files, components, and systems that may change.
- **Non-goals:** behavior and areas that must remain unchanged.
- **Acceptance criteria:** individually verifiable requirements.
- **Evidence:** commands, tests, artifacts, logs, or manual checks that prove the
  criteria.
- **Stop condition:** the exact state that means the goal is complete.
- **Pause conditions:** missing authority, external dependency, destructive
  choice, or a repeated blocker that requires user input.

If any required item is missing, investigate what can be established from the
repository and memory before asking the user a focused question.

## 2. Team allocation

The environment supports four active agents including the root coordinator. Use
staged waves so implementation and review remain independent.

### Investigation wave

- **Root coordinator:** owns scope, acceptance criteria, integration, and the
  final completion decision.
- **Architecture investigator:** traces the relevant flow and identifies the
  smallest safe change.
- **Test investigator:** reproduces the problem and designs meaningful checks.
- **Risk investigator:** examines Tor isolation, privacy, persistence, lifecycle,
  and regression risks relevant to the goal.

Investigators are read-only unless the coordinator explicitly assigns a bounded
file set. Their reports must cite concrete evidence.

### Delivery wave

- Assign one implementer per file or module.
- Never allow concurrent edits to the same files.
- After implementation, assign an agent that did not author the main change to
  perform adversarial review.
- The coordinator resolves review findings and runs the final gate.

## 3. Baseline

Before the first change:

1. read `AGENTS.md` and the persistent memory protocol;
2. inspect `git status` and preserve unrelated user work;
3. record the current commit and application version;
4. run the smallest relevant baseline/verification command on the unchanged
   baseline;
5. record existing failures separately so the goal does not claim to have caused
   or fixed them without evidence.

## 4. Improvement cycle

Repeat this sequence while at least one acceptance criterion remains unmet:

1. **Observe:** inspect current failures, scores, artifacts, and reviewer notes.
2. **Prioritize:** select the largest verified bottleneck.
3. **Hypothesize:** state why one focused change should improve it.
4. **Change:** implement the smallest coherent adjustment.
5. **Evaluate:** run deterministic checks first, then any necessary manual or
   rubric-based review.
6. **Compare:** state whether the result improved, regressed, or remained
   inconclusive relative to the best known checkpoint.
7. **Review:** inspect the diff and ask an independent reviewer to challenge
   meaningful changes.
8. **Checkpoint:** record evidence, open risks, and the next action in the goal
   log. Commit only coherent, validated checkpoints.

Change one causal idea at a time when practical. If multiple unrelated changes
are bundled together, split them before evaluation so results remain explainable.

## 5. Evaluation order

Use the strongest available evidence in this order:

1. deterministic unit and integration tests;
2. build, syntax, schema, lint, and static-analysis checks;
3. reproducible runtime observations and structured logs;
4. direct inspection of the generated application or artifact;
5. independent rubric-based agent review;
6. unsupported opinion.

An agent review supplements tests; it does not replace deterministic evidence.
Tests that merely mirror the implementation are not sufficient proof.

For this repository, the default automated gate is:

```powershell
cd D:\gpt\will\TorMultiClient
npm test
```

Navigation, proxy, bootstrap, Electron lifecycle, DNS, WebRTC, and
fingerprinting changes also require relevant manual or integration evidence.

## 6. Adversarial review

The reviewer must try to reject the change. At minimum, check for:

- lost or corrupted persistent data;
- incorrect Tor account, port, process, or partition isolation;
- proxy bypass, DNS/WebRTC leakage, or overstated anonymity claims;
- races during startup, shutdown, restart, and New Identity;
- `about:blank` or internal URLs overwriting valid navigation state;
- tests that pass without exercising the claimed behavior;
- unrelated refactors, duplicated logic, or missing rollback paths.

Every finding must include severity, evidence, affected file or behavior, and a
reproduction or concrete failure scenario. Resolve critical and high findings
before completion. Document accepted lower-severity residual risks.

## 7. Goal log

When `.memory/` exists, create `.memory/Goals/<goal-slug>.md` from the Obsidian
`Goal Run` template. After every meaningful checkpoint, record:

- timestamp and current commit;
- acceptance criteria status;
- change attempted and hypothesis;
- commands executed and exact outcome;
- reviewer findings;
- best known checkpoint;
- next action or blocker.

Keep the log concise and evidence-based. Never store credentials, cookies,
account content, Tor identity data, or raw unredacted logs.

## 8. Completion gate

Declare the goal complete only when all statements are true:

- every acceptance criterion has direct evidence;
- relevant automated checks pass, or pre-existing failures are explicitly
  isolated and shown to be unrelated;
- required manual or artifact checks are complete;
- no unresolved critical or high review finding remains;
- the final diff contains no unintended changes;
- `CHANGELOG.md` and relevant repository documentation are current;
- Obsidian current state, decisions, known issues, roadmap, and goal log agree
  with the delivered result;
- the working tree and remote state match the requested delivery method.

## 9. Pause and failure rules

Pause and request user direction when completion requires new authority, a
destructive choice, credentials, external coordination, or a material expansion
of scope. Do not silently choose among product decisions with meaningfully
different outcomes.

If the same blocker survives three consecutive attempts or resumed goal turns,
record the attempts and evidence, mark the goal blocked, and ask one focused
question. Difficulty, uncertainty, or an imperfect intermediate result alone do
not justify stopping while safe progress remains possible.

## 10. Standard goal prompt

Use this structure when starting Goal Mode:

```text
/goal Complete <one concrete outcome> without stopping until <verifiable end state>.

Read AGENTS.md, docs/DELIVERY_LOOP.md, docs/MEMORY_PROTOCOL.md, and the project
memory before changing files.

Scope:
- <allowed components>

Non-goals:
- <behavior that must not change>

Acceptance criteria:
- [ ] <criterion with objective evidence>
- [ ] <criterion with objective evidence>

Validation:
- <command or artifact>

Use staged agent waves for independent investigation, implementation, and
adversarial review. Keep one writer per file. Log every meaningful checkpoint in
.memory/Goals/<goal-slug>.md. Stop only when the completion gate passes or a
documented pause condition requires user direction.
```
