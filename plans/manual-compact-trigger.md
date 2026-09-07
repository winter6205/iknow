# Plan: 手动 `/compact` 与 auto 开火同效果（扳机分离）

**Goal:** `/compact`（及 web 压缩按钮）立刻跑一次与 proactive auto-compact **已经开火之后**相同的压缩，不再被 auto-compact token 门挡住。
**Approach:** 压缩执行体不新开一条；只把手动路径的扳机从「先过 167k 估算」改成「斜杠/按钮 = 视作已过门」。loop-engine proactive 阈值与公式不动。两刀：先 session-api 行为 + 测试可演示，再 TUI/Web 文案跟 reason 对齐。少于三刀是因为没有独立 schema/路由切片，第三刀会变成垫文件。
**Spec link:** `specs/672-fault-recovery.md` Boundaries Out：「手动 `/compact` 不走 token 门（#270 / compress 独立 PR）」。产品补句由本计划 Harvest 冻结（操作员 2026-09-07）：效果同 auto 开火，扳机不同。
**Tracker:** 本地 markdown fallback。操作员明确指示不用 GitHub issue tracker；无 `ready-for-agent` issue、无 GraphQL `addBlockedBy` 边。本文件即票面。
**Worktree:** `.claude/worktrees/manual-compact-trigger` · branch `plan/manual-compact-trigger`
**ACR:** all-yes

```
bounded-context-guardian: yes — 手动入口仍在 session-api hub；token 公式与 evaluateCompactTrigger 仍在 harness/compress；loop-engine proactive 不改模块归属；不新建 bounded context
defensive-contract-validator: yes — T1 覆盖 empty（空会话 no-op）/ negative（条数少仍走与 auto 开火相同的 full_summary 支）/ overflow（默认窗 167k 下短会话必须压缩）/ concurrent（既有 serialize）/ exception（signal abort 仍 cancelled、不落盘）
error-handling-enforcer: yes — 不新增吞错 catch；abort / empty_response / adapter 失败仍走既有 FullCompactOutcome 与 EXIT；手动不再把「未达 auto 阈值」当成功路径上的静默成功压缩
complexity-anti-drift: yes — 计划是扳机分叉不是第二套压缩器；禁止把 auto 阈值公式改掉来「顺便让手动能压」
minimal-change-verifier: yes — 一个逻辑任务（手动扳机≠auto 门）；拆成下列 tracer 各 1 commit；不改 DEFAULT_KEEP_RECENT、不改 167k 公式、不改 estimateMessagesTokens、不改 ADR-0008 usage 账
```

**affects:** `src/session-api/` compact 入口；既有 compact 集成测试；TUI `/compact` notice；web compact hook 文案；`docs/CONTEXT.md`（persist，非本计划 commit 混进业务刀）

**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch

**Code review phase (end of round):** 两刀都合入后对整轮 diff 跑一次 `arthurpower:code-review`（Standards + Spec），再 `verification-before-completion`。单刀 WIP commit 不重复整轮审查。

## Harvest

**Settled:**

- 手动 `/compact` 不走 auto-compact token 门（672 Out；`docs/STATUS.md` 同句）。
- 手动触发后的**效果** = proactive 在 `evaluateCompactTrigger` 已过 token 门之后会走的那条：有可丢前缀 → 窗口压缩；无可丢前缀但仍有内容 → `full_summary`。执行体仍是既有 `runFullCompact` / `compactMessages` 回退，与 auto 开火共用，不分叉压缩实现。
- 空会话 / 无可压缩内容 → `compacted:false`，不落盘、不 bump `updatedAt`（既有幂等）。
- cancel / abort → `cancelled:true`，与「未压缩」区分（既有 #548）。
- proactive auto-compact 仍用 `getAutoCompactThreshold`（缺省 `window − 20000 − 13000`）；`IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` 只覆盖自动路径。
- token 估算仍只做判据、不进 `lastUsage` / trace（ADR-0008 D6）。

**Open（折进 T1/T2，不另开 [decision]）:** 空会话的 `reason` 字面继续用 `messages_too_few` 还是保留 `below_token_threshold` 仅给 auto；TUI/Web 用户可见 copy 字面（锁「不是 auto 阈值挡住」语义即可）。

**Contradicts CONTEXT（非 ADR）:** `docs/CONTEXT.md` 现写「手动 `/compact` 与 auto 共用 `evaluateCompactTrigger` 且 token 门一并约束手动」——那是 #601 文档，与 672 与本次操作员冻结冲突。不重开 ADR-0013（那条是 proactive/reactive 共用 `compactMessages`）。待写入见下。

## 待写入（persist）

已 flush 到 worktree `docs/CONTEXT.md`（**compact reason** / **auto-compact token gate** / **manual compact**）。无 ADR。

## Tasks (ordered by dependency)

1. **手动 compact 视作已过 token 门** — tag: `[implementation]`
   - **Inherits:** 672：手动 `/compact` 不走 token 门。操作员：效果与 auto 开火后相同。空会话 no-op。proactive 阈值公式零改。有窗口则窗口路径，无窗口有内容则 full_summary。serialize / abort 既有契约保留。
   - **Surface:** `session-api`（hub 手动 compact 入口）；`harness/compress` 仅复用既有判据的「过门之后」两支，不改默认阈值函数
   - **Acceptance:** 生产缺省阈值（`thresholdTokens` 缺席 → 约 167k）下，短会话且消息数超过保留尾窗时 `compactSession` 返回 `compacted:true` 并落盘。同配置下空会话仍 `compacted:false` 且 `updatedAt` 不变。消息不超过尾窗但非空时走与 auto 开火相同的 full_summary 支（不是 `below_token_threshold` noop）。loop-engine 在估算低于缺省阈值时仍不 proactive compact。`npx vitest run tests/session-api tests/harness/compress tests/harness/loop-engine.test.ts` 与 `npm run typecheck` exit 0。
   - Status: [ ] pending

2. **手动压缩文案不再说「未达自动阈值」** — tag: `[implementation]`
   - **Inherits:** T1 的 reason 语义。客户端按 `CompactSessionResponse.reason` 分文案；禁止把「auto token 门未过」当成手动成功压缩的失败解释。copy 字面 open。
   - **Surface:** `src/tui/`；`web/` compact 提示
   - **Acceptance:** 短会话手动压缩成功后，TUI/Web 提示压缩已发生（windowed 或 full_summary 分支），不出现「当前 token 未达压缩阈值 / 上下文未达压缩阈值」。空会话仍提示无可压缩上下文。`npx vitest run tests/web` 与 bun `tests/tui/` compact notice 相关用例 exit 0。
   - Status: [ ] pending
   - [blocks: T1]
