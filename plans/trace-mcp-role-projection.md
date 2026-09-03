# Plan: trace MCP 读侧 role 投影（v1.2）

**Goal:** 外部 agent 经 trace MCP 找一个会话的最终 assistant 结论时，不需要盲翻 parts / 逐窗猜 role——`get_record` 清单臂每个 part 带 `role`，`query_trace` 行轴投影带 `last_assistant_preview`，最短动线 `list_sessions(limit:1) → query_trace(limit:1)` 两次调用直达结论。

**Approach:** 三颗 bullet。T1 先把判据写进 spec（spec Assumption 8：tool face 输出形状的语义变更必须 spec 先行，「代码先动、spec 后补」不算豁免）；T2 在共享核（`src/traceserver/`）单点落地，ACI 与 MCP 两张皮自动继承，只各补测试与 description 单源更新；T3 重建 dist 让生产 bin 追平（当前 `dist/trace-mcp` 是 v1.0 旧构建，只注册 `query_trace`，生产 bin 缺两件工具——实测发现的环境雷，顺路排掉）。**决策已定，不新增第四件工具**（「读最新会话最终结论」便捷工具否决：收益撑不起 Assumption 4 + SC6 白名单 + 两张皮 schema 的变更面；组 1 落地后两次调用已达目的）。

**Spec link:** `specs/trace-mcp-server.md`（T1 修订后为 v1.2）
**ACR:** 见文末 5-verdict 块
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch
**Tracker:** 本地 `plans/*.md`（fallback）——本仓既有惯例（`plans/trace-mcp-read-side-split.md` 等均为本地 plan 文件），未开 GitHub issues。

## 实测依据（2026-09-04，stdio 直驱 MCP server 复现外部 agent 检索动线）

- 会话 `0cee57d3`（53 turn / 53 llm_call）：最终结论 625 字符 assistant 文本存在于最后一条 llm_call 的 messages（idx=38, part=1）——数据无缺失，纯导航缺失。
- `query_trace` 投影的 `last_message_preview` 每条都是 `<agent_status>` user 注入消息（loop-engine 每轮尾部追加），assistant 永远不可见——该字段对「找结论」动线是死预览。
- `get_record(detail=messages)` 清单臂 201 个 parts 只有 `{message_index, part_index, chars}`，无 role——区分 user/assistant 只能逐窗盲读。
- 生产 bin（`scripts/iknow-trace-mcp.cjs` → `dist/trace-mcp/main.js`）是旧构建，`tools/list` 只含 `query_trace`；`.iknow/mcp.json` 实配走 dev wrapper（`iknow-trace-mcp-dev.cjs` → tsx 源码），线上无感。

## Tasks (ordered by dependency)

1. **spec v1.2 修订：role 投影判据入 spec** — tag: `[decision]`
   - **Inherits:** spec Assumption 8 原文：「`conversation_id` 必填、…加参都是**语义变更**，必须先经本 spec（即本 Assumption 4 + SC6–SC8）改写才允许落地——『代码先动、spec 后补』不算拿到豁免」；Assumption 4 四条锁定全部不变（`conversation_id` 必填、字符帽非参数、backstop 20000、两张皮 schema 逐项一致）。
   - **Surface:** `specs/trace-mcp-server.md`（沿 v1.1 的「版本头导航 + 修订清单 + 可逆声明」体例加 v1.2 段）。
   - **Acceptance:** spec 载明两条投影扩展判据——(a) `get_record` 清单臂 `detail=messages` 每个 part 携带其所属 message 的 `role`（`detail=tool_results` 不加：tool_result 按定义在 user 侧）；(b) `query_trace` llm_call 投影新增 `last_assistant_preview`（最后一条 `role==="assistant"` 消息的预览，帽沿用 `QUERY_TRACE_PREVIEW_CAP=400`，无 assistant 消息时字段缺席），`last_message_preview` 原样保留不改语义；并载明否决记录（不加第四件工具、不改 `last_message_preview` 语义）。参数面无任何变化（两张皮 schema 逐项一致判据 SC18 不受扰动）。
   - Status: [x] done
   - [blocks: T2]

