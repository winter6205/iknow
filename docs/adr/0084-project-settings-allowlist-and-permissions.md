# 0084. Project settings allowlist; permission SSOT moves into JSON

Date: 2026-09-11
Status: accepted

The user layer `~/.iknow/settings.json` and the shared project layer `<repo>/.iknow/settings.json` remain the only two file layers (no third local layer). ADR-0015's "project overrides user" narrows to: **the project file adopts only** `hooks`, `verify`, `secrets`, `permissions`. Any other top-level section (including `isolation` / `llm` / `memory` / `subagent` / `web` / `lsp` / `loop` / `graph`) appearing in the project file → dropped, never overriding user values, with a visible warning at startup.

Write-back respects the layer: user-layer keys go only to the user file; keys such as thinking must not be written into the project file just because "the project file already exists".

The mechanical permission layer migrates from `permissions.toml` into the project's `settings.permissions`. **Reading toml stops.** Both present at once → fail-loud at startup/load. The user layer does not accept `permissions`.

> **Amendment 2026-09-13** (ADR-0090): the preceding paragraph's "predicate semantics are not to be replaced by string lists" is **superseded**. The allowlist, the toml reading stop, and the user-layer rejection of permissions all remain in force. Current rule form = **declarative permission rules** (`allow`/`ask`/`deny` strings).

**Why not let the project keep overriding isolation / llm:** one project `isolation: false` would strip the gating for everyone or (under the old assembly) remove the worktree tools, turning a personal switch into a repository contract. The allowlist separates team contracts (hooks, verification, secrets, permissions) from personal runtime (model, isolation, subagents).

**Why not a third local layer:** two layers already cover "shared vs personal"; a third only adds override-ordering and write-back ambiguity.

Related: CONTEXT topic "project settings allowlist".
