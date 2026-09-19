# 2026-09-19 issue #1059 worktree unbound 物理 ro-bind — 实测证据落档

分支 `worktree-feat+1059-worktree-ro-bind`（base `bd67e717`）。本轮把 worktree 门禁
bash 面从预测式分类翻转为物理 `--ro-bind` 保证（ADR-0109 supersede ADR-0037 bash
条款；spec `specs/worktree-unbound-ro-bind.md`）。本文按 code-review 修复轮要求，
把此前只存在于会话中的验收证据落档。

## 1. probe:sandbox（14 类 = 11 物理 + 3 violation）

`npm run probe:sandbox` → exit 0：

```text
all green — global 19/19, worktree 23/23
  （含新类「unbound workspace ro-bind (physical)」：
    main: fence-exit=1 host-persisted=false rofs=true
    pad : fence-exit=0 host-persisted=true）,
workspace 17/17, node-side 2/2
```

新类双重验收 = 主 checkout 写被围栏挡下（exit≠0 ∧ EROFS ∧ 宿主不落盘）且
session pad 写正常落宿主——证明 ro-bind 段与 pad rw 复盖的 mount 序合同。

## 2. TUI 真实交互（mcp__aiterm__pty_* + bun run src/cli.ts tui）

会话 `6adab3de-25f0-4b53-96aa-64dee8e91d73`，门禁 ON、unbound。三面走读全绿
（屏上 capture-pane 证据，2026-09-19T11:27Z 前后）：

1. **SC1 零误触**：`cd` 组合、`date && ls 2>&1 | head`、`sleep`、`gh --version`
   等未知/只读命令实际执行返回正常结果，无 `[worktree_isolation]` 门禁回执。
2. **SC2 EROFS 回灌 + 无污染**：unbound 写主 checkout 后屏上出现：

   ```text
   [fs_denied] the workspace is read-only in this session: worktree isolation
   is ON and this session is not yet bound to a task worktree, so the main
   checkout is mounted read-only inside the sandbox fence and the writes ...
   ```

   （含 `create-worktree` 与「重发这一次调用」指引）；执行后主 checkout
   `git status --porcelain` 干净、零新文件。

3. **bound 回路**：模型调 `create-worktree` → 审批弹窗按 `y` 通过 → 活
   `taskRoot` 翻到 task 树 → 下一波同命令写入成功；bound 档 argv 与翻转前
   byte-identical（vitest deepEqual 另证）。

交互环境注记：TUI 经 `/home/winner/.bun/bin/bun run src/cli.ts tui` 起（tsx 嵌套
报「TUI 需用 Bun 运行」）；门禁开关实际生效于用户级 `~/.iknow/settings.json`
（项目级 `isolation` 键被 ADR-0084 允许名单忽略）。

## 3. 窄矩阵回归

- `npm run typecheck` → exit 0。
- `npm run test:changed` → 356 文件 / 5255 用例绿。
- 环境性失败仅 `grep.test.ts`（worktree 缺 vendor rg 二进制）：`ln -sfn` 主
  checkout 的 `vendor/ripgrep/15.1.0` 后 89/89 绿，未降断言。

## 4. review-repair 轮增量（本文档同 commit 落地）

- S1(High)：`.git` 目标 EROFS 回灌文案区分（`git metadata` 专属指引 +
  `.gitignore`/`.github` 防误判断言）——补实现对齐 ADR-0109 子决策 4。
- M1：background 档物理围栏在 spawn 回执 `notice` 预披露（detached stderr
  不上前台结果，EROFS 原文可在 task log 见）；bound/OFF 回执形状不变。
- M3：`WorktreeGateReader` 具名只读类型收敛 20 处内联结构类型。
- L1–L3：`EROFS_UNBOUND_PATTERN` 取消导出、测试助手去重、plans 沿革注记。
