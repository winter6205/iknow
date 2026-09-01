# Spec: trace-mcp-server — stdio MCP server 暴露 trace 读侧三面（第三条读侧动线）

> **版本**：v1.0 = 单工具 `query_trace`（#803）。**v1.1**（`plans/trace-mcp-read-side-split.md`）把读侧按轴拆成 `list_sessions` / `query_trace` / `get_record` 三件 read-unit 化工具，并让字符帽退出工具面。
> **v1.1 改到的一切（此清单即「哪份文本生效」的导航）**：新增「v1.1 划界」小节；Assumption 4（三件白名单 + 四条锁定）/ 5（补前缀归属）/ 8（收窄括注豁免 + panel face 明示不动）/ 9（测试覆盖面）/ 11（补票③ 粒度）；Out of scope 的「不扩展参数面」被票③ 取代、只留时间窗轴；SC6 / SC7 / SC8 判据改写（**达成于票③、非票②**，见该组标注）；新增 SC14–SC20（票③）；Inherits / Changes / ACR 各加票③ 段。未列处即未改。**可逆**：`git revert` 本票 commit 即回 v1.0 原文。

> 来源：GitHub #803 提案 + 2026-08-30 wayfinder/LogicSync 对齐（外部编码 agent 当 MCP client；本仓交付 stdio MCP server）+ skeptic 子代理对假设清单 `PASS_WITH_REVISIONS`。
> 假设闸门：操作员授权「推荐方向 Confirm」+ 子代理必改修订并入 Assumptions；开放纠正。v1.1 修订经 `architecture-change-reviewer` 五轮 PASS 5/5。

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

## v1.1 划界 — 读侧三面与两种序列化归属

> 本小节**不是** Glossary 的延伸。下列词名是对 `plans/trace-mcp-read-side-split.md` §待写入 的**引用**，尚未进 `docs/CONTEXT.md`（全票合入后经 `domain-modeling` 落）。定义权威在那份 plan，本处只述语义、不另立定义。

- 三件工具各管一条正交轴，一次调用只返回调用方指定位置的一页：`list_sessions`（目录轴：有哪些会话）、`query_trace`（行轴：一个会话里的哪些记录 + 行分页）、`get_record`（内容轴：一条记录的哪个字节窗）。
- **tool face**（ACI + MCP 两张皮）输出 = records 数组 + 回显调用方给过的坐标 + 一行人类可读收窄提示（契约 X 的 marker 形态，**不是** JSON 元字段）。**不含** `truncated` / `total`——这两项是 Glossary 契约 X 的 `Avoid` 原文所禁。`response_truncated` 一并禁用是**本 spec 的延伸**（CONTEXT.md 与 ADR-0004:23 未点名它），理由：它随记录数走、不随字段走，是假负号来源。页没收满的诚实信号改由隐式关系给出：`records.length < limit` 即「到底了」。
- **panel face**（`http.ts` → Web，ADR-0020 语义不变）保留 `{records,total,skipped_lines,truncated,offset}` 信封，因面板需要 `total` 画分页器。契约 X 的措辞是「工具返回」（`docs/adr/0004-tool-layer-six-tool-set.md:23`），面板 JSON 不经 executor，故 `total` 在 panel face 合法——这是**澄清适用面**，不推翻 ADR-0004。
- 两个 face 直读同一 reader；panel face 从不经过 tool-face 序列化出口，故核侧改动不可能回归面板。

## Assumptions（操作员 + skeptic 修订锁定）

