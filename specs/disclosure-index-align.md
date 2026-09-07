# Spec: disclosure-index-align — 索引档对齐 + 直呼加载 + 超限降档

> 输入 = 2026-09-06 LogicSync（operator 终锁：search 只为「前缀没有描述」；工具超限仍留名+描述、直呼加载 schema；MCP/skill 超限只留名才补描述；`skill_search` 删；目录外 skill 走 `read_file`；#631 短描述收回）。
> 范围 = 模型面索引档内容、加载入口、超限降档梯子；不含新检索算法、不含装配期目录外自动扫描。

## ASSUMPTIONS（假设闸门）

本轮 LogicSync 已由 operator 确认；下列条目进入契约，不再重开。

1. 内建工具起步 = 全量 schema 进 `tools[]`；核心七件永不退场（沿用 ADR-0043）。日常预期不超限，但超限路径必须存在。
2. MCP 起步 = schema 不 upfront（沿用 ADR-0043）；索引档收回 #631 T2：服务名 + 一句话、工具 **名 + 短描述（首行，截 ~120 字）**；会话冻结快照（不恢复每轮现读 status）。
3. Skill 起步 = `<available_skills>` **名 + description**（沿用 #337 T6）；正文只经 `skill({name})`。
4. **分界 SSOT**：前缀**有描述** → 禁止把 search 当必经步，按精确名加载贵载荷即可；前缀**没有描述**（MCP/skill 索引降档后的仅名字）→ 才用 search / 按名补描述。
5. 超限只降一档、**不从目录删名字**：内建 schema 退场件 → **名+描述**（不剥描述、不走 search）；MCP / skill 索引超限条目 → **仅名字**。退场内建件不参与索引降档剥描述。
6. 有描述时的加载：MCP/`mcp__*` 与 lazy 内建直呼 → `discover`（参数齐则执行，否则非 error 投影 schema）；skill → `skill({name})`。废除 `tool <name> not loaded — call tool_search first`。
7. `tool_search` 仅服务「描述不在前缀」：关键词找回描述+schema，或 `names` 精确名补描述+schema。有描述的退场内建 / 未降档 MCP **不得**要求先 search。
8. `skill_search` 删除。无描述的 skill 靠 `skill({name})` 带回正文（含「这是干什么的」），不另留检索件。
9. 装配扫描根以外的 skill：不新增加载器；操作员在对话里指路径，模型 `read_file`。
10. 闸门形态：schema 退场与索引降档均为 countTokens 实测、禁 chars/4、仅首轮一次、失败跳过 + `console.warn`。阈值皆为端点窗口 10%。剥光 MCP/skill 描述后仍超阈 → 接受超阈、不删名、不剥内建描述。
11. 栈与验证：TypeScript ESM、`npm test`；不新增 npm 依赖。
12. `disable-model-invocation` skill 仍不进 `<available_skills>`；精确名 `skill({name})` 仍可取正文。
13. 前缀资格线 / 开局等待 / 手动重连只消息追加 / lazy 尾部追加纪律 **不重开**。

## Objective

把渐进式披露收成：索引档常驻；有描述就按名加载贵载荷；没描述才 search。用户是 iknow chat/TUI/serve 操作者。成功 = 带描述的 MCP/退场内建不必先 `tool_search`；`skill_search` 不存在；MCP 目录恢复短描述；超限不删名字。

## Boundaries

- **Does:**
  1. **MCP 索引档收回 #631 T2**：加性段渲染 connected 服务名+可选服务描述、工具名+短描述（`MCP_TOOL_SHORT_DESCRIPTION_MAX = 120` 首行截断）；描述缺席 → 只渲染工具名；failed/pending/disabled 不渲染；空则段缺席。firstTurnReady 后冻结。
  2. **有描述则直呼加载**：未 discover 的 `mcp__*` 与 schema 退场 lazy 内建：本轮 `discover()`（尾部追加 `tools`）；input 通过 schema → 执行；否则非 error 文本投影 `{name, description, inputSchema}`。不抛「先 tool_search」。
  3. **`tool_search` 合同**：description 写明仅在索引无描述时用（关键词或 `names`）；命中仍 `discover`。带描述条目的直呼路径不依赖本工具。
  4. **删除 `skill_search`**：移出 `ACI_TOOLSET_NAMES`；`skill` 文案 = 从 `<available_skills>` 精确名直呼；未知名引导清单或 `read_file`，禁止提 `skill_search`。
  5. **内建 schema 溢出**：10% + 既有退场次序 + 核心七件；退场件进索引档为 **名+描述**。
  6. **索引降档**：仅 MCP 与 skill 条目；合计超 10% 时从大到小剥描述只留名；退场内建描述保留。
  7. **测试与 TUI**：identity MCP 段、overflow、skill 工具、337 E2E 直呼 `skill`、Gate 3 名单、删除 TUI `skill_search` 映射。
  8. **文档**：CONTEXT + ADR-0046 + ADR-0043 amendment（persist 步）。
