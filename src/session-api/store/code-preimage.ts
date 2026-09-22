/**
 * Code restore plan + apply (ADR-0036 / ADR-0121).
 *
 * The plan is pure: fold the abandoned head-chain segment into one inverse op
 * per touched path — but the fold never crosses a transcript. Each input group
 * is one transcript's events, and a path's ownership is decided by how many
 * groups wrote it: one group folds inside its own chain, more than one has no
 * order to fold by and is a receipt skip (ADR-0121 rejects both concatenating
 * the parent chain with the worker transcripts and sorting by `createdAt`).
 * The apply is the only side-effecting half: it reads every restore blob up
 * front (so an unreadable blob aborts before any file changes and the rewind
 * head stays put), then restores a path only when the live root identity
 * matches and the file's current bytes still equal that chain's last captured
 * post-image — writing the preimage bytes back, or, where the earliest ref
 * recorded capture-time absence, deleting the created path instead. Everything
 * else is a reported skip, ownership skips riding along with the guard skips.
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
 *  captured write inside its OWNING transcript) and `rootIdentity` matches the
 *  live root. `absentBefore` — capture-time ENOENT evidence on the EARLIEST ref
 *  of that one transcript — flips the guarded outcome from a byte write-back to
 *  a delete: the pre-segment state of a created path is absence. Never derived
 *  from empty bytes. */
export interface CodeRestoreOp {
  readonly relPath: string;
  readonly rootIdentity: string;
  readonly restoreSha: string;
  readonly expectedPostimageSha: string;
  readonly absentBefore: boolean;
}

/** The transcript a group of events came from. `transcriptId` is only ever
 *  compared for equality — it is not a clock and carries no ordering, because
 *  parent and worker are separate writers (ADR-0110). The caller (hub) learns it
 *  at the join seam: the parent's own chain versus one `subagents/<taskId>/`
 *  transcript. */
export interface CodeRestoreTranscript {
  readonly transcriptId: string;
  readonly events: ReadonlyArray<SessionEventRecord>;
}

/** A path we deliberately did not touch, with why. `cross_transcript` is an
 *  attribution verdict the plan makes before any live-file guard runs; `drift`
 *  and `root_identity` are the guards themselves.
 *
 *  This union is restated in `contract.ts` (`RewindCodeRestoreSkip`) and in the
 *  TUI picker's label map; the `_rewindSkipReasonAlignment` satisfies assertion
 *  in contract.ts keeps all three from drifting apart at compile time. */
export interface CodeRestoreSkip {
  readonly relPath: string;
  readonly reason: "drift" | "root_identity" | "cross_transcript";
}

/** What the fold produced: ops for the paths exactly one transcript owns, plus
 *  the paths it refused to sequence at all. */
export interface CodeRestorePlan {
  readonly ops: ReadonlyArray<CodeRestoreOp>;
  readonly skipped: ReadonlyArray<CodeRestoreSkip>;
}

/** What one apply pass did: paths written back, paths skipped — the plan's
 *  ownership verdicts first, then the guards' own refusals. */
export interface CodeRestoreReport {
  readonly restored: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<CodeRestoreSkip>;
}

/** Typed failure on the restore path (plain-object convention shared with the
 *  code-snapshot store): the rewind asked to put code back but no live task
 *  root can be located for this conversation (no dirty-root record, no
 *  persisted workspaceRoot). Thrown before any workspace write and before the
 *  head moves — the same posture as an unreadable restore blob. */
export type CodeRestoreError = {
  kind: "restore_root_unavailable";
  conversation_id: string;
};

/** A fold entry while the scan is still running: the op fields plus the set of
 *  transcripts that claimed the path, which is what decides if folding is legal.
 *  Mutable on purpose — the scan updates `expectedPostimageSha` in place. */
interface FoldEntry {
  relPath: string;
  rootIdentity: string;
  restoreSha: string;
  expectedPostimageSha: string;
  absentBefore: boolean;
  transcripts: Set<string>;
}

