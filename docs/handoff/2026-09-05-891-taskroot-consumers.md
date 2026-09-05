# Session Handoff — #891 taskRoot 剩余消费点 (2026-09-05)

## 当前 live 状态

- **任务:** 按 `plans/891-taskroot-remaining-consumers.md` 实施围栏 overlay + 模型可见写根；本会话只定位与写计划，未改产品代码。
- **为什么重要:** 隔离改绑后 JS 写工具拦得住主仓，bash 仍能经 `$HOME` 可写绑定打穿；模型仍把身份根当写根。
- **operator 显式指令:** systematic-debugging 定位、给方案、开 worktree、写 plan，到另一会话实施。基于已有 session root / `taskRoot`，不新造第五根。

## 已固化工件（引用，不复制 inline）

| 类型     | 路径 / URL                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 领域词汇 | `docs/CONTEXT.md`（`taskRoot` / `SessionRoots` / `子代理根归属`）                                               |
| 决策记录 | `docs/adr/0037-worktree-isolation-on-mutate.md` §4 / §7；`docs/adr/0040-subagent-identity-and-dispatch-gate.md` |
| 计划     | `plans/891-taskroot-remaining-consumers.md`                                                                     |
| issue    | https://github.com/winter6205/iknow/issues/891                                                                  |

## 本 session 变更

| 变更（文件路径）                                     | 一行效果                                             |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `plans/891-taskroot-remaining-consumers.md`          | 工作树，未 commit：T1 合同 / T2 围栏 / T3 模型可见面 |
| `docs/handoff/2026-09-05-891-taskroot-consumers.md`  | 本指针                                               |
| git worktree `worktree-issue-891-taskroot-consumers` | 从 `875a2f80` 分出，无产品 diff                      |

## 已验证状态

```
npx tsx /tmp/repro-891-home-bind.mts
=> exit 0
leakedToMainRepo: true
classifyMkdir: "mutate"
dangerousCat (单行): false
dangerousNewline: true
homeBindAt > cwdBindAt: true
identityRoBindPresent: false
```

未跑 `npm test`（无产品改动）。

## Open blockers + next steps

**[NEXT] 在 worktree `/home/winner/projects/iknow/.claude/worktrees/issue-891-taskroot-consumers` 打开 `plans/891-taskroot-remaining-consumers.md`，按 T1 先写 ADR-0037 amendment + CONTEXT 一句，单独 commit，再 TDD T2。**

- T2 / T3 可并行，都 block 在 T1。
- 不要修 #891 P1（hard_wall）或 P3（label）。

## Suggested skills（下个 agent 建议 invoke）

- `test-driven-development` — T2/T3 先红后绿；复现脚本语义即 T2 overflow 用例
- `error-handling-enforcer` — 身份根缺失必须 fail-loud，禁止 `existsSync` 跳过
- `verification-before-completion` — 每个 bullet commit 前
- `code-review` — 全部 bullet 落地后一轮

## 脱敏

- 无 API key / token / password
