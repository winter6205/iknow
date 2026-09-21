# 0027. Session authoritative history moved to a single-file JSONL

Date: 2026-08-22
Status: accepted

Context: the first round made the session a whole-JSON file with tmp/rename, noting "no JSONL migration this cycle" (the claimed ADR-0007 never landed in a file). That was shippable scaffolding, not a deliberate design fork. A later grilling wanted crash-resume and rewind to keep branches, which a linear `messages[]` cannot do.

Decision: the session's authoritative history is a single-file, append-only JSONL with id/parent; the in-process working copy follows the on-disk rewind head. trace JSONL remains observation-only. Old SessionFileV1 stays loadable and migrates on the next save. Resume state is not stuffed into `CheckpointRecord`.

Why: only a JSONL running log allows writing while keeping branches; whole-file overwrite plus truncating rewind would lose half-finished turns and rewound-away history. The constraint that every entry point reads the same on-disk copy still holds — only the file shape changes.

## Consequences

- 2026-08-22: save double-writes authoritative `<id>.jsonl` + compatibility mirror `<id>.json`; load prefers JSONL by extension. This is the temporary shape of the expand phase.
- 2026-08-23: save drops the `.json` mirror. load keeps the `.json` fallback (migration window). The dual-shape paths in list / delete stay until a one-shot migration script has run legacy-only `.json` through load+save, after which they get cut.
- 758 legacy-only `<id>.json` files remain visible only via the fallback; dropping the write mirror in this change **loses no data** (first save migrates), but the read fallback cannot be dropped in sync — the migration script must finish first.
- Test surface: removed the mirror assertions in `jsonl.test.ts`, the dual-write block in `jsonl-migration.test.ts`, and the mirror-reflects test in `rewind.test.ts`; tests reading `.json` directly moved to reading the `<id>.jsonl` head record or `store.load()`.
- 2026-09-08 (ADR-0071): the transcript **location** moved from `<baseDir>/sessions/<basename(cwd)>-<sha1(cwd)[:12]>/` into the **session folder** `<baseDir>/projects/<project slug>/<conversationId>/`, with the grouping key changed from `cwd` to **`projectIdentityRoot`** (stable across session-worktree rebind) — the old key name was dishonest: `resolveProjectSessionDir` claimed a "Project namespace" but actually grouped by cwd, splitting one project's sessions into N sibling directories via worktrees (measured: 5 of 127 directories belonged to different worktrees of the same project). **The record shape is unchanged to the byte**: still append-only JSONL with `id`/`parent` + rewind-head projection, and the `<id>.json` compatibility mirror remains absent. Sibling files `todos.md` / `trace.jsonl` / `blobs/` / `subagents/` were added in the same directory (see ADR-0071).
- 2026-09-08 (ADR-0071 Decision 7): the follow-up above — "758 legacy-only `<id>.json` files remain visible only via the fallback … the migration script must finish first" — ends here: ADR-0071 explicitly does **not keep legacy compatibility**, and the 758 legacy-only `.json` files plus the 127 old session directories are retired together (`--resume` stops working for old sessions, the TUI session list empties; operator-authorized). Therefore the `.json` read fallback **can retire** without first writing a one-shot migration script. The repo-root 337MB legacy `trace/` was archived to `~/.iknow/archive/trace-legacy/` (not into the repo `archive/`: measured that the directory is not gitignored).
