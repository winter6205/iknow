# 0088. The home project tree keeps conversation records and background registry in one tree; the workspace `.iknow` carries neither

Date: 2026-09-13
Status: accepted

## Context

The workspace `.iknow/{projects,sessions,tasks}` was a mismatch: the first two write harness diaries into a tree that grep sweeps, while the last pins the background registry to the checkout (ADR-0021 D1.3), giving every checkout of the same `projectIdentityRoot` its own ledger. ADR-0087 already pinned the session pool root to home, but tasks remained per-root, and the retired `sessions/` tree could still be sitting in the workspace.

## Decision

**The home project tree** = explicit `--data-dir`, otherwise `~/.iknow`, with `projects/<slug>/` underneath: conversation-folder leaves + a sibling `tasks/` + a sibling `memory/`. The slug still keys on `projectIdentityRoot` (ADR-0071). Retired `sessions/`: zero product writes, and it is not auto-migrated into conversation folders (L3). The workspace `.iknow` keeps only anchors that must sit next to the repo (worktrees / project settings / mcp / skills / rules). Conflicting leaves are not overwritten. The fix does not rely on grep-excluding the whole `.iknow` tree.

## Why not

**Why not keep tasks following `workspaceRoot`:** a throwaway checkout should not open a second live ledger; what "tasks stay visible after a rebind" needs is project identity, not workspace sharding.

**Why not put the registry inside the conversation-folder leaf:** its lifetime and lock semantics differ from a conversation's (ADR-0071 Decision 2 still holds); only the namespace anchor moves, not the "record vs live state" split.

**Why not auto-collect `sessions/` into `projects/` leaves:** flat jsonl and conversation folders have different shapes; already rejected by 0071 L3.

## Consequences

- (+) Workspace grep no longer hits these three kinds of harness writes; multiple checkouts share one tasks registry.
- (−) A `--workspace-root` throwaway no longer isolates tasks (same direction as 0087's stance on the transcript); use `--data-dir` for a separate pool.
- (−) Existing workspace copies of the three directories need a one-time move; if the target already exists, skip.