2. **共享核 role 投影落地（两皮自动继承）** — tag: `[implementation]`
   - **Inherits:** spec v1.2 判据（T1 产出）；CONTEXT.md `tool_result projection` 词条（同层平级扩展，不替代）；`get_record` 窗臂契约 SC8 不变（窗响应仍不添 role——窗正文寻址已有 `message_index`，role 在清单臂给出）；核 error 无工具名前缀（SC16）。
   - **Surface:** `src/traceserver/`（`query-trace-core.ts` 投影 + `get-record-core.ts` 清单臂 + 两份 `*_DESCRIPTION` 单源更新——description 是两张皮共享文本，受 `tests/harness/aci/tools/d9-description-guard.test.ts` 约束）；ACI（`src/harness/aci/tools/`）与 MCP（`src/trace-mcp/`）两薄皮仅补行为测试，无 schema 改动。
   - **Acceptance:** (a) 实测动线：对真实 trace 跑 `list_sessions(limit:1) → query_trace(record_type:"llm_call", limit:1)`，返回含 `last_assistant_preview` 且内容为该会话最终结论的开头（当前仓 trace 数据可直接验证）；(b) `get_record(detail=messages)` 清单臂每个 part 带 `role`，201-part 清单可一步定位 assistant part；(c) `npx vitest run tests/traceserver/ tests/trace-mcp/ tests/harness/aci/tools/` EXIT 0，其中新增用例覆盖：无 assistant 消息的 llm_call → 字段缺席（合法态，非错误）、`detail=tool_results` parts 不带 role、blob 模式下解引用后 role 仍可得。
   - Status: [ ] pending
   - [blocks: T1] · [parallel] 与 T3 无依赖，但 T3 在其后执行以一次构建同时带上 T2 产物

3. **生产 bin 追平：重建 dist 并验证白名单** — tag: `[implementation]`
   - **Inherits:** spec SC6 原文：`tools/list` 含且仅含三件白名单 `list_sessions` / `query_trace` / `get_record`。
   - **Surface:** 构建（`npm run build` 产物 `dist/trace-mcp/`）+ 生产 bin `scripts/iknow-trace-mcp.cjs`；不改任何源码。若重建后白名单仍不齐，该 bullet 升级为排查 dist 构建接线（tsconfig include / 产物路径），按排查结论扩票。
   - **Acceptance:** stdio 驱动生产 bin `node scripts/iknow-trace-mcp.cjs`：`tools/list` 含且仅含三件白名单，且 `query_trace` 投影含 `last_assistant_preview`（即 dist 内是含 T2 的构建）。
   - Status: [ ] pending
   - [blocks: T2]

## 待写入

- **CONTEXT.md 新词条**（本轮 persist，经 domain-modeling 落盘）：**role projection**（role 可见性投影）——trace 读侧投影平级扩展，见下方 persist 记录。
- spec v1.2 修订由 T1 在实施期落 `specs/trace-mcp-server.md`，属于代码票产出，不在本轮 persist 范围。
- 无 ADR 新增 / reopen：本次是投影层字段扩展，参数面与帽语义零变化，不触碰 Assumption 4 / 契约 X / ADR-0006。

## ACR

```
bounded-context-guardian:   yes — 全部改动在 src/traceserver/ 共享核 + 两薄皮测试；无跨皮反向依赖，无新 bounded context
defensive-contract-validator: yes — 空输入（无 assistant 消息 → 字段缺席为合法态）、非法路径（越界 / blob 解引用失败 EXIT 降级）均入 T2 验收
error-handling-enforcer:    yes — 无新错误路径；既有 5 kind 映射不变；字段缺席是合法态不是错误
complexity-anti-drift:      yes — 单点核改 + 测试；无复制分支（两皮经共享核自动继承）
minimal-change-verifier:    yes — 三票三 commit（spec 修订 / 核+测试 / dist 重建）；不混票；第四件工具否决记录在案
```

## Per-bullet loop（实施期，非本 plan 产出）

每票：test-driven-development → typecheck + 定向 vitest → arthurpower:code-review → verification-before-completion → 票分支上 1 commit。全票落地后收尾一轮 code review phase。
