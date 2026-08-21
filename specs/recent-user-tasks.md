# Spec: 任务摘录（compact 边界现抽现贴）

## Objective

压缩发生时，把当时对话里**最近几句合格用户任务原话**贴到压缩边界，让模型在摘要 + 截断窗口之外还能看见「用户交代过什么」。不在会话里常驻一张「当前任务」卡，也不每回合让 LLM 填卡。

用户：`chat` / TUI / `serve` 的正常模式（HITL）。成功 = compact 后模型看到至多 3 句用户任务原文；自动模式不贴；旧 `session.taskFocus` 不再 seed、不落盘、不进 `/goal status`。

## Boundaries

- **Does:**
  - 仅在 compact **实际发生**时，从当时 `messages` 现抽现贴。过程中的 seed、首条 user、会话 JSON 字段都不作数。
  - 抽取：按时间倒序最多 **3** 句合格用户提示词原文（trim）。合格 = 现有 `isTurnQuery`（非纯 `tool_result`、非子代理 drain）且现有寒暄过滤（今日 `shouldSeedTaskFocus` 的「像样任务句」语义，不含「写一次不切」）。不要助手、不要工具结果。不足 3 句就有几句贴几句；0 句则不贴这段。
  - 3 句里时间上最后一句就是最新交代。不另算一张「当前任务」再塞进去。
  - 贴上去的那段必须标成非用户任务句（与 drain 同类：下次抽取不得抽到摘录自己）。
  - 自动模式（`/goal` 钉着）compact **不贴** 任务摘录。
  - 删除：`seedTaskFocus` 切换、`taskFocus.history`、首条 `extractGoal` 当焦点、`/goal status` 展示焦点、compact 的 240+3×120 / cap 720 焦点渲染。
  - 会话 load：忽略既有盘上的 `taskFocus`；save 不再写出该字段。不 bump schema 版本（可选字段删除，sanitize drop）。
  - 对话+工具的结构化收集继续走既有 `runFullCompact` 摘要（含 All User Messages / Current Work / Next Step）；不为摘录再加一轮模型。
- **Confirms with human:** （本轮盘问已收，全部下列视为 confirmed）
- **Out of this spec:**
  - 压缩触发开关、reason 文案、窗口不够时的路径（PR #601 / `evaluateCompactTrigger`）。本 spec **不改** `DEFAULT_KEEP_RECENT`、不改 `preserveToolPairs`。
  - 会话 JSON `checkpoints[]`（打断快照 / rewind）。
  - 知识记忆（`AGENTS.md`、`memory_save` / `memory_recall`、`~/.iknow/memory`）；禁止收本单进度（ADR-0009）。
  - Wayfinder [#594](https://github.com/winter6205/iknow/issues/594) 及子票 595–599（sidecar / 每回合填卡 / 扩 taskFocus）：口径已被本 spec 取代，**票已关**，不按旧图做。
  - `/goal` 自动模式判官信封（仍只读 `goal.text`，ADR-0024）。

## Success Criteria

```bash
npm run typecheck
npx vitest run tests/session-api tests/cli tests/harness/compress
```

每条 yes/no：

- compact 发生且正常模式、历史里有 ≥3 句合格用户任务：边界附件含这 3 句原文（trim 后相等），时间顺序最新在最后（empty 的反面：有料才贴）。
- 仅寒暄、或仅 `tool_result` / drain、或 0 句合格：不贴任务摘录段（empty）。
- 自动模式 compact：不贴任务摘录（negative）。
- 超长单句用户任务：原文整句进入摘录，不再用 240/120/720 截（overflow：旧 cap 不得再现）。
- 摘录段本身不得被下一轮抽取当成合格用户任务（concurrent：自引用隔离）。
- load 含旧 `taskFocus` 的会话 JSON：对象上无该字段或运行时读不到焦点；`/goal status` 不展示焦点（exception：旧盘不炸）。
- 源码 compact 路径不再调用旧焦点渲染（无 240+history 拼接）；`seedTaskFocus` 不再作为会话写入器被 chat/hub 调用。
- `npm run typecheck` 与上列 vitest 路径 exit 0。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- 栈：TypeScript + Node ESM、`tsc` strict；`npm test`（vitest）。无新依赖。
- compact 缝：`runFullCompact` 摘要 + 截断窗口 + `boundaryAttachment`（今日 `hub` 的 taskFocus 渲染口）。
- 抽取谓词：`isTurnQuery`、`messageText`、寒暄过滤（今日 `shouldSeedTaskFocus` 的合格判定，去掉「只写一次」）。
- CONTEXT 现行（本 spec **覆盖** `taskFocus` 条）：
  - **taskFocus（任务焦点）**: 正常模式 compact 保焦对象（确定性提取，v1 不用 LLM）；寒暄不 seed，像样任务句写入一次后不自动切；仅 compact 边界渲染；自动模式内不存在。
  - **自动模式**: …自动模式里再用 taskFocus 当使命（Avoid 仍成立，对象改为任务摘录）。
- ADR-0009 记忆层不收本单进度。ADR-0018 的 `session.goal` 拆分与模型零写入仍成立；其中 `session.taskFocus` 常驻 + compact 焦点渲染由本 spec + ADR-0026 覆盖。ADR-0024：完成向 `task` 仍仅 `goal.text`；taskFocus 不进 verify。
- 归档 `458-goal-lifecycle-taskfocus.md` 的「首条 seed / 不自动切 / 240+history」不再是产品口径。

**Changes：**

- compact 保焦物从会话字段 `taskFocus` 改为边界上的 **任务摘录**（现抽现贴，最多 3 句用户任务原文）。
- 删除会话侧焦点生命周期（seed / history / status 展示 / 焦点渲染数字）。
- 待写入（persist → `domain-modeling`）：CONTEXT 用 **任务摘录** 替换活跃 `taskFocus`；补 **一轮** / **截断窗口**；ADR-0026；ADR-0018 Status 注明 taskFocus 段被 0026 覆盖。

## architecture-change-reviewer

实施未开始。预定接线：session-api 抽取与 `boundaryAttachment`、schema sanitize、chat-session / hub 去掉 seed 与 status 焦点、对应 tests、本 spec、`verify-goal-gate.md` 中 HITL 焦点条款、CONTEXT/ADR persist。

```
bounded-context-guardian: yes — 抽取与附件留在 session-api；compact 窗口与 trigger 仍在 harness/compress；verify 不读摘录；不新建 bounded context
defensive-contract-validator: yes — Success Criteria 覆盖 empty（0 句/寒暄）/ negative（自动模式不贴）/ overflow（超长原句、无 240 cap）/ concurrent（摘录不自抽）/ exception（旧盘 taskFocus drop）
error-handling-enforcer: yes — 0 句则不贴（命名 EXIT）；load 旧字段 sanitize drop 不抛；摘录失败不得阻断已成功的 compact 摘要+窗口
complexity-anti-drift: yes — 抽取是纯函数（合格谓词复用，取最近 3 条替换取第一条）；附件替换旧渲染，不把摘要 LLM 与摘录合成新神函数
minimal-change-verifier: yes — 1 个逻辑任务（compact 保焦物替换）；不改 #601 trigger、不改 KEEP_RECENT、不改 rewind checkpoints、不改记忆层
```
