# Plan: skill() 二次短路 + skill 正文不挂写根

**Goal:** 同名 `skill()` 在可见历史仍有全文时只回短回执；技能程序与写处境拆开。
**Approach:** 先停 `createSkillBody` 追加 trailer（三处消费路径跟停），再在 `skill()` handler 按可见 messages 短路。slash / 改绑 / worker prior 本轮只回归、不改合同。
**Spec link:** `specs/skill-body-short-circuit.md`
**ACR:** all-yes（2026-09-10）。五维块见下。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

**Worktree:** `.iknow/worktrees/skill-body-short-circuit`（分支 `feat/skill-body-short-circuit`）。实施在该树上进行。
**待写入:** （空 — CONTEXT / ADR-0079 已在 LogicSync persist 落盘）

## ACR

```
bounded-context-guardian: yes — 短路与去 trailer 都留在 harness skill / ACI skill 消费面；写处境判定仍住 isolation，writeRootSegment 仍住 skill；不新建技术分层目录，不让 skill() 依赖门禁模块。
defensive-contract-validator: yes — spec 已为 skill() 闸列出 empty / negative / overflow / concurrent / exception；去 trailer 覆盖「传入活根仍无写根段」与未知名引导句。
error-handling-enforcer: yes — 历史快照缺席 fail-closed 灌全文，不得假装已加载；未知名保持既有引导句；短路必须仍有非空 tool_result（不得吞 tool_use）；无空 catch 计划。
complexity-anti-drift: yes — 装配停追加与「是否已有全文」分成两片；handler 组合判定 + 装配，不把 compact / slash / 写处境塞进一个函数。
minimal-change-verifier: yes — 一个主题（skill 正文合同按 ADR-0079 收回 trailer + 二次短路）；T1–T3 按依赖各一 commit，不与无关重构混合。
```

**affects（实施不得超出）：**

- `src/harness/skill/body.ts`（`createSkillBody` 停追加 trailer；`writeRootSegment` 保留给 prior / 改绑）
- `src/harness/aci/tools/skill.ts`（二次短路）
- `src/session-api/hub.ts`（`loadSkillBody` 不再为 trailer 传写处境）
- TUI slash 装配口（停传写处境；不闸二次 slash）
- 为让 handler 看见可见 messages 所需的既有 executor / ctx 缝（只加只读快照，不把已加载 Set 写进 system）
- `tests/skill/body.test.ts`、`tests/harness/aci/tools/skill.test.ts` 及与 trailer-on-skill 断言冲突的既有测试
- 已整理的 spec 指针：`specs/skill-body-short-circuit.md`、`skill-load-write-root.md`、`337-skill-mcp-extension.md` SC6、`write-situation-disclosure.md`、`specs/README.md`

不在本计划：`writeRootSegment` 文案改写、门禁回执、slash/Web 短路、worker prior 合同 6、改绑合同 7。

---

## Harvest

**Inherits:** ADR-0079；可见历史判据；闸只罩 `skill()`；短回执语义；337 装配形态减 trailer；合同 1 helper SSOT；截断窗口丢正文后放行再灌。
**Open for implementer:** 短回执字面；可见 messages 如何到达 handler（ctx 只读快照 vs 既有缝）；如何识别「成功全文」vs 引导句 / 短回执。

## Tasks (ordered by dependency)

1. **createSkillBody 与三处消费停挂写根** — tag: `[implementation]`
   - **Inherits:** ADR-0079；`skill-load-write-root` 合同 2/3/4 与 SC2/SC3/SC5 2026-09-10 amend；337 SC6 再 amend；`write-situation-disclosure` SC4 amend。
   - **Surface:** `src/harness/skill`、ACI `skill` 装配调用、session-api `loadSkillBody`、TUI slash 装配。
   - **Acceptance:** 传入活 `taskRoot` / 写处境时 `createSkillBody` 输出仍无 `current write root`；slash / `loadSkillBody` / 首次 `skill()` 正文末段是 `</skill_files>`；worker prior 与改绑一次仍能渲染同一 helper；相关既有测试按新合同改绿，`npm run typecheck` exit 0。
   - Status: [ ] pending

2. **skill() 按可见历史二次短路** — tag: `[implementation]`
   - **Inherits:** CONTEXT `skill() 二次短路`；spec SC2/SC3/SC5/SC7 与 S2 五类；短回执必须是非空 `tool_result`。
   - **Surface:** ACI `skill` + executor 只读可见 messages 缝。
   - **Acceptance:** 可见历史已有该名成功全文 → 短回执且不含 SKILL 程序；无该全文或只有引导句 → 灌全文或引导；同一波第二次同名短路；截断后窗口内无该全文 → 再灌全文；历史快照缺席 → 灌全文。
   - Status: [ ] pending
   - [blocks: T1]

3. **slash 不闸 + 告知面回归** — tag: `[implementation]`
   - **Inherits:** spec SC4 / SC6；ADR-0079「slash 不闸」；写处境不走 skill 正文。
   - **Surface:** TUI slash skill-load；既有 worker prior / 改绑测试。
   - **Acceptance:** 同会话已 `skill()` 过后 slash 信封仍含装配全文；prior / 改绑测试对 `writeRootSegment` 的既有断言不回退。
   - Status: [ ] pending
   - [blocks: T2]
