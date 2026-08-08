# Plan: 252 — loop stop 语义:超限收尾 + maxTurns 开关 + reactive compact 兜底

**Tracker**: GitHub issues (main path) — label `ready-for-agent`
**Spec**: `specs/252-loop-stop-semantics.md` (ACR all-yes)
**ADR**: 0011 (超限收尾) / 0012 (maxTurns 开关) / 0013 (reactive compact) / 0008 (usage 落点)
**Base branch**: `worktree-wayfinder-loop-stop` (当前活跃 worktree base)

**成功 = plan has 7 tracer bullets, each with binary acceptance + one `[decision]`|[implementation]` tag**

---

## T1. `[decision]` 三 surface throw 契约适配范围 + 收尾摘要事件路由

- **Affects**: `src/cli/chat.ts` (或 chat REPL 消费点) · `src/cli/ask.ts` · `src/session-api/` (serve 消费点) · `src/harness/stream.ts` (确认 `stop_summary` 事件消费面)
- **Acceptance**: 三 surface 各自的 catch 点 + 收尾摘要呈现方式已定案 (文字记录在本 ticket Resolution), 且此决定可作为 T4/T6 的实现输入 — 无 open 决策阻塞。
- **Per-ticket loop**: N/A (decision ticket, 无 code diff)

> 这是唯一 open 的契约面:spec Open Questions 里 "TUI/Web 展示形态" + "MaxTurnsExceeded 字段形态" + "cancelled/timeout 覆盖范围" 需在此定案后才能铺 T4/T6。

---

## T2. `[implementation]` PromptTooLongError 错误翻译 (adapter 地基)

- **Affects**: `src/harness/errors.ts` (新增 `PromptTooLongError extends ProtocolError`, 宿主于 `:17` 旁) · `src/harness/model-adapter/anthropic-adapter.ts:643/:510` (两个 SDK 调用点包 try/catch)
- **Acceptance**: 单测 — (`a`) SDK 400 prompt-too-long → 抛 `PromptTooLongError`; (`b`) 其他 400 → 原样 rethrow; (`c`) 非 400 → 原样 rethrow。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## T3. `[implementation]` loop-engine 超限 throw + reactive compact 分支

- **Affects**: `src/harness/loop-engine.ts:593-603` (silent stop → `throw MaxTurnsExceeded`) · `src/harness/loop-engine.ts:430-439` (ProtocolError 分支加 reactive 处理: `PromptTooLongError` → 压缩一次 → 重试, 每 run 限 1 次 `reactive_compact_attempted`)
- **Acceptance**: 单测 — (`a`) 超限 → `throw MaxTurnsExceeded` (不再 silent stop); (`b`) 模拟 prompt-too-long → 压缩一次重试; (`c`) 压缩后仍超 → throw; (`d`) 每 run 限 1 次。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## T4. `[implementation]` 收尾摘要 epilogue (真·模型摘要, 独立超时, 不污染历史)

- **Affects**: `src/harness/stream.ts` (扩 `HarnessStreamEvent` 加 `{ type: "stop_summary"; text }`) · `src/harness/loop-engine.ts` (异常停后跑一轮摘要: ~8K 尾部窗口输入, ~15s 独立超时 + catch-all, 失败即跳过, 不 append `_messages`, usage 落 `LlmCallRecord`)
- **Acceptance**: 单测 — (`a`) 超限/异常停后发 `stop_summary` 事件; (`b`) 摘要不进 `_messages`; (`c`) 摘要轮不计 maxTurns; (`d`) 摘要失败 (stub) → 跳过, 原始停因仍抛出。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## T5. `[implementation]` maxTurns 配置化 (CLI flag + env, 默认无限)

- **Affects**: `src/cli/parse-args.ts` (新增 `--max-turns`, 照 `--max-bytes` 先例 `:120-129`, 校验整数 + `n < 1` 拒绝) · `src/config/env.ts` (`LlmEnv` 加 `maxTurns?`, env `IKNOW_LLM_MAX_TURNS`) · `src/harness/loop-engine.ts:128` (`LoopEngineDeps.maxTurns: number` → `number | undefined`; `:593` `turnCount >= maxTurns` 需处理 undefined = 永不触发) · `src/harness/build-engine.ts:172` (`maxTurns: 6` → 读 env/flag, 缺省 `undefined` = 无限) · `src/tui/deps.ts:129` (`maxTurns: 6` → 读 env, 缺省 `undefined` — TUI 是独立装配点, 不经过 buildHarnessEngine)
- **Acceptance**: 单测 — (`a`) 不设 flag/env → `maxTurns === undefined` (无 6 硬编码, build-engine 与 tui/deps 双点); (`b`) `--max-turns 3` → 透传到 deps; (`c`) `--max-turns 0/-1/非整数` → parse-args 抛错; (`d`) `maxTurns === undefined` 时 loop-engine 永不触发 stop (类型层 `number | undefined` 编译通过)。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## T6. `[implementation]` 四 surface 适配 throw 契约 + 呈现收尾摘要

- **Affects**: chat REPL (`src/cli/chat.ts`) · ask (`src/cli/ask.ts`) · serve (`src/session-api/`) · tui (`src/tui/`) — 各自 catch `MaxTurnsExceeded` + 呈现 `stop_summary`
- **Acceptance**: 集成测试 — chat/ask/serve/tui 各: 设 `--max-turns` 撞上 → (a) 收 throw + (b) 呈现收尾摘要; serve 走 `IKNOW_LLM_MAX_TURNS` env。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

**依赖**: blocks on T1 (契约面) + T5 (flag/env 已就绪)

---

## T7. `[implementation]` compress Q3 注释更新 + 双保险共存测试

- **Affects**: `src/harness/compress/index.ts:1` ("reactive 不实现" → "reactive 已实现, ADR-0013") · `test/` (proactive + reactive 双保险共存单测)
- **Acceptance**: 单测 — proactive (估算触发) 与 reactive (错误触发) 双保险共存, 无优先级/阈值冲突; compress/index.ts 注释已更新。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

**依赖**: blocks on T2 (PromptTooLongError) + T3 (reactive 分支已通)

---

## 依赖图

```
T1 (decision) ──► T4 ◄── T2 ──► T3 ──► T7
   │                │            │
   └──► T6 ◄────────┘            │
        ▲                        │
        └── T5 ──────────────────┘
