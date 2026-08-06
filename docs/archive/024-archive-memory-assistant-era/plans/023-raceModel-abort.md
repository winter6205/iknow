# Plan: 023 raceModel abort - engine-timeout 时取消 HTTP 请求

> **Spec**: `specs/023-raceModel-abort.md`（ACR 5/5 yes）
> **Tracker**: GitHub issues（`ready-for-agent` label）- gh CLI 可用
> **Base branch**: `worktree-spec-023-raceModel-abort`（或合并后的 master）
> **依赖**: spec PR #100（spec body + ACR 修订）合并后本 plan 可执行
> **来源**: wayfinder #54 Resolution（Q1=A 现在就修 / Q2=L1'+R2-a+4-enum source+options object / Q3=preserve 017 trace shape via temp mapping）

---

## Section 1 - Context-Loop Pre-Check

- `docs/CONTEXT.md` 已读：Loop Engine / StopReason（`cancelled` / `timeout`）/ LoopTrace（TurnTrace / Totals）/ in-flight closeout / required runtime layer vs conditional remediation layer 五术语入 spec Glossary，本 plan 不重定义。
- `docs/adr/` 已读：
  - ADR-0001（9router stack as code defaults）：确认 `@anthropic-ai/sdk` 是 runtime dep、9router 是唯一 provider，本 plan 不动 env/stack。不直接相关，无矛盾。
  - ADR-0002（web UI variant A tailwind）：host 层，out of scope，不相关。
  - 无 ADR 矛盾需标注（`> Contradicts ADR-NNNN`）。
- 冻结契约边界：014（model turn + append-only history）/ 015（tool ACI + result boundary）/ 017（loop hardening）均不动；TurnTrace shape #98 已解冻并落地 cancelKind 枚举（原双布尔经 runModelPhase 临时映射的历史已终结）。
- `loop-engine.ts` 实测 610 行（`wc -l`，spec 记 611 为尾行差异），已过 300 行 file soft trigger——file cap 决策见 T1。

## Section 2 - ACR 5-Verdict Block（引自 spec）

```
bounded-context-guardian:           yes - touches only src/harness/loop-engine.ts + tests/harness/loop-engine.test.ts; LoopAdapter public interface + run/step/createLoopEngine signatures unchanged; 014/015 frozen contracts preserved; 017 TurnTrace shape preserved; no new deps
defensive-contract-validator:       yes - 4 new tests cover exception class (T2-new-1 APIUserAbortError post-settle), concurrent signal+timer race (T2-new-1 + T2-new-3), signal-state boundary (T2-new-2 composite signal actually aborted), post-settle idempotency (T2-new-4); 017 boundary tests pass unmodified
error-handling-enforcer:            yes - 4 EXIT paths documented (timer-fire calls child.abort() then settles timerTimeout; caller-abort settles callerAbort; adapter-resolve settles adapter; settled guard drops post-settle SDK errors); SDK-first rejection route through runModelPhase try/catch; every failure path typed (discriminated RaceOutcomeSource union)
complexity-anti-drift:              yes (flipped from unclear via Plan-Phase hard gate) - T1 of this plan owns the function-level shape commitment (raceModel body ≤30 OR helper-decomposed each ≤30; settle co-located; file cap 700)
minimal-change-verifier:            yes - single logical task; 1 commit; 2 files (1 src + 1 test appended to existing describe block); no deps; no frozen-contract touches; #97 / #98 / SDK error classification deferred
```

## Section 3 - Tracer Bullets（依赖序）

> **Bullet 计数 justification**（`acceptance-criteria.md` 要求 ≥3 或书面理由）：spec + ACR `minimal-change-verifier` 把本变更定为**单 logical task**（1 commit / 2 文件 / raceModel 原子重写）。唯一 pre-code 决策是 T1 的 complexity 硬门槛 + file cap（spec 明确把 function-level shape 留给 plan）。强行拆 >2 bullet 会把一次原子 raceModel 重写切成人造碎片，违反 1-commit-per-logical-task。故 2 bullet（1 decision + 1 implementation）是此 spec 的正确粒度。

---

### T1. `[decision]` complexity-anti-drift 硬门槛 + 文件大小上限 + settle 共址

