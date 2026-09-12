# Spec: query-trace-tool-results — 从 llm_call.messages 投影 tool_result（不写 tool_call.result）

> 2026-08-29：P2「tool result 捕获开关」否决复制写入。读侧从已有 `llm_call.messages` 抽出工具结果。操作员授权直接成文。
> 2026-09-02：plan `trace-mcp-read-side-split` T7 把 `query_trace` 瘦成行筛选 + 行分页；下钻（`record_id` / `detail`）迁出本 spec，归 `specs/trace-mcp-server.md` 的内容轴工具 `get_record`。SC3–SC5、SC8 删去。

## Glossary（exact copy from docs/CONTEXT.md）

- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加更新，禁止原地修改或建立第二份权威副本。
  _Avoid_: 把 harness trace JSONL 当会话历史。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口从这里取，工具数永不同步漂移。
  _Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组。
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；executor 兜底 `OUTPUT_HARD_CAP=20000`（ADR-0006）。
  _Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断。
- **blob 引用模式**（`IKNOW_TRACE_MESSAGES=blob`，默认 `full`）: llm_call 行内 messages 元素替换为内容寻址引用 `{sha, bytes}`、正文写 `<traceDir>/blobs/<`/`sha>` 的 opt-in trace 存储模式；`messages_captured` 捕获语义不变，物理去重（实测 98.2% 重复）。ADR-0036。
  _Avoid_: 默认开启；当成对 ADR-0014「模型实际所见」不变量的修订；与写侧 delta/off 截断混同
- **tool_result projection**: 从已解引用的 `llm_call.messages` 抽出的工具结果摘要（`tool_use_id` / name / is_error / chars / preview）。供 `query_trace` 列表页；**不是** `tool_call` 行上的 stdout 副本。`specs/query-trace-tool-results.md`。
  _Avoid_: 打开 `resultCaptured` 往 tool_call 抄正文；把投影当会话账本；默认下钻倒 messages 全文
- **read unit（读单元，T7）**：工具级参数表达「读多少」的语义单位（行 / 条 / 字符窗），与 executor 的字符兜底正交。`query_trace` 的读单元是「一行 + 一页」。
  _Avoid_: 用输出字符帽当分页机制。
- **window（窗口，T6）**：`get_record` 中由调用方给的 `{message_index, part_index, from_char, count}` 坐标组；窗内数据是事实，不是截断声明。
- **tool face / panel face（T4）**：同一 traceserver 数据的两种序列化归属——tool face（ACI + MCP）不带 `truncated`/`total`；panel face（`http.ts` → Web）保留 `total` 供分页显示。
  _Avoid_: 「MCP 版 / HTTP 版」这种按 transport 命名的说法。

## Assumptions（2026-08-29 操作员讨论锁定，2026-09-02 T7 校准）

1. 不把 `resultCaptured: true` / `argumentsCaptured: true` 打开；不往 `tool_call` 行抄 stdout。
2. 投影只读 trace JSONL（+ blob 解引用）。**不** join 会话账本。
3. 末轮工具执行后模型直接 `end_turn`、没有下一次 `llm_call` 时，trace **看不到**该批 tool_result。契约写明；本 spec 不堵。
4. 纯函数 SSOT 一处，`query_trace` 与日后 MCP 共用。
5. **T7 改写**：行轴无字符帽；面板继续无帽（ADR-0020 不变）。截断只发生在 executor 兜底（ACI 面）与 MCP 面的 `TRACE_OUTPUT_BACKSTOP`（= executor `OUTPUT_HARD_CAP`，值由 `src/traceserver/output-backstop.ts` 锁定）。
6. Tech stack：既有 traceserver reader + `query-trace.ts`；无新依赖。
7. **T7 新增**：行轴 `conversation_id` 必填（Assumption 4 关掉了「缺省=最近活跃会话」的隐式默认——这是内容轴在 T6 关过的同一道门，行轴是第二个必填 `conversation_id` 的工具）。

→ 以上视为已确认。

## Objective

主代理用 `query_trace` 能看见工具输出摘要，且工具面不出现「行下钻 / messages 全文 / 字节轮询」三种本属于其他轴的语义。行筛选 + 行分页 = 全部。成功 = SC 全绿。

## Boundaries

- **Does:**
  - 新增纯函数（建议 `src/traceserver/` 或 `query-trace.ts` 旁，禁止第二份拷贝）：输入已解引用的 `messages`，输出 `tool_results: [{ tool_use_id, name?, is_error, chars, preview }]`。`preview` 单条 ≤400 字符，超长截断并带标记。从 user 块的 `tool_result` 与配对 assistant `tool_use` 取 name。
  - **列表**（无下钻轴）：`llm_call` 在现有 `messages_count` / 首末 preview 上增加 `tool_result_count`；若 count>0，附加最多 2 条短 preview（≤200 字/条）。`tool_call` 行仍为元数据（name / status / duration / error），不塞正文。
  - **行筛选 + 行分页**：`record_type` / `status` / `task_id` / `parent_turn_id` / `turn_id` 各为可选筛选；`limit` (1..200, 缺省 100) + `offset` (≥0, 缺省 0) 分页；`offset` 的真正语义是「从第 N 行开始」。**`record_id` / `detail` / `resume_offset` 已删除**，下钻走 `get_record`，字节轮询归面板（SC-R 14）。
  - blob 行：reader 先解引用再投影。
  - 工具 description 写明：末轮无后续 `llm_call` 则无 tool_result 投影；行 `offset` 是行分页参数；下钻用 `get_record`。
  - 工具面输出 = `{records, limit, offset}`，回显生效坐标，无 `total` / `truncated` / `skipped_lines`。
  - `conversation_id` 必填；缺失或文件不存在 → `TraceSessionNotFoundError`（kind=`session_not_found`，T6 引入、T7 复用）。
