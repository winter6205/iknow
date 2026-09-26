# Testing Policy

When adding or changing business logic, prioritize adding or updating tests before implementation. Tests must cover the applicable behavior classes:

1. Normal behavior.
2. Failure behavior.
3. Boundary conditions.
4. Insufficient permissions.
5. Empty or invalid input.
6. Concurrent or repeated submission, when applicable.

## Docs-only commits

When the staged diff contains only markdown documents (`docs/`, `specs/`, root `*.md`) and no code, typecheck and test suites are not the contract for the change: `.husky/pre-commit` fast-paths such commits (skips `typecheck` + `test:changed`, keeps lint-staged formatting). If a docs-only commit still triggers a full suite run (e.g. `vitest --changed` degrading to whole-suite on a no-code diff), committing with the hook bypassed is authorized for that commit; state "docs-only" in the commit body.

Do not delete tests or weaken assertions to make a build pass. A deleted or replaced test must be covered by an equivalent or stronger test and have a rationale, authorization, and explanation in the commit body. Do not mark a failing test as skipped unless explicitly authorized and the reason is documented.

## Session and trace evidence

- When changing `SessionStore` persistence, migration, replay, resume, or listing, exercise the real store and filesystem in an isolated temporary directory. Give each case a fresh `conversationId`; never use the repository's `data/` directory or a user's session directory. For durability claims, read through a newly constructed store or inspect the actual persisted JSONL and verify the loaded result.
- Use representative session content for the behavior under test: for example, user and assistant messages, tool-use/result pairs, checkpoints, title events, or legacy records when those paths are affected. Assert observable data such as message content, event/head relationships, list or resume results, and persisted record shape. Do not rely only on mocks, call counts, or assertions about private helpers.
- When changing trace writing or reading, use the production trace writer/reader against real temporary files. Build fixtures in the format that component consumes: session-store JSONL, harness `llm_call` / `tool_call` / `turn` records, or trace-server `session` records as applicable. Assert relevant record order, IDs and parent IDs, status, and the result visible to the consumer. Prefer the production serializer/writer for valid records; hand-written records are appropriate for malformed or historical compatibility cases.
- Stub an external model, network service, or host process at its boundary when that external behavior is not the subject of the test. Keep the internal code path under test real; do not mock the `SessionStore`, filesystem, trace writer, or other internal component whose behavior is being verified. Isolate external side effects; destructive or outbound effects require explicit opt-in in the applicable spec and its safety gates. Harmless real integrations may run in a suitable isolated test environment.

## Model-visible behavior and interactive surfaces

- For changes to prompt text, model inputs, tool descriptions/schemas, or model trajectory, read `docs/guides/prompt-development.md` and run the applicable golden fixture/set. A trajectory set requires its real-model half via `npm run test:real-llm`; offline fixtures or stub models do not count as that half. If credentials are unavailable, report the real-model check as `Not run`, with the reason; do not report it as passed. Follow the guide's rule for building a set or registering a gap.
- For changes to interactive conversation behavior in the CLI, TUI, or REPL, capture a real PTY interaction and its observable output using the project's available PTY tooling. Use browser-based verification only when the changed behavior is in a browser surface.

## Validation report

If a relevant check cannot run, record it in the completion report:

```text
Validation:
- Not run: <reason>
- Expected command: <command>
- Blocking issue: <issue>
```

Do not describe a check that was not run as passing. State which validation remains outstanding and why.
