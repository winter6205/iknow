# 0087. The session pool root is home; it does not shard with workspaceRoot

Date: 2026-09-13
Status: accepted

## Context

ADR-0071 Decision 1 pinned the conversation folder at `~/.iknow/projects/<slug>/<conversationId>/`. ADR-0019, however, let `resolveServeDataDir` fall back to `<workspaceRoot>/.iknow` whenever a `workspaceRoot` existed. TUI / serve then wrote session jsonl and blobs into the workspace, and a `grep --no-ignore` sweep of the workspace would hit patterns just written into the transcript. The `workspaceRoot` glossary entry briefly counted sessions as per-root state, conflicting with the "conversation folder" entry.

## Decision

**Session pool root = explicit `--data-dir` / `dataDir`, otherwise `~/.iknow`. It does not shard with `workspaceRoot`.**

`resolveServeDataDir` no longer reads its second argument. TUI / serve / chat / trace read and write sides use the same formula. `--workspace-root` still anchors settings write-back / worktrees (the remaining clauses of ADR-0019), but not session records. **For the tasks location see ADR-0088; for the project-memory location see ADR-0099** (neither is per-root anymore). A throwaway isolation directory therefore no longer carries its own transcript; every copy sharing one `projectIdentityRoot` shares the same global slot.

Legacy state: move conversation folders mistakenly written under `<workspace>/.iknow/projects/` to `~/.iknow/projects/`; do not overwrite a conversation leaf that already exists at the target.

## Why not

**Why not just exclude `.iknow` from grep:** that disguises a diary problem as a search problem and hides worktrees / project settings / skills. The root cause is the landing location.

**Why not a silent runtime dual-pool fallback:** sharding is a fault; making resume scan the workspace again would turn the fault into a feature.

## Consequences

- (+) Workspace grep no longer hits session jsonl / blobs; TUI, `iknow --resume`, and the trace read side see one pool.
- (+) ADR-0071's path literals and the implementation point the same way.
- (−) A `--workspace-root` throwaway no longer isolates the transcript; an explicit `--data-dir` can still open a separate pool.
- (−) Existing `<workspace>/.iknow/projects/` content needs a one-time move; on a same-conversation leaf conflict, keep the home side.
