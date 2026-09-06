# Plan: disclosure-index-align

**Goal:** 索引有描述则按名加载贵载荷；没有描述才 `tool_search`；收回 MCP 短描述；删除 `skill_search`。
**Approach:** 先把冻结目录变回名+短描述并改 `skill` 文案/删检索件；再把未加载直呼改成 `discover`；最后接 schema 退场形态与 MCP/skill 索引降档。文档已在 spec persist 落地，本计划不重写 ADR。
**Spec link:** `specs/disclosure-index-align.md`
**ACR:** PASS 5/5（见 spec 内块；下同）
**Tracker:** 本地 markdown（本 worktree 先交契约；issue 边由操作员决定是否开）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

```
bounded-context-guardian: yes — 改动落在既有 Harness/ACI/identity 与 TUI 映射，不新开检索器/加载器/技术分层
defensive-contract-validator: yes — empty=空段与无描述；negative=failed 不渲染 + 未知工具/未知 skill；overflow=schema 退场与索引降档；concurrent=邻轮 tools+system deep-equal；exception=countTokens 失败跳过
error-handling-enforcer: yes — 直呼合法 input 执行、否则非 error 投影 schema；废除 call tool_search first；溢出失败跳过+console.warn；删除名与未知工具同形失败
complexity-anti-drift: yes — 目录渲染 / hydrate / overflow 退场与降档 / 删 skill_search / TUI 分切面，无整条梯子塞进一个函数
minimal-change-verifier: yes — 单一产品契约「有描述则加载、无描述才 search」；实施 commit 后拆；不含新检索/skill({path})/schema upfront
```

## Decided vs Open

**Inherits：** ADR-0046 全条；ADR-0043 amendment（必经 tool_search 废除）；#631 120 字；10% countTokens；核心七件；lazy 尾部追加；firstTurnReady 冻结；`read_file` 目录外 skill。
**Open：** 目录段标签名是否仍叫 `mcp_name_directory`；hydrate 落在 registry 还是 executor；索引降档与 schema 退场是否同一次 countTokens。

## 待写入

空（CONTEXT / ADR-0046 / ADR-0043 amendment 已随 spec persist）。

## Tasks (ordered by dependency)

1. **MCP 索引恢复名+短描述且会话冻结** — tag: `[implementation]`
   - **Inherits:** spec Does #1；#631 `MCP_TOOL_SHORT_DESCRIPTION_MAX = 120`；firstTurnReady 后字节稳定
   - **Surface:** identity 加性段 + build-engine 目录快照
   - **Acceptance:** SC1 + SC2：connected 工具行有短描述（有则截 120）；无 connected 段缺席；相邻轮 system 含该段 deep-equal
   - Status: [ ] pending

2. **删除 skill_search 并改 skill 直呼文案** — tag: `[implementation]` `[parallel]`
   - **Inherits:** spec Does #4；ADR-0046 Decision 1
   - **Surface:** ACI 工具集 + TUI 摘要/settled
   - **Acceptance:** SC5 + SC6 + SC8：名单与 visibleSchemas 无 `skill_search`；未知 skill 引导无该名；E2E/`skill({name})` 直呼成功
   - Status: [ ] pending

3. **有描述则直呼 discover（废除先 tool_search 报错）** — tag: `[implementation]`
   - **Inherits:** spec Does #2/#3；ADR-0046 Decision 1
   - **Surface:** ACI registry / 执行链 + `tool_search` 描述
   - **Acceptance:** SC3：未 discover 的 `mcp__*` 合法 input 执行成功；缺参非 error 且含 schema；文案不再要求先 search；`tool_search` 描述声明仅无描述时用
   - Status: [ ] pending
   - [blocks: T1]

4. **内建 schema 退场索引为名+描述** — tag: `[implementation]`
   - **Inherits:** spec Does #5；ADR-0046 Decision 2（退场件不剥描述）
   - **Surface:** 溢出判定 + 名字目录渲染
   - **Acceptance:** SC4：退场件在索引中带 description；直呼不强制 `tool_search`；核心七件仍在首轮 `tools[]`
   - Status: [ ] pending
   - [blocks: T1, T3]

5. **MCP/skill 索引降档仅剥描述** — tag: `[implementation]`
   - **Inherits:** spec Does #6；ASSUMPTIONS #10 剥光后仍超阈则接受、不删名
   - **Surface:** 溢出/索引判定 + skill 段与 MCP 目录渲染
   - **Acceptance:** SC7：超 10% 后被降档条目仅名仍在；退场内建若在场仍带 description；失败跳过 + warn
   - Status: [ ] pending
   - [blocks: T1, T4]

## Code review phase

全部 bullet 落地后整轮一次 `arthurpower:code-review`。
