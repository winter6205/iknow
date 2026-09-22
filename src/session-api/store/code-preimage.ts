/**
 * Code restore plan + apply (ADR-0036 / ADR-0121).
 *
 * The plan is pure: fold the abandoned head-chain segment into one inverse op
 * per touched path. The apply is the only side-effecting half: it reads every
 * restore blob up front (so an unreadable blob aborts before any file changes
 * and the rewind head stays put), then restores a path only when the live root
 * identity matches and the file's current bytes still equal the segment's last
 * captured post-image — writing the preimage bytes back, or, where the
 * earliest ref recorded capture-time absence, deleting the created path
 * instead (ADR-0121). Everything else is a reported skip.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  codeSnapshotSha,
  isCodeSnapshotSha,
  readCodeSnapshot,
} from "./code-snapshot-store.js";
import type { SessionEventRecord } from "./jsonl.js";

/** One path's inverse op: put `restoreSha` bytes back at `relPath`, but only
 *  when the file currently equals `expectedPostimageSha` (this path's last
 *  captured write in the segment) and `rootIdentity` matches the live root.
 *  `absentBefore` — capture-time ENOENT evidence on the EARLIEST ref — flips
 *  the guarded outcome from a byte write-back to a delete: the pre-segment
 *  state of a created path is absence. Never derived from empty bytes. */
export interface CodeRestoreOp {
  readonly relPath: string;
  readonly rootIdentity: string;
  readonly restoreSha: string;
  readonly expectedPostimageSha: string;
  readonly absentBefore: boolean;
}

/** A path we deliberately did not touch, with why. */
export interface CodeRestoreSkip {
  readonly relPath: string;
  readonly reason: "drift" | "root_identity";
}

/** What one apply pass did: paths written back, paths skipped. */
export interface CodeRestoreReport {
  readonly restored: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<CodeRestoreSkip>;
}

/**
 * Fold the abandoned segment into inverse ops. A path's `restoreSha` is the
 * EARLIEST preimage on the segment (bytes before it was first touched) and its
 * `expectedPostimageSha` the LATEST postimage (what a live file must still look
 * like to write back safely). A ref is dropped when any of its three
 * transcript-supplied locators is unusable — a relative path that is absolute
 * or climbs out of the root, or a blob name that is not sha256 hex: a
 * transcript is history, not a licence to touch anything outside the
 * workspace's own content-addressed store.
 */
export function buildCodeRestorePlan(
  abandoned: ReadonlyArray<SessionEventRecord>
): ReadonlyArray<CodeRestoreOp> {
  const byPath = new Map<string, CodeRestoreOp>();
  const order: string[] = [];
  for (const event of abandoned) {
    const ref = event.codePreimage;
    if (ref === undefined) continue;
    if (
      !isSafeRelPath(ref.relPath) ||
      !isCodeSnapshotSha(ref.preimageSha) ||
      !isCodeSnapshotSha(ref.postimageSha)
    ) {
      continue;
    }
    const key = `${ref.rootIdentity}\u0000${ref.relPath}`;
    const existing = byPath.get(key);
    if (existing === undefined) {
      order.push(key);
      byPath.set(key, {
        relPath: ref.relPath,
        rootIdentity: ref.rootIdentity,
        restoreSha: ref.preimageSha,
        expectedPostimageSha: ref.postimageSha,
        // The delete directive belongs to the pre-segment state, which only
        // the earliest ref describes; a later ref (even one claiming absence)
        // cannot turn an existing file into a created one.
        absentBefore: ref.absentBefore === true,
      });
    } else {
      byPath.set(key, { ...existing, expectedPostimageSha: ref.postimageSha });
    }
  }
  return order
    .map((key) => byPath.get(key))
    .filter((op): op is CodeRestoreOp => op !== undefined);
}

export interface ApplyCodeRestoreOpts {
  readonly sessionFolder: string;
  readonly taskRoot: string;
  readonly rootIdentity: string;
  readonly ops: ReadonlyArray<CodeRestoreOp>;
}

/**
 * Write the abandoned segment's files back. Pass 1 loads every restore blob so
 * a missing one throws before pass 2 touches the workspace; pass 2 restores the
 * paths whose live identity and current bytes both still match.
 */
export async function applyCodeRestore(
  opts: ApplyCodeRestoreOpts
): Promise<CodeRestoreReport> {
  const blobs: Buffer[] = [];
  for (const op of opts.ops) {
    blobs.push(await readCodeSnapshot(opts.sessionFolder, op.restoreSha));
  }
  const restored: string[] = [];
  const skipped: CodeRestoreSkip[] = [];
  for (let i = 0; i < opts.ops.length; i++) {
    const op = opts.ops[i]!;
    const outcome = await restoreOne(op, blobs[i]!, opts);
    if (outcome === "restored") restored.push(op.relPath);
    else skipped.push({ relPath: op.relPath, reason: outcome });
  }
  return { restored, skipped };
}

async function restoreOne(
  op: CodeRestoreOp,
  restoreBytes: Buffer,
  opts: ApplyCodeRestoreOpts
): Promise<"restored" | CodeRestoreSkip["reason"]> {
  if (op.rootIdentity !== opts.rootIdentity) return "root_identity";
  const abs = resolve(join(opts.taskRoot, op.relPath));
  const current = await readFileOrEmpty(abs);
  if (codeSnapshotSha(current) !== op.expectedPostimageSha) return "drift";
  if (op.absentBefore) {
    // Guard hit on a created path: absence IS the restore state; a path
    // already gone satisfies it (force absorbs ENOENT). Other IO failures
    // propagate — no silent half-restore.
    await rm(abs, { force: true });
    return "restored";
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, restoreBytes);
  return "restored";
}

async function readFileOrEmpty(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return Buffer.alloc(0);
    }
    throw err;
  }
}

function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || isAbsolute(relPath)) return false;
  return !relPath.split(/[\\/]/).some((segment) => segment === "..");
}
