# Spec: skill() 二次短路 + skill 正文不挂写根

> 输入 = LogicSync 2026-09-10（Confirm 拆开 + 沿用 Recommend）+ ADR-0079 + CONTEXT `skill() 二次短路`。
> 本文件是行为合同。`specs/skill-load-write-root.md` / `337-skill-mcp-extension.md` SC6 / `write-situation-disclosure.md` 告知面组成由本 spec **amend**，不 supersede 写根 helper SSOT、改绑一次告知、门禁回执。

## Glossary（exact copy from docs/CONTEXT.md）

- **skill() 二次短路**: 模型再调同名 `skill()` 时，若可见 messages 仍有该名成功全文 `tool_result`，只回短回执、不重装 SKILL 正文；compact 丢掉该条后才再灌全文。闸只罩 ACI `skill()`。ADR-0079。
- **直呼加载 (exact-name load)**: (ADR-0046) 前缀已有名字时按该名灌贵载荷——`skill({name})` 取 SKILL.md；未 discover 的工具或 MCP 调其名即 `discover`（参数齐则执行）。
- **渐进式披露 (progressive disclosure)**: (#631 / ADR-0046) 便宜索引常驻 + 重载荷按需：索引有描述则按精确名加载（`skill({name})` / 直呼 `discover`）；索引没有描述才 `tool_search`。
- **写处境（write situation）**: 「此刻能不能写、写哪」的三态纯函数判定——`writable_main` / `writable_tree` / `no_writable_root`。告知面（worker prior / 改绑后注入）共享此判定但不共享措辞。skill 正文不挂写根 trailer。ADR-0069；告知面组成见 ADR-0079。
- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新。
- **截断窗口**: compact 从 `messages` 末尾留下的原文条数；窗口内若有 `tool_result` 而对应 `tool_use` 在窗外，再把那条 `tool_use` 整条捞回。

## Assumptions（本会话已确认，不再开口）

1. 「加载技能」= 模型调 ACI `skill()` 把装配正文灌进可见上下文，不是 system 每轮重灌索引。
2. 二次短路判据 = 当前可见 messages，不是只增不减的会话 Set。
3. slash `[skill-load]` 与 Web `getSkillBody` 不闸。
4. 写处境从 skill 正文拆走；不在写工具成功路径另注写处境段。
5. 磁盘 SKILL.md 本会话变了不自动再灌。
6. 未绑树时模型可能按 skill 先伸手写一次再看门禁回执——已接受。
7. 短回执仍是配对 `tool_result`，不得吞掉 `tool_use`。

## Objective

模型第一次 `skill({name})` 仍拿到装配正文（frontmatter 剥离 + `Base directory` + `<skill_files>`）。同名再调且可见历史里该次成功全文还在，只拿短回执。写处境不再绑在这份正文上。

成功 = 二次同名调用不出现第二份 SKILL 全文；compact 丢掉该 `tool_result` 后可以再灌；slash 再装信封仍灌全文；`createSkillBody` 与三条 skill 消费路径不再追加写根 trailer；worker prior 与改绑一次告知仍走既有 helper。

## Boundaries

- **Does:**
  - ACI `skill()` handler：可见 messages 已有该名成功全文 → 短回执；否则 `createSkillBody`。
  - 成功全文 = 该名 `skill` 的非引导、非短路 `tool_result`（337 装配形态）。未知名引导句不算已加载。
  - 同一波两次同名：第一次灌全文，第二次短路（本波已成功的全文对第二次可见）。
  - `createSkillBody` 不再追加写根段；TUI slash / hub `loadSkillBody` / `skill()` 三处生产调用不再为 trailer 传入写处境。
  - 整理指针：本 spec amend `skill-load-write-root` 合同 2/3/4/6/8 与 SC2/SC3/SC5；337 SC6 去掉「skill 正文末尾 trailer」；`write-situation-disclosure` 告知面不再含 skill trailer。
- **Confirms with human:** （已确认）短回执具体措辞由实施选定，须含「已在可见上下文 / 勿再调 `skill()` / 按先前正文执行」语义。
- **Out of this spec:**
  - slash / Web 二次短路。
  - 会话 Set、system 已加载集合。
  - 写工具成功路径另注写处境。
  - 改 `writeRootSegment` 文案、改门禁回执、改 T9。
  - skill 包路径写拒绝、改名 `Base directory`。

## Success Criteria

绿线：`npx vitest run` 覆盖 skill 正文装配与 `skill()` 工具的既有 + 新增测试；`npm run typecheck` exit 0。

1. **首次灌全文**：可见历史无该名成功全文时，`skill({name})` 输出 = frontmatter 剥离 + `Base directory` + `<skill_files>`，**不含** `current write root` / 写处境段。
2. **二次短路**：同一可见历史上再调同名 `skill()` → 短回执，字节远小于全文，且不含 SKILL 程序正文；仍是非空 `tool_result`。
3. **compact 后再灌**：可见 messages 不再含该名成功全文（截断窗口外）→ 再调同名必须灌全文（SC1 形态）。
4. **slash 不闸**：同会话已 `skill()` 过后，slash skill-load 信封仍含装配全文。
5. **未知名**：叫错名仍是既有引导句，不记为已加载，再调仍引导。
6. **写处境不进正文**：三处生产路径（slash / `loadSkillBody` / `skill()`）的装配正文在传入活 `taskRoot` 时仍无写根 trailer；worker prior 与改绑一次仍用同一 `writeRootSegment` helper。
7. **同一波两次同名**：一波 `executeAll` 内两次 `skill({name})`，第二次短路。
8. **绿线**：`npm test` 中与本面相关的 skill / write-root prior 测试 + `npm run typecheck` exit 0。

### 输入五类（S2，`skill()` 短路闸）

| 类         | 输入                               | 期望                                          |
| ---------- | ---------------------------------- | --------------------------------------------- |
| empty      | `name` 空 / 非 string              | 既有未命中引导句，不短路集合                  |
| negative   | 可见历史无该名全文；或只有引导句   | 灌全文（命中时）或引导                        |
| overflow   | 超长 SKILL.md 首次加载             | 全文仍可装配；二次仍短回执                    |
| concurrent | 同一波两次同名                     | 第二次短路                                    |
| exception  | catalog 无此名；handler 读历史缺席 | 引导句 / fail-closed 灌全文（不得假装已加载） |

## Open Questions

(none)

## Inherits / Changes

- **Inherits:** ADR-0079；ADR-0069 除 Decision 1 告知面组成外；ADR-0046 直呼加载；`append-only messages` / `截断窗口`；`writeRootSegment` 文案 SSOT 仍在 `src/harness/skill` 旁；合同 1「写根文案只有一份」仍约束 worker prior 与改绑缝；337 装配形态（无 trailer）；`ToolExecutionContext` 今日只有 signal / conversationId 等，**不**把「已加载 Set」写进 system。
- **Changes:** `createSkillBody` 停追加 trailer；`skill()` 按可见历史短路；上述三份旧 spec 指针与 SC 以本文件为准。

## ACR

```
bounded-context-guardian: yes — 短路与去 trailer 都留在 harness skill / ACI skill 消费面；写处境判定仍住 isolation，writeRootSegment 仍住 skill；不新建技术分层目录，不让 skill() 依赖门禁模块。
defensive-contract-validator: yes — spec 已为 skill() 闸列出 empty / negative / overflow / concurrent / exception；去 trailer 覆盖「传入活根仍无写根段」与未知名引导句。
error-handling-enforcer: yes — 历史快照缺席 fail-closed 灌全文，不得假装已加载；未知名保持既有引导句；短路必须仍有非空 tool_result（不得吞 tool_use）；无空 catch 计划。
complexity-anti-drift: yes — 装配停追加与「是否已有全文」分成两片；handler 组合判定 + 装配，不把 compact / slash / 写处境塞进一个函数。
minimal-change-verifier: yes — 一个主题（skill 正文合同按 ADR-0079 收回 trailer + 二次短路）；计划 T1–T3 按依赖各一 commit，不与无关重构混合。
```

见 `plans/skill-body-short-circuit.md`。