/**
 * Fold the abandoned segment into inverse ops, one fold per transcript. A path's
 * `restoreSha` is the EARLIEST preimage on the transcript that wrote it (bytes
 * before that chain first touched the path) and its `expectedPostimageSha` the
 * LATEST postimage on that same transcript (what a live file must still look
 * like to write back safely). A path whose refs come from more than one
 * transcript has no order to fold by — no op is built for it, so the apply
 * cannot even reach a guard or a delete for it.
 *
 * A ref is dropped when any of its three transcript-supplied locators is
 * unusable — a relative path that is absolute or climbs out of the root, a
 * blob name that is not sha256 hex, or an empty root identity: an empty
 * identity names no project, and the apply guard would then pass for any
 * equally-empty live root, writing relative to the process CWD.
 */
export function buildCodeRestorePlan(
  transcripts: ReadonlyArray<CodeRestoreTranscript>
): CodeRestorePlan {
  const byPath = new Map<string, FoldEntry>();
  const order: string[] = [];
  for (const group of transcripts) {
    for (const event of group.events) {
      const ref = event.codePreimage;
      if (ref === undefined) continue;
      if (
        !isSafeRelPath(ref.relPath) ||
        !isCodeSnapshotSha(ref.preimageSha) ||
        !isCodeSnapshotSha(ref.postimageSha) ||
        ref.rootIdentity.length === 0
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
          transcripts: new Set([group.transcriptId]),
        });
      } else {
        existing.transcripts.add(group.transcriptId);
        existing.expectedPostimageSha = ref.postimageSha;
      }
    }
  }
  const ops: CodeRestoreOp[] = [];
  const skipped: CodeRestoreSkip[] = [];
  for (const key of order) {
    const entry = byPath.get(key)!;
    if (entry.transcripts.size > 1) {
      skipped.push({ relPath: entry.relPath, reason: "cross_transcript" });
      continue;
    }
    ops.push({
      relPath: entry.relPath,
      rootIdentity: entry.rootIdentity,
      restoreSha: entry.restoreSha,
      expectedPostimageSha: entry.expectedPostimageSha,
      absentBefore: entry.absentBefore,
    });
  }
  return { ops, skipped };
}

export interface ApplyCodeRestoreOpts {
  readonly sessionFolder: string;
  readonly taskRoot: string;
  readonly rootIdentity: string;
  readonly plan: CodeRestorePlan;
}

/**
 * Write the abandoned segment's files back. Pass 1 loads every restore blob so
 * a missing one throws before pass 2 touches the workspace; pass 2 restores the
 * paths whose live identity and current bytes both still match. The plan's
 * ownership skips are already decided and lead the report — a path two
 * transcripts wrote never becomes an op, so no blob is read for it and no guard
 * is ever asked about it.
 */
export async function applyCodeRestore(
  opts: ApplyCodeRestoreOpts
): Promise<CodeRestoreReport> {
  const blobs: Buffer[] = [];
  for (const op of opts.plan.ops) {
    blobs.push(await readCodeSnapshot(opts.sessionFolder, op.restoreSha));
  }
  const restored: string[] = [];
  const skipped: CodeRestoreSkip[] = [...opts.plan.skipped];
  for (let i = 0; i < opts.plan.ops.length; i++) {
    const op = opts.plan.ops[i]!;
    const outcome = await restoreOne(op, blobs[i]!, opts);
    if (outcome === "restored") restored.push(op.relPath);
    else skipped.push({ relPath: op.relPath, reason: outcome });
  }
  return { restored, skipped };
}

/** What the two live-file guards can decide about one op. Ownership is not here:
 *  the plan already settled it, which is why `cross_transcript` cannot be an
 *  outcome of the guard. */
type GuardOutcome = "restored" | "drift" | "root_identity";

async function restoreOne(
  op: CodeRestoreOp,
  restoreBytes: Buffer,
  opts: ApplyCodeRestoreOpts
): Promise<GuardOutcome> {
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