1. **角色**：交付 **stdio MCP server**；外部编码 agent（Cursor / Claude Code 等）当 MCP **client**。不代理 traceserver HTTP。
2. **SDK**：新增根依赖 `@modelcontextprotocol/server` ^2.0.0；入口 `serveStdio` + `McpServer.registerTool`。不手写 JSON-RPC；不复用 `tests/fixtures/mcp-server/`。仅当源码直接 `import` zod 时再声明根依赖 `zod` ^4.2（server 包已带 zod，勿误称 peer）。
3. **协议 era**：使用 `serveStdio` **默认**行为（`legacy: 'serve'`，兼容旧宿主）；**不**设 `legacy: 'reject'`。不把「SDK 包实现 2026-07-28」写成「首版 pin modern / 拒绝 legacy」。
4. **工具面（v1.1 改写）**：暴露 **三件** tool —— `list_sessions` / `query_trace` / `get_record`，白名单取代 v1.0 的「只暴露一个 tool」。三条轴正交：目录 / 行 / 字节窗。锁定四条：
   - **`conversation_id` 在 tool face 必填**（`query_trace` / `get_record`）。v1.0 的「缺省 → 最近活跃会话」隐式默认在工具面删除——它让外部 agent 无从知道自己读的是哪个会话；panel face 的 SC-R 12 缺省最近会话**不变**。
   - **字符帽不是任何工具的参数**。读多少由 read-unit 参数表达（行 `limit` / 条 / `get_record` 的 `{message_index, part_index, from_char, count}` 窗坐标），不是「输出别超过 N 字符」。`QUERY_TRACE_RESPONSE_CAP=4000` 随窗口机制落地退场。
   - **MCP transport 自带 backstop = 20000**，与 executor 的 `OUTPUT_HARD_CAP`（`src/harness/tools/executor.ts:30`）**同值**。该常量在 executor 内**未导出**，取值的合法方式是在 `src/traceserver/`（非 `harness/`）定义具名常量 `20_000` + 一条锁值的断言 + 注释指名来源，**禁止** `import` 自 `harness/`（与假设 5、SC12 相抵）。同值是为不犯 ADR-0006:29「低于 executor 又静默裁 = 双层截断」。backstop 语义对齐 executor：marker **计入** 20000 预算，最终输出**严格 ≤ 20000**。ACI 面由 executor 兜，不另设工具级帽。
   - 三件的 `inputSchema` 在 ACI 与 MCP 两张皮上逐项一致（防漂移由断言锁，不靠人记）。
5. **共享核（落点钉死，v1.1 补前缀归属）**：查询/投影/序列化纯核落在 **`src/traceserver/`**（新文件，如 `query-trace-core.ts`，经 `traceserver/index.ts` 导出）。**禁止**该核 import `harness/`（含 `ToolExecutionError`）。校验失败用 traceserver 域内 typed error（或等价判别联合）；ACI 薄皮映射为既有 `QueryTraceValidationError` / `ToolExecutionError`；MCP 薄皮映射为 tool `isError` 文本。**核的 error 消息不带工具名前缀——前缀是薄皮的活**（一张皮一个名字，`list_sessions` 的报错不得顶着 `query_trace:`）。blob 解引用失败路径保留 `// EXIT:` 降级（对齐 `project-tool-results`）；raise-site 不是 EXIT，别贴。业务逻辑**禁止**堆进 MCP 壳。MCP 模块（`src/trace-mcp/`）= transport only，**不**注册进 ACI registry。
6. **`traceDir` 解析**：`--trace-out`（或等价 CLI flag）> `IKNOW_TRACE_OUT` > 默认 `./trace/`（与写侧 `resolveTracePath` / ACI registry 回落对齐）。**禁止**新造 `IKNOW_TRACE_DIR`。空串 / 非法路径 → **进程启动期** fail-fast（stderr + exit ≠ 0）。工具参数非法 → MCP tool `isError`（与启动失败分开）。
7. **分发**：同仓新增 `package.json` bin（如 `iknow-trace-mcp` → dist 入口）；不做独立 npm 拆仓。stdout 仅 JSON-RPC；诊断只写 stderr。
8. **范围外**：resources / prompts、HTTP MCP、OTel、改写侧、改 traceserver 面板（**panel face 的 wire 形状与 ADR-0020 语义不在本轮变更范围**）、改 ACI 工具**语义**。
   括注豁免的边界：该豁免**仅**覆盖「共享抽取导致的机械搬移」（同语义换 owner）。v1.1 的 `conversation_id` 必填、`record_id` / `detail` / `resume_offset` 删参、`list_sessions` / `get_record` 加参都是**语义变更**，必须先经本 spec（即本 Assumption 4 + SC6–SC8）改写才允许落地——「代码先动、spec 后补」不算拿到豁免。
