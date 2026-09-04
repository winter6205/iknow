# Plan: 记忆读通道停下令 · worktree 门禁按「会不会写工作区」分类

**Goal:** 记忆读通道不再下令召回；隔离门禁只拦真写入，回执不再把模型下一拍收成建树。
**Approach:** 先改记忆指针/纪律/工具说明与默认 limit（同一读通道），再拆门禁分类器（不碰 bash readonly 表），最后改 unbound 回执文案。文档修订已在 SPECIFY persist 落盘，实施票只动代码与测。
**Spec link:** `specs/casual-ask-context-hygiene.md`
**Tracker:** 本地 markdown（与地图同一裁定：不开 GitHub issue）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

planned files: `src/harness/memory/assembly.ts`, `src/harness/memory/catalog.ts`, `src/harness/memory/tools/recall.ts`, `src/harness/isolation/worktree-gate.ts`, corresponding tests under `tests/harness/memory/` and `tests/harness/isolation/`.

```
bounded-context-guardian: yes — 记忆读通道改动留在 harness/memory；门禁分类与回执留在 harness/isolation；memory 不 import bash-readonly；isolation 不改 ACI 建树工具形态
defensive-contract-validator: yes — SC 覆盖 empty（空/非字符串 bash）、negative（2>&1 只读不得标 mutate；标题撞词不得当必须召回）、overflow（recall 默认 3、目录帽不变）、concurrent（per-root memoryDir / 门禁按会话绑定未改）、exception（未知 bash fail-closed mutate；装配失败仍 log-and-continue）
error-handling-enforcer: yes — 只读误判改为放行；真 mutate 仍 typed 可见 notice；validateReadonlyCommand 失败路径不动；无空 catch
complexity-anti-drift: yes — 工作区写入判定从 readonly 表拆出，不把两套语义揉进一个 validateSegment；classifyCall 保持按工具名分支
minimal-change-verifier: yes — 一个 destination（通道卫生）；落地按本 plan 分 commit（记忆读 / 门禁分类 / 回执文案）；禁止与 ES、意图分类器、建树 ACI 混提
```

## Tasks (ordered by dependency)

1. **Stop commanding recall on the read path** — tag: `[implementation]`
   - **Inherits:** spec Does：EXISTENCE_POINTER = `A memory library is available.`；纪律句全文锁定；`memory_recall` 默认 limit 3、description 不含 `at the start of a task`；prefetch 与 autoExtract 不动
   - **Surface:** harness memory assembly / catalog / recall tool
   - **Acceptance:** SC1–SC4 与 SC8–SC9 的 memory 半边为真；既有 `tests/harness/memory/` 预取与 ask opt-out 仍绿
   - Status: [ ] pending

2. **Classify bash by workspace write, not readonly-mode table** — tag: `[implementation]`
   - **Inherits:** spec Does：`classifyCall` 不调 `validateReadonlyCommand`；`date '+%Y-%m-%d' && ls … 2>&1 | head` → read；`echo x > f.txt` / 非字符串 command → mutate；`validateReadonlyCommand("ls 2>&1")` 仍抛
   - **Surface:** harness isolation gate
   - **Acceptance:** SC5–SC6 为真；`tests/harness/isolation/worktree-gate.test.ts` 与 bash-readonly 测绿
   - Status: [ ] pending
   - [parallel] with T1

3. **Factual unbound mutate notice** — tag: `[implementation]`
   - **Inherits:** spec Does：notice 含 `create-task-worktree`、含这次调用会写且未执行、不含 `this conversation's task worktree`
   - **Surface:** harness isolation gate
   - **Acceptance:** SC7 为真；真 mutate 仍被拦且点名建树工具
   - Status: [ ] pending
   - [blocks: T2]

## 待写入

清单空。ADR / CONTEXT 已在 SPECIFY persist 刷进本 worktree。
