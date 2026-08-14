# Spec — Trace 检测面板（traceserver）

状态：v0（面板功能未完全完善，字段集将持续扩展）。
范围：为 `src/harness/trace/` 写侧产生的 JSONL trace（`trace.jsonl`，snake_case 落盘）
提供读取层、HTTP 查询 API 与 Web 检测面板。写侧零改动。

## 目标

1. 用户无需 `cat | grep` 即可在浏览器中检测 trace：按 conversation / 记录类型 / 状态过滤，
   查看统计、明细与原始 JSON。
2. 代码为后续加字段设计：字段声明表（`TRACE_FIELD_DEFS`）是解析/序列化/面板渲染的单一真值，
   新增 trace 字段 = 类型 + 声明表加一行，面板零改动。

## 需求

- R1 读取层 `src/traceserver/reader.ts`：解析四类行（llm_call / tool_call / turn / violation）；
  ENOENT → 空结果（正常态）；坏行（JSON 失败或非对象）计入 skippedLines；
  其他 IO 错误 → typed TraceReadError；字节上限（默认 8 MiB，可注入）超限截断并置 truncated；
  支持 conversation_id / record_type / status 过滤 + offset/limit 分页；按 started_at ?? ts 降序。
- R2 HTTP `GET /api/v1/traces`（挂在现有 session server，经 ServeOptions.traceOut 接线）：
  200 `{ records, total, skipped_lines, truncated }`；非法参数（负 limit/offset、
  非法 record_type/status、limit 越界、空 conversation_id）→ 400 validation；
  未配置 trace 文件 → 404 not_found；reader IO 错误 → 500 internal（不泄漏细节）。
- R3 `GET /api/v1/traces/fields`：返回字段声明表（面板列驱动）。
- R4 前端 TracePanel：统计条 / 过滤栏 / 声明驱动表格（列由字段表生成）/ 行展开原始 JSON；
  顶层视图切换（对话 / Trace 面板），切换不丢失对话状态。
- R5 可扩展性：`src/traceserver/fields.ts` 声明表为字段 SSOT，模块加载时自检 key 唯一。

## 成功判据（SC，二元）

1. `npx tsc --noEmit` 与 web 类型检查通过。
2. 全量 `npm test` 无新增失败；traceserver 专项 ≥ 30 测试覆盖：正常 / 空文件 / ENOENT /
   坏行 / IO 错误 / truncation / 过滤 / 分页 / 400 各类非法参数 / 500 IO / 404 未配置 / fields 端点。
3. 真实冒烟：真实 LLM 调用产生 trace → serve → API 返回记录、过滤与 400 行为符合 R2。
4. 写侧零改动：`src/harness/trace/jsonl.ts`、`loop-engine.ts` 埋点、
   `hub.ts.recordViolationTrace` 不在 diff 中。
5. 无新增 npm 依赖、无 lockfile 变更。
6. `docs/architecture.md` Capability modules 表含 traceserver 行（SSOT）。
7. 前端不引入 router 库；面板子组件分解（StatsBar / FilterBar / Table / ExpandedRow）。

## 明确排除（范围外）

JSONL rotation / fsync、OTel 导出、`iknow trace` CLI 子命令、chat TTY trace、
`--trace-out` usage 文档缺口（另开任务）、messages/arguments/result payload 捕获。
