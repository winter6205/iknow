/**
 * The host-owned per-call root context the bounded cleanup exceptions consume
 * (ADR-0132 / ADR-0133), and the filesystem-aware containment question it
 * exists to answer.
 *
 * Why this module exists instead of a parameter on `findDangerousPattern`: the
 * cleanup exceptions must be answerable from a TRUSTED snapshot that the host
 * built once per call and handed to BOTH permission admission and the Bash
 * handler. Keeping the shape here (and here only) is what lets the two gates
 * consume one value without either importing the other's internals —
 * `permission/` takes nothing from `sandbox/`, and this module takes nothing
 * from either.
 *
 * Why containment is filesystem-aware and never textual: `…/fence-tmp/escape/
 * secret.txt` starts with the scratch root's own path string, so a lexical
 * prefix check would grant deletion authority over a file that resolves
 * outside it. `realpathSync` on the target's nearest existing ancestor is the
 * only fact that settles `..`, `.`, and symlinked ancestors, and it is the same
 * fact `resolveWithinRoot` uses for the other write tools — one rule, one
 * place.
 *
 * The snapshot is DATA, not a live handle: a call freezes it at entry so a
 * mid-call root rebind cannot widen or narrow the answer, and both gates read
 * the same frozen value. Absent roots mean "the host established no cleanup
 * scope", which every consumer must read as no exception at all.
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * One call's root context. Both fields are optional because a host may wire
 * one and not the other: a main-session engine always has a task root, a
 * caller that injected an explicit `tmpDir` has a scratch root, and a test
 * host may deliberately supply only one to pin that arm.
 */
export interface CleanupRootSnapshot {
  /**
   * The calling identity's own session scratch — the host path ADR-0092 hands
   * this identity as `$TMPDIR`. This identity only: a worker pad is a
   * DIFFERENT path and inherits nothing from the main session's.
   */
  readonly scratchRoot?: string;
  /** The active `taskRoot` this call's working directory is anchored in. */
  readonly taskRoot?: string;
}

/** Which root an admitted cleanup was established inside. */
export type CleanupScope = "identity-scratch" | "task-root";

/** A realpath failure that is not "path does not exist". */
class UnreadablePathError extends Error {}

/**
 * `realpathSync` on the longest existing prefix of `path`, with the remaining
 * (necessarily non-existent) segments appended back.
 *
 * `rm -f` is precisely the case where the target does not exist, so realpath'ing
 * the whole path cannot be the containment rule — a cleanup of a file already
 * deleted would then be unanswerable. The nearest existing ancestor still
 * carries every symlink and `..` hop that decides containment, and a suffix
 * under it cannot move the answer.
 */
function realpathOfExistingPrefix(path: string): string {
  let current = path;
  const trailing: string[] = [];
  for (;;) {
    try {
      return trailing.length === 0
        ? realpathSync(current)
        : resolve(realpathSync(current), ...trailing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new UnreadablePathError(
          `cannot resolve ${path}: ${code ?? "unknown"}`
        );
      }
      const parent = dirname(current);
      // Reached the filesystem root without finding an existing ancestor.
      if (parent === current) {
        throw new UnreadablePathError(`no existing ancestor for ${path}`);
      }
      trailing.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/** Resolve `target` against `base` (the call's effective working directory). */
function absolutize(target: string, base: string): string {
  return isAbsolute(target) ? target : resolve(base, target);
}

/**
 * Whether `target` is a STRICT descendant of `root` after full symlink
 * resolution. Strict: the root itself is never "inside" it, because ADR-0132
 * withholds the scratch root as a target and ADR-0133's operand is a file
 * inside the workspace.
 *
 * A resolution failure is NOT containment — an unresolvable path cannot
 * establish that it is inside anything, and the exceptions' contract is that
 * uncertainty grants no authority.
 */
export function isContainedFileTarget(
  target: string,
  root: string,
  base: string
): boolean {
  const absTarget = absolutize(target, base);
  const absRoot = absolutize(root, base);
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = realpathOfExistingPrefix(absTarget);
    realRoot = realpathOfExistingPrefix(absRoot);
  } catch {
    return false;
  }
  if (realTarget === realRoot) return false;
  const prefix = realRoot.endsWith("/") ? realRoot : `${realRoot}/`;
  return realTarget.startsWith(prefix);
}

/**
 * Whether the path names something that can only be a file, judged the way the
 * wall needs it: a target that does not exist yet is not a directory (this is
 * the `rm -f` of an already-removed intermediate file), but a target that
 * exists AS a directory is out of scope for both exceptions — ADR-0132 removes
 * files, and a bare `rm -f <dir>` fails in `rm` itself without `-r`.
 */
export function isNonDirectoryTarget(target: string, base: string): boolean {
  try {
    return !statSync(absolutize(target, base)).isDirectory();
  } catch {
    return true;
  }
}

/** Any character that makes a path unresolvable without a shell expansion. */
const UNRESOLVED_GLOB = /[*?\[\]{}]/;

/**
 * Whether `word` is a fully determined path operand: no variable, no command
 * substitution, no tilde, no glob, no backslash escape, and not a bare option.
 *
 * The wall may only establish authority over a path it can resolve ITSELF.
 * Anything the shell would expand at runtime is a different path by the time
 * `rm` sees it, so no expansion form inherits an exception — those follow the
 * existing review / deny contracts instead (ADR-0132).
 *
 * `$TMPDIR` is the single exception to "no variable", and it is checked by the
 * caller's own expansion below rather than here, so this predicate answers the
 * question for a word whose variable has already been substituted out.
 */
export function isDeterminedPathWord(word: string): boolean {
  if (word.length === 0) return false;
  if (word.startsWith("-")) return false;
  if (word.includes("$") || word.includes("`")) return false;
  if (word.startsWith("~")) return false;
  if (word.includes("\\")) return false;
  if (UNRESOLVED_GLOB.test(word)) return false;
  return true;
}
