# Spec: Trace Service (A-scenario local debug observability)

> **Lean spec.** The 14 settled decisions from GH issue #64 (winter6205/iknow) grilling session (2026-07-31) are this spec's authoritative prior decisions; this spec turns them into the **interface contract + scope boundaries + binary success criteria**, nothing more. Implementation-level layout (file paths inside `src/harness/trace/`, `safeTrace` implementation, JSONL line-writer internals) is left to `writing-plans`.
>
> The companion ADR is `docs/adr/0003-trace-service-domain-interface.md` (written by `domain-modeling`; this spec references it but does not own it).

## Objective

**What**: A separate `TraceService` bounded context at `src/harness/trace/` that records **LLM call / tool call / turn** content to a JSONL file for **local debug**. It complements the existing `LoopTrace` at `src/harness/loop-trace.ts` (which records _loop health_ metadata only) — it does not extend LoopTrace, does not modify its A7 field set, and does not change the 016/017 contracts.

**Why**: When an AI run goes wrong, the developer has no content-level record (messages, tool arguments, tool results) to inspect. They currently re-run with `console.log` sprinkled through the adapter. This spec ships a default-on JSONL trace so a `grep` on `trace.jsonl` answers "what did the model actually see and decide?".

**Who**:

- The developer running `iknow ask "question"` or `iknow serve` (default-on trace).
- The developer debugging a multi-turn Session API conversation (correlated by `conversation_id`).
- Future B-scenario authors (OTel export / Langfuse / Datadog) — they get a domain-driven interface to translate, not a re-implementation.

**Success**: A-scope ships

1. `TraceService` interface with three methods (`recordLlmCall` / `recordToolCall` / `recordTurn`).
2. `NoopTraceService` default (zero behavior change baseline).
3. `JsonlTraceService` writer (single file append, no fsync, no rotation).
4. `safeTrace` wrapper (`T | undefined`, never throws).
5. `LoopEngine` injection: optional `trace?` on `LoopEngineDeps`;埋点 at 4 points in `stepWithTrace` (model phase entry, model phase exit, tool phase entry, turn end).
6. CLI flags on `ask` and `serve` subcommands; `chat` TTY REPL is out of scope.
7. B-scope OTel translation **stub only** (file exists, throws "B-scenario not implemented", wrapped by `safeTrace`).

> **Non-success**: B-scenario OTel export is **deliberately not** part of this spec. Any feature whose only justification is "for the OTel exporter" is out of scope.

## Tech Stack

- **Language**: TypeScript (project `tsconfig.json`: ES2022 / NodeNext / strict / noUnusedLocals / verbatimModuleSyntax / isolatedModules).
- **Module**: ESM (`package.json` `"type": "module"`); TS source uses `.js` suffix for relative imports.
- **Runtime**: Node.js server-side. No new runtime dependencies introduced in A-scope.
- **Test runner**: Node built-in test runner via `tsx --test` (project convention; same as 016 / 017 specs).
- **A-scope NO new packages**: no `@opentelemetry/*`, no `uuid` package, no `ajv`, no DB driver. `crypto.randomUUID()` is built into Node 19+.

> Tech stack changes require a new assumption gate (project Iron Law). A-scope adds zero deps; B-scope's dep choices live in a future ADR.

## Commands

```bash
# Type check (project-wide)
npm run typecheck

# Full test suite (Node built-in runner via tsx)
npm test

# Manual smoke (after T5 lands)
npx tsx src/cli.ts ask "test question"           # writes ./trace.jsonl
npx tsx src/cli.ts ask "test question" --trace-out /tmp/run.jsonl
IKNOW_TRACE_OUT=/tmp/run.jsonl npx tsx src/cli.ts serve
```

> A-scope does **not** add new npm scripts. `writing-plans` may add `npm run trace:smoke` if the plan needs it; not required for spec acceptance.

## Project Structure

A-scope adds one new bounded context at `src/harness/trace/`. The path, sub-file naming, and exact export surface are writing-plans territory; the **responsibility split** is the spec contract:

