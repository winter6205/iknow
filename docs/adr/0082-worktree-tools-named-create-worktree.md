# 0082. Worktree ACI registration names drop "task"; serve agent usability first

Date: 2026-09-10
Status: accepted

The five model-surface tools register as `create-worktree` / `enter-worktree` / `exit-worktree` / `list-worktrees` / `remove-worktree`. The description answers only what the tool does and whether the agent can call it. Naming a blocked write is the harness receipt; human-facing "create" prompting is prompt + fixture. The old names `create-task-worktree` etc. are no longer model-surface names. The on-disk category term **task worktree** may stay in CONTEXT but does not enter tool registration names.

**Why not keep create-task-worktree:** the name welds "task" into the capability surface, the description then layers blocking policy on top, and what the agent sees first is process prose rather than a tree-creation tool.
