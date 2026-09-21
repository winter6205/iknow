# 0074. Fence /tmp backed by a per-identity host directory, session-lifetime

Date: 2026-09-09
Status: accepted

> **Superseded 2026-09-13 (ADR-0092, bind surface only)**: the backing is no longer bound as the fence's `/tmp` — the session tmp uses its host path and `$TMPDIR` points at it. Per-identity backing and session lifetime are **kept** (ADR-0092).

The closed-world writable set is still `taskRoot` + `/tmp`. (The default FS posture is superseded by ADR-0092: default global tier; bind surface below; the lifetime clause survives.) `/tmp` is no longer one empty tmpfs per bash call: each identity (the main session or one worker) gets a host directory inside the session folder, bound as that identity's fence `/tmp`. `bash` / `write_file` / `edit_file` can all write these two roots. Every hand-off carries the `task_id` and that `/tmp` root; the parent uses the existing `subagent_result` to list the top level or read one file by id. It is not a delivery destination: nothing is auto-copied into the repository, no extra worktree is opened.

**Why not keep per-command tmpfs:** when the command ends the disk is gone, and the parent cannot locate intermediates by path.

**Why not let only bash write `/tmp`:** it splits from the fence's writable set, leaving the write tools narrower than the shell.

Amends the `/tmp` lifetime clauses of ADR-0068 / ADR-0037 §9.2 (the bind surface is amended again by ADR-0092: no longer bound as `/tmp`; the lifetime clause remains in force).
