---
id: 0013
type: lesson-recap
date: 2026-07-25
---

# 0013 · 读陌生代码库方法 + gbrain 工具地图 + 「重启工具」误解纠正

## 用户状态

- 用户发起 /teach，原话：「我对这个 upstream 的源码几乎不了解，是在没了解的情况下改，不知道是不是重复做了东西。我的本意是重启它的工具，但不知道它本来有什么工具。你来教我怎么看，结合我们的计划看看我们在做什么。Send explorers first if you need。」
- 这是用户**第一次主动要求「教方法」而非「教概念」**——从被动接收转向主动要工具。基线仍是：TS 基本不懂、上游源码一行没读过。

## 决策

- 用户明确说 "Send explorers first"——用并行侦察兵挖事实（上游工具清单 + iknow 工具/计划），teacher 同时用 codebase-memory 索引独立定位枢纽做交叉验证。
- 课型 = 方法课（怎么看陌生库，可复用）+ 事实课（gbrain 工具全图）+ 纠偏课（结合计划）三合一，围绕一个核心技能展开，符合渐进式披露。
- 全部代码事实标 file:line，贴真实源码逐行讲，TS 语法（箭头函数返回对象加括号 / interface / 可选 ? / Record / Set）第一次出现即解释。

## 关键事实（可回溯）

- **gbrain 工具枢纽**：`_upstream_gbrain/src/core/operations.ts:5316` 的 `operations: Operation[]`，**102 个工具**（文档 CLAUDE.md 写 ~90，实际 102——代码是 ground truth）。
- **工具形状**：`operations.ts:589-619` `interface Operation { name, description, params, handler, scope?, localOnly?, cliHints? }`。一个工具 = 菜单(name/description/params) + 厨房(handler)。
- **LLM 白名单**：`src/core/minions/tools/brain-allowlist.ts:48` — LLM 子代理实际只见 14 个（定义 102 ≠ 暴露 102）。
- **iknow 4-tool ↔ 上游对照**：kb_retrieve←query/search（收窄）、kb_compile←extract_facts（收窄）、kb_governance←散落能力（收敛）、kb_verify_citation←无（**原创**，上游 102 工具里没有引用核验）。
- **iknow 工具注册表两份**：`src/tools/registry.ts:24-41`（运行时绑定）+ `src/agent-loop/tool-defs.ts:25`（LLM 协议 KB_TOOL_DEFS）；LLM 真正看到工具在 `llm-agent.ts:155`；hop 白名单 `tool-defs.ts:8`（只 kb_retrieve/kb_verify_citation 消耗 hop）。

## 纠正的误解（高价值）

- 用户以为「我的本意是重启 gbrain 的工具」。实际项目计划**没有任何一处**说要重开/重做工具协议，反而多份文档反复写「不重开 4-tool 协议」（STATUS.md:149、progress-brief.md:49、prototype-cli-integration...md:5）。真正下一步焦点：真实语料 + 9router key 对齐 + 会话增强 + UI 栈归一决策。「重启工具」这个念头本身，正是「没看过上游、心里没底」的症状——这节课补了地图后，用户应能理解自己做的是「有意识的收窄+补强」，不是重复造轮子。

## 产出

- `lessons/0010-reading-unknown-codebase-gbrain-tools.html`：三招方法 + gbrain 102 工具分组 + 4-tool 对照表 + 计划纠偏 + 3 题 quiz + 3 段面试 Q&A。
- `reference/17-gbrain-tool-map.html`：可贴墙工具地图（三枢纽 + 对照表 + 102 工具分组 + 三招方法卡）。

## ZPD 影响

- 用户从「上游零认知 / 误以为在重启工具」推进到「有上游地图 / 能讲清 4-tool 对应关系 / 知道项目真正在干什么」。
- **下一步最该补**（按用户优先级 + 面试含金量）：
  1. **kb_verify_citation 三态核验导读**（最高含金——这是 iknow 原创、上游没有、最能体现「取舍」的工具）。
  2. **招数实战复练**：让用户自己用三招去定位 iknow 的某个 seam（从「看我找」到「你找」，建立 storage strength）。
  3. **web 技术栈**（用户优先级第 3）：Vercel AI SDK useChat。

## 关联

- 0010（本课）、0011（agent loop happy path）、0012（教学纪律）
- reference/17（工具地图）
- MISSION.md / NOTES.md（不变）
