# Spec: 023 raceModel abort - engine-timeout 时取消 HTTP 请求

> **Status**: SPECIFY (decision-gathering complete per #54 Resolution; awaiting ACR 5-verdict)
> **Source**: wayfinder #54, closed 2026-07-31
> **Scope**: `src/harness/loop-engine.ts` (`raceModel` + `runModelPhase`) + 4 new tests + module-level exports
> **Out of scope**: #97 (position-arg refactor), #98 (TurnTrace enum refactor), SDK error classification

## Objective

When the Loop Engine's `raceModel` timer fires (model call exceeds `modelTimeoutMs`), the currently in-flight HTTP request to the model provider is **cancelled**, not left to fly until natural return. This eliminates token waste on timed-out requests and frees the underlying connection promptly.

**User**: harness internal - the API contract change is observable only to:

- test code (4 new assertions see the structured `RaceModelOutcome`)
- future host code that explicitly opts into `childAbort()` (not used by current CLI / Session API assembly)

**Success looks like**:

- timer fire -> SDK HTTP request receives `AbortSignal` cancellation
- routing to `stopReason: "timeout"` is unaffected by the SDK's subsequent `APIUserAbortError` throw
- caller-initiated abort still wins the race and routes to `cancelled`
- aborts after settle are idempotent no-ops

## Tech Stack

- TypeScript 5.8.x (strict ESM, `tsconfig.json` unchanged)
- Node ≥20.3.0 stable APIs only (`AbortSignal.any`, `AbortController`) - `engines.node >=20` unchanged
- `@anthropic-ai/sdk` ^0.115.0 (already runtime dep; used to import `APIUserAbortError` class for test mocks)
- Vitest 3.x (test framework unchanged)
- ajv 8.17.x (schema validation; not touched in this spec)

No new dependencies.

## Commands

```
# Type check (unchanged)
npm run typecheck

# Test (unchanged - adds 4 new assertions in tests/harness/loop-engine.test.ts)
npm test

# Real-SDK smoke (unchanged, regression check)
npx tsx scripts/i9-real-anthropic-adapter-smoke.ts

# CI gate (unchanged)
git commit -> husky pre-commit runs: lint-staged + typecheck + test
```

## Project Structure

Files touched (2 total):

```
src/harness/loop-engine.ts
  └─ raceModel():      return RaceModelHandle instead of Promise<AssistantTurnResult>
  └─ runModelPhase():  destructure handle.outcome, map source 4-enum to TurnTrace booleans + StopReason
  └─ exports:          add RaceModelOpts, RaceModelOutcome, RaceModelHandle, raceModel

tests/harness/loop-engine.test.ts
  └─ append 4 new `it()` cases inside the existing "loop engine 017 S12–S17" describe block
     (no new describe block, no test file rename)
```

Files NOT touched (this spec):

```
src/harness/model-adapter/anthropic-adapter.ts     # 019 already wires signal to messages.create({ signal })
src/harness/executor.ts, registry.ts, types.ts     # 015 frozen contract
src/harness/loop-trace.ts                           # 017 TurnTrace shape - wait for #98
src/harness/stubs/*, aci/*, index.ts                # not in raceModel call graph
src/cli/*, src/session-api/*, web/*                 # host layer
src/agent-loop/*, src/interaction/*, src/kb-*       # archived (per CLAUDE.md Module boundaries)
docs/architecture.md, docs/CONTEXT.md, CHANGELOG.md # documentation updates deferred to writing-plans / PR
```

## Code Style

### New types (added to `src/harness/loop-engine.ts`, module-level export)

```ts
/**
 * 023: Source of a raceModel outcome. The 4-value union replaces the implicit
 * "model resolved" vs "raceModel settled due to timer/signal" dichotomy that
 * the previous Promise<AssistantTurnResult> return shape lost.
 *
 * - "adapter"       - adapter.step resolved normally
 * - "timerTimeout"  - modelTimeoutMs timer fired (engine aborted HTTP via child.abort())
 * - "hostCancel"    - caller invoked handle.childAbort() to preempt the timer
 * - "callerAbort"   - caller-supplied signal aborted (caller intent wins over timer)
 */
export type RaceOutcomeSource =
  "adapter" | "timerTimeout" | "hostCancel" | "callerAbort";

export interface RaceModelOutcome {
  readonly result: AssistantTurnResult | undefined; // undefined when source != "adapter"
  readonly source: RaceOutcomeSource;
}

export interface RaceModelHandle {
  readonly outcome: Promise<RaceModelOutcome>;
  readonly childSignal: AbortSignal;
  readonly childAbort: () => void;
}

export interface RaceModelOpts {
  readonly adapter: LoopAdapter;
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}
```

### `raceModel` signature (lifecycle = L1')

The function returns a `RaceModelHandle`. Internally it owns a child `AbortController` and a composite `AbortSignal.any([callerSignal, child.signal])` that is passed to `adapter.step`. The `settle` closure guards single-wins and is the single cleanup point: on any settle it clears the timer, removes the caller abort listener, and calls `child.abort()` (idempotent). The timer-fire branch calls `child.abort()` explicitly first (the bug fix proper), then settles with `source: "timerTimeout"`. The caller-abort branch settles with `source: "callerAbort"`. The adapter-resolve branch settles with `source: "adapter"`. SDK errors (`APIUserAbortError`, `APIError` family) that arrive after settle are dropped by the `settled` guard so they cannot pollute the structured outcome; SDK errors that arrive as the first event resolve the outcome through a separate rejection path that `runModelPhase` catches.

> Implementation detail (variable names, helper decomposition) belongs in the plan, not this spec. The spec fixes the shape: handle return type, source enum, L1' cleanup discipline, explicit `child.abort()` on the timer branch.

### `runModelPhase` rewrite (source -> TurnTrace mapping)

`runModelPhase` destructures `handle.outcome`, awaits it, and maps:

- `source === "adapter"` -> `{ kind: "ok", result }` (existing path)
- `source === "timerTimeout" || source === "hostCancel"` -> `stopReason: "timeout"`, `TurnTrace.timeoutHit = true`, `signalAborted = false`
- `source === "callerAbort"` -> `stopReason: "cancelled"`, `TurnTrace.signalAborted = true`, `timeoutHit = false`

This temporary mapping preserves the 017 `TurnTrace` double-boolean shape (frozen by `specs/loop-hardening-for-migration.md`) and is removed when #98 lands the enum refactor. SDK-thrown errors caught in the `await handle.outcome` try/catch keep the existing `ProtocolError -> protocolError` / rethrow contract.

### Naming + formatting

- Match existing module style: `Object.freeze({ ... })` for plain-data literals, readonly interfaces, string-literal unions (matching existing `StopReason` shape - no TS `enum`)
- 2-space indent, single quotes, trailing commas per repo prettier config
- Comments explain _why_ (L1' explicit abort on timer, dropped post-settle SDK errors, temp double-boolean mapping pending #98)

### Plan-Phase hard gate: complexity-anti-drift

The rewritten `raceModel` will introduce a child `AbortController` + `AbortSignal.any` composite + 4-branch settle discipline + explicit `child.abort()` on the timer branch. The current `raceModel` body is already ~52 lines (pre-existing near the 30-lines/function soft trigger); the rewrite risks extending it further. The plan MUST satisfy all of the following or the implementation cannot commit:

- Either `raceModel` body fits in ≤ 30 lines (complexity-anti-drift hard threshold) **or** it is decomposed into named helpers (e.g. `buildCompositeSignal`, `createSettleGuard`, `wireTimerBranch`) such that the top-level body stays within the limit and each helper individually does too.
- The four distinct exit branches (adapter-resolve, timer-fire, caller-abort, post-settle SDK-error drop) remain co-located in the `settle` closure so cleanup discipline stays in one place — decomposition is permitted but must not split settle into separate functions across files.
- `loop-engine.ts` is already 611 lines (pre-existing past the 300-lines/file soft trigger); the diff is allowed to add lines but must not push the file past a documented plan-defined cap. The plan should state the cap and how it was chosen.

This clause exists to flip the ACR `complexity-anti-drift` verdict from `unclear` to `yes`. The plan owns the concrete function-level shape; the spec only fixes the boundary.

## Testing Strategy

### Unit (new, 4 assertions in `tests/harness/loop-engine.test.ts` S12–S17 describe block)

All 4 use stub adapter + `import { APIUserAbortError } from "@anthropic-ai/sdk"` for SDK error mocking. **No real fetch**, no real `Anthropic` client.

| Test ID  | What it asserts                                                                                                                                    | What it prevents                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| T2-new-1 | stub adapter throws `APIUserAbortError` after signal fires; `outcome.source === "timerTimeout"`, `result.stopReason === "timeout"`                 | SDK error does NOT poison timeout routing                  |
| T2-new-2 | capture adapter.step's `signal` param; after timer fires, `signal.aborted === true`                                                                | the bug being fixed - composite signal is actually aborted |
| T2-new-3 | caller aborts via `controller.abort()` before timer fires; `outcome.source === "callerAbort"`, `result.stopReason === "cancelled"`                 | caller abort beats timer; not misrouted to `timeout`       |
| T2-new-4 | adapter resolves quickly; then `controller.abort()` and `handle.childAbort()` are called post-settle; `outcome.source` still `"adapter"`, no throw | idempotency of post-settle aborts                          |

Existing 017 S12 / S14 / S15 / S17 / boundary tests must continue to pass **without modification** - they assert `stopReason` + `TurnTrace.timeoutHit/signalAborted` which the temp mapping preserves.

### Integration / smoke (unchanged, regression check)

- `npm test` exits 0 (all harness + cli + interaction tests)
- `npx tsx scripts/i9-real-anthropic-adapter-smoke.ts` exits 0 (real SDK link unbroken)
- Pre-commit hook (`.husky/pre-commit`): lint-staged + typecheck + test - unchanged

### Coverage

- Line: ≥ 80% in `src/harness/loop-engine.ts` (baseline)
- Branch: ≥ 70%
- New tests cover: success path (adapter), timeout path (timer fire), caller-abort path (signal), SDK-error-after-abort path, post-settle abort idempotency

## Boundaries

**Always do**:

- Run `npm run typecheck` + `npm test` before commit
- Run ACR (architecture-change-reviewer) 5-verdict gate before merging this spec's implementation
- Match existing module style (frozen objects, readonly types, string-literal unions over enums)
- Surface any new finding in `docs/STATUS.md` if user-visible behavior changes

**Ask first**:

- Any change to the `LoopAdapter` public interface (`step(state, req, signal?)` signature) - **forbidden** in this spec
- Any change to `TurnTrace` / `Totals` / `computeTotals` shape - wait for #98
- Any change to i9 smoke or its assertions - out of scope
- Any new dependency (none needed)

**Never do**:

- Add automatic retry / backoff / token-cost guard / OTel - those are conditional remediation layer (017 deferred)
- Touch 014/015 frozen contracts
- Touch `src/cli/`, `src/session-api/`, `web/`, `src/agent-loop/`, `src/interaction/`, `src/kb-*`
- Delete or skip any existing 017 test to make build pass
- Weaken any existing assertion
- Embed implementation detail (specific line numbers, intermediate variable names) in spec - this spec defines shape + behavior, plan owns code

## Success Criteria

Binary (yes/no), each maps to a measurable check:

1. `raceModel` returns `RaceModelHandle`, not `Promise<AssistantTurnResult>` - verifiable by `tsc` type check of `src/harness/loop-engine.ts`
2. `RaceModelOutcome.source` is a 4-value union `"adapter" | "timerTimeout" | "hostCancel" | "callerAbort"` - verifiable by type test
3. `raceModel` accepts options object `RaceModelOpts` (no positional args) - verifiable by `tsc` signature check
4. `raceModel`, `RaceModelOpts`, `RaceModelOutcome`, `RaceModelHandle` are module-level `export`s - verifiable by `tsc` + grep
5. Timer fire calls `child.abort()` _before_ `settle("timerTimeout")` - verifiable by T2-new-2 (asserts `signal.aborted === true` after timer)
6. Caller abort wins the race (timer does not also fire in caller-abort path) - verifiable by T2-new-3
7. SDK throwing `APIUserAbortError` after signal abort does not change `outcome.source` from `"timerTimeout"` to anything else - verifiable by T2-new-1
8. Post-settle `controller.abort()` and `handle.childAbort()` are no-ops, do not throw - verifiable by T2-new-4
9. `signalAborted` and `timeoutHit` in `TurnTrace` continue to be correctly set for all 4 raceModel sources, mapped via `runModelPhase` - verifiable by all existing S12/S14/S15/S17 tests passing without modification
10. `result.stopReason` is `"timeout"` for `timerTimeout` and `hostCancel`, `"cancelled"` for `callerAbort`, `"completed"`/etc for `adapter` - verifiable by existing S12/S14 tests + T2-new-1/3
11. `npm run typecheck` exits 0
12. `npm test` exits 0; new tests count = 4; existing test count unchanged
13. `npx tsx scripts/i9-real-anthropic-adapter-smoke.ts` exits 0 (real SDK link unchanged)
14. No new npm dependency added (verifiable by `git diff package.json` empty)
15. `tsconfig.json`, `.husky/pre-commit`, `package.json` scripts, CI configs all unchanged
16. `LoopAdapter` public interface unchanged (verifiable by `git diff` of `src/harness/model-adapter/types.ts` empty)
17. No file outside `src/harness/loop-engine.ts` + `tests/harness/loop-engine.test.ts` is modified (verifiable by `git diff --name-only`)

## Open Questions

None. The #54 wayfinder grilling cleared all decisions (Q1 = A / Q2 = L1' + R2-a + 4-enum source + options object / Q3 = preserve 017 trace shape via temp mapping). All remaining questions are implementation-level (variable names, internal helpers) and belong in the plan, not the spec.

## Glossary (surfaced from `docs/CONTEXT.md`)

- **Loop Engine**: Foundation 状态机运行内核，位于 `src/harness/`；本 spec 修改其内部 `raceModel`。
- **StopReason**: 七类停止判别联合；本 spec 涉及 `cancelled`（signal abort）与 `timeout`（超时强制）两类，追加不重排。
- **LoopTrace (TurnTrace / Totals)**: `run()` 第二返回面 A 层结构元数据；本 spec **不动**其 shape（`timeoutHit` / `signalAborted` 双布尔），等 #98。
- **in-flight closeout**: abort/timeout 发生时的收尾语义；本 spec 保持 model 在途则整回合不进历史。
- **required runtime layer / conditional remediation layer**: 017 两层对仗边界；本 spec 属 required runtime layer 边角细化，**不带入** conditional remediation layer（自动重试 / token-cost / OTel 等）。

## Architectural Constraints (ADRs)

- **ADR-0001** (9router stack as code defaults): 不直接相关，但确认 `@anthropic-ai/sdk` 是 runtime dep、9router 是唯一 provider - 本 spec 不动 env/stack。
- **ADR-0002** (web UI variant A tailwind): 不相关（host 层 out of scope）。
- **014 冻结契约** (model turn + append-only history): 不动 - `raceModel` 不构造/修改 messages。
- **015 冻结契约** (tool ACI + result boundary): 不动 - `raceModel` 不触碰 Executor/Registry。
- **017 冻结契约** (loop hardening): `TurnTrace` shape 临时映射保留，不擅改；`StopReason` 追加不重排保持。

---

## ACR Verdict Block (filled in by `architecture-change-reviewer`)

```
bounded-context-guardian:           yes - touches only src/harness/loop-engine.ts + tests/harness/loop-engine.test.ts; LoopAdapter public interface (loop-engine.ts L47-57) and run/step/createLoopEngine signatures (L527-611) unchanged; 014/015 frozen contracts preserved; 017 TurnTrace shape preserved (loop-trace.ts L14-30); no new deps; no reverse-deps or circular imports introduced
defensive-contract-validator:       yes - 4 new tests cover exception class (T2-new-1 APIUserAbortError post-settle), concurrent signal+timer race (T2-new-1 + T2-new-3), signal-state boundary (T2-new-2 composite signal actually aborted), and post-settle idempotency (T2-new-4); empty/negative inputs contractually preserved by 017 boundary tests mandated to pass unmodified
error-handling-enforcer:            yes - 4 EXIT paths documented explicitly (timer-fire calls child.abort() then settles timerTimeout; caller-abort settles callerAbort; adapter-resolve settles adapter; settled guard drops post-settle SDK errors); SDK-first rejection route through runModelPhase try/catch (ProtocolError -> protocolError stop, else rethrow); every failure path typed (discriminated RaceOutcomeSource union), non-empty, EXIT-deterministic
complexity-anti-drift:              yes (flipped from unclear) - spec "Plan-Phase hard gate: complexity-anti-drift" clause (above) commits the plan to: raceModel body ≤30 lines OR decomposed into named helpers (buildCompositeSignal / createSettleGuard / wireTimerBranch) with each helper ≤30 lines; settle closure stays co-located (no cross-file split); plan states a file-size cap for loop-engine.ts (already 611 lines, pre-existing past 300-line soft trigger). Gate is plan-enforced; implementation cannot commit otherwise.
minimal-change-verifier:            yes - single logical task (engine-timeout cancels in-flight HTTP); 1 commit; 2 files (1 src + 1 test appended to existing describe block, no rename no new describe); no deps added; no frozen-contract touches; public API unchanged; #97 / #98 / SDK error classification correctly deferred out
```

All 5 verdicts `yes` -> spec advances to `writing-plans`.

> ACR scope note: the spec touches 2 files, below the ACR ≥3-file default threshold; the orchestrator overrode the threshold given the spec modifies a frozen-contract-adjacent internal (`raceModel`) and introduces new public exports. Verdict emitted per override.