- **Confirms with human:** 无。
- **Out of this spec:** 新检索器；会话中重扫 skill；`skill({path})`；MCP schema upfront；改 30s 开局等待；服务端 `tool_reference`；#337 其它 MCP 生命周期；把退场内建剥成仅名字。

## Success Criteria

1. 测试：connected MCP 的 system 段在未降档时含工具短描述；超 120 字截断；无描述则仅名；无 connected → 无该段。
2. 测试：相邻两轮 `tools` + `system` deep-equal（含短描述快照）。
3. 测试：带描述、未 discover 的 `mcp__*` 直呼不抛 `call tool_search first`；合法 input 执行成功；缺参 → 非 error 且含 `inputSchema`，下一轮 `tools` 尾部有该 schema。
4. 测试：schema 退场内建件索引含 description；直呼该件不要求先 `tool_search`；核心七件 schema 仍在首轮 `tools[]`。
5. 测试：`skill_search` 不在 `ACI_TOOLSET_NAMES` / `visibleSchemas`；对该名调用与未知工具同形失败。`skill` description 不含 skill_search。
6. 测试：未知 `skill({name})` 引导含 available_skills 或 `read_file`，不含 `skill_search`。
7. 测试：撑大 MCP/skill 索引超 10% → 被降档条目仅剩名字、原名仍在；退场内建若在场则仍带 description。
8. 测试：337 E2E（或等价）`skill({name})` 直呼成功，无 `skill_search`。
9. `npm test` 全绿；不强制 `test:real-llm`。

## Open Questions

(none)

## Inherits / Changes

- **Inherits**
  - **渐进式披露 (progressive disclosure)**、**名字目录 (tool name catalog)**、**溢出治理 (tool-surface overflow governance)**、**前缀资格线**、**开局等待**（CONTEXT / ADR-0043；正文以 persist 后版本为准）。
  - `#337` 三级扫描、`skill({name})`、`disable-model-invocation` 不进清单。
  - `#631` T2 120 字短描述、空段缺席、failed 不渲染。
  - `npm test`；Gate 3。
- **Changes**
  - 目录默认名+短描述；索引降档只剥 MCP/skill 描述。
  - 有描述 → 直呼 `discover`；`tool_search` 仅无描述。
  - 删除 `skill_search`。
  - ADR-0043 §2/§5/§7「必经 tool_search」由 ADR-0046 修订。

## architecture-change-reviewer

**第一轮（2026-09-06）— PASS（5/5 yes）**；终锁「search = 前缀无描述」未改模块切面 / 五类边界 / 失败合同形态，不重开闸。

```
bounded-context-guardian: yes — 改动落在既有 Harness/ACI/identity 与 TUI 映射，不新开检索器/加载器/技术分层
defensive-contract-validator: yes — empty=空段与无描述；negative=failed 不渲染 + 未知工具/未知 skill；overflow=schema 退场与索引降档；concurrent=邻轮 tools+system deep-equal；exception=countTokens 失败跳过
error-handling-enforcer: yes — 直呼合法 input 执行、否则非 error 投影 schema；废除 call tool_search first；溢出失败跳过+console.warn；删除名与未知工具同形失败
complexity-anti-drift: yes — 目录渲染 / hydrate / overflow 退场与降档 / 删 skill_search / TUI 分切面，无整条梯子塞进一个函数
minimal-change-verifier: yes — 单一产品契约「有描述则加载、无描述才 search」；实施 commit 后拆；不含新检索/skill({path})/schema upfront
```