9. **测试**：vitest；优先 SDK `InMemoryTransport`（或子进程 stdio + 既有 client）；覆盖三件的 `tools/list` 白名单、目录轴（`list_sessions`）、行筛选 + 行分页（`query_trace`）、字节窗（`get_record`）、非法参数、启动缺/非法 `traceDir`；不进 `test:real-llm`。
10. **时机 / #803 前置修订**：开写本 spec 的前置 = **投影 SSOT + ACI `query_trace` 已存在**（已落地）。显式取代 #803 原文「T1–T10 用一阵再开」。
11. **落地顺序**：**票①②（v1.0）**＝ ① 抽共享核 + ACI 薄包 + 既有测回归；② MCP 壳 + bin + 依赖 + MCP 测。禁止单 commit 混两票。**票③（v1.1）**＝ `plans/trace-mcp-read-side-split.md` T1–T8，**一票一 commit 一轴、全串行**（T5/T6 共改 registry 末尾不可并行；T7 破坏性收窄必须晚于 T5+T6 的去处落地）。

→ 以上视为已确认（含 skeptic 必改修订）。

## Objective

让外部主开发进程（编码 agent）在开发 iknow 时，经标准 MCP stdio 调用与进程内 ACI **同一套** `query_trace` 投影读本地 JSONL trace——第三条读侧动线（人 → traceserver 面板；iknow agent → ACI；外部 agent → 本 MCP）。成功 = Success Criteria 全绿。

## Boundaries

- **Does:**
  - **票①**：在 `src/traceserver/` 抽出共享 query/投影核（无 harness import）；ACI `createQueryTraceTool` 改为薄包映射错误类型；既有 `query-trace` / `project-tool-results` 测全绿。
  - **票②**：新增依赖 `@modelcontextprotocol/server` ^2.0.0；`src/trace-mcp/` + `serveStdio(factory)`；注册 tool `query_trace`（票② 交付态 = 当时唯一一件；**件数由票③ 扩为三件，白名单判据见 SC6**；Zod schema + description 对齐 ACI；`readOnlyHint: true`）；bin `iknow-trace-mcp`；解析 `--trace-out` / `IKNOW_TRACE_OUT` / `./trace/`；mcp.json 示例（本 spec 附录或 `docs/` 短节，须可复制）；MCP 定向 vitest（见 SC）。
  - **票③（v1.1）**：把 tool face 按轴拆成三件 read-unit 化工具——`list_sessions`（目录轴）、瘦身后只留行筛选 + 行分页的 `query_trace`、`get_record`（字节窗轴）；`conversation_id` 在 tool face 转必填；`4000` 字符帽整体退出工具面、改由 MCP transport 的 20000 backstop 承担；核 error 去工具名前缀、前缀归各薄皮。panel face 一字不改。
- **Confirms with human:** （无——假设闸已过。）
- **Out of this spec:**
  - MCP resources / prompts；Streamable HTTP / SSE transport。
  - B-scope OTel（ADR-0003 排除域）；生产遥测。
  - 代理或替换 traceserver HTTP / ADR-0020 挂载拓扑。
  - **时间窗过滤轴**（`TraceQuery` 至今无此轴，v1.1 也不引入）。注：v1.0 原文把「扩展 `query_trace` 参数面」整体列为 out of scope，该条已被票③ 取代——目录轴与字节窗轴本轮确实引入，时间窗轴没有。
  - 改写侧 / blob 默认 / rotation。
  - 独立发包、改 fixture 注释（可选顺手，非门禁）。
  - 记忆 MCP 或其他 MCP server。

## Success Criteria

**票①（抽核）**

