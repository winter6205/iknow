# 0099. Project memory lives in the home project tree at `projects/<slug>/memory/`

Date: 2026-09-18
Status: accepted

## Context

Session records and the background-task registry already live under `<dataDir or ~/.iknow>/projects/<slug>/`, keyed by `projectIdentityRoot` (ADR-0087 / ADR-0088). The project memory store, however, still lived per ADR-0019 at `<workspaceRoot>/.iknow/memory/<slug>`: for the same project, sessions sit in the global project tree while memory sits on another workspace tree. Operators expect memory, like the other project groupings, to hang under that project's session directory.

## Decision

Project memory store = `<dataDir or ~/.iknow>/projects/<slug>/memory/`, the same slug as the session leaf and `tasks/`. It no longer shards with `workspaceRoot`. The `--workspace-root` throwaway no longer isolates project memory; use `--data-dir` for a separate pool. Existing workspace data is not migrated automatically. The user-layer `AGENTS.md` / `resolveUserMemoryDir` are outside this decision.

## Why not

**Why not keep it per-root:** multiple checkouts each hold their own memory copy; browsing the home project tree shows no memory for the project.

**Why not auto-move the workspace `.iknow/memory/`:** same policy as the ADR-0088 session-stock decision; the old layout nests the slug under memory, the new layout puts memory/ under the slug, and a silent rename can collide with an existing target.

## Consequences

- (+) Browsing `~/.iknow/projects/<slug>/` shows the session leaf, `tasks/`, and `memory/` together.
- (−) Old workspace memory stores are invisible to new processes and must be migrated by hand.
