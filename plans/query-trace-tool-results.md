# Plan: query-trace-tool-results

**Goal:** `query_trace` 列表与下钻能看到从 `llm_call.messages` 抽出的 tool_result 摘要，不把 messages 全文倒进 4000 帽，也不往 `tool_call` 行抄 stdout。
**Approach:** 本 PR 只落契约。实施先纯函数投影，再接线列表/下钻/`detail`，并锁写路径仍不捕获 result。末轮无后续 `llm_call` 的缺口按 spec 不堵。
**Spec link:** `specs/query-trace-tool-results.md`
**Tracker:** 操作员指定不开 GitHub issue；实施按本文件分 commit。
**ACR:** all-yes（2026-08-29）

```
bounded-context-guardian: yes — 投影落 traceserver 或 query-trace.ts；query-trace 已单向依赖 traceserver；loop-engine 写路径零改；禁止 MCP
defensive-contract-validator: yes — empty SC2；negative SC8；overflow SC5+4000帽；concurrent SC9 Promise.all；exception SC10 blob 解失败+EXIT
error-handling-enforcer: yes — 非法 detail→QueryTraceValidationError（SC8）；blob 失败空投影+// EXIT:、不抛进 turn（SC10）
complexity-anti-drift: yes — 一纯函数 + 列表/下钻两处接线
minimal-change-verifier: yes — 单一读侧投影；禁止写侧 resultCaptured/MCP/改 recordToolCall
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入

本 plan 落盘后已 flush（CONTEXT：**tool_result projection**）。无新 ADR（`detail` 为可逆加法）。

## Out of scope

写侧 `resultCaptured`；join 会话 JSONL；trace MCP（#803）；resume_offset UI；sandbox stdout；改 `recordToolCall` 字段填写。

## Tasks (ordered by dependency)

1. **Persist `tool_result projection` glossary** — tag: `[decision]`
   - **Inherits:** spec 待写入：从已解引用 `llm_call.messages` 抽出；不是 `tool_call.result`
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** 词条与 spec Assumptions 1–3 一致；本 commit 无生产代码
   - Status: [x] done（本 docs PR）

2. **Pure projection from dereferenced messages** — tag: `[implementation]`
   - **Inherits:** spec Does：`tool_results: [{ tool_use_id, name?, is_error, chars, preview }]`；preview ≤400 并截断标记；name 来自配对 `tool_use`；blob 先解引用再投影
   - **Surface:** `src/traceserver` 或 `query_trace` 旁一处纯函数（禁止第二份拷贝）
   - **Acceptance:** SC1 夹具级（函数本身）、SC2、SC5、SC6、SC9、SC10
   - [blocks: T1]
   - Status: [x] done（T2）

3. **List and drill-down consume the projection** — tag: `[implementation]`
   - **Inherits:** spec 列表 `tool_result_count` + 最多 2 条 ≤200 字 preview；`record_id` 默认投影、默认无 messages 全文；`detail: "messages" | "tool_results"` 缺省 `tool_results`；非法 detail typed；4000 帽仍在；工具 description 写明末轮缺口
   - **Surface:** `src/harness/aci` `query_trace` + traceserver 读路径若已投影
   - **Acceptance:** SC1（工具响应）、SC3、SC4、SC8；`npx vitest run tests/harness/aci/tools/query-trace.test.ts` EXIT 0
   - [blocks: T2]
   - Status: [x] done（T3）

4. **Write path still does not copy tool stdout onto `tool_call`** — tag: `[implementation]`
   - **Inherits:** spec Out：不打开 `resultCaptured`；loop-engine `recordToolCall` 仍 false
   - **Surface:** `src/harness` loop-engine 断言（只测，不改写路径语义）
   - **Acceptance:** SC7
   - [parallel]
   - [blocks: T1]
   - Status: [x] done（T4）

## End of round

T1 已在本 PR。实施：T2 → T3；T4 可与 T2 并行。全部合入后一轮 code-review + verification-before-completion。
