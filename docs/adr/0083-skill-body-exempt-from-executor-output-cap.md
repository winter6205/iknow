# 0083. skill 正文不经通用输出闸

Date: 2026-09-11
Status: accepted

ADR-0006 的 executor 兜底闸（20000 字符硬截断 + 引导语「用更精确的输入重新调用」）建立在「工具输出多为读文件 / 搜内容等**可再生查询**」这一前提上。`skill()` 不满足该前提：它的输出是一次装配产物（frontmatter 剥离 + `Base directory` 行 + `<skill_files>`），单一来源、整份语义，被截断后没有「换更精确输入重调」这条恢复路径；而三条消费路径（TUI slash / session-api `loadSkillBody` / ACI `skill()`）本就共用同一装配口，正文一大就只有第三条分叉。半份技能程序比没有更危险——模型会把半份当全份执行，且同名重调会撞二次短路（ADR-0079），本会话内不可恢复。

因此：`skill()` 的正文移出 executor `OUTPUT_HARD_CAP` 的适用范围。豁免是**装配期静态声明**（落 Foundation `ToolDef` 的可选字段，`createSkillTool` 落值，executor 的 `safeContent` / `applyOutputCap` 读），不是运行期字段、不是工具自报——契约 X「executor 是截断元数据的唯一权威」不变。MCP 工具**结构性不可取得**：`toAciToolDef` 只映射 name / description / inputSchema，`registerExternal` 强制 `mcp__` 前缀。`OUTPUT_HARD_CAP` 对其余工具的数值与语义一字不动。

**Why not 给 skill 设专属上限 / 截断后 read_file 补读**：专属上限仍是截断，只是换个数，半份程序的问题原样存在；`read_file` 同样受 20000 兜底闸，不构成逃生口（要分多次读，总量不减，且绕开二次短路闸）。**Why not 运行期强制正文大小**：正文大小纪律是作者契约（正文精简、细则进 `references/`，后者零成本直到被读），机制上不设限，纪律留在作者面。

本豁免是行为合同；ADR-0006 的适用面在此收窄，其对其余工具的裁决继续有效。
