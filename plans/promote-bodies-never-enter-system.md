# Plan: 记忆正文不再进入 system — promote 只服务 GC

**Goal:** `autoExtract` 开启时 system 不再摊 promote 正文；可晋升条目仍能被预取撞词命中；召回保持纯读。
**Approach:** 先改装配与预取同一条运行时契约（system 无 body、预取不按资格排除），再把仍写「promote 进 system / 已晋升不再预取」的下游 spec 对齐。ADR / CONTEXT 已 persist，实施票不重写。catalog 与 prefetch 载荷形状不动。
**Spec link:** `specs/promote-bodies-never-enter-system.md`
**Tracker:** 本地 markdown（本努力不开 GitHub issue；无 `gh` 票、无 blocking edge）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

两条即可：运行时是一条可演示行为；文档对齐是第二条。不拆成「先装配后预取」——缺任一半 SC1/SC3 都不成立。

## ACR

planned files: `src/harness/memory/assembly.ts`, `src/harness/memory/prefetch.ts`, `tests/harness/memory/assembly.test.ts`, `tests/harness/memory/prefetch.test.ts`, `tests/harness/memory/integration.test.ts`, `tests/harness/memory/refresh.test.ts`, `specs/auto-memory-layering.md`, `specs/auto-memory-low-trust-read.md`, `specs/casual-ask-context-hygiene.md`, `specs/README.md`.

```
bounded-context-guardian: yes — 装配与预取改动留在 harness/memory；不碰 isolation / identity / ACI 建树；不把 AGENTS.md 作者权做成新工具
defensive-contract-validator: yes — SC 覆盖 empty（无资格条目时 system 仍无 promote 块）、negative（资格条目不得进 system、disabled 仍不预取）、overflow（预取 5 条帽与 catalog 帽本票不放宽）、concurrent（per-root memoryDir / 会话快照仍冻结 catalog）、exception（目录/预取 IO 仍 log-and-continue）
error-handling-enforcer: yes — 不新增空 catch；召回保持纯读失败路径；装配失败不毒化缓存（既有 refresh 合同）
complexity-anti-drift: yes — 删掉 system 拼段与预取排除，不把 GC 资格函数塞进装配
minimal-change-verifier: yes — 一个 destination（ADR-0044）；落地按本 plan 分 commit（运行时契约 / 下游 spec 对齐）；禁止与 catalog 去掉、prefetch 瘦身、AGENTS.md 下令混提
```

## Tasks (ordered by dependency)

1. **System has no promote bodies; prefetch still hits eligible entries** — tag: `[implementation]`
   - **Inherits:** spec Does：装配不输出 `formatPromote` 块；prefetch 不按 `eligibleForPromote` 排除；`disabled` 仍丢；`memory_recall` 不调用 `recordRecall`；不新增 AGENTS.md 作者句。SC1–SC7。
   - **Surface:** harness memory assembly / prefetch
   - **Acceptance:** SC1–SC7 为真；`npx vitest run tests/harness/memory/` EXIT 0
   - Status: [ ] pending

2. **Downstream specs stop promising promote-in-system** — tag: `[implementation]`
   - **Inherits:** spec Changes：`auto-memory-layering` 不再要求 autoExtract 同闸拼 promote 段；`auto-memory-low-trust-read` 不再写「已在 promote 段的条不再预取」；`casual-ask-context-hygiene` 不再把 promote 列进「不改」；`specs/README.md` 列出本 spec。
   - **Surface:** specs 索引与上述三份读路径 spec
   - **Acceptance:** 上述文件与 ADR-0044 不再互相矛盾；本 spec 已出现在 `specs/README.md` 身份与记忆组
   - Status: [ ] pending
   - [blocks: T1]

## 待写入

清单空。ADR-0044 / CONTEXT 已在 SPECIFY persist 刷进本 worktree。