1. 共享核文件位于 `src/traceserver/`，且该文件（及其 traceserver 内依赖）**无** `from ".../harness/..."` import（静态检索）。
2. `createQueryTraceTool` 与（票②完成后的）MCP handler 均调用同一导出核；`npx vitest run tests/harness/aci/tools/query-trace.test.ts tests/traceserver/project-tool-results.test.ts` EXIT 0。
3. `tests/traceserver/project-tool-results.test.ts` 中「concurrent / Promise.all 投影确定性」用例仍绿（继承 `is deterministic when projected concurrently`）；共享核路径上 blob 失败仍 `// EXIT:` 降级、不抛进调用方（既有或等价断言）。
4. 非法输入经核抛出域内 typed error；ACI 薄皮仍表现为 `QueryTraceValidationError` / `ToolExecutionError`（既有测或补一条映射测）。

**票②（MCP 壳）**

> **SC 归属（v1.1 注）**：SC5、SC9–SC13 是票② 的交付态判定，v1.1 未改。**SC6 / SC7 / SC8 的判据已被 v1.1 改写，达成于票③（`plans/trace-mcp-read-side-split.md` T5–T7）而非票②**——票② 的历史交付态（只注册 `query_trace`、输出 ≤4000、`detail` 下钻）见 `git revert` 前的 v1.0 原文，不以本处判据回溯判定票② 失败。

5. 根 `package.json` 声明 `@modelcontextprotocol/server` ^2.0.0，且存在 bin 指向可执行 stdio 入口。
6. In-memory（或等价）MCP client：`tools/list` **含且仅含** v1.1 三件白名单 `list_sessions` / `query_trace` / `get_record`（取代 v1.0 的「只含 `query_trace`」）。三件都带 `readOnlyHint: true`。
7. **字符帽不再是判据**（取代 v1.0 的「单次 `content` ≤4000 字符」）。改为四条可断言判据：
   - tool face 输出 JSON **不含** `truncated` / `total` / `response_truncated` 任一字段（静态断言 + 一条「一条超 4000 的记录必须原样可读」的行为断言）；
   - 「读多少」只由 read-unit 参数决定（`limit` / `offset` / 窗坐标），且这些参数**不存在**任何名为 cap/limit-chars 的字符帽；
   - 三件的 **description 文案不含任何字符帽表述**（现两张皮都写着「Results are capped at 4000 characters」：`src/harness/aci/tools/query-trace.ts:65` 与 `src/trace-mcp/server.ts:27`，后者是假称——该处随 SC 单源化改为真值）。文案单一来源，受 `tests/harness/aci/tools/d9-description-guard.test.ts` 约束；只锁 JSON 字段不锁文案 = 判据可被绕过。
   - MCP transport 的 backstop 存在且 **等于 20000**，marker 计入该预算、最终输出严格 ≤20000（对齐 `executor.ts:100` 的预算法）；ACI 面由 executor 兜（同值，不出现双层截断）。
8. **下钻轴归 `get_record`**（取代 v1.0 的「`record_id` 下钻 + `detail:messages` 才走 messages」）：
   - `query_trace` 参数面**不含** `record_id` / `detail` / `resume_offset`（去处已在 SC6 的另两件里）；
   - `get_record(conversation_id, record_id, detail, message_index, part_index, from_char, count)` 的窗坐标全由调用方给且**原样回显**；
   - 装不下 → `window_overflow` 且**零部分字节泄漏**；无命中 → `record_not_found`（不再是静默 `records: []`）；
   - 下钻**永不**删字段：v1.0 的 `compactRecord` 静默降级（要 `detail:messages` 却只回标量、还标 `response_truncated:false`）是本轮要消灭的 P0。
9. 非法 tool 参数 → tool 结果 `isError: true`（或 SDK 校验错误形态），进程不崩（vitest）。
10. 启动时 `traceDir` 解析为空/非法 → stderr 有可读信息且 exit ≠ 0（vitest 或可脚本化断言）。
11. 源码未设 `legacy: 'reject'`（检索断言）。
12. `src/trace-mcp/` **不** import ACI registry、**不** `registerExternal`（静态或单测）。
13. 本 spec 新增 `tests/trace-mcp/**`（路径 plan 可微调）`npx vitest run` EXIT 0；不改 `test:real-llm` 门禁集。

**票③（v1.1 读侧三面，`plans/trace-mcp-read-side-split.md` T2–T8）**

