# Plan: 任务摘录（compact 边界现抽现贴）

**Goal:** compact 时贴最近至多 3 句用户任务原话；会话不再持有 `taskFocus`。
**Approach:** 先换 compact 附件（产品可见），再拆掉 seed/落盘/status；trigger 与窗口计数不动。#601 正交，本计划在 `master` 新工作树实施，不合入 `feat/compact-trigger-gate`。上游 wayfinder 地图 #594–#599 已关（Destination 改画为本 spec）。
**Spec link:** `specs/recent-user-tasks.md`
**Tracker:** GitHub — spec [#603](https://github.com/winter6205/iknow/issues/603)；T1 [#604](https://github.com/winter6205/iknow/issues/604)；T2 [#605](https://github.com/winter6205/iknow/issues/605) blocked-by T1；T3 [#606](https://github.com/winter6205/iknow/issues/606) blocked-by T1+T2。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

bounded-context-guardian: yes — 抽取与附件留在 session-api；compact 窗口与 trigger 仍在 harness/compress；verify 不读摘录；不新建 bounded context
defensive-contract-validator: yes — Success Criteria 覆盖 empty（0 句/寒暄）/ negative（自动模式不贴）/ overflow（超长原句、无 240 cap）/ concurrent（摘录不自抽）/ exception（旧盘 taskFocus drop）
error-handling-enforcer: yes — 0 句则不贴（命名 EXIT）；load 旧字段 sanitize drop 不抛；摘录失败不得阻断已成功的 compact 摘要+窗口
complexity-anti-drift: yes — 抽取是纯函数（合格谓词复用，取最近 3 条替换取第一条）；附件替换旧渲染，不把摘要 LLM 与摘录合成新神函数
minimal-change-verifier: yes — 1 个逻辑任务（compact 保焦物替换）拆成下列 tracer bullets 各 1 commit；不改 #601 trigger、不改 KEEP_RECENT、不改 rewind checkpoints、不改记忆层

## Tasks (ordered by dependency)

1. **compact 边界贴任务摘录** — tag: `[implementation]`
   - **Inherits:** spec：仅 compact 实际发生时从当时 `messages` 现抽；至多 3 句合格用户原话（`isTurnQuery` ∧ 寒暄过滤）；最新在最后；0 句不贴；自动模式不贴；贴出段下次不得再被抽到；不为摘录加模型；失败不阻断摘要+窗口
   - **Surface:** `session-api` compact `boundaryAttachment`；合格谓词已在 session-api / turn-projection
   - **Acceptance:** 上列 inherit 每条有测试为 yes；vitest `tests/session-api` 与 compact 附件相关用例绿；源码不再走 240+history 焦点渲染
   - Status: [x] done — #604 in PR #607 (`02934f39`)

2. **会话不再持有 taskFocus** — tag: `[implementation]`
   - **Inherits:** spec：不再 seed / 不再写 `history` / `/goal status` 不展示焦点；load 忽略旧字段、save 不写出；不 bump schema 版本
   - **Surface:** session-api schema sanitize；chat-session / hub 写入与 slash status
   - **Acceptance:** 旧盘含 `taskFocus` 的 JSON load 不炸且运行时读不到焦点；新 save 无该键；chat/hub 不再调用焦点写入器；`/goal status` 输出不含焦点
   - Status: [x] done — #605 in PR #607 (`d925b6ce`) + follow-up `18764af5`
   - [blocks: T1]

3. **对齐 verify-goal-gate 与索引** — tag: `[implementation]`
   - **Inherits:** spec：HITL compact 保焦条款改指向本 spec；活跃 spec 索引列出 `recent-user-tasks.md`；ADR-0024 完成向 `task` 仍仅 `goal.text`
   - **Surface:** `specs/` 活跃索引与 `verify-goal-gate.md` 中 HITL 焦点条款；相关回归测试
   - **Acceptance:** `verify-goal-gate.md` 不再要求 compact 注入 `taskFocus`；`specs/README.md` 活跃表有本 spec 一行；仍断言自动模式判官 `task === goal.text` 的测试绿
   - Status: [x] done — #606 in PR #607 (`ac311062`)
   - [blocks: T1, T2]

## 待写入

（spec 阶段已 flush：CONTEXT `任务摘录` / `一轮` / `截断窗口`；ADR-0026；ADR-0018 Status 覆盖段。本计划空清单 → persist skip。）
