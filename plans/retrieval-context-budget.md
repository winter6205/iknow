!# Plan: retrieval-context-budget（检索进窗：计量 + search/fetch 瘦身）

**Goal:** 多轮 `web_search` / `web_fetch` 不再因估算把 `tool_result` 当成几乎零 token 而错过 proactive compact；单次搜索与抓取进权威历史的体积可控。不换默认搜索后端。
**Approach:** 严格串行三 commit：先修压缩账本（A），再搜索字段/条边界预算（B），再抓取减噪声与同 URL 内存缓存（C）。禁止 T2 与 T3 并行合入。适配器、阶段 D、默认 Exa/MCP 均不在本计划。
**Spec link:** 无独立 spec。契约继承 LogicSync 选定 R（A+B+C）与 ADR-0004 契约 X、ADR-0006（executor 20000、禁止落盘 offload）、ADR-0008 D6（估算只供 compact 判据）、ADR-0013（proactive + reactive 共存）、CONTEXT `auto-compact token gate` / `append-only messages` / `executor truncation authority`。
**Tracker:** 本文件为跟踪 SSOT。不按 tracer bullet 建 GitHub issue（操作员指示）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch（整轮结束后再跑一轮 code-review，不按 commit 重复）。

## 待写入（persist 段）

- 空。不新增领域词；不新开 ADR；不 reopen ADR-0006。

## Out of scope

- 默认改接 Exa / Tavily / Firecrawl / 无 key 厂商轮询；把 `web_search` 换成 MCP 搜索面。
- 结果落盘指针、改 executor 20000、JS 整页渲染。
- 从权威 messages 删除或改写已追加的旧 web `tool_result`（阶段 D）。
- 可插拔搜索 HTTP 适配器（工具仍 `web_search`、零 key 默认仍 Bing HTML）——本计划完成后另做，不写入本文件跟踪面。

## ACR

首轮 pre-impl 门禁 **BLOCKED**（defensive-contract-validator / error-handling-enforcer / minimal-change-verifier）。本文件已按裁决补：每 bullet 点名新行为的五类、T2/T3 的 typed + `// EXIT:` 降级、**禁止 T2∥T3**，顺序锁定 T1 → T2 → T3、各 1 commit、永不合并。

```
bounded-context-guardian: yes — T1 只动 harness compress（estimate）；T2 只动 ACI web_search；T3 只动 ACI html-text/web-fetch；executor 零改、无反向 import、无新 top-level context。
defensive-contract-validator: yes — 新行为五类写在各 Acceptance（T1：`[object Object]` vs 文本块数组；T2：字段 cap overflow + 同 query 并发去重；T3：抽空正文 / max_chars overflow / 同 URL 缓存并发 / SSRF exception），挂在既有 estimate / web-search / web-fetch 测试面，不发明未落地的测试路径。
error-handling-enforcer: yes — T2 字段裁到空、按条丢光、去重命中/未命中均有 typed 结果或 ToolExecutionError + `// EXIT:`；T3 抽取失败回退、缓存 miss/hit、禁止落盘均有 EXIT；禁止空串冒充成功、禁止 truncated/total 自称字段。
complexity-anti-drift: yes — 估算 switch、search 字段投影、html-text 抽正文、web-fetch 窗口/缓存分模块一层，无三阶段合一 god-handler，适配器仍 out of scope。
minimal-change-verifier: yes — 三件逻辑任务三 commit：T1 计量 → T2 搜索预算 → T3 抓取提取与缓存；禁止并行合入、禁止单 commit 混装。
OVERALL: PASS — hand to writing-plans
```

## Tasks (ordered by dependency)

1. **T1 压缩估算看见真实 tool_result 体积** — tag: `[implementation]`
   - **Inherits:** ADR-0008 D6：chars/N 估算只供 compact 判据，不进 usage/trace。ADR-0013：proactive 与 reactive 共用压缩，估算失准不得再把万字 `tool_result` 判成低于阈值。encode 成功路径 `tool_result.content` 为文本块数组，不得用 `String(array)` 变成 `[object Object]`。`append-only messages` 本 bullet 零改写。
   - **Surface:** harness compress（估算与既有 trigger/estimate 测试面）。
   - **Acceptance:**
     - **empty：** `content` 缺席、`[]`、或 string `""` → 有界小估算，不抛。
     - **negative：** `content` 既非 string 也非数组（及非 text 块）→ 不估成 0、不崩 `evaluateCompactTrigger`；`// EXIT:` 走有界降级（计 0 以外的明确规则，禁止再 `String(array)`）。
     - **overflow：** 单块超长 text 数组 → 估算量级足以跨过既有 auto-compact threshold（fixture，不打 LLM）。
     - **concurrent：** 纯函数无共享可变状态则 N/A，测试固定两份 messages 交叉调用结果独立。
     - **exception：** 与「`String([{type,text}]) === '[object Object]'`」对照：同一长正文数组的估算必须远大于对该结构 `String(content)` 的结果。
     - thinking / redacted_thinking：若会出现在 compact 估算的 messages 里则计入；否则回归锁定「漏计」不会再引入。
     - `tests/harness/compress/estimate.test.ts`（trigger 若被牵动一并绿）；`npm run typecheck` exit 0。
   - Status: [ ] pending

