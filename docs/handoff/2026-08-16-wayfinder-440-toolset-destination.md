# Session Handoff — wayfinder #440 工具体系 destination 重定位 (2026-08-16)

## 当前 live 状态

- **任务**: 重定位 wayfinder map #440 的 destination——从「PR #430 去向决策」提升为「iknow 工具体系该完善什么」；用户以 Agent 架构专家视角与助手讨论中。
- **为什么重要**: 原 map 把一份**描述性调研**（OpenHarness 工具盘点）误当**规范性合同**，导致 6 张票全在答「怎么补齐 §4.7」。换回以 iknow 自身哲学为准绳，工具体系才不会照抄参照系。
- **operator 显式指令**: 「交接一下,我在别的会话继续」——本交接是**上下文快照**，未落 tracker（map #440 未改、未开新票）。**下个会话是这场 destination 讨论的继续，不是已定决策的实施。**

## 已固化工件（引用，不复制 inline）

| 类型         | 路径 / URL                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| map / ticket | https://github.com/winter6205/iknow/issues/440 （6 子票 #441-#446）                                                                                      |
| PR #430      | https://github.com/winter6205/iknow/pull/430 （未 merge，代码在 worktree `p04-tool-aci-completion`）                                                     |
| 领域词汇     | `docs/CONTEXT.md`（`ACI tool set` / `executor truncation authority` / `observability side-channel` / `声明工具面 vs 实际工具面` / `goal` / `taskFocus`） |
| 决策记录     | `docs/adr/0004` `0006` `0009` `0016` `0018`（工具层 / 输出上限 / prior-art 消费 / deny-list / goal-taskFocus 拆分）                                      |
| 调研报告     | `docs/harness-report/p04-tool-aci.html` §4.7（OpenHarness 44 工具全景表）                                                                                |

> 下个 agent 应直接读上述工件；本文件只给指针 + 讨论结论，不抄正文。

## 本 session 变更

| 变更                          | 一行效果                             |
| ----------------------------- | ------------------------------------ |
| 未改动任何代码 / 未动 tracker | 纯讨论轮；结论见下，待下个会话落决策 |

## 已确认的讨论结论（grilling 已锁定，待落 tracker）

1. **§4.7 全景表不是合同**。铁证：`docs/harness-report/` 是 OpenHarness（Claude Code 的开源移植）的交叉映射报告，§4.7 只是 44 个工具文件的**描述性盘点**（无 must/should/required 语言）；`grep "全景表"` 全 repo 只有 p04 worktree 那一个未 merge 分支在当合同用；ADRs 只把它当 prior-art 引用。
2. **plan mode（enter/exit_plan_mode）→ 不做，关闭**。用户明确讨厌；iknow 已有宿主侧 plan permission（`PERMISSION_MODES`，modes.ts，`/permissions` 切换）；模型触发版与 iknow「goal 模型不可写」哲学冲突；报告对这两个工具零实现细节。
3. **MCP 增量（resource 通道 / mcp_auth）→ 搁置**。MCP **工具**通道已完整（`mcp__*` + tool_search + `/mcp` 看板，#337）；resource/mcp_auth 是增量，`mcp_auth` 一碰就卷入 #406 secret-roundtrip 接缝。
4. **动态工具暴露 → 已做（#224），不升级**。lazy discovery + `registerExternal`（增量）+ `promptTools` 每轮求值缝；缺的「按会话状态移除工具」无消费者，不为无消费者的能力建机制。
5. **todo_write → 研究原型（选项 b）**。用户选 b。报告给的关键证据：OpenHarness 的 todo_write **缺 `passes` 完成验证字段**（p10-pitfalls，标缺失）；用户原始直觉「探索性任务下列表是噪音」。
6. **目标校准**：用户澄清目标是**完善工具体系**，不是做某件工具；「要做什么」尚未定——下个会话要定的就是这个。

## 未决议（下个会话的 grilling 主题）

**工具面两维坐标系**（所有权 control locus × 生命周期 lifecycle）——助手上轮提出，用户尚未回应选 A/B/C：

```
        宿主控制                         模型控制
         ┌───────────────────────────────┐
长期    │ goal · taskFocus · memory      │ todo_write(待定) ← 争议区
状态    │ (都已存在,#458/#228)           │
         ├───────────────────────────────┤
短期    │ permission · skill 开关        │ bash · edit_file · web_search
状态    │ (宿主侧切换)                   │ spawn_subagent (执行工具)
         └───────────────────────────────┘
```

- 空白象限 = **模型控制 + 长期状态**（todo_write 的位置；iknow 故意留空）。
- 三个可选动作：
  - **A** 填右下：做「模型可写的长期状态」工具（todo_write 只是候选之一）——接受 50% 风险去研究。
  - **B** 不填：定死「长期状态一律宿主控制」，完善左下+右上象限。
  - **C** 中间态：模型提案 + 宿主确认（todo 由模型提议、宿主一键确认）——最接近用户想法的候选。

## Open blockers + next steps

**[NEXT] 下个会话继续 grilling：让用户对「工具体系完善方向」做出选择（A 填模型可写长期态 / B 定死宿主控制 / C 模型提案+宿主确认，或修改坐标系）** — 在继续讨论前，先 Read `docs/CONTEXT.md` + 本文件 + 已固化工件表里的 map/PR/报告链接。

- 落决策后重画 map #440：改写 destination、关闭 T2/T3（plan mode / mcp_auth）、处置 T1/T4/T5/T6（随「不 merge PR #430」而失效/重锚）、记 Decisions-so-far 与 Not-yet-specified、Notes 记手off路由。
- 若 todo_write 原型立项：明确假说对照（H-c 焦点所有权 vs H-a 有用性 vs H-b passes 验证）与验证矩阵，再决定是否另开 prototype 票。
- map 重画前不写代码、不改 master。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:wayfinder` — 工作方式：work-through 模式，地图 URL = #440
- `arthurpower:deep-dive-protocol` — destination 定型的访谈驱动（当前会话用的就是这个）

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据一律用环境变量名，不写值
