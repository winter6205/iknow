# Subagent roles (subagent_type)

`spawn_subagent` routes its optional `subagent_type` argument through an agent
catalog. The catalog entry supplies the subagent's persona (system-prompt
segment), optional `bashMode` restriction, and optional tool denylist.

## Builtin roles

| id                | Behavior                                                           |
| ----------------- | ------------------------------------------------------------------ |
| `explore`         | Read-only exploration; write tools denied, bash forced `readonly`. |
| `general-purpose` | Default. Full tool surface.                                        |

## User-defined roles: `~/.iknow/agents/`

Drop a role file named `AGENTS.md` into the global agents folder — either one
directory per role (mirrors the skill convention):

```
~/.iknow/agents/code-reviewer/AGENTS.md
```

or a flat file:

```
~/.iknow/agents/code-reviewer.md
```

The role id is the directory / file name (`code-reviewer` above). The file is
an optional frontmatter block plus the persona body:

```markdown
---
description: Reviews diffs against the repo's standards.
bashMode: readonly
disallowedTools: edit_file, write_file
---

You are a code-review agent. Read the cited files, compare against the
standards in AGENTS.md, and report findings by severity.
```

Frontmatter keys (all optional):

- `description` — shown in the `spawn_subagent` tool's type list. Falls back to
  `User-defined subagent role '<id>'.`
- `bashMode` — `readonly` forces the worker's bash into read-only mode; `any`
  (default) keeps the full surface.
- `disallowedTools` — comma-separated tool names denied for this role.

Everything after the frontmatter is the persona body injected into the
subagent's system prompt.

## Semantics

- Builtin roles are authoritative: a user role whose id matches a builtin
  (`explore`, `general-purpose`) is skipped with a warning at scan time —
  the builtin entry keeps its guarantees (e.g. `explore` stays read-only).
- Role ids must match `[A-Za-z0-9][A-Za-z0-9_-]*`; files with other names are
  skipped with a warning.
- Unknown `subagent_type` values are rejected by the tool schema at dispatch
  time; the worker falls back to the no-persona baseline if the role went
  missing between dispatch and worker assembly.
- The agents folder is scanned once per process and memoized; changes take
  effect on the next iknow start (parent and worker processes each scan once).
- With no `~/.iknow/agents/` directory, behavior is identical to the builtin
  catalog.