2. **T2 web_search 字段预算 + 按条截断 + 同 query 去重** — tag: `[implementation]`
   - **Inherits:** ADR-0006 两层：工具级管语义单位（条/字段），executor 仍是字符总闸与截断元数据唯一权威；输出不得带 `truncated`/`total`。默认搜索端点与 SSRF 不变（Bing HTML，`search_url` 覆写仍可用）。去重不得改写历史上已追加的 `tool_result`。
   - **Surface:** ACI `web_search`（含既有 web-search 测试面）。
   - **Acceptance:**
     - **empty：** 解析零结果 → 既有 `ToolExecutionError`，不改成空串成功。
     - **negative：** `max_results` 非法仍 schema/clamp；字段裁完后 title+snippet+URL 皆空的一条 → `// EXIT:` 丢该条，不输出无意义空项。
     - **overflow：** 超长字段 cap；拼完仍超工具自限则按整条丢尾；若丢到 0 条 → `// EXIT:` typed `ToolExecutionError`（与零结果同一失败族，消息可区分「有命中但预算丢光」），禁止半条切断、禁止 `truncated`/`total` 字段。
     - **concurrent：** 两不同 query 缓存不串；同 query 并行至多一次上游 HTTP（或测死「至多两次且不炸」并 `// EXIT:` 注释竞态）。
     - **exception：** SSRF / 非 2xx 仍带前缀的 `ToolExecutionError`。去重命中：`// EXIT:` 短投影成功，仍新追加 tool_result，不改写旧消息；未命中走完整解析。
     - 既有 web-search 测试全绿；`npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T1]

3. **T3 web_fetch 正文提取 + 默认窗下调 + 同 URL 内存缓存** — tag: `[implementation]`
   - **Inherits:** `UNTRUSTED_BANNER` 与 SSRF 保留。ADR-0006：完整抓取不落盘；窗口元数据仍在 output 头部，executor 不信任工具截断字段。`start_chars` 续窗协议已落地（`plans/web-fetch-html-window.md`）：本 bullet 不得破坏 `Window:` 行与 `returned` 语义。默认 `max_chars` 下调且仍落在既有 schema 500..16000；可配置/可调用覆盖。缓存不得 mutate 旧 messages。
   - **Surface:** ACI `web_fetch` 与共享 HTML 纯化。
   - **Acceptance:**
     - **empty：** 空 HTML、抽取后无主内容、`start_chars === original_length` → 成功空窗 + `Window:` + banner；抽取失败 `// EXIT:` 回退既有整页 `htmlToText`（或等价），不空串冒充「已提取」。
     - **negative：** 非法 `start_chars` / `max_chars` → `ToolExecutionError`，不静默 clamp。
     - **overflow：** 默认 `max_chars` 下调仍在 500..16000；超长页经 executor 硬顶；无工具自称 truncated 字段。
     - **concurrent：** 两 URL 缓存不串；同 URL 并行至多一次上游 fetch（竞态 `// EXIT:` 写死）。
     - **exception：** SSRF / 非 2xx 不变。缓存 miss 打网；hit 不打网且新追加续窗 tool_result。`// EXIT:` 禁止把正文写入工作区或 session 旁路文件（ADR-0006）。
     - 既有 web-fetch 窗口/html 测试更新默认窗断言后全绿；`npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T2]

## Code review phase

T1–T3 全部落地后，整轮 diff 过一次 end-of-round code-review，再宣称本计划完成。
