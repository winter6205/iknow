/**
 * SSOT for the two-level session-tree directory names.
 *
 * Layout: `<baseDir>/projects/<project-slug>/<conversationId>/{...,subagents/}`.
 * The only literal declaration site. Previously shadowed in four places —
 *   - `session-api/store/session-store.ts` (where `SUBAGENT_TRACE_DIR_NAME`
 *     was defined);
 *   - `traceserver/session-discovery.ts` + `traceserver/sessions.ts`
 *     (each with a local `PROJECTS_DIR_NAME` / `"subagents"` literal);
 *   - `harness/subagent/manager.ts` (added with the two-phase derivation) —
 * all converged into this file.
 *
 * Placement rationale: `src/shared/` is the neutral layer already imported
 * by harness / session-api / traceserver alike (traceserver's "must not
 * import harness/" boundary, pinned by
 * `tests/traceserver/output-backstop.test.ts`, applies to these constants
 * too — the read-side path-decoupling principle shares its origin with
 * output-backstop). Renaming any of these names requires re-evaluating
 * old-layout compatibility (archive/migration semantics of the session
 * folder consolidation).
 */

/** Level one of `<baseDir>/projects/<slug>/` — the project identity slug layer. */
export const PROJECTS_DIR_NAME = "projects";

/** `<projectDir>/<convId>/subagents/` — per-agent subagent record directory name. */
export const SUBAGENT_TRACE_DIR_NAME = "subagents";

/** `<sessionFolder>/fence-tmp/` — host backing pad for the main session's fenced `/tmp` (ADR-0074). Must not collide with `subagents/`. */
export const MAIN_SESSION_FENCE_TMP_DIR_NAME = "fence-tmp";

/** `<sessionFolder>/code-snapshots/` — content-addressed preimage blobs a successful workspace write captured (ADR-0036 / ADR-0071). Sibling of `subagents/` and `fence-tmp/`. */
export const CODE_SNAPSHOTS_DIR_NAME = "code-snapshots";

/** `<sessionFolder>/blobs/` — the session-local immutable body pool for masked trace bodies and native recovery state; trace readers follow only trace-authorized references. */
export const BLOBS_DIR_NAME = "blobs";

/** `<projectDir>/tasks/` — background task registry root (ADR-0088). Sibling of the session folder leaves. */
export const TASKS_DIR_NAME = "tasks";

/** `<projectDir>/memory/` — project memory library root (ADR-0099). Sibling of session leaves and `tasks/`. */
export const MEMORY_DIR_NAME = "memory";
