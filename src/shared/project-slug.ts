/**
 * SSOT for the home project-tree grouping key.
 *
 * ADR-0071 / ADR-0088 / ADR-0099: `<poolRoot>/projects/<basename(projectIdentityRoot)>-<sha1[:12]>/`
 * is the grouping anchor shared by session folders, background task
 * registries, and the project memory library. Consumers
 * (`resolveProjectSessionDir` in `src/session-api/store/session-store.ts`,
 *  `resolveTasksDir` in `src/harness/background/paths.ts`,
 *  `resolveProjectMemoryDir` in `src/harness/memory/paths.ts`) each
 * historically computed their own formula and set their own length cap —
 * drift would land a task registry under a slug different from the
 * same-root session folder, orphaning the registry (live ledger with no
 * conversation, or vice versa). This module collapses formula and cap into
 * single literals: `computeProjectSlug` yields the slug,
 * `MAX_PROJECT_IDENTITY_ROOT_BYTES` yields the cap, shared by both sites.
 *
 * Placement rationale: `src/shared/` is the neutral layer already imported
 * by harness / session-api / traceserver alike (`src/harness/` Gate B forbids
 * importing `src/session-api/` and vice versa; `src/shared/` is the only
 * bidirectionally reachable layer).
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";

/**
 * Char cap for the `projectIdentityRoot` path, shared by session folders and
 * task registries — roots of 121–255 chars must be **accepted by both**, or
 * a folder under such a root resolves while the registry throws a typed
 * error → orphaned registry. The historical caps diverged
 * (`MAX_ROOT_DETAIL_CHARS = 120` in paths.ts vs
 * `MAX_CONVERSATION_ID_BYTES = 255` in session-store.ts); the 121–255 char
 * window was the regression range a review caught.
 *
 * 255 = the POSIX single path-component hard limit, kept same-sourced with
 * the conversation-id segment cap (also 255 in session-store.ts's
 * `MAX_CONVERSATION_ID_BYTES`) for uniform diagnostics.
 */
export const MAX_PROJECT_IDENTITY_ROOT_BYTES = 255;

/**
 * The single-formula slug: `<basename(root)>-<sha1(root)[:12]>`.
 *
 * No IO, no side effects, no input-shape validation (validation is carried
 * by each consumer's typed-error wrapper: session-store throws
 * `SessionRootError`, paths.ts throws the same `SessionRootError`; call this
 * function only after validation passes).
 */
export function computeProjectSlug(projectIdentityRoot: string): string {
  const digest = createHash("sha1")
    .update(projectIdentityRoot)
    .digest("hex")
    .slice(0, 12);
  return `${basename(projectIdentityRoot)}-${digest}`;
}