- **背景**: spec 的「Plan-Phase hard gate: complexity-anti-drift」clause 把具体 function-level shape 留给 plan，并要求 plan 声明 `loop-engine.ts` 文件大小上限及其选择理由。`loop-engine.ts` 当前 610 行（已过 300 行 file soft trigger）；`raceModel` 当前 body ~52 行（已近 30 行 function soft trigger），重写引入 child `AbortController` + `AbortSignal.any` composite + 4-branch settle，不加约束则 risk 超 30 行 hard threshold。ACR `complexity-anti-drift` 初判 `unclear`，经此 decision 翻 `yes`。
- **决策**（shape-level 约束，**非实现模板**——helper 拆法 / 变量名 / 中间变量 / wiring 顺序由 T2 实施者自定）:
  1. **per-function ≤30 行**：`raceModel` top-level body ≤30 行；若超限则拆成命名 helper（spec 举例 `buildCompositeSignal` / `createSettleGuard` / `wireTimerBranch`，**为举例非 mandate**，实施者可自选等价拆法），每个 helper 各 ≤30 行。runModelPhase 同守 ≤30 行/function（含 source 映射 switch）。
  2. **settle 闭包共址**：4 个 exit branch（adapter-resolve / timer-fire / caller-abort / post-settle SDK-error drop）必须留在**同一 settle 闭包**内，cleanup discipline 单点。可拆 helper 但**不跨文件拆 settle**，且 settle 本身不拆成多个函数。
  3. **`loop-engine.ts` 文件大小上限 = 700 行**。选择理由：当前 610 + 新增 module-level export 类型块（`RaceOutcomeSource` / `RaceModelOutcome` / `RaceModelHandle` / `RaceModelOpts` + 注释 ~30 行）+ `raceModel` 重写净增（child controller / composite signal / 4-branch settle / helper 拆分签名，~60 行 headroom）= ~700 上限。hard gate 是 function-level ≤30（真正的紧约束）；文件上限是防 runaway growth 的 guardrail，非紧约束。实施若逼近 700 必须回头拆 helper，**不得突破**。
- **Affects**: 无代码变更（纯决策记录）
- **Acceptance**: 决策写入本 plan，T2 实施时引用；实施后 `wc -l src/harness/loop-engine.ts` ≤ 700 且每个新增/重写 function body ≤30 行 □
- **Status**: [ ] pending

---

### T2. `[implementation]` raceModel abort + 结构化 handle + runModelPhase 临时映射

- **Affects**:
  - `src/harness/loop-engine.ts` - 新增 module-level export 类型（`RaceOutcomeSource` / `RaceModelOutcome` / `RaceModelHandle` / `RaceModelOpts`）；`raceModel` 改签名为 `(opts: RaceModelOpts) => RaceModelHandle`，内部 child `AbortController` + `AbortSignal.any([callerSignal, child.signal])` composite 透传 `adapter.step`，4-branch settle（timer fire **显式 `child.abort()` 后** settle `timerTimeout`）；`runModelPhase` 改为 `await handle.outcome` 并按 `source` 映射
  - `tests/harness/loop-engine.test.ts` - 在既有 "loop engine 017 S12–S17" describe block 内追加 4 个 `it()`（T2-new-1/2/3/4），**不新增 describe、不改文件名**
- **Acceptance**（binary，引自 spec Success Criteria，每条独立可验）:
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0；新增 test 计数 = 4；既有 test 计数不变 □
  - `npx tsx scripts/i9-real-anthropic-adapter-smoke.ts` 退出码 0（真实 SDK 链路不破）□
  - `git diff --name-only` 恰为 `src/harness/loop-engine.ts` + `tests/harness/loop-engine.test.ts` 两文件 □
  - `git diff package.json` 为空（无新依赖）□
  - `git diff src/harness/model-adapter/types.ts` 为空（`LoopAdapter` 公开接口不动）□
  - `git diff src/harness/loop-trace.ts` 为空（TurnTrace shape 不动）□
  - `wc -l src/harness/loop-engine.ts` ≤ 700；`raceModel` body 或其每个 helper ≤30 行（T1 硬门槛）□
  - 既有 S12 / S14 / S15 / S17 + 017 boundary 测试**零修改零回归** □
  - 4 新测试断言落地：T2-new-1（`APIUserAbortError` 不污染 `timerTimeout` 路由）/ T2-new-2（timer fire 后 composite `signal.aborted === true`）/ T2-new-3（caller abort 抢先路由 `callerAbort` / `cancelled`）/ T2-new-4（post-settle `controller.abort()` + `handle.childAbort()` 幂等不抛）□