14. **characterization 基线先行**：在**未改动**的现役核上补齐 `tests/traceserver/` 覆盖，逐条钉住今天真实行为（含 P0 静默降级与假 `response_truncated`，按「现在确实如此」写成通过态断言）。该基线 commit `EXIT 0`，且 T3 之后仍 `EXIT 0`——只是断言方向翻转，master 上不允许出现红灯 commit。
15. **单一 owner**：「最近会话」推导只有一个 owner，panel 与 tool 两侧都经它；tool-page 序列化出口只有一个且两张皮共用。判据 = `tests/traceserver/http.test.ts` **零改动仍绿**（纯机械搬移）。
16. **前缀归属**：核 error 消息不含工具名；`list_sessions` 的校验错误在两张皮里都显示为 `list_sessions: …`，全仓不出现 `query_trace:` 顶替（`stripQueryTracePrefix` 随之退场）。
17. **必填轴诚实报错**：`conversation_id` 在 tool face 必填后，指向不存在会话的调用 → `session_not_found`，不得退化成静默空结果。
18. **两张皮参数面逐项一致**：一条 diff 断言比对 ACI `inputSchema` 与 MCP Zod 派生 schema 的三件工具参数面，防漂移。
19. **面板轮询不受影响**：`resume_offset` 在 panel face（`parseResumeOffset` → `TraceQuery`）原样保留，从不经过 tool-face parser；SC-R 14 字节续读与 SC-R 12 缺省最近会话两条面板测零改动仍绿。
20. **每个新 kind 有 ACI catch arm**：`record_scan` / `record_not_found` / `window_overflow` / `validation` / `session_not_found` 五个 kind 各有一条 ACI 映射测。MCP 薄皮的兜底 catch 把未映射 error 显示成 `isError` 文本**不算已处理**。

## Open Questions

(none)

## Inherits / Changes

- Inherits：ADR-0003 A-scenario JSONL；ADR-0020 读侧 reader SSOT（`createJsonlTraceReader`）；ADR-0036 blob 解引用后再投影；`specs/trace-agent-readability.md` T9；`specs/query-trace-tool-results.md`（投影纯函数；其 Out of scope 之「trace MCP」由本 spec 承接）。
- Inherits：写侧/ACI 目录解析惯例 `flag > IKNOW_TRACE_OUT > ./trace/`（`src/cli.ts` `resolveTracePath`；`registry.ts` traceDir 回落）。
- Inherits：仓库已有 `@modelcontextprotocol/client` ^2.0.0（本 spec 不改 client 行为）。
- Changes：票①抽出 `src/traceserver/` 共享核并改 ACI 薄包；票②新增 `@modelcontextprotocol/server` + bin + `src/trace-mcp/`；#803 前置改为「投影 SSOT + query_trace 已存在」。
- **票③ Inherits**：ADR-0003 / ADR-0004 契约 X（**适用面经本轮澄清** = 工具返回，不含 panel face）/ ADR-0006 D6「工具级管读多少（语义单位：行/条/字符），executor 管输出不超多少（字符兜底）」+ `:29`（低于 executor 又静默裁 = 双层截断，故 4000 退场是向该条收敛）/ ADR-0020 面板语义 / ADR-0036 blob 解引用在投影前。**无 ADR reopen**；`QUERY_TRACE_RESPONSE_CAP=4000` 退场不与任何已接受 ADR 冲突。
- **票③ Changes**：`query_trace` 参数面收窄（删 `record_id` / `detail` / `resume_offset`，`conversation_id` 转必填，暴露既有行 `offset`）；新增 `list_sessions` / `get_record` 两张皮各一份；`compactRecord` 与其 256-slice 退场；tool face 无截断元字段；registry 工具数 40→41→42。
- Test command: 票① `npx vitest run tests/harness/aci/tools/query-trace.test.ts tests/traceserver/project-tool-results.test.ts`；票②另加 `tests/trace-mcp/**`；票③ `npx vitest run tests/traceserver/ tests/trace-mcp/ tests/harness/aci/tools/`，另加 registry 枚举面，按三类分（完整核实见 plan §执行期前提修正 #1）：
  - **须随 T5/T6/T7 同批改**：`tests/harness/aci/tools/registry.test.ts`、`tests/harness/aci/tools/d9-description-guard.test.ts`（`:245`+`:246` 两条 `toHaveLength`）、`tests/session-api/ensure-deps-aci-tools.test.ts`、`tests/harness/build-engine.test.ts`、`tests/tui/deps-tools.test.ts`（`:96` `EXPECTED_TOOLSET_30`）、`tests/subagent/worker-tool-surface.test.ts`（`:111` `WORKER_BASE_SURFACE`）、`tests/trace-mcp/server.test.ts`、`tests/trace-mcp/startup.test.ts`。
  - **策略位（不是机械 +1）**：`WORKER_BASE_SURFACE` 是子代理 worker 的 **allow-list 基线**，`:249-250` 以 `assert.deepEqual` 断**全等**。加件即扩子代理能力面。裁定 = 两件新工具都是 read-only 且与已在名单内的 `query_trace` 同门，故**纳入**；该裁定必须写进 T5 的测注释，不得被当成一条意外回归「修掉」。
  - **派生自 `ACI_TOOLSET_NAMES`、自动跟随（禁手改）**：`tests/harness/verify/judge-input.test.ts`、`tests/harness/verify/three-stage-flow.test.ts`。
  - **按下标锁尾部，不重排即安全**：`tests/harness/graph/run-graph-assembly.test.ts`、`tests/harness/mcp/zero-linkage-guard.test.ts`。
