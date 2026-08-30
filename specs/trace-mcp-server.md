# Spec: trace-mcp-server — stdio MCP server 暴露 `query_trace`（第三条读侧动线）

> 来源：GitHub #803 提案 + 2026-08-30 wayfinder/LogicSync 对齐（外部编码 agent 当 MCP client；本仓交付 stdio MCP server）+ skeptic 子代理对假设清单 `PASS_WITH_REVISIONS`。
> 假设闸门：操作员授权「推荐方向 Confirm」+ 子代理必改修订并入 Assumptions；开放纠正。

## Glossary（exact copy from docs/CONTEXT.md）

- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口从这里取，工具数永不同步漂移。
  _Avoid_: 在 harness 之外另起 tool 注册表；在 entry point 手写工具数组。
- **tool_result projection**: 从已解引用的 `llm_call.messages` 抽出的工具结果摘要（`tool_use_id` / name / is_error / chars / preview）。供 `query_trace` 列表与下钻；**不是** `tool_call` 行上的 stdout 副本。`specs/query-trace-tool-results.md`。
  _Avoid_: 打开 `resultCaptured` 往 tool_call 抄正文；把投影当会话账本；默认下钻倒 messages 全文
- **blob 引用模式**（`IKNOW_TRACE_MESSAGES=blob`，默认 `full`）: llm_call 行内 messages 元素替换为内容寻址引用 `{sha, bytes}`、正文写 `<traceDir>/blobs/<sha>` 的 opt-in trace 存储模式；`messages_captured` 捕获语义不变，物理去重。ADR-0036。
- **workspaceRoot**: per-root 操作状态锚；默认 `process.cwd()`，可被 `--workspace-root` 或 `IKNOW_WORKSPACE_ROOT` 覆盖（ADR-0019 D1.1）。
  _Avoid_: 与 `home`（global 配置锚）混同。
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；executor 兜底 `OUTPUT_HARD_CAP=20000`（ADR-0006）。
  _Avoid_: 工具自填 truncated/total 字段；executor 凭工具标记跳过兜底截断。

**本 spec 划界（非新 CONTEXT 词条）**：MCP server 是 trace 读侧的 **transport adapter（第二张皮）**，不是第二套 ACI 注册表；ACI `query_trace` 仍是进程内第一张皮。

## Assumptions（操作员 + skeptic 修订锁定）

