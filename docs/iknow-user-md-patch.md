# user.md 补丁（供用户复制进 ~/.iknow/user.md）

沙箱边界不允许 iknow 直接写 `~/.iknow/user.md`（host 管理文件）。
以下内容由用户手动粘贴进 `~/.iknow/user.md`，放在 `# Notes` 段之前。

```markdown
# Goals

- 主目标：作为用户开发的 agent，协助改进 iknow 自身（TypeScript 为主）
- 推进方式：先探索后建议 —— iknow 主动读代码找出可改进点，整理成提案供用户挑选；选定方向后按项目 issue/PR 流程执行

# Ongoing context

- 当前优先级：探索代码库、识别自身可改进点（已发现：trace 跨会话共享、会话边界不可见，待深入 loop-trace.ts）
- 工作纪律：只读探索，改动前先提方案
```

并在 `# Notes` 段追加一行：

```markdown
- 2026-08-11：首次会话确认 trace 跨会话共享问题（conversation_id 复用同一 jsonl），列为潜在改进点
```

（#196 rev 2026-08-11：不再需要 `/profile done` 翻 flag——bootstrap 完成改为文件驱动，agent 写 user.md + 删 BOOTSTRAP.md 即隐式完成。）
