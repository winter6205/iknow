# 交接：任务摘录（compact 保焦）

日期：2026-08-22  
工作树：`.claude/worktrees/recent-user-tasks`（分支 `worktree-recent-user-tasks`）  
**未 push。**

## 计划文件

`plans/recent-user-tasks.md`（仓库根相对路径；工作树内绝对路径：`.claude/worktrees/recent-user-tasks/plans/recent-user-tasks.md`）

## 合同

- spec：`specs/recent-user-tasks.md`（issue [#603](https://github.com/winter6205/iknow/issues/603)）
- ADR-0026：`docs/adr/0026-recent-user-tasks.md`
- 实施：T1 [#604](https://github.com/winter6205/iknow/issues/604) → T2 [#605](https://github.com/winter6205/iknow/issues/605) → T3 [#606](https://github.com/winter6205/iknow/issues/606)

## 已关的旧图 / 手交

- wayfinder [#594](https://github.com/winter6205/iknow/issues/594) 及子票 #595–#599 已关闭。不要做 sidecar / 每回合填卡 / 扩 `taskFocus`。
- [#569](https://github.com/winter6205/iknow/issues/569) 是 verify 门禁 grilling 手交，已改成归档并关闭。A+B 合在 [#570](https://github.com/winter6205/iknow/pull/570)，门禁合在 [#575](https://github.com/winter6205/iknow/pull/575)。不要从那张票读 `taskFocus`。

## 不要动

- PR [#601](https://github.com/winter6205/iknow/pull/601) 压缩触发闸（单独合）
- interrupt `checkpoints[]` / rewind
- 知识记忆（ADR-0009）
- `DEFAULT_KEEP_RECENT` 窗口条数

## 下一跳

T1–T3 已在本分支落地；PR [#607](https://github.com/winter6205/iknow/pull/607) 已开（本交接不 push）。合入后关 [#603](https://github.com/winter6205/iknow/issues/603)–[#606](https://github.com/winter6205/iknow/issues/606)。剩余 hygiene 见 [#608](https://github.com/winter6205/iknow/issues/608)（非本轮）。
