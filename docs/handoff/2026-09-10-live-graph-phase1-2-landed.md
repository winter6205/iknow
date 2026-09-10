# Session Handoff — 活图阶段 1+2 已合入 (2026-09-10)

## 当前 live 状态

- **任务**: `#929` 长程图执行的 host 两阶段（会话活图 + 失败边 / 同 id 再跑 / effort 8）已合入 `master`。
- **为什么重要**: V1 `run_graph` 只是一次 Kahn DAG；没有会话账本就谈不上 Dynamic Pipeline / 外环 replan。
- **operator 显式指令**: 更新总路线进度；告诉下一会话怎么做。先合 `#944`，先不写下一刀实现。

## 已固化工件（引用，不复制 inline）

| 类型 | 路径 / URL                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------- |
| map  | https://github.com/winter6205/iknow/issues/929                                                          |
| 种子 | https://github.com/winter6205/iknow/issues/904                                                          |
| spec | `specs/live-graph-phase1.md`、`specs/live-graph-phase2.md`                                              |
| plan | `plans/live-graph-phase1.md`、`plans/live-graph-phase2.md`                                              |
| ADR  | `docs/adr/0047`–`0067`（活图权威 / 外环 / 失败边 / effort）                                             |
| 词条 | `docs/CONTEXT.md`（活图状态 / 外环修订 / 剩余子图 / 图内绕回）                                          |
| 实现 | `src/harness/graph/ledger.ts`、`residual.ts`、`on-failure.ts`、`outcome-scheduler.ts`、`effort-fuse.ts` |
| 合并 | https://github.com/winter6205/iknow/pull/944（`a5948155`）；`#942` 已关                                 |

## 本 session 变更

| 变更                         | 一行效果                                                   |
| ---------------------------- | ---------------------------------------------------------- |
| `a5948155`                   | Merge `#944`：活图账本 + 剩余子图 + `onFailure` + effort 8 |
| `#942` closed                | phase 1 超集已在 `#944`，不再单合                          |
| `plans/live-graph-phase1.md` | T1–T4 标 done（本交接 commit）                             |
| `#929` 正文                  | 加 Progress：阶段 1+2 host 已落地；Destination 第四句未锁  |

## 已验证状态

```
gh pr view 944 → state=MERGED, mergedAt=2026-09-10T01:15:35Z
git log -1 → a5948155 Merge pull request #944
worktree rebase 后：npm run typecheck → exit 0
npx vitest run tests/harness/graph + 两条接线测试 → graph 全绿；fixture 修后 8/8
GitHub #944：s4-check pass；test-fast pass；test-full skipped
```

本交接回合未重跑全量 `npm test`。

## Open blockers + next steps

**[NEXT] 新开会话，只对 `#929` Destination 第四句「明确收口（预算 / 不再 replan / 任务完成）」跑 logicsync，产出 `specs/live-graph-phase3.md`（或书面否决：收口保持 empty residual + 人停 / 既有 loop 停条件），不写 `src/` 业务代码。**

- 不要从合入前的 master 再开图 worktree；下一刀实现必须等 phase 3 spec（或否决）落盘后再 `architecture-change-reviewer`。
- 不要把 `wait:false`、账本 JSONL 持久化、TUI `#749` 塞进同一刀——都是邻图或 `#929` Not yet specified。
- `#929` 保持 OPEN，直到 Destination 四句都有 yes/no 验收。

## Suggested skills（下个 agent 建议 invoke）

- `logicsync` — 收口是硬决策，未锁合同前禁止实施
- `domain-modeling` — grilling 若产出新词 / 一票否决 ADR，再落 CONTEXT 或 ADR
- `spec-driven-development` — 仅当操作员点名出 phase 3 spec（router 不自动开）

## 脱敏

- 无 API key / token / password / credential 值出现
