# Subagent thinking settings

## Basis

The operator requested separate subagent thinking settings in user `settings.json`, with unset values inheriting the parent's effective thinking settings. The TUI must not change. This includes a parent's per-turn thinking override when a subagent is spawned during that turn.

## Behavior

- Accept optional user-layer `subagent.thinking` (`off` or `adaptive`) and `subagent.thinkingEffort` (`low`, `medium`, `high`, `xhigh`, `max`). Reject invalid field values by dropping those fields, matching the existing settings parser. Project settings cannot override either field.
- At spawn or continuation time, carry the parent's effective thinking mode and effort through the existing executor wrapper chain, tool execution context, and worker envelope. Do not add model-facing tool arguments.
- In the worker, use each explicit subagent field first. If neither field is set, inherit the parent's effective mode and effort. If only effort is set, enable adaptive thinking; if only mode is set, inherit the parent's effort. An explicit `off` mode suppresses effort on the wire.
- A legacy or direct worker envelope without parent thinking falls back to its own `env.llm` thinking values. `subagent.model` continues to control only routing.
- Document the settings shape and inheritance. Do not change TUI controls or persistence.

## Public input contract

Entry: user `settings.json` parsed by `loadIknowSettings`, and the strict worker envelope parser.

- Empty: absent fields inherit; empty strings are invalid and dropped.
- Invalid: wrong types and unknown enum values are dropped in settings; malformed parent thinking in an envelope is rejected.
- Overflow: enum strings have no numeric or size range; a long string is an invalid enum.
- Concurrent: run two concurrent spawn calls with different parent thinking snapshots and assert that each worker payload receives only its own snapshot.
- Exception: assert that a malformed parent thinking field in the worker envelope raises the existing typed envelope validation error; unrelated settings I/O errors keep their existing propagation.

## Planned files

affects: plans/subagent-thinking-settings.md
affects: src/config/settings.ts
affects: src/config/env.ts
affects: src/harness/build-engine.ts
affects: src/harness/loop-engine.ts
affects: src/harness/tools/types.ts
affects: src/harness/tools/executor.ts
affects: src/harness/aci/aci-executor.ts
affects: src/harness/permission/permission-executor.ts
affects: src/harness/sandbox/violation-executor.ts
affects: src/harness/isolation/worktree-gate.ts
affects: src/harness/subagent/role.ts
affects: src/harness/subagent/spawn-subagent-tool.ts
affects: src/harness/subagent/subagent-continue-tool.ts
affects: src/harness/subagent/manager.ts
affects: src/harness/subagent/envelope.ts
affects: src/harness/subagent/worker.ts
affects: src/session-api/thinking-override.ts
affects: tests/config/subagent-settings.test.ts
affects: tests/subagent/worker-model-route.test.ts
affects: tests/subagent/envelope.test.ts
affects: tests/subagent/spawn-subagent.test.ts
affects: tests/subagent/subagent-continue-tool.test.ts
affects: tests/session-api/thinking-override.test.ts
affects: tests/harness/subagent-thinking-propagation.test.ts
affects: docs/llm-config-quickstart.md

## Architecture review

bounded-context-guardian: yes — config parses settings, the harness carries an immutable turn snapshot, and the worker selects adapter parameters; no reverse import from config to the session API.
input-contract-tests: yes — settings and envelope tests cover absent, invalid, long invalid, and valid values; concurrent mutation is avoided by immutable per-turn data.
error-handling-enforcer: yes — parsing retains existing drop-invalid behavior, envelope validation rejects malformed input, and no new catch or magic error code is added.
complexity-anti-drift: yes — small field-selection helpers keep config parsing, context propagation, and worker adapter construction at separate abstraction levels.
minimal-change-verifier: yes — one settings-backed subagent thinking feature; no UI, dependency, lockfile, or unrelated behavior change.

## Verification

- Capture RED results for focused settings, context-to-envelope, concurrent spawn isolation, malformed-envelope rejection, continuation, and worker adapter tests before production edits.
- Run an integration test that sends a parent thinking snapshot through the assembled ACI, permission, sandbox, and worktree executor wrappers to a captured spawn payload; assert `subagent_continue` replaces the previous hop's snapshot with the current turn's value.
- Run focused tests, TypeScript checking, and the repository's relevant test suite.
- Review the pinned diff on Standards and Spec axes, then verify behavior before committing and opening the PR.
