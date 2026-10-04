/**
 * Per-file atomic publish for ordinary content writes
 * (ADR-0136 / specs/session-checkpoint-architecture.md §3, SC10).
 *
 * Why: an in-place `writeFile` leaves a partially written target if the
 * writer dies mid-write, and a partial file is neither the old bytes nor the
 * new ones — recovery can then match it against neither preimage and must
 * escalate. Staging the COMPLETE content in the target's own directory and
 * `rename`-ing it onto the target keeps the replacement inside one
 * filesystem, where rename is atomic, so a reader sees the wholly old file or
 * the wholly new file and never a mixture.
 *
 * The guarantee is PER FILE. A multi-file operation is not a transaction: a
 * crash between file A and file B leaves A published and B untouched, and
 * that is the intended, separately accountable outcome.
 *
 * Honest degradation. Symlink / hardlink / special-file / metadata
 * preservation are explicitly out of scope (spec §Boundaries), so a target
 * rename would silently destroy the link node rather than honour the
 * existing semantics. Those cases fall back to today's in-place write and
 * REPORT that they did so, so a caller can surface it — an unsupported case
 * must never silently inherit a guarantee it does not satisfy.
 */
import { chmod, lstat, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** `atomic` = the target was replaced by rename and a reader never sees a
 *  partial file. `in_place` = the caller's bytes were written directly and
 *  the guarantee does NOT hold. */
export type FilePublishMode = "atomic" | "in_place";

export interface FilePublishResult {
  readonly published: FilePublishMode;
  /** Present exactly when `published === "in_place"`: why the atomic
   *  guarantee does not apply to this target. */
  readonly reason?: string;
}

export interface PublishFileOptions {
  /** Crash-test seam: the staged file is complete, rename has NOT run. */
  readonly onStaged?: (stagingPath: string) => void | Promise<void>;
  /** Crash-test seam: rename has completed, this call has not returned. */
  readonly onPublished?: (target: string) => void | Promise<void>;
}

type Stat = Awaited<ReturnType<typeof lstat>>;

/**
 * Write `content` to `target`, atomically when the target's shape allows it.
 * The complete content lands on the same filesystem first; the target itself
 * is only ever touched by a single rename.
 */
export async function publishFile(
  target: string,
  content: string,
  options?: PublishFileOptions
): Promise<FilePublishResult> {
  const existing = await lstatOrUndefined(target);
  const blocker = await atomicBlocker(target, existing);
  if (blocker !== null) {
    await writeFile(target, content, "utf8");
    return { published: "in_place", reason: blocker };
  }
  const staging = stagingPathFor(target);
  try {
    await writeFile(staging, content, "utf8");
    // An in-place writeFile inherits the existing mode for free; a
    // rename-replace does not, so the mode is carried across explicitly. A
    // file that did not exist takes the default mode, same as today.
    if (existing !== undefined) {
      await chmod(staging, Number(existing.mode) & 0o7777);
    }
    await options?.onStaged?.(staging);
    await rename(staging, target);
  } catch (err) {
    // Never leave staging debris behind on a handled failure. A hard kill
    // runs none of this, which is why the staging name is unique per call.
    await rm(staging, { force: true });
    throw err;
  }
  await options?.onPublished?.(target);
  return { published: "atomic" };
}

/**
 * Why `target` cannot be atomically replaced, or null when it can.
 *
 * A symlinked ancestor is degraded as well: the directory the staging file
 * resolved into and the directory `rename` resolves are then two independent
 * lookups, so the pair is no longer provably one filesystem. Degrading is the
 * honest answer; claiming the guarantee there would not be.
 */
async function atomicBlocker(
  target: string,
  existing: Stat | undefined
): Promise<string | null> {
  if (existing !== undefined && !existing.isFile()) {
    return `target exists and is not a regular file (symlinks, directories and special files are published in place)`;
  }
  const parent = await lstatOrUndefined(dirname(target));
  if (parent === undefined) return null;
  if (parent.isSymbolicLink()) {
    return `parent directory is reached through a symbolic link`;
  }
  return null;
}

/**
 * Dot-prefixed staging name in the target's OWN directory: same filesystem as
 * the target (so rename is atomic) and ignored by the project's own ignore
 * globs. The random suffix keeps a SIGKILL's un-renamed leftover from ever
 * colliding with a later attempt.
 */
function stagingPathFor(target: string): string {
  return join(
    dirname(target),
    `.${basename(target)}.iknow-publish-${randomBytes(6).toString("hex")}`
  );
}

async function lstatOrUndefined(path: string): Promise<Stat | undefined> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