- **Per-ticket loop**: tdd -> typecheck+tests -> code-review -> verification-before-completion -> commit on ticket branch
- **[blocks: T1]**（T2 实施前 T1 decision 必须先落定）
- **Status**: [ ] pending

**实施要点**（shape-level 约束，引自 spec，**非实现模板**——具体 helper 拆法 / 变量名 / timer+listener wiring 顺序由实施者按 T1 硬门槛自行决定）:

- `handle.childAbort()` 触发 `source: "hostCancel"`（与 timer fire 的 `timerTimeout` 区分；两者都映射 `stopReason: "timeout"`）— spec Q2 决议
- timer-fire branch **必须先 `child.abort()` 再 settle `"timerTimeout"`**（本 spec 修的 bug 本体：当前 loop-engine.ts:155 仅 settle-reject `MODEL_TIMEOUT` 不 abort signal）— spec Success Criteria #5
- `AbortSignal.any` 为 Node ≥20.3 stable API，repo 实测 v24.14，**不动 `engines.node`** □
- SDK 错误路由：post-settle 到达的 `APIUserAbortError` / `APIError` 家族由 `settled` guard 丢弃，不污染结构化 outcome；作为 first-event 到达的 SDK 错误走 `runModelPhase` try/catch（`ProtocolError` -> `protocolError` stop，else rethrow）— spec error-handling-enforcer
- `runModelPhase` 映射（#98 已落地，此临时双布尔映射已移除；runModelPhase 直接产出 cancelKind）：`source === "adapter"` -> `{ kind: "ok", result }`；`timerTimeout` -> `stopReason: "timeout"` + `cancelKind="timerTimeout"`；`hostCancel` -> `stopReason: "timeout"` + `cancelKind="hostCancel"`；`callerAbort` -> `stopReason: "cancelled"` + `cancelKind="callerAbort"` — spec Code Style
- mock 用 `import { APIUserAbortError } from "@anthropic-ai/sdk"` + stub adapter，**不挂真实 fetch / 真实 Anthropic client** — spec Testing Strategy
- `LoopAdapter` 公开接口（`step(state, request, signal?)`）**不动**；`run` / `step` / `createLoopEngine` 签名不动 — spec Boundaries / 015 冻结契约

---

## Section 4 - Tracker（GitHub main path）

- **T1** -> GitHub issue，label `ready-for-agent`，title `T1 [decision] 023 complexity-anti-drift 硬门槛 + file cap`
- **T2** -> GitHub issue，label `ready-for-agent`，title `T2 [implementation] 023 raceModel abort + 结构化 handle`，`blockedBy T1`（GraphQL `addBlockedBy` mutation 渲染原生 blocking 边）
- 创建顺序：T1 先（拿到 issue 号），T2 后（引用 T1 号建 blocking 边）

## Cross-references

- **architecture-change-reviewer verdict**: 5/5 yes（引自 spec Section 2 / 本 plan Section 2）
- **affected S1-S6 skills**: S2（defensive-contract，4 新测试覆盖 exception / concurrent / signal-state / idempotency 4 类边界）/ S5（complexity-anti-drift，T1 硬门槛 + file cap 700）/ S6（minimal-change，1 commit / 2 文件 / 零新依赖 / 冻结契约不动）
- **parallelization surface**: 无并行——T2 `blockedBy` T1，且本 plan 仅 1 个 implementation bullet（单原子重写）
- **out-of-scope deferred**: #97（全仓库位置参数 -> options object）/ SDK 错误分类缺口（map #44 Not yet specified）— 均不在本 plan；#98 已落地（TurnTrace 双布尔 -> 枚举 cancelKind），不再 deferred。