- Surfaces: 外部 MCP host via bin；chat/tui/serve 仅受票①无行为 diff 影响；**票③ 起 ACI `query_trace` 语义确有变更**（不再能下钻），故票③ 以本 spec 改写为前置。

## ACR

**票①②（v1.0，历史判定）**

```
bounded-context-guardian: yes — 共享核钉死 src/traceserver/且禁 harness import；MCP 在 src/trace-mcp/ 仅 transport；错误类型在边界映射；不进 ACI registry
defensive-contract-validator: yes — empty SC10；negative SC4/SC9；overflow SC7（4000）；concurrent SC3 钉死既有 project-tool-results 并行测；exception SC3 EXIT + SC10 启动失败
error-handling-enforcer: yes — 核用域内 typed error；ACI/MCP 薄皮映射；blob EXIT 保留；启动 stderr+非0；日志不进 stdout
complexity-anti-drift: yes — 一共享核 + ACI/MCP 两薄皮 + stdio 入口；无 god-server
minimal-change-verifier: yes — 两票两 commit（①抽核+ACI ②壳+bin+测）；禁止混票与 HTTP/OTel/resources
```

**票③（v1.1，`plans/trace-mcp-read-side-split.md`，四轮 BLOCKED 后第五轮 PASS 5/5）**

```
bounded-context-guardian:   yes — 数据装配归 src/traceserver/，wire 形状归各薄皮；无跨皮反向依赖
defensive-contract-validator: yes — 5 边界类 × 3 面覆盖分配成表，T2 先钉现状基线
error-handling-enforcer:    yes — 5 个 kind 各有归属票 + catch-arm 通则 + 前缀归属落 T5
complexity-anti-drift:      yes — 两处已存在的复制（session-index default / 信封字面量）由 T4 单点收编
minimal-change-verifier:    yes — 8 票各一 commit 一轴，破坏性收窄（T7）排在去处落地之后
OVERALL: PASS — 演进记录（含四轮 BLOCKED 各自裁定的具体内容）见 plan 的「ACR 演进记录」段
```

## 待写入

- （无强制 ADR）可选：#803 评论留痕「前置修订为投影 SSOT 已存在」——不阻塞 PLAN。
- **v1.1 新 CONTEXT 词条**（read unit / window / tool face · panel face，以及对契约 X 适用面的澄清）的 SSOT 在 `plans/trace-mcp-read-side-split.md` §待写入，全票合入后经 `domain-modeling` 落 `docs/CONTEXT.md`。本 spec 只在「v1.1 划界」段引用其语义，**不**另存一份定义，避免出现第二权威。
