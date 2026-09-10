# Spec: skill 正文加载契约 — 三路同源、不经通用输出闸

> 输入 = 2026-09-11 会话（skill 正文加载面的现状核查 + 决议）+ ADR-0079。
> 本文件是行为合同。与 `specs/skill-body-short-circuit.md` 同面不同轴：那份管「同名再调不再灌第二份」，本份管「灌进去的那一份完不完整」。不改短路判据、不改装配形态。

## Glossary（exact copy from docs/CONTEXT.md）

- **直呼加载 (exact-name load)**: (ADR-0046) 前缀已有名字时按该名灌贵载荷——`skill({name})` 取 SKILL.md；未 discover 的工具或 MCP 调其名即 `discover`（参数齐则执行）。
- **渐进式披露 (progressive disclosure)**: (#631 / ADR-0046) 便宜索引常驻 + 重载荷按需：索引有描述则按精确名加载（`skill({name})` / 直呼 `discover`）；索引没有描述才 `tool_search`。
- **skill() 二次短路**: 模型再调同名 `skill()` 时，若可见 messages 仍有该名成功全文 `tool_result`，只回短回执、不重装 SKILL 正文；compact 丢掉该条后才再灌全文。闸只罩 ACI `skill()`。ADR-0079。
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。
- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新。

## Assumptions（本会话已确认，不再开口）

1. **skill 正文不是可再生查询**。它是一次装配产物、单一来源、整份语义；被截断后「换更精确的输入重调」这条恢复路径不存在（executor 截断标记的引导语对工具查询成立，对本工具不成立）。
2. 正文只在用户 / 模型显式加载时进上下文；加载后持久占用，harness 不重读磁盘（ADR-0079）。
3. compact 后正文不保证存活；恢复路径 = 模型重调同名 `skill()`（`skill-body-short-circuit.md` SC3）。自动重挂本 spec 不做。
4. 不新增截断 / 预览 / 目录 / 回退 / 落盘机制；不设 skill 专属上限。
5. 正文大小纪律是**作者契约**（正文精简、细则进 `references/`），不由运行时强制——它是「不设运行时上限」能成立的前提。
6. 「三路同源」指装配正文内容同源；运输层形态本就不同（slash 走 `[skill-load]` 信封、`skill()` 走 `tool_result`），不要求运输层一致。
7. 半份技能程序比没有更危险：模型会把半份当全份执行，且本会话内不可恢复。

## Objective

三条消费路径（TUI slash / session-api `loadSkillBody` / ACI `skill()`）交付同一份完整装配正文——`createSkillBody` 产物在进入上下文的每一步都不被通用输出闸截断。

成功 = 同一 skill 经三路进入上下文的正文与 `createSkillBody` 产物逐字节相等、无截断标记；其他工具的输出闸行为一字不变；MCP 工具不能取得该豁免。

## Boundaries

- **Does:**
  - ACI `skill()` 的正文移出 `OUTPUT_HARD_CAP`（`src/harness/tools/executor.ts`）的适用范围。豁免是**装配期静态声明，落在 Foundation `ToolDef`（`src/harness/tools/types.ts`）的可选字段上**：`createSkillTool` 装配期落值，`executor.ts` 的 `safeContent` / `applyOutputCap` 读它。字段名由实施选定（语义 = 该工具输出不进 executor 兜底截断）；**不得**在 executor 内靠 cast 读取（`ToolDef` 类型上看不见 `aci`，那是影子契约），**不得**让 `src/harness/tools/` import `src/harness/aci/`（反向依赖）——声明落 Foundation 后，`build-engine` / `subagent/worker` / `aci/demo` 三处 `createExecutor` 自动同源，无需各自接线。
  - 三路继续只经 `createSkillBody` 取正文（`skill-load-write-root.md` 合同 4 不变）；装配形态（frontmatter 剥离 + `Base directory` 行 + `<skill_files>` 采样 ≤10）不变。
  - 反向约束：其余工具（bash / read_file / grep / glob / MCP 等）仍受 20000 字符兜底；`src/harness/mcp/adapter.ts` 的转换路径不设置豁免声明。
  - 文档面：skill 作者契约（正文精简 + 细则进 `references/`）落进相应文档。
- **Confirms with human:** （已确认）正文不设 skill 专属上限；不加预览 / 回退 / 落盘；compact 自动重挂不做。
- **Out of this spec:**
  - 改 `OUTPUT_HARD_CAP` 对其他工具的数值与语义；改 `createSkillBody` 装配形态。
  - slash / Web 二次短路；会话级已加载 Set（ADR-0079 已否决）。
  - 自动重挂机制、重挂配额、模型侧「被压缩」告知。
  - 运行期的正文大小强制（如扫描期拒绝超大 SKILL.md）。

## Success Criteria

绿线：`npm test` 中与本面相关的 skill / executor / MCP 测试 + `npm run typecheck` exit 0。

**基线**：本契约叠在 `feat/skill-body-short-circuit`（ADR-0079 短路实现：`48f172a9` / `63b9bbe7` / `0d47d3a8` / `8d65bd50`）之上。SC5 的短路前提只在该基线上可测；基线未合并时 SC5 记「基线先行」，不降断言强度。

1. **超长正文完整交付**：>20000 字符 SKILL.md，`skill({name})` 输出 = 完整装配正文（末段 `</skill_files>`），不含 `executor: 输出超长已截断` 标记，且字节数 > 20000。
2. **三路同源**：同一 skill 经 slash 信封正文 / hub `loadSkillBody` / ACI `skill()` 三路得到的正文与 `createSkillBody` 产物逐字节相等。
3. **闸不泄漏**：内建非豁免工具与 MCP 工具的超长输出仍被截到 ≤20000 并带既有标记（回归断言）。
4. **豁免不可自称**：MCP 转换路径产出的工具无豁免声明（结构断言），且超长 MCP 结果仍截断（行为断言）。加固：`registerExternal`（`src/harness/aci/aci-registry.ts`）对 `mcp__` 前缀的 def 剥离 / 拒绝该声明，防未来 in-process 手工构造的 def 混入。
5. **既有短路不回归**：首次灌全文、二次短回执、compact 后重灌三条 SC 与 `skill-body-short-circuit.md` 一致。
6. **失败面不变**：未知名仍返回既有引导句；catalog miss / 读文件失败仍走既有失败路径，不因豁免变成静默假成功。
7. **绿线**：相关面 `npm test` + `npm run typecheck` exit 0。

### 输入五类（S2，正文加载面）

| 类         | 输入                            | 期望                                                |
| ---------- | ------------------------------- | --------------------------------------------------- |
| empty      | 空正文（仅 frontmatter / 空白） | 仍装配 `Base directory` + `<skill_files>`，不 panic |
| negative   | 未知名                          | 既有引导句，不触发豁免路径                          |
| overflow   | >20000 字符正文（含 1MB 级）    | 完整交付，无截断标记                                |
| concurrent | 同一波两次同名                  | 第二次短回执（既有 SC7 不变）                       |
| exception  | 读文件失败 / catalog miss       | 既有失败路径，不静默假成功                          |

## Open Questions

(none)

## Inherits / Changes

- **Inherits:** ADR-0006 的兜底闸对其余工具照旧；契约 X（工具不声称截断字段）不变——豁免是装配期静态声明，不是运行期声称；`createSkillBody` 仍是唯一装配口；`exceedsUserInputCap` / `isSkillLoadText` 的 skill-load 豁免语义不动（那是用户输入面，与工具输出面两回事）。
- **Changes:** `skill()` 正文从 `OUTPUT_HARD_CAP` 适用范围移出——ADR-0006「任何工具输出经 executor 总闸必不超 20000 字符」的后果句对本工具失真，需 ADR 记录；skill 作者契约进文档。

## 待写入（persist 清单）

- ADR：skill 正文不经通用输出闸（理由 = 非可再生查询 + 三路一致性 + 半份程序不可交付；边界 = 仅内建静态声明、MCP 不可取得）。编号避开主 checkout 在途的 0075–0082，取 **0083**。
- `docs/CONTEXT.md`：`executor truncation authority` 词条补 scope 例外（skill 正文）；补一对 disambiguation（「skill 正文豁免 vs 契约 X」）。

## ACR

```
bounded-context-guardian: yes — 豁免声明落 Foundation `ToolDef` 可选字段（src/harness/tools/types.ts），createSkillTool 落值，executor 经 safeContent/applyOutputCap 读；tools/ 不进 aci/ import，无影子契约 cast。
defensive-contract-validator: yes — S2 表五类齐全；SC1/SC3/SC4/SC6 钉死「>20000 完整交付」「其他工具仍截断」「MCP 结构+行为断言」「失败面不变」。
error-handling-enforcer: yes — 不新增 catch/fallback；未知名 / catalog miss / 读失败走既有 typed 路径；豁免只绕截断，不绕错误处理。
complexity-anti-drift: yes — 唯一改动点 = 既有 cap 处加一个布尔读（executor.ts）；禁新增截断/预览/回退机制。
minimal-change-verifier: yes — 单一主题；基线声明已补（叠 feat/skill-body-short-circuit）。
```

首轮判 BLOCKED（bounded-context-guardian: no）已按上述落点修：豁免 home 选定 + executor 读路径点名 + 基线声明 + MCP 加固项。
