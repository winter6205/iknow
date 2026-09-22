# 0084. Project settings allowlist; permission SSOT moves into JSON

Date: 2026-09-11
Status: accepted

The user layer `~/.iknow/settings.json` and the shared project layer `<repo>/.iknow/settings.json` remain the only two file layers (no third local layer). ADR-0015's "project overrides user" narrows to: **the project file adopts only** `hooks`, `verify`, `secrets`, `permissions`. Any other top-level section (including `isolation` / `llm` / `memory` / `subagent` / `web` / `lsp` / `loop` / `graph`) appearing in the project file → dropped, never overriding user values, with a visible warning at startup.

Write-back respects the layer: user-layer keys go only to the user file; keys such as thinking must not be written into the project file just because "the project file already exists".

The mechanical permission layer migrates from `permissions.toml` into the project's `settings.permissions`. **Reading toml stops.** Both present at once → fail-loud at startup/load. The user layer does not accept `permissions`.

> **Amendment 2026-09-13** (ADR-0090): the preceding paragraph's "predicate semantics are not to be replaced by string lists" is **superseded**. The allowlist, the toml reading stop, and the user-layer rejection of permissions all remain in force. Current rule form = **declarative permission rules** (`allow`/`ask`/`deny` strings).

> **Amendment 2026-09-22**: "with a visible warning at startup" above holds when the two layers are **two files**. When the entry directory _is_ `$HOME` (or reaches it through a symlink), `~/.iknow/settings.json` and `<cwd>/.iknow/settings.json` name **one file**, and the warning's wording becomes false: it reports the user's own keys as "ignored" while nothing left the merged result, and it reports user-layer `permissions` as rejected when that same file is what feeds the project layer that grants them. So: **the filtering is unchanged, the wording is suppressed in the one-file case.** The entry directory is a legitimate workspace scope (ADR-0019 D1.1 makes the launch directory the per-root state anchor; ADR-0088 keeps project settings among the anchors that sit next to the repo), which is why the one file keeps serving both layers instead of the project layer being skipped. Multi-key and repeated-load repetition is additionally deduplicated on the _default_ warn sink only — an injected `onWarn` still receives every message, and the dedup key carries a per-file change signal so a long-lived process re-arms after an edit instead of muting a later state.

**Why not let the project keep overriding isolation / llm:** one project `isolation: false` would strip the gating for everyone or (under the old assembly) remove the worktree tools, turning a personal switch into a repository contract. The allowlist separates team contracts (hooks, verification, secrets, permissions) from personal runtime (model, isolation, subagents).

**Why not a third local layer:** two layers already cover "shared vs personal"; a third only adds override-ordering and write-back ambiguity.

Related: CONTEXT topic "project settings allowlist".