```

- T2 → T3 → T7 (reactive 链: 错误类 → 分支 → 注释/共存测试)
- T1 → T4 (收尾摘要契约面) 与 T6 (surface 适配)
- T5 → T6 (flag/env 就绪后 surface 才能透传)
- T4 与 T5 可并行 (无依赖); T3 与 T4 可并行 (无依赖)

`[parallel]`: T4 与 T5, T3 与 T4 可并行。

## Blocker 标注

- `[blocks: T6]`: T1 (契约面) · T5 (flag/env)
- `[blocks: T7]`: T2 (错误类) · T3 (reactive 分支)

## 边界 (from spec Boundaries)

- Always: 跑测试后才 commit; 摘要失败即跳过; 每 run reactive 限 1 次。
- Ask first: 改 `HarnessStreamEvent` 联合 / `_messages` append-only / 新依赖 / CONTEXT+ADR。
- Never: 保留 silent-stop; 摘要递归; reactive 无限重试; maxTurns 默认非无限。

## ACR per-bullet cross-check

- bounded-context-guardian: 全部改动在 `src/harness/` + config plumbing (T5) + surface catch (T6) — 无 session-api/RuntimeBundle/TUI 语义泄漏。
- defensive-contract-validator: T2 (exception/其他400) · T3 (overflow/exception) · T4 (empty/concurrent/exception) · T5 (negative/empty) — 覆盖 spec 五类。
- error-handling-enforcer: T3 reactive exceeded → throw; T4 摘要 catch-all; T6 surface catch — 无静默路径。
- complexity-anti-drift: 复用 `compactMessages` / `envInt` / `--max-bytes` 先例 / 现有 ProtocolError 分支。
- minimal-change-verifier: 7 bullets = 7 logical tasks, 无 scope creep; Open Questions 已由 T1 收敛。
