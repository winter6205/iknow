# Session Handoff — 闭世界围栏真实 TUI 走查(PR #899 合并前补测)(2026-09-06)

## 当前 live 状态

- **任务:** 补齐 `plans/closed-world-bash-fence.md` Round 1 验收第 3 条——真实 TUI(pty)走查。PR 实施环境无 `mcp__aiterm__pty_*`,合并前由交互会话代跑。
- **结论:** 闭世界读面在真实交互链路上成立,#896 病灶 2/3(home 持久执行配置不可见)实机闭合;PR #899 已合并(merge commit `7e1ac886`)。

## 走查环境

- 代码:PR #899 HEAD `f98c945a`(含合并前两个 CI 修复 commit),`npm run build` 后 `npm run dev:tui`(bun)起真实 TUI。
- 模型:MiniMax-M3(本机 settings 已配 key),Default mode,worktree isolation ON。
- 证据:tool_use/tool_result 逐条配对提取自 trace
  `.iknow/sessions/closed-world-bash-fence-plan-b4ecba516bb7/ac34d712-6f86-41f0-8a8d-dbfb673afd49.jsonl`。

## 探针结果(ground truth 全表)

| 探针                                         | 结果                                                                   | 判定                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `cat /etc/hostname`                          | 可读(`LAPTOP-DIF7442G`)                                                | ✓ 系统前缀 ro-bind                                            |
| `ls ~/.iknow`                                | `No such file or directory`                                            | ✓✓ #896 病灶闭合:持久执行配置物理不可见                       |
| `cat ~/.bashrc`                              | `No such file or directory`                                            | ✓ shell rc 不进读白名单                                       |
| `ls ~/.ssh`                                  | `No such file or directory`                                            | ✓ by-design 不进读白名单                                      |
| `cat ~/.gitconfig`                           | 可读(http 段)                                                          | ✓ 可选读成员存在性放行                                        |
| `ls /`                                       | 仅白名单系统前缀 + /tmp /proc /dev /home(空挂)                         | ✓ 闭世界读面                                                  |
| `echo $HOME && pwd`                          | `$HOME=/home/winner`,cwd=taskRoot                                      | ✓ PATH/HOME 重建正常                                          |
| `echo > ~/should-fail.txt` / `> ./wt-ok.txt` | engine 层 worktree_isolation 拦截(session 未绑 task worktree,主仓只读) | ✓ 分层防御:bwrap 写面由 probe 改绑档 + 122 isolation 测试覆盖 |
| `create-task-worktree`                       | `kind=foreign_worktree` fail closed                                    | ✓ 既有 fail-closed 设计(见下遗留)                             |

## 本 session 变更

- PR 分支两个 CI 修复(已随 PR 合入):
  - `e1df0c7b` ci:6 个 bwrap 依赖测试文件加入 CI 排除清单(guard 52/52);
  - `f98c945a` test(bwrap):node 工具链根断言对齐 §9.2 塌缩语义(CI runner node 在 /opt 下触发塌缩分支,原断言无条件要求 ro-bind 仅在本地成立)。
- `f02c9c10` chore:清理误入的 `.wt-review75` 空 gitlink(CI cleanup warning 根因,master 级历史遗留)。
- `plans/closed-world-bash-fence.md`:T1–T6 status 勾为 done(带 commit 指针)。

## 遗留 / 风险

- **行为观察(建议开 issue):** 在已存在的 git worktree 里开的 session,`create-task-worktree` 判 `foreign_worktree` fail closed,无法绑自有可写根——fail-closed 方向正确,但「在 worktree 内开会话」场景与 worktree 隔离互斥,需裁决是否有合法通路。
- **CONTEXT.md `taskRoot` 词条过时:** `docs/CONTEXT.md:377` 仍写「bash 围栏把身份根后挂只读 overlay(ADR-0037 §4 amendment)」;本 PR 已反转为读白名单成员(§9 条款 superseded)。词条维护按流程走 `/self-evolving-rules`,同批把候选词「闭世界围栏(closed-world fence)」写入 persist 清单。
- **Round 2(T7 sandbox server 化决策 + T8 实施)** 未开轨,计划 status 仍 pending,开轨时独立过 ACR + code review。
- code review advisory(P 描述已挂起,不阻断):两个 probe 脚本越过 500 行软闸(主体为场景数据表);`rebindFixturePaths` 模块级隐式耦合。