```
src/harness/trace/                       # new — A-scope adds this directory
├── types.ts                             # TraceService interface + record types
├── noop.ts                              # NoopTraceService (zero behavior)
├── jsonl.ts                             # JsonlTraceService (single file append, no fsync)
├── safe-trace.ts                        # safeTrace wrapper (try/catch, never throws)
├── observability-bridge.ts             # B-scope stub (throws "B-scenario not implemented"; renamed from otel-translator.ts per Gate B 禁词守门)
└── index.ts                             # public exports for harness injection
```

LoopTrace is **not** touched: `src/harness/loop-trace.ts` stays byte-identical, A7 field set frozen.

LoopEngine `src/harness/loop-engine.ts` gains:

- An optional `trace?: TraceService` field on `LoopEngineDeps`.
- 4 `await safeTrace(...)` call sites inside `stepWithTrace` (model-phase entry, model-phase exit, tool-phase entry, turn-end). Field-level placement is writing-plans territory; spec only fixes the _number_ and _intent_ of埋点.

CLI `src/cli.ts` gains:

- `--trace-out <file>` flag on the `ask` subcommand.
- `--trace-out <file>` flag (or `IKNOW_TRACE_OUT` env read) on the `serve` subcommand.
- `chat` TTY REPL subcommand is **unmodified**.

`tests/harness/trace/` — new test directory; coverage strategy in §Testing Strategy below.

## Code Style

### Interface contract (decision layer; implementation in writing-plans)

```ts
// src/harness/trace/types.ts — TraceService interface (illustrative, not literal)

export interface TraceService {
  /**
   * Record an LLM call. Generates the llmCallId.
   * @throws never — implementations MUST swallow IO errors and return undefined.
   */
  recordLlmCall(record: LlmCallRecord): Promise<string | undefined>;

  /**
   * Record a tool call. parentLlmCallId is required; passing undefined
   * yields a JSONL record with parent_llm_call_id: null (orphan).
   * @throws never.
   */
  recordToolCall(record: ToolCallRecord): Promise<string | undefined>;

  /**
   * Record a turn. Generates the turnId.
   * @throws never.
   */
  recordTurn(record: TurnRecord): Promise<string | undefined>;
}
```

Field names are illustrative; spec only fixes the **shape categories** (ID slots / timestamps / status / error double-track / correlation keys). B-scope OTel translation operates on these domain fields, not on JSONL strings.

### Field shape (categories only — not literal TS)

`recordLlmCall` carries: **id slots** (none required, returns `llmCallId`), **correlation** (`conversationId` required, `turnId` from recordTurn), **model** (`modelRequested` + `modelActual` separate, `provider`), **tokens** (`inputTokens` / `outputTokens` / `cacheReadTokens` nullable), **request params** (`temperature` / `maxTokens` nullable), **response** (`finishReason` enum, `stream` boolean, `firstTokenMs` nullable), **timing** (`startedAt` / `endedAt` / `durationMs`), **content capture** (`messagesCaptured` boolean, `messages` only present when true), **error** (`status` + `error` double-track).

`recordToolCall` carries: **id slots** (`parentLlmCallId` required, returns `toolCallId`), **correlation** (`conversationId` + `turnId`), **tool** (`toolName` required, `toolKind` enum), **content capture** (`argumentsCaptured` + `resultCaptured` booleans, fields only present when true), **timing**, **error** double-track.

`recordTurn` carries: **id slots** (returns `turnId`), **correlation** (`conversationId` + `turnIndex`), **timing**, **children** (`llmCallIds` array + `toolCallIds` array — IDs returned by earlier recordXxx calls in the same turn), **decision** (derived from `StopReason`: `final_answer` / `max_turns_exceeded` / `error` / `cancelled` / `timeout` / `protocol_error`), **status** + **error** double-track.