1. **角色**：交付 **stdio MCP server**；外部编码 agent（Cursor / Claude Code 等）当 MCP **client**。不代理 traceserver HTTP。
2. **SDK**：新增根依赖 `@modelcontextprotocol/server` ^2.0.0；入口 `serveStdio` + `McpServer.registerTool`。不手写 JSON-RPC；不复用 `tests/fixtures/mcp-server/`。仅当源码直接 `import` zod 时再声明根依赖 `zod` ^4.2（server 包已带 zod，勿误称 peer）。
3. **协议 era**：使用 `serveStdio` **默认**行为（`legacy: 'serve'`，兼容旧宿主）；**不**设 `legacy: 'reject'`。不把「SDK 包实现 2026-07-28」写成「首版 pin modern / 拒绝 legacy」。
4. **工具面**：首版只暴露 **一个** tool，名 `query_trace`；参数语义、投影、`detail`、4000 字符帽与现役 ACI `createQueryTraceTool` 对齐；`inputSchema` 用 Zod 声明（SDK 派生 JSON Schema）。
5. **共享核（落点钉死）**：查询/投影/序列化纯核落在 **`src/traceserver/`**（新文件，如 `query-trace-core.ts`，经 `traceserver/index.ts` 导出）。**禁止**该核 import `harness/`（含 `ToolExecutionError`）。校验失败用 traceserver 域内 typed error（或等价判别联合）；ACI 薄皮映射为既有 `QueryTraceValidationError` / `ToolExecutionError`；MCP 薄皮映射为 tool `isError` 文本。blob 解引用失败路径保留 `// EXIT:` 降级（对齐 `project-tool-results`）。业务逻辑**禁止**堆进 MCP 壳。MCP 模块（`src/trace-mcp/`）= transport only，**不**注册进 ACI registry。
6. **`traceDir` 解析**：`--trace-out`（或等价 CLI flag）> `IKNOW_TRACE_OUT` > 默认 `./trace/`（与写侧 `resolveTracePath` / ACI registry 回落对齐）。**禁止**新造 `IKNOW_TRACE_DIR`。空串 / 非法路径 → **进程启动期** fail-fast（stderr + exit ≠ 0）。工具参数非法 → MCP tool `isError`（与启动失败分开）。
7. **分发**：同仓新增 `package.json` bin（如 `iknow-trace-mcp` → dist 入口）；不做独立 npm 拆仓。stdout 仅 JSON-RPC；诊断只写 stderr。
8. **范围外**：resources / prompts、HTTP MCP、OTel、改写侧、改 traceserver 面板、改 ACI 工具**语义**（共享抽取导致的机械搬移除外）。
9. **测试**：vitest；优先 SDK `InMemoryTransport`（或子进程 stdio + 既有 client）；覆盖列表投影、`record_id` 下钻、非法参数、启动缺/非法 `traceDir`；不进 `test:real-llm`。
10. **时机 / #803 前置修订**：开写本 spec 的前置 = **投影 SSOT + ACI `query_trace` 已存在**（已落地）。显式取代 #803 原文「T1–T10 用一阵再开」。
11. **落地顺序（两票）**：① 抽共享核 + ACI 薄包 + 既有测回归；② MCP 壳 + bin + 依赖 + MCP 测。禁止单 commit 混两票。

→ 以上视为已确认（含 skeptic 必改修订）。

## Objective

让外部主开发进程（编码 agent）在开发 iknow 时，经标准 MCP stdio 调用与进程内 ACI **同一套** `query_trace` 投影读本地 JSONL trace——第三条读侧动线（人 → traceserver 面板；iknow agent → ACI；外部 agent → 本 MCP）。成功 = Success Criteria 全绿。

## Boundaries

- **Does:**
  - **票①**：在 `src/traceserver/` 抽出共享 query/投影核（无 harness import）；ACI `createQueryTraceTool` 改为薄包映射错误类型；既有 `query-trace` / `project-tool-results` 测全绿。
  - **票②**：新增依赖 `@modelcontextprotocol/server` ^2.0.0；`src/trace-mcp/` + `serveStdio(factory)`；注册唯一 tool `query_trace`（Zod schema + description 对齐 ACI；`readOnlyHint: true`）；bin `iknow-trace-mcp`；解析 `--trace-out` / `IKNOW_TRACE_OUT` / `./trace/`；mcp.json 示例（本 spec 附录或 `docs/` 短节，须可复制）；MCP 定向 vitest（见 SC）。
- **Confirms with human:** （无——假设闸已过。）
- **Out of this spec:**
  - MCP resources / prompts；Streamable HTTP / SSE transport。
  - B-scope OTel（ADR-0003 排除域）；生产遥测。
  - 代理或替换 traceserver HTTP / ADR-0020 挂载拓扑。
  - 扩展 `query_trace` 参数面（时间窗等）；改写侧 / blob 默认 / rotation。
  - 独立发包、改 fixture 注释（可选顺手，非门禁）。
  - 记忆 MCP 或其他 MCP server。

## Success Criteria

**票①（抽核）**

1. 共享核文件位于 `src/traceserver/`，且该文件（及其 traceserver 内依赖）**无** `from ".../harness/..."` import（静态检索）。
2. `createQueryTraceTool` 与（票②完成后的）MCP handler 均调用同一导出核；`npx vitest run tests/harness/aci/tools/query-trace.test.ts tests/traceserver/project-tool-results.test.ts` EXIT 0。
3. `tests/traceserver/project-tool-results.test.ts` 中「concurrent / Promise.all 投影确定性」用例仍绿（继承 `is deterministic when projected concurrently`）；共享核路径上 blob 失败仍 `// EXIT:` 降级、不抛进调用方（既有或等价断言）。
4. 非法输入经核抛出域内 typed error；ACI 薄皮仍表现为 `QueryTraceValidationError` / `ToolExecutionError`（既有测或补一条映射测）。

