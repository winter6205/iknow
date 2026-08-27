# Session Handoff — 未合并 PR 轨道（2026-08-27，master 整理后）

## 当前 live 状态

- **任务**: 主仓库已切到同步后的 `master`；本稿列出**仍未 merge** 的 PR/issue 轨道。
- **为什么重要**: graph mode（#721）、trace（#725）、auto-memory（#728）已进主干；V2 总览文档、todo 治理、memory follow-ups 等仍开 PR。
- **整理说明（2026-08-27）**: 丢弃与 master 重复的本地脏改（`CONTEXT`/`STATUS`/ADR-0030）；`git pull` 至 `0aad4a3`。

## 已固化工件（引用，不复制 inline）

| 类型               | 路径 / URL                                                                     |
| ------------------ | ------------------------------------------------------------------------------ |
| 领域词汇           | `docs/CONTEXT.md`（graph mode、`run_graph`、auto-memory）                      |
| 图模式 ADR         | `docs/adr/0030-graph-mode-shift-tab-overlay.md`（master）                      |
| 自动记忆 ADR       | `docs/adr/0031-auto-memory-extract-and-mechanical-gc.md`（master，#728）       |
| 图模式 spec/plan   | `specs/545-d-alpha-graph-mode.md`、`plans/545-d-alpha-graph-mode.md`（master） |
| 自动记忆 spec/plan | `specs/auto-memory.md`、`plans/auto-memory.md`（master）                       |
| V2 总览（PR 分支） | `docs/multi-subagent-v2-overview.md`（仅 #697 分支，**仍不在 master**）        |
| 父图               | https://github.com/winter6205/iknow/issues/540                                 |
| 上轮长程菜单交接   | `docs/handoff/2026-08-27-next-track-long-vs-extension.md`（历史；#545 已落地） |

## 本轨道已合 master（供对照，非下一会话任务）

| 变更                           | 一行效果                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| GitHub PR #721 → `be52cdf`     | D-α V1：Shift+Tab graph overlay + `run_graph`                 |
| GitHub PR #725 → `f06f880`     | #703/#704 重摘：TUI `subagentTrace` + `parentTurnId`          |
| GitHub PR #728 → `0aad4a3`     | auto-memory extract + mechanical GC（默认 OFF）；ADR-0031     |
| GitHub PR #709                 | CLOSED（superseded by #728 `winter/auto-memory-onto-master`） |
| GitHub PR #698–#708、#703–#706 | closed（superseded by #721/#725）                             |
| GitHub #715–#720               | closed（#721 tracker 收口）                                   |
| GitHub #722                    | closed → #726（可视化）、#727（性能+prompt），**其它会话**    |

master 尖：`0aad4a3`（2026-08-27）。

## 未合并 PR（下一会话主清单）

### P0 — 文档 / follow-ups

| PR       | 分支                                  | 说明                                                                           |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| **#733** | `winter/spec-memory-layer-follow-ups` | memory-layer follow-ups spec/plan/CONTEXT；纯 docs，与 #728 代码互补           |
| **#697** | `winter/handoff-540-phase-0-1`        | V2 总览 + handoff 指针；`docs/multi-subagent-v2-overview.md` **仍不在 master** |

### P1 — 治理 / TUI（独立）

| PR            | 分支                                   | 说明                                                        |
| ------------- | -------------------------------------- | ----------------------------------------------------------- |
| **#651**      | `worktree-issue-648-todo-write-limits` | todo_write 写路径上限；分支极老，merge 前需审 rebase 或重写 |
| **#723/#724** | TUI markdown/perf                      | OPEN；与 #726/#727 graph polish 不同轨                      |

### 明确不做（operator 其它会话）

- **#726/#727** — 图模式 polish
- **#382/#110** — graph/langgraph **原型**，非产品路径
- 大量 draft — 非本轨道

## 工作树（主仓库）

| 项     | 状态                                          |
| ------ | --------------------------------------------- |
| 分支   | `master` @ `0aad4a3`，与 `origin/master` 同步 |
| 脏文件 | 无（`CONTEXT`/`STATUS`/重复 ADR 已丢弃）      |
| 本稿   | 本 commit 纳入 master                         |

## 已验证状态

```
git rev-parse HEAD origin/master
=> 0aad4a3…  exit 0（整理后 fast-forward 同步）

gh pr view 728 --json state,mergedAt
=> MERGED 2026-08-27T06:35:28Z  exit 0

gh pr view 709 --json state
=> CLOSED（superseded） exit 0

gh pr list --state open --search "733 OR 697 OR 651" --json number,title
=> #733 #697 #651 均为 OPEN  exit 0
```

## Open blockers + next steps

**[NEXT] 从 `master`（`0aad4a3`）审/合 #733 或 #697 — 二者均为 docs，互不阻塞。**

- merge #733 后：memory follow-ups 进 SSOT；关对应 tracker（若有）。
- merge #697 后：`multi-subagent-v2-overview.md` 进 master；可关 #540 Phase 0 文档缺口。
- **#651** 单独轨道：rebase 成本 high，需 operator 确认是否仍要。
- auto-memory tracker **#710–#714**：已 CLOSED（#728 合入后收口）。
- **明确不做**：#726/#727 图模式 polish。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:code-review` — docs PR merge 前双轴（#733 / #697）
- `arthurpower:minimal-change-verifier` — 1 PR 一任务
- `arthurpower:verification-before-completion` — claim merge 前对照 spec/plan

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据一律用环境变量名，不写值
