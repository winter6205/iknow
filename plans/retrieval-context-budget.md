# Plan: retrieval-context-budget（检索进窗：计量 + search/fetch 瘦身）

**Goal:** 多轮 `web_search` / `web_fetch` 不再因估算把 `tool_result` 当成几乎零 token 而错过 proactive compact；单次搜索与抓取进权威历史的体积可控。不换默认搜索后端。
**Approach:** 先修压缩账本（A），再在工具层给搜索字段/条边界预算（B），再给抓取减噪声并避免同 URL 重复灌窗（C）。三刀都坐在既有 ACI 工具面与 executor 总闸之下。适配器式 Agent 搜索 API、会话级丢旧 web 结果（D）、默认 Exa/MCP 均不在本计划。
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

操作员在 LogicSync 定 R 后直接 `/writing-plans`。下列 5 行按本切片填写（compress 与 ACI web 工具分 commit，executor 零改动）。

```
bounded-context-guardian: yes — T1 只动 harness compress 估算；T2 只动 ACI web_search；T3 只动 ACI web_fetch/html-text；三面已存在、无新 bounded context；executor 与 MCP 装配不在切片内，无反向依赖意图。
defensive-contract-validator: yes — 每 bullet 在既有 compress / web-search / web-fetch 测试面覆盖 empty / negative / overflow / concurrent / exception（见各 Acceptance）；不把五类写进未创建的测试路径名。
error-handling-enforcer: yes — 估算失败不得吞成 0；search/fetch 仍走既有 ToolExecutionError 前缀路径；缓存未命中与 SSRF/非 2xx 不得改成空串成功；封顶与缓存 miss 预置 EXIT 语义，不引入 truncated/total 工具自称字段。
complexity-anti-drift: yes — 估算、字段投影、抽取/窗口/缓存分职责，禁止把三阶段塞进单一 god-handler；复杂度门槛见 complexity-anti-drift skill，本计划不抄数字。
minimal-change-verifier: yes — 一个逻辑主题、三个有序 tracer bullet、各 1 commit；文档只在需要说明默认窗变化时随 T3，不与 T1/T2 混提。
OVERALL: PASS — hand to writing-plans
```

## Tasks (ordered by dependency)

1. **T1 压缩估算看见真实 tool_result 体积** — tag: `[implementation]`
   - **Inherits:** ADR-0008 D6：chars/N 估算只供 compact 判据，不进 usage/trace。ADR-0013：proactive 与 reactive 共用压缩，估算失准不得再把万字 `tool_result` 判成低于阈值。encode 成功路径 `tool_result.content` 为文本块数组，不得用 `String(array)` 变成 `[object Object]`。`append-only messages` 本 bullet 零改写。
   - **Surface:** harness compress（估算与既有 trigger/estimate 测试面）。
   - **Acceptance:**
     - 含数组形态 `tool_result`（块内为长 text）的 messages，`estimateMessagesTokens` 随正文长度单调增大，且远大于对同一结构做 `String(content)` 的结果。
     - 空 content / 空数组走 empty：估算为有界小值，不抛、不当成巨大窗口。
     - 非预期 content 形态（非 string 非数组）走 exception/negative：不把体积估成 0 且不崩 compact 判据。
     - 超长单块 overflow：估算反映长度量级，足以让 `evaluateCompactTrigger` 在既有 threshold 下不再 `below_token_threshold`（用 fixture messages，不打真实 LLM）。
     - concurrent：两份不同 messages 并行估算互不串扰（纯函数则声明 N/A 并在测试中固定无共享可变状态）。
     - thinking / redacted_thinking：若该块会出现在送给 compact 估算的 messages 里，则计入；若产品路径从不把它们送进该函数，Acceptance 写明并加回归防再漏计。
     - `tests/harness/compress/estimate.test.ts`（及该模块既有 trigger 测试若被行为牵动）全绿；`npm run typecheck` exit 0。
   - Status: [ ] pending

2. **T2 web_search 字段预算 + 按条截断 + 同 query 去重** — tag: `[implementation]`
   - **Inherits:** ADR-0006 两层：工具级管语义单位（条/字段），executor 仍是字符总闸与截断元数据唯一权威；输出不得带 `truncated`/`total`。默认搜索端点与 SSRF 不变（Bing HTML，`search_url` 覆写仍可用）。去重不得改写历史上已追加的 `tool_result`。
   - **Surface:** ACI `web_search`（含既有 web-search 测试面）。
   - **Acceptance:**
     - 每条结果的 title / snippet / URL 有字段上限；超长字段被裁后仍是合法列表项（可被模型当纯文本读），整次输出在拼完后若仍超工具自限，按**整条结果**丢尾，不在某条中间切断。
     - empty：零结果仍 `ToolExecutionError`（既有语义不降级）。
     - negative：`max_results` 非法仍走既有校验/clamp，不产出无上限倾倒。
     - overflow：超长 title+snippet 的 fixture HTML 解析后，handler 输出字符数低于 executor 硬顶，且不含工具自称 truncated 元字段。
     - 同一 process 内相同 query（大小写/空白归一化规则由实现选定并测死）第二次调用不把第一份全文再灌一遍；第二次仍追加一条新 tool_result（append-only），内容为短回执或同等短投影。
     - concurrent：两不同 query 并行不串缓存；同 query 并行至多打一次后端（或文档化竞态下至多双次并测试不炸）。
     - exception：非 2xx / SSRF 仍 `ToolExecutionError`，前缀纪律不变。
     - 既有 web-search 测试全绿；`npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel] 与 T3：T1 合入后可与 T3 并行

3. **T3 web_fetch 正文提取 + 默认窗下调 + 同 URL 内存缓存** — tag: `[implementation]`
   - **Inherits:** `UNTRUSTED_BANNER` 与 SSRF 保留。ADR-0006：完整抓取不落盘；窗口元数据仍在 output 头部，executor 不信任工具截断字段。`start_chars` 续窗协议已落地（`plans/web-fetch-html-window.md`）：本 bullet 不得破坏 `Window:` 行与 `returned` 语义。默认 `max_chars` 下调且仍落在既有 schema 500..16000；可配置/可调用覆盖。缓存不得 mutate 旧 messages。
   - **Surface:** ACI `web_fetch` 与共享 HTML 纯化。
   - **Acceptance:**
     - 带 nav/footer 的 fixture HTML，`as=text` 默认路径进入模型的正文明显短于「整页 htmlToText」基线，且仍含主内容样例句。
     - empty：空 HTML / `start_chars === original_length` 仍成功空窗 + Window 行 + banner。
     - negative：非法 `start_chars` / `max_chars` 仍 `ToolExecutionError`，不 clamp 成静默错窗（与既有 web-fetch 契约一致）。
     - overflow：默认窗下调后，典型页面经 executor 后仍无「工具自称 truncated 字段」；超长页仍受 executor 硬顶。
     - 同 URL 第二次 `start_chars` 续抓：不二次打网（测试注入 fetch 计数）；追加的新 tool_result 是续窗而非再塞一份从头开始的全文；进程内缓存，不写工作区/不写 session 旁路文件。
     - concurrent：两 URL 并行缓存不串；同 URL 并行至多一次上游 fetch（或测死并文档化）。
     - exception：SSRF / 非 2xx 不变。
     - 既有 web-fetch 窗口/html 测试更新默认窗断言后全绿；`npm run typecheck` exit 0。
   - Status: [ ] pending
   - [blocks: T1]
   - [parallel] 与 T2：T1 合入后可与 T2 并行

## Code review phase

T1–T3 全部落地后，整轮 diff 过一次 end-of-round code-review，再宣称本计划完成。
