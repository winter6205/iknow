# Spec: 两套判断逻辑模块（HITL vs `/goal` 自动模式）

## Objective

把完成判定从「一条 `completed` 链、`goal ?? query` 喂 LLM 判官」改成 **两个产品、同一套判官系统、两套逻辑模块**。

用户：`chat` / TUI / `serve`。成功 = 默认聊天是 HITL（人不在时不请 LLM 评「做完没」）；`/goal` 是另开的自动循环（条件 + 截断对话交给判官，成功也评，不成续跑）；HITL compact 保焦改走任务摘录（`recent-user-tasks.md`），不再当备用 goal。

## Boundaries

- **Does:**
  - 默认产品 = 正常模式（HITL）。判断不先问有没有 `goal`。无 `goal` → 不进完成向判断。硬失败（checker `EVIDENCE_CONTRADICTED` / 命令非零）打回干活模型。证据够或说不清 → 不请 LLM 评语义完成；回合还给用户。`StopReason=completed` 只表示本轮说完。
  - `/goal <text>` / `## GOAL:` = 另开自动模式。一钉上循环到停档；人默认不介入，除非 `/goal clear` 或打断。模式内 **不贴任务摘录**（不写、不读会话焦点）。
  - 自动模式判官：`task` 仅 `goal.text`；host 截断对话走独立字段；`evidenceContext` 独立当提示不当题目；只读工具保留当辅证。成功也评条件是否成立。
  - 同一套判官系统（只读 worker、四态、`maxTurns: 2` 内环）。差在逻辑模块，不另起评价产品。装配去掉完整 iknow 灵魂/助手口吻（修共用系统，防串戏）。
  - 自动模式停法三档：① 判官 Impossible / 修不好 → 清 goal；② 连续若干轮零工具空转 → 停循环、goal 留着；③ 不可恢复错误（鉴权失败、额度耗尽、压缩救不了的爆上下文、模型不可达）→ 清 goal。瞬时错误（限流、过载）不清。无默认轮次硬顶；`/goal` 命令可 **可选** 结构化指定最多尝试轮次（写法 plan 定）。
  - HITL compact 保焦：任务摘录（现抽现贴，见 `recent-user-tasks.md`）。本 spec 不再规定 `session.taskFocus` seed / 240+history 渲染。
  - 接线缝：`verify-loop` 按模式分派逻辑模块（禁止 `goal ?? query` 当统一 task）；`run-classifier-adapter` 的 `buildJudgeTask` 禁止把 `evidenceContext` 拼进 `task`；`chat-session` / `hub` 的 `userText` 与模式一致；TUI 默认仍装配判官系统，无 `/goal` 时走 HITL 模块而非卸掉分类器。
  - `resolveVerifyUserText` 无 goal 时不得 fail-open 到 `query` 去请完成向 LLM。HITL 跳过完成向判官是命名 EXIT，不新增 StopReason。
- **Confirms with human:** （assumption gate 已收）空转「几轮」、命令上限的 slash 写法 — plan 定。
- **Out of this spec:**
  - `verify.command` 沙箱修正 / 趋势裁判（`128-auto-correction-loop`）。
  - `449-evidence-checker` 纯函数三态。三级流 shape 可留在各模块前级；完成向 LLM 只挂自动模式。
  - 判官只读工具面契约（`468-subagent-judge-tool-surface`）不重开白名单。
  - TUI 隐藏判官 drain（A+B，独立分支已提交）。
  - `validateGoalText` / `/goal` 三面 / `model_proposed` 删除（已落地）。
  - 寒暄词表具体名单、空转轮次数字、可选 max-turns 的 flag 字符串。

## Success Criteria

```bash
npm run typecheck
npx vitest run tests/harness/verify tests/session-api tests/cli
```

每条 yes/no：

