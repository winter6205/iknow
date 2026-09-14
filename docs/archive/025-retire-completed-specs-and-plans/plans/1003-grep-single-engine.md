# Plan: #1003 grep 单引擎 + Node 降级（非双方言同判）

**Goal:** 生产 `grep` 有 rg 时匹配只出 rg；无 rg 时用 Node 扫文件 + JS 编得过的 pattern。验收对象是 `createGrepTool` handler，不是门禁函数 fuzz。
**Approach:** 先钉「降级 ≠ 第二台 ripgrep」；再改生产路径与 handler 级测试；丢掉把 JS `RegExp` 对齐 rg（含 `--engine=auto`）当成合同的 WIP。不修 #1000 落点（那是 `docs/plans/home-project-tree.md`）。
**Spec link:** LogicSync（本会话）；`feat/aci-grep-surface` 上 `specs/aci-file-search-surface.md` **D6/SC9「Node 全语义」读法作废**，以本计划 + ADR-0089 为准。ADR-0004「rg 优先 + Node fallback」不废，只收窄 fallback 含义。
**ACR:** all-yes（2026-09-13）

```
bounded-context-guardian: yes — 只动 harness ACI grep（及同模块测试）；不把搜面合同写进 session-api / 数据目录。
defensive-contract-validator: yes — 空/非法 pattern、rg ENOENT、rg 非零退出、并发 abort、超大/二进制跳过，验生产 handler。
error-handling-enforcer: yes — rg 起不来的 EXIT = Node 降级（非 typed 拒整次调用、非改去 PATH 另找一台当「自带引擎」）；坏 JS 正则仍 ToolExecutionError。
complexity-anti-drift: yes — 不保留「双方言对齐器」；Node 不复制 rg 默认引擎拒绝集。
minimal-change-verifier: yes — 单任务 #1003；不含 home 项目树、不含 grep 排除 `.iknow`。
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

**Sibling:** #1000 落点 → `docs/plans/home-project-tree.md`。两计划可并行；合入顺序不强制，但 #1000 未做完时工作区日记仍可能被搜到，那不算本票回归。

**Out of scope:** 安装根自带 rg 发版（文件搜面 spec 旧 D6 二进制分发）；合入 `wip/aci-grep-parity-r5`；用排除表修 #1000。

**待写入:** flushed 2026-09-13（ADR-0089）。CONTEXT 无新词。

## Harvest

**Settled**

- 有 rg：匹配不走 JS。
- 无 rg（ENOENT / 无法执行）：仍要能搜；Node 遍历 + `RegExp` 编得过的 pattern。
- 不做双方言同判（JS ≡ rg，含强迫 PCRE2/`--engine=auto` 来凑 fuzz）。
- Node **不**模仿 rg 默认引擎拒绝集（lookaround 等在无 rg 机器上可以更宽）。
- 验收 = 生产 handler 输出；门禁 `pattern.ts` fuzz `DIVERGE=0` 不能当本票绿。
- `wip/aci-grep-parity-r5` 勿合。

**Open for implementer**

- rg 二进制如何解析（PATH `rg` vs 注入路径）——本票不改「必须自带安装根二进制」除非现有装配已经钉死。
- Node 扫的 ignore / hidden / 跳过目录表：保持与现行 grep 一致即可，**不要**为了 #1000 加整棵 `.iknow` 排除。

> Contradicts `specs/aci-file-search-surface.md` D6/SC9（仅 feature 枝）「Node 扫必须实现 D2–D5 全语义」— worth reopening because 两套形式语言没有同一判据，fuzz 测错了函数。

## Tasks (ordered by dependency)

1. **合同：降级不是第二引擎** — tag: `[decision]`
   - **Inherits:** Harvest Settled；ADR-0004 grep 仍是 rg 优先 + fallback。
   - **Surface:** `docs/adr/`
   - **Acceptance:** ADR-0089 accepted；写明 Node 路径允许与 rg 命中集不同；禁止把 handler 与 JS 方言 leak:0 当发布门。
   - Status: [x] done 2026-09-13

2. **生产 handler：rg 成功则只信 rg** — tag: `[implementation]`
   - **Inherits:** ADR-0089；有 rg 不把命中再经 JS 过滤。
   - **Surface:** harness ACI grep
   - **Acceptance:** 注入可用 rg 时，lookaround / rg 能吃的 pattern 的工具输出与 rg 子进程一致（允许行截断等既有输出整形）。注入 ENOENT 时走 Node，调用成功（非因「无 rg」拒绝）。相关 vitest 打在 **createGrepTool / handler**，不把门禁 fuzz 当本条绿。
   - Status: [ ] pending
   - [blocks: T1]

3. **Node 路径：能编则搜，不抄 rg 拒绝集** — tag: `[implementation]`
   - **Inherits:** ADR-0089 选 A（不模仿 rg 默认引擎拒绝集）。
   - **Surface:** harness ACI grep（fallback 扫描）
   - **Acceptance:** ENOENT 档上，合法 JS 正则（含 lookaround）可出命中；非法 JS 正则仍 `ToolExecutionError` 且消息含 pattern。不要求与同 pattern 的 rg 命中条数相等。
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel] 可与 T2 同窗，只要测试用 spawn seam 切开两条路

4. **丢掉同判 WIP 的合同意义** — tag: `[implementation]`
   - **Inherits:** 勿合 `wip/aci-grep-parity-r5`；`--engine=auto` 不得成为「对齐 JS」的手段。
   - **Surface:** 若实施枝来自 `feat/aci-grep-surface`，搜面 argv / pattern 门禁
   - **Acceptance:** 合入 master 的 grep 路径没有「生产匹配 = JS 与 rg leak:0」的测试或注释合同。未合入的 parity WIP 不进本 PR。
   - Status: [ ] pending
   - [blocks: T2]

## Code review phase

全部 implementation bullets 落地后跑一轮 `code-review`；`GATE: BLOCKED` 则下一槽 `review-report-repair`，再 `verification-before-completion`。
