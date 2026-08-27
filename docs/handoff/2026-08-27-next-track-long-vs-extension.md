# Session Handoff — 下一程：长程任务 vs 扩展源菜单（2026-08-27）

> **归档说明**: 本稿为同日较早 session 的 A/B 拍板交接。#545 graph mode 已合（#721）、auto-memory 已合（#728）。**当前未合并 PR 清单以** [`2026-08-27-unmerged-prs-tracks.md`](./2026-08-27-unmerged-prs-tracks.md) **为准。**

## 当前 live 状态

- **任务**: 把本 session 的 tracker 收口 + 证据交给下一会话，让 operator 在「长程任务产品路径」与「开场那张扩展源菜单」之间拍板后动手。
- **为什么重要**: 工具层旧票开着造成「无事可干」错觉；长程缺口（graph 未接线、live 路由脆、mailbox 未到）仍在 [Multi-subagent capability V2](https://github.com/winter6205/iknow/issues/540)。
- **operator 显式指令**: 「交接一下，看看下会话做你说的这个还是，我一开始说那些（要不要做智能体会安装指令按照用户skill，然后还要有安装plugin或读取，以及mcp，或者是子agent编排消息队列，后者说长程任务实测）」

## 已固化工件（引用，不复制 inline）

| 类型                                   | 路径 / URL                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 领域词汇                               | `docs/CONTEXT.md`（`continue_pending`、渐进式披露）                                                          |
| 能力缺口 SSOT                          | `docs/coding-agent-capability-gap.md` §5C / §6.3 / §8 最弱「Subagent 编排产品化」                            |
| V2 实施总览                            | `docs/multi-subagent-v2-overview.md`                                                                         |
| 长程父图                               | https://github.com/winter6205/iknow/issues/540                                                               |
| 下一刀设计票                           | https://github.com/winter6205/iknow/issues/545 （T-V2-A，OPEN；#555/#562 已关，停车理由没了）                |
| 事件唤醒 / mailbox 上游                | https://github.com/winter6205/iknow/issues/546 （blocked by A）                                              |
| skill/MCP 决策图（已清、已落地）       | https://github.com/winter6205/iknow/issues/337 （plugin 市场 = Out of scope；`user-invocable` `/cmd` = fog） |
| 440 决策（已落地、本 session 关图）    | `docs/handoff/2026-08-17-wayfinder-440-decisions.md`                                                         |
| 续跑落地 PR                            | https://github.com/winter6205/iknow/pull/692 （merge `3718d55`）                                             |
| T8 夹具 unhang                         | https://github.com/winter6205/iknow/pull/699 （本 session merge `56aa24a`；不改 `src/`）                     |
| 云端 Phase 1 PR 链（未合、非产品接入） | https://github.com/winter6205/iknow/pull/698 … https://github.com/winter6205/iknow/pull/708                  |
| 续跑 spec                              | `specs/continue-pending.md`                                                                                  |

## 本 session 变更

| 变更（文件路径）             | 一行效果                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GitHub PR #699               | 本 session `gh pr ready` + `gh pr merge --merge` → master `56aa24a`（T8 `stdin.resume()` 夹具 + 探针；无 `src/`）               |
| GitHub #687–#691、#686、#270 | 按 #692 已测未关票关闭（缺 `Closes` 链接，不是缺代码）                                                                          |
| GitHub PR #430、issue #440   | 关闭：#440 已在主干落地；#430 draft superseded                                                                                  |
| `docs/STATUS.md`             | 工作树，未 commit：§3.1 记 T8/#699 已合入。当前分支 `winter/handoff-540-phase-0-1` @ `885d8f0`，勿与 V2 overview PR #697 混叙事 |

未改产品 `src/`。

## 已验证状态

```
gh pr view 699 --json state,mergedAt,mergeCommit
=> MERGED at 2026-08-26T17:57:17Z, merge commit 56aa24a  exit 0

gh issue view 270 --json state ; gh issue view 440 --json state
=> 本 session 关闭后均为 CLOSED  exit 0

gh pr view 430 --json state
=> CLOSED（superseded） exit 0

git merge-base --is-ancestor 2f9b155 master; echo $?
=> 1（#651 todo 写路径上限 commit 不在 master；本 session 未合）
```

未在本机重跑 T8 / `npm test`（#699 CI `test-fast` 合入前为 pass）。

## Open blockers + next steps

**[NEXT] 开场用 `arthurpower:logicsync` 让 operator 在 A/B 里拍板；未另说则走 A：认领 https://github.com/winter6205/iknow/issues/545（T-V2-A），同一会话只解这一票。**

本 session Recommend（证据在缺口文 + #540 predecessor）：**选 A**。原菜单拆开如下，不要揉成一件活。

| 开场原话                    | 现状                                                                 | 本程是否该做                                                    |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| A 长程：图模式 + 真任务实测 | #540 主路径；#555/#562 已关；T8 夹具已合；云端 698–707 只读对照      | **是。先 T-V2-A，再用修好的 T8 跑 spawn≥2 真链路**              |
| 智能体安装指令 / 用户 skill | 已扫 `~/.iknow/skills` 三级；缺的是 337 fog：`user-invocable` `/cmd` | 新图或 fog 毕业，**不挡 A**                                     |
| 安装 plugin 或读取          | 337 **Out of scope**（第三方市场）                                   | **不要开**，除非 operator 重画 destination                      |
| MCP                         | stdio + `mcp__*` + `list/read_mcp_resource` **已在主干**             | 增量（remote/OAuth）是 fog，**不是下一步**                      |
| 子 agent 编排消息队列       | #540 Phase 2–3 / #546；mailbox 在 map 里曾标 D-δ fog                 | **A 之后**，不要跳过 T-V2-A                                     |
| 长程任务实测                | 与 A 同一缺口；#699 只修测试挂死                                     | **并入 A**：设计收口后立刻 live e2e，不合整条云端链当「已接入」 |

- 不要合 698–708 当产品接入；审观测地板（#698）与 e2e（#702）仅作对照。
- 不要重做 #440 todo_write / MCP resources。
- `docs/STATUS.md` 未 commit：下个会话可单独落到 master，勿塞进 #545 实施。
- #651 仍 OPEN，与长程无关，不挡 A。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:logicsync` — 开场 A/B 拍板（operator 点名要选）
- `arthurpower:wayfinder` — 拍板 A 后 work-through map #540，claim #545
- `arthurpower:architecture-change-reviewer` — T-V2-A 若进入跨模块落地
- `arthurpower:verification-before-completion` — 任何 claim 长程 e2e done 前

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据一律用环境变量名（`GITHUB_TOKEN`、`MINIMAX_API_KEY`），不写值