- 无 `goal` 的 HITL 问候轮：spy 显示完成向判官 spawn = 0（empty）。
- HITL 有焦点且 checker `SUFFICIENT`：不 spawn 完成向判官；控制权回到用户（negative：成功不评 LLM）。
- HITL 硬失败：注入失败/补跑信封到主模型，不先 spawn 完成向判官评「任务完成没」（negative）。
- 有非空 `goal.text`：传入判官的 `task === goal.text` 且 `task !== query`，`task` 字符串不含 `evidenceContext` JSON（negative）。
- 自动模式 `StopReason=completed` 且非硬失败：spawn 判官 ≥ 1，即使 checker `SUFFICIENT`（concurrent：成功也评）。
- 超长 goal 仍走 `validateGoalText` 2000 上限，不放宽（overflow）。
- `/goal clear` 后下一轮 HITL 不再走自动模块；goal 空（concurrent）。
- 判官 abort / unverified 仍映射既有 unstable。store.load throw：不 spawn 完成向判官、不把 `query` 当 `task`（exception）。
- compact 任务摘录与自动模式不贴：见 `recent-user-tasks.md`。本 spec 只要求 `/goal` 活跃时 compact **不** 把摘录当判官使命。
- 源码完成向消费端不再出现 `goal.text ?? query` 或 `goal ?? taskFocus ?? query` 作为判官 `task`。
- 活跃 spec 索引指向本文件；归档的 128-classifier / 458 判定公式 / 449-loop 判官门禁不回活跃表。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- 栈：TypeScript + Node ESM、`tsc` strict；`npm test`（vitest）。无新依赖。
- 数据模型：`session.goal`、`/goal` 三面、`validateGoalText`。判官只读三件套与 `maxTurns: 2` 内环（`run-classifier-adapter.ts`）。`session.taskFocus` 由 `recent-user-tasks.md` / ADR-0026 退役。
- 外挂自检层：advisor 包裹 `run()`（ADR-0011）；判官走子代理（ADR-0014）；不开新 settings 口（ADR-0015）。
- checker 三态与 D2 探测、补跑至多 1 次：HITL 硬失败 / 补跑仍可用；不作为自动模式「绿了就不评 LLM」的通行证。
- CONTEXT 现行抄录（本 spec **覆盖**；taskFocus / 任务摘录已 persist，见 `recent-user-tasks.md` / ADR-0026）：
  - **goal**：`docs/CONTEXT.md` 仍写 `goal.text ?? query` 与「verify 第一优先段」。
  - **taskFocus**：已退役；HITL compact 仅任务摘录（`recent-user-tasks.md` / ADR-0026）。
  - **task 取值公式**：`task = session.goal.text ?? query` — 判定层作废。
  - **判官**：仍写「command 缺失时接管」— 作废为总开关。
- ADR-0017 三级流 shape 仍参考；「SUFFICIENT 永不请判官 / INSUFFICIENT 必请」在完成向上由本 spec + ADR-0024 覆盖。
- ADR-0018 字段拆分与模型零写入仍成立；文中判定层三段公式作废。

**Changes：**

- 完成判定按模式分派，禁止统一 `??` 链。
- 自动模式：LLM 完成评价每轮（非硬失败）；信封 = `goal.text` + 截断对话 + `evidenceContext` 提示。
- HITL：完成向 LLM 关闭；焦点只服务 compact。
- persist 已落地：CONTEXT `goal` / `task 取值公式` / `判官` / **正常模式** / **自动模式**；ADR-0024 accepted；ADR-0017 Status 为部分取代。ADR-0018 Status 因 write-guard 保持 `superseded by 0026`（goal 拆分仍有效，见该文件「现行」段）。

## architecture-change-reviewer

实施未开始。预定接线：`src/harness/verify/{verify-loop,run-classifier-adapter}.ts`、`src/session-api/hub.ts`、`src/cli/chat-session.ts`、对应 tests、本 spec、CONTEXT/ADR persist。

```
bounded-context-guardian: yes — 门禁留在 harness/verify；goal/taskFocus 仍由 session-api 持有；CLI/hub 只改分派与 seed，不把 session 模型搬进 verify
defensive-contract-validator: yes — Success Criteria 已覆盖 empty / negative / overflow / concurrent / exception
error-handling-enforcer: yes — HITL 跳过完成向判官与 load 失败为命名 EXIT；禁止空 catch fail-open 到 query；Impossible/空转/不可恢复错误三档 EXIT 分离；不新增 StopReason
complexity-anti-drift: yes — 两套逻辑模块分派，禁止合并成一条 ?? 链；seedTaskFocus 保持写入器、信号外置
minimal-change-verifier: yes — 1 个逻辑任务（模式分派 + 信封 + 焦点信号）；不混入 TUI drain A+B、command 沙箱闭环、空转数字与 slash 字面量
```

## 待写入

无（persist 已 flush）。CONTEXT 与 ADR-0024 / ADR-0017 部分取代已落地。ADR-0018 Status 保持 `superseded by 0026`（write-guard 枚举）；goal 拆分与模型零写入仍有效，见 ADR-0018「现行」段 + ADR-0026。