> **Not** in the schema (A-scope): `guardrail_trigger`, `context_window_usage`, `total_input_tokens` / `total_output_tokens` aggregates, `eval_*` fields. These will be added when the underlying capabilities exist (Postel's Law). See ADR §Decision 10.

### Style要点

- **ID generation by TraceService**, not by caller. Caller chains via return value. ID format (UUID v4) lives in TraceService; B-scope OTel hex conversion lives in the translator, not the caller.
- **snake_case in JSONL, camelCase in TS.** Transformation in one file (`jsonl.ts`); harness代码 never touches the snake_case form.
- **`status` enum + `error` object double-track** — both required when present, neither alone suffices. `error.type` reuses iknow's existing `kind` enums.
- **Async IO, sync ID return.** ID allocation is synchronous; write is async via `fs.appendFileSync`. Callers `await`; the IO cost is bounded by line size (~50 bytes per turn, ~500 bytes per LLM call).

## Testing Strategy

Test layers and what each covers:

- **Unit (NoopTraceService)** — `tests/harness/trace/noop.test.ts`. Verifies the three methods return `""` (sentinel) or no-op, and produce **zero** side effects (no files written, no globals touched, no console output). This test is the contract that "default = zero behavior change".
- **Unit (JsonlTraceService)** — `tests/harness/trace/jsonl.test.ts`. Verifies:
  - snake_case conversion (camelCase TS field → snake_case JSONL key).
  - Single line per record (no embedded newlines; valid JSONL).
  - `parent_llm_call_id: null` (literal null) when parent ID is undefined.
  - **Disk-full / permission-denied does NOT throw** — write is wrapped; service returns `undefined` and logs `console.warn` once. (T3 integration test should also exercise this on real FS.)
  - All three `recordXxx` return type is `string | undefined`.
- **Unit (safeTrace wrapper)** — `tests/harness/trace/safe-trace.test.ts`. Verifies:
  - Successful async function → returns its result.
  - Throwing async function → returns `undefined`, no rethrow.
  - Sync throw inside the async function (via `Promise.reject`) → also caught.
  - Does NOT swallow synchronous throws _outside_ the async function (those are programmer errors, not IO errors).
- **Unit (observability-bridge stub)** — `tests/harness/trace/observability-bridge.test.ts`. Verifies the stub throws `"B-scenario not implemented"` when called; verifies `safeTrace` wrapping the stub call does not break the harness (smoke test using a stub harness that counts how many turns complete).
- **Integration (harness with stub model + stub tool)** — `tests/harness/trace-integration.test.ts`. Runs `stepWithTrace` end-to-end with a stub adapter that emits: pure-text turn / single-tool-call turn / multi-tool-call turn / `cancelled` mid-model-call / `timeout` mid-tool-call. Asserts:
  - Loop-engine output (transition / finalState) is **byte-identical** to the no-trace baseline.
  - JSONL file contains expected records in expected order (turn → llm → tool(s) → turn).
  - `parent_llm_call_id` chain is intact (tool call references the llm call that triggered it).
  - When `recordLlmCall` is wired to a writer that always throws, the harness completes the run; JSONL has `parent_llm_call_id: null` orphan records but the run result is correct.
- **Test scope**: 100% unit + 100% integration. **No e2e** (no real model, no real network). Real FS in `jsonl.test.ts` is encouraged (tempfile in `os.tmpdir()` + `fs.statSync` size check).

> Tests are the contract. A-scope spec acceptance is binary: `npm test` exits 0, and the integration test passes the no-trace baseline byte-equality check.

## Boundaries

- **Always do**:
  - Run `npm run typecheck` + `npm test` before committing; both must exit 0.
  - Preserve `src/harness/loop-trace.ts` A7 field set (017 lock). Adding fields there is **not** in scope for any PR titled "trace service".
  - Default `trace.jsonl` to be added to `.gitignore` in the PR that lands T3.
  - Wrap every `TraceService.recordXxx` call site in `safeTrace` — never call `traceService.recordXxx` directly from loop-engine.
  - Pass `parentLlmCallId: undefined` to `recordToolCall` when `recordLlmCall` returned `undefined`; do not skip the record.
  - Use `fs.appendFileSync` (sync), not `fs.createWriteStream` (stream); sync keeps the call-site `await` model simple and the IO cost is small for A-scope.
- **Ask first**:
  - Add any new runtime dependency to `package.json` (A-scope: zero; B-scope: separate ADR).
  - Modify `src/harness/loop-trace.ts` (017 lock).
  - Modify `LoopEngineDeps` in ways other than the **single optional** `trace?` field.
  - Extend `recordLlmCall` / `recordToolCall` / `recordTurn` field set beyond the categories in §Code Style.
  - Move trace write boundaries (e.g. start writing on every `recordLlmCall` instead of every `recordTurn`).
- **Never do**:
  - Import or depend on `@opentelemetry/*` in A-scope.
  - Add a 4th public method to `TraceService` (e.g. `recordRun` / `recordSpan`) in A-scope — multi-layer recording is B-scope.
  - Pre-declare fields that are not yet fillable (e.g. `guardrail_trigger` while iknow has no guardrail mechanism).
  - Delete or weaken tests in `tests/harness/trace*/` to make builds pass (project code-quality rule).
  - Wire trace into `chat` TTY REPL.
  - Use SQLite / database / external storage for trace.
  - Implement the `observability-bridge.ts` body beyond a `throw` stub.

## Success Criteria

Binary判据. Each is yes/no. Mapping to a measurable check (test name, file, command).

1. `npm run typecheck` exits 0? □
2. `npm test` exits 0? □
3. `src/harness/trace/` directory exists with the responsibility split in §Project Structure? □
4. `TraceService` interface has exactly 3 public methods (`recordLlmCall` / `recordToolCall` / `recordTurn`), each with `@throws never` JSDoc? □
5. `NoopTraceService` is the default injection: when `LoopEngineDeps.trace` is `undefined`, behavior is byte-identical to pre-#64 baseline? □ (Integration test compares harness output.)
6. `JsonlTraceService` writes snake_case JSONL: `camelToSnake` transformation is in `jsonl.ts`, not duplicated elsewhere? □
7. `recordToolCall` requires `parentLlmCallId`; passing `undefined` produces a JSONL line with `parent_llm_call_id: null` (literal `null`, not the string `"undefined"`)? □
8. `recordLlmCall` / `recordToolCall` / `recordTurn` IDs are generated by TraceService, not by caller? □ (No `crypto.randomUUID` in `loop-engine.ts` trace-related code.)
9. `safeTrace(asyncFn)` returns `T | undefined`; verified by tests for both happy path and throwing path? □
10. Disk-full / permission-denied during `JsonlTraceService.recordXxx` does NOT throw — verified by test that injects a writer which always throws? □
11. `recordTurn` writes **at step end** (after tool phase completes, before next step's model call) — verified by integration test that injects a deliberate mid-run kill? □ (Simplification: integration test asserts JSONL file is non-empty after every step's `recordTurn`, not just at `run` exit.)
12. `LoopTrace` A7 field set is byte-identical: `git diff src/harness/loop-trace.ts` shows zero changes in any PR titled "trace service"? □
13. CLI `ask` accepts `--trace-out <file>`; `chat` does NOT accept `--trace-out`; `serve` accepts `--trace-out` (or reads `IKNOW_TRACE_OUT`)? □
14. Default trace path is `./trace.jsonl` (relative to CWD), overridable by flag, overridable by `IKNOW_TRACE_OUT` env (flag > env > default)? □
15. `trace.jsonl` is in `.gitignore` after the PR that lands T3? □
16. `src/harness/trace/observability-bridge.ts` exists, its exported function `translateToObservability` throws `Error("B-scenario not implemented")`, and `safeTrace` wrapping the translator call does not break a harness smoke test? □
17. `LoopEngineDeps` is modified **only** by adding the optional `trace?: TraceService` field; no other field is renamed, retyped, or removed? □
18. No new runtime dependency added to `package.json` by any A-scope PR? □
19. Error double-track: a `recordLlmCall` / `recordToolCall` for a failed call has both `status: "error"` AND `error: { type, message }` (or `error.type` for non-tool LLM calls) — verified by integration test of the cancelled / timeout / protocol_error paths? □
20. `error.type` reuses iknow's existing kind enums (no new enum introduced for trace-only failure modes)? □

> 判据 5 is the spec's **byte-equality contract**: the A-scope default behavior is "the harness runs and produces the same output as before, plus a JSONL file." Any PR that changes harness output other than the JSONL file fails this criterion.
> 判据 12 is the **017 lock guard**: the LoopTrace module is read-only for any PR titled "trace service".
> 判据 16 is the **B-scope留位 contract**: the stub exists, is tested, and the harness survives calling it.

## Open Questions

None at the spec layer. The 14 settled decisions (2026-07-31 grilling session) cover the spec's open questions. Remaining items are writing-plans territory:

- File-level layout inside `src/harness/trace/` (e.g. whether `safe-trace.ts` and `jsonl.ts` share utility helpers in `_internal/`).
- Exact `safeTrace` implementation (try/catch shape, sync vs async error propagation, console.warn dedup).
- Exact test file names and `describe` / `it` titles (convention is project test runner's idiomatic style).
- Whether T2 / T3 / T4 / T5 land as one PR or as four sequential PRs.
- B-scope OTel translation mapping table (separate ADR / spec, separate worktree).

---

## ACR 5-Verdict Gate

> `architecture-change-reviewer` verdict — recorded inline per spec-template requirement. Each verdict is `yes` / `no` / `N/A with reason`.

1. **bounded-context-guardian**: `yes` — new module `src/harness/trace/` is a separate bounded context from `src/harness/loop-trace.ts` (017 A7 lock preserved, byte-identical). Sub-responsibility split (types / noop / jsonl / safe-trace / observability-bridge / index) follows capability seams, not technical layers. No reverse dependencies from `loop-engine.ts` to trace implementation details; loop-engine only knows the `TraceService` interface + `safeTrace` wrapper. No circular imports possible (interface-only dependency).

2. **defensive-contract-validator**: `yes` — five boundary classes covered by tests:
   - **empty**: NoopTraceService is the empty-case baseline (判据 5).
   - **negative**: `parentLlmCallId: undefined` produces `null` JSONL field (判据 7).
   - **overflow**: large `messages` array, large `result` object — covered by `JsonlTraceService` content-capture defaults (`*_captured` boolean, opt-in).
   - **concurrent**: `recordTurn` is called from `stepWithTrace` only, which is single-threaded (loop-engine 016 contract). N/A with reason: no concurrency surface in A-scope.
   - **exception**: `safeTrace` wrapper + `JsonlTraceService` internal try/catch + `recordXxx @throws never` JSDoc (判据 4, 9, 10, 16).

3. **error-handling-enforcer**: `yes` — three error surfaces explicit:
   - **TraceService IO error** (disk full, permission denied): `JsonlTraceService` internal try/catch → `console.warn` → return `undefined` (判据 10).
   - **Caller contract violation** (forgetting `safeTrace`): type system + integration test (判据 8 — no `crypto.randomUUID` in loop-engine trace code).
   - **Harness-level cancelled / timeout** (017 S12 / S14): recorded via `error.type: "cancelled"` / `"timeout"`, status `error`, never discarded (017 in-flight closeout + 019 raceModel abort decisions preserved; trace just observes, never mutates loop control flow).

4. **complexity-anti-drift**: `yes` — spec-fixed interface has 3 methods, ~20 fields per record (already conservative for OTel-aligned domain). No function in the spec is past 40 lines (interface is type-only; the meat is in `safeTrace` and `JsonlTraceService` write methods, both <40 lines target). No new file >500 lines target. No clone rate concern (single transformation function, no copy-paste).

5. **minimal-change-verifier**: `yes` —
   - One new directory `src/harness/trace/`.
   - One optional field on `LoopEngineDeps`.
   - One ~5-line埋点 per phase × 4 phases = ~20 lines added to `loop-engine.ts`.
   - Two CLI flags added to `cli.ts` (ask + serve).
   - One `.gitignore` line.
   - No new runtime dep.
   - `LoopTrace` byte-identical (017 lock).
   - Single logical task = A-scope trace service; per T1-T5 split into 5 commits, but they ship as one feature.

**OVERALL: PASS** — 5 维全绿, hand to `writing-plans`.

---

## Cross-references

- **ADR** (decision layer): `docs/adr/0003-trace-service-domain-interface.md` — written by `domain-modeling`.
- **Prior decisions (grilling session 2026-07-31)**: GH issue #64 (winter6205/iknow) — 14 settled decisions.
- **017 spec (LockTrace A7 field-set lock)**: `specs/loop-hardening-for-migration.md`.
- **LoopTrace source (read-only)**: `src/harness/loop-trace.ts`.
- **Domain language**: `docs/CONTEXT.md` — `LoopTrace` (A-layer structural metadata, no payload) / `turnCount` / `append-only messages` / `in-flight closeout` / `StopReason` 7-class union.
- **Environment variable convention**: `docs/adr/0001-9router-stack-as-code-defaults.md` — `IKNOW_*` env var naming.
- **Web UI ADR (for distinguishing from this one)**: `docs/adr/0002-web-ui-variant-a-tailwind.md` — this trace ADR is **0003**, not 0002.