**票②（MCP 壳）**

5. 根 `package.json` 声明 `@modelcontextprotocol/server` ^2.0.0，且存在 bin 指向可执行 stdio 入口。
6. In-memory（或等价）MCP client：`tools/list` 含且仅含 `query_trace`（本 server 范围内）。
7. 夹具 trace 目录：调用 `query_trace` 返回投影 JSON 文本，单次 `content` 文本 ≤4000 字符，且 **不含** 列表路径下的 messages 全文。
8. `record_id` 下钻：默认 `tool_results`；`detail: "messages"` 才走 messages 通道（vitest）。
9. 非法 tool 参数 → tool 结果 `isError: true`（或 SDK 校验错误形态），进程不崩（vitest）。
10. 启动时 `traceDir` 解析为空/非法 → stderr 有可读信息且 exit ≠ 0（vitest 或可脚本化断言）。
11. 源码未设 `legacy: 'reject'`（检索断言）。
12. `src/trace-mcp/` **不** import ACI registry、**不** `registerExternal`（静态或单测）。
13. 本 spec 新增 `tests/trace-mcp/**`（路径 plan 可微调）`npx vitest run` EXIT 0；不改 `test:real-llm` 门禁集。

## Open Questions

(none)

## Inherits / Changes

- Inherits：ADR-0003 A-scenario JSONL；ADR-0020 读侧 reader SSOT（`createJsonlTraceReader`）；ADR-0036 blob 解引用后再投影；`specs/trace-agent-readability.md` T9；`specs/query-trace-tool-results.md`（投影纯函数；其 Out of scope 之「trace MCP」由本 spec 承接）。
- Inherits：写侧/ACI 目录解析惯例 `flag > IKNOW_TRACE_OUT > ./trace/`（`src/cli.ts` `resolveTracePath`；`registry.ts` traceDir 回落）。
- Inherits：仓库已有 `@modelcontextprotocol/client` ^2.0.0（本 spec 不改 client 行为）。
- Changes：票①抽出 `src/traceserver/` 共享核并改 ACI 薄包；票②新增 `@modelcontextprotocol/server` + bin + `src/trace-mcp/`；#803 前置改为「投影 SSOT + query_trace 已存在」。
- Test command: 票① `npx vitest run tests/harness/aci/tools/query-trace.test.ts tests/traceserver/project-tool-results.test.ts`；票②另加 `tests/trace-mcp/**`。
- Surfaces: 外部 MCP host via bin；chat/tui/serve 仅受票①无行为 diff 影响。

## ACR

```
bounded-context-guardian: yes — 共享核钉死 src/traceserver/且禁 harness import；MCP 在 src/trace-mcp/ 仅 transport；错误类型在边界映射；不进 ACI registry
defensive-contract-validator: yes — empty SC10；negative SC4/SC9；overflow SC7（4000）；concurrent SC3 钉死既有 project-tool-results 并行测；exception SC3 EXIT + SC10 启动失败
error-handling-enforcer: yes — 核用域内 typed error；ACI/MCP 薄皮映射；blob EXIT 保留；启动 stderr+非0；日志不进 stdout
complexity-anti-drift: yes — 一共享核 + ACI/MCP 两薄皮 + stdio 入口；无 god-server
minimal-change-verifier: yes — 两票两 commit（①抽核+ACI ②壳+bin+测）；禁止混票与 HTTP/OTel/resources
```

## 待写入

- （无强制 CONTEXT/ADR）可选：#803 评论留痕「前置修订为投影 SSOT 已存在」——不阻塞 PLAN。
