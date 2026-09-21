# 0043. 工具面披露分层：内建常驻 + MCP 目录化 + 溢出治理与开局等待

Date: 2026-09-04
Status: accepted

> **Amendment 2026-09-06**（ADR-0046）：§2「完整定义经 tool_search」「未加载即调用 → 报错并提示先 tool_search」、§5「要用即走 tool_search」、§7「信息由名字目录 + tool_search 结果消息承载」中**必经 tool_search** 的读法 **superseded**。名字目录默认名+短描述；有描述则直呼 `discover`；`tool_search` 仅当前缀无描述。schema 不 upfront、开局等待、前缀冻结、§3 schema 退场次序与 10% 闸仍有效。

## Context

wayfinder 图「模型面前缀分层与缓存兑现」G1 票（前缀稳定边界）与 MCP 披露形态合并裁决。前缀序 `tools → system → messages`，目标端点走被动前缀缓存：前缀任何字节变动即其后全部作废。现状三处违约：`<mcp_tools_overview>` 每轮现读连接状态（连上即变）；MCP 工具连上即全量 schema 进 tools（每会话早期抖 1~2 次）；连接事件无模型侧告知。既有 lazy / `tool_search` 机制（渐进式披露，发现序尾部追加）建而未用（`lazy: true` 零命中）。

## Decision

**按工具类别切分披露形态，前缀区只收「构造上会话内恒定」的内容；两条断言执法。**

1. **内建工具**：核心件全量 schema 常驻（`bash` / `read_file` / `edit_file` / `write_file` / `grep` / `glob` / `spawn_subagent` 永不延迟）；低频大件受溢出治理约束（见 3）。
2. **MCP 工具**：schema **一律不进前缀区 upfront**——名字目录进 system（首轮定稿、会话内恒定），完整定义经 `tool_search` 按需加载；发现 = 结果消息追加 + schema 尾部追加进 tools（客户端双写，每件一次性抖动，此后常驻）。未加载即调用 → 报错并提示先 `tool_search`。lazy 尾部追加纪律（不插回注册序）收编为全工具通用规则。
3. **溢出治理**：可延迟工具（MCP 名单 + 标记的内建低频件）schema 总量（**countTokens 实测，禁止 chars/4 估算参与判定**）超过**端点模型 context window 的 10%**（窗口值从 adapter 配置读，不硬编码）时，超出部分退到名字目录。**只在首轮装配判定一次**，会话内不重算。退场次序（面积 × 低频从大到小）：trace 读侧三件（`query_trace` / `list_sessions` / `get_record`）→ `web_search` / `web_fetch` → 其余低频查询件按实测面积排。核心件永不退场。
4. **开局等待**：首轮请求前等待 MCP 连接完成（超时 30s，超时者停止自动重试、本会话缺席）；窗口内连上的零破坏进首轮装配——首个请求发出前前缀即定稿。
5. **手动重连**：超时缺席的 server 由用户手动重连成功后，**只往 messages 尾部追加一条通知**（该 server 的工具名字），不改写历史；模型要用即走 `tool_search`。
6. **断开**：server 会话中断开，其工具调用报错，tools 与历史一字不动。
7. **system 清理**：`<mcp_tools_overview>` 撤出 system（其信息由名字目录 + `tool_search` 结果消息承载）。
8. **执法断言**：① `IKNOW_ASSEMBLY_ORDER` 每个声明段必须出现在装配产物中，或显式声明为条件段并给出缺席条件（补 T0 揭示的「声明与实现分离」漏洞）；② harness 测试中相邻两轮装配的 tools + system deep-equal（D7 已立 tools 侧，此处补 system 侧与总装）。

## Why not

- **MCP 连接即全量 schema 注入**：每会话早期固定抖 1~2 次，用不用都抖；且把「面积」问题暴露给每个请求。
- **默认全懒加载（无阈值）**：客户端形态下每件真用到的工具触发一次抖动且时点不可预测——仅在面积超限时才划算，故溢出治理只在首轮判定超限时启动。
- **中途自动重连后注入 tools**：为小概率恢复事件破坏「前缀会话内零变化」承诺，纪律无破口化；手动重连仅消息追加已覆盖恢复场景。
- **`<mcp_tools_overview>` 快照化留 system**：内容会随连接状态过时，模型按过时概览调用未连接 server 的工具即 `tool_not_found`——比缺席更坏（对比 D1 git 块免责句可救文字过时，救不了硬调用失败）。

## Consequences

- **正面 / Applied:** 前缀区（tools 常驻部分 + system）在正常会话内零变化；连接/断开/重连事件全部落在消息侧或 handler 层。R4 抖动表中「tools 尾部追加（MCP 连上）」与「system 任一段变（MCP 概览）」两行消除，每会话全量 messages 缓存作废次数从 3~5 降至 0（正常路径）；溢出治理作为面积保险丝随端点自适应。
- **负面 / Trade-offs:** 每件真用到的 MCP 工具多一跳 `tool_search`（一次性，~200 tok 级）；名字目录需保持信息量使模型能正确决定查什么；溢出治理依赖 countTokens 实测（估算参与判定已禁止）。

## Evidence pointers

- R2/R3 实测（asset: `scripts/wayfinder-measure-prefix.ts`）：tools 42 件 ≈ 10.4K tok（chars/4 估算，真实值待 countTokens 实测）。
- R5：MCP 连接抖动路径与 lazy 机制现状（`lazy: true` 零命中）；尾部追加纪律注释（`src/harness/aci/aci-registry.ts:143`）。
- R4 抖动表：每会话 3~5 次全量 messages 作废的事件构成。
- D7：会话内可变闸门只许落位 messages 尾部或 handler 层。
- D8（ADR-0042）：memory_layer catalog 会话级快照先例。