- **Confirms with human:** （无。）
- **Out of this spec:** 写侧捕获开关；join 会话 JSONL；trace MCP（#803）；P2 resume_offset 前端；sandbox stdout 截断；改 `recordToolCall` 字段填写；`record_id` 下钻与 `detail` 二选一臂（两者一并迁出，归 `specs/trace-mcp-server.md` 内容轴）。

## Success Criteria

1. 夹具 `llm_call.messages` 含一对 tool_use / tool_result → 列表投影 `tool_result_count >= 1` 且 preview 含结果片段（vitest）。
2. 无 tool_result 的 `llm_call` → `tool_result_count === 0`，无 `tool_results` 键或空数组（ vitest 钉一种）。
3. **T7 删**：原 SC3（`record_id` 下钻默认响应不含顶层 `messages` 数组），随 `record_id` 一起迁出。下钻断言现在由 `get_record` 的 SC 覆盖。
4. **T7 删**：原 SC4（`detail: "messages"` 下钻含 messages），随 `detail` 一起迁出。
5. 单条 tool_result 正文 >400 字 → preview 以截断标记结尾且长度有界（vitest）。
6. blob 形态 messages 解引用后与 full 形态投影字段一致（vitest）。
7. `loop-engine` 对 `recordToolCall` 仍 `resultCaptured: false`（既有或新断言）。
8. **T7 改**：非法参数走既有 `QueryTraceValidationError`（`kind=validation`），SC 全文以 `validation` 为唯一 kind，不再有 SC8 的「非法 detail」专项（`detail` 已不在行轴）。
9. 同一已解引用 `messages` 上并行两次投影（`Promise.all`）→ 字段一致且函数无共享可变累积（vitest）。
10. blob 解引用失败 → 该 `llm_call` 投影为空 `tool_results`（或 count 0）且 `// EXIT:`，不抛进用户 turn（vitest）。
11. `npx vitest run tests/harness/aci/tools/query-trace.test.ts` 加本票测（及投影单测文件）EXIT 0。
12. **T7 新增**：行轴 envelope = `{records, limit, offset}` 三键（**仅**这三键），不含 `total` / `truncated` / `skipped_lines`（SC15 面板侧 `http.ts` 不动，仍含）。
13. **T7 新增**：行 `offset` 真分页——offset=N 返回「从第 N 行起的下一页」；`offset` 越界（≥ filtered total）返回 `{records: [], offset}`（隐式 end-of-data，不抛）。
14. **T7 新增**：`conversation_id` 缺失 / 文件不存在 → `TraceSessionNotFoundError`（`session_not_found`），与「文件存在但无记录」通过不同 kind 区分（后者返回 `records: []`，不抛）。
15. **T7 新增**：SC18 跨面参数面一致——两张皮的属性集 + `additionalProperties: false` + 逐字段 type / minimum / maximum 与 `conversation_id` 是否必填，逐件比对。

## Open Questions

(none)

## Inherits / Changes

- Inherits：归档 spec `docs/archive/025-retire-completed-specs-and-plans/specs/trace-agent-readability.md` T9 `query_trace`；ADR-0003 A-scope JSONL；ADR-0006 不落可再生工具输出第二份盘；ADR-0036 blob。
- Inherits：`createJsonlTraceReader` 为读侧 SSOT。
- Changes（T7）：`projectRecord` 列表投影保留；`record_id` / `detail` 路径删除并迁出；`offset` 暴露；`resume_offset` 删除；envelope 由 `ResponseEnvelope` 拆为 `QueryTracePage`（少 `total` / `truncated` / `skipped_lines` 三键）；`conversation_id` 改必填 + 缺席抛 `session_not_found`。
- Test command: `npx vitest run tests/harness/aci/tools/query-trace.test.ts` 及投影函数测 + `tests/traceserver/query-trace-core-input-face.test.ts`（T7 新增）。
- Surfaces: 凡装配 `query_trace` 的入口（chat / tui / serve）；web `/trace` 面板继续走 `http.ts`（SC15 冻结件），不直接接核的 envelope。

## ACR

```
bounded-context-guardian: yes — 投影在 traceserver/query-trace；loop-engine 写路径零改；面板/工具面 envelope 拆为两构造（plan §序列化 对 T7 的硬约束）
defensive-contract-validator: yes — empty SC2 + SC14；negative SC1 + SC15；overflow SC5+panel backstop；concurrent SC9 纯函数并行；exception blob 解失败降级空投影 + EXIT（SC6 夹具）
error-handling-enforcer: yes — session_not_found（T6 引入 / T7 复用）一处 catch arm；非法参数走既有 validation；解引用失败不抛进 turn
complexity-anti-drift: yes — 一纯函数 + 两处接线（列表）；下钻 + detail 路径已删除
minimal-change-verifier: yes — 只读投影；禁止写侧 resultCaptured；禁止 MCP（get_record 走 spec §mcp-server）；本 spec 只动行轴，不重打开内容轴
```

## 待写入

T7 落地后整轮 `domain-modeling`：四条新词条（read unit / window / tool face / panel face）写进 `docs/CONTEXT.md`；`TraceQueryValidationError` 类名同步改名（误名项）；`query-trace-errors.ts` 文件名同步改名。单独开票。
