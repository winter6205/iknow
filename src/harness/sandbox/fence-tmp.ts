import { existsSync, mkdirSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeConversationSegment } from "../session-roots.js";
import { MAIN_SESSION_FENCE_TMP_DIR_NAME } from "../../shared/session-tree-names.js";
import type { CleanupRootSnapshot } from "../permission/cleanup-roots.js";

/** Host path of the main-session fence tmp dir under a session folder. */
export function mainSessionFenceTmpPath(sessionFolder: string): string {
  return join(sessionFolder, MAIN_SESSION_FENCE_TMP_DIR_NAME);
}

/** Create (if needed) and return the main-session fence tmp host dir. */
export function ensureMainSessionFenceTmp(sessionFolder: string): string {
  const pad = mainSessionFenceTmpPath(sessionFolder);
  mkdirSync(pad, { recursive: true });
  return pad;
}

/**
 * Main-session pad for `<projectDir>/<sanitized conversationId>/fence-tmp`.
 * Stays in harness (sanitize + join); does not import session-api.
 */
export function ensureMainSessionFenceTmpForConversation(
  projectDir: string,
  conversationId: string
): string {
  return ensureMainSessionFenceTmp(
    join(projectDir, sanitizeConversationSegment(conversationId))
  );
}

/**
 * Current-identity fence tmp host dir: explicit `tmpDir`, else
 * `<projectDir>/<conversationId>/fence-tmp`. Missing inputs → undefined
 * (write tools keep the legacy `/tmp` reject; bash supplies its own fallback).
 */
export function resolveSessionFenceTmp(input: {
  readonly tmpDir?: string;
  readonly projectDir?: string;
  readonly conversationId?: string;
}): string | undefined {
  if (input.tmpDir !== undefined && input.tmpDir.trim().length > 0) {
    mkdirSync(input.tmpDir, { recursive: true });
    return input.tmpDir;
  }
  if (
    input.projectDir !== undefined &&
    input.conversationId !== undefined &&
    input.conversationId.trim().length > 0
  ) {
    return ensureMainSessionFenceTmpForConversation(
      input.projectDir,
      input.conversationId
    );
  }
  return undefined;
}

/**
 * ADR-0132/ADR-0133: this identity's own scratch root, resolved once per call
 * so the permission wall and the Bash handler read the SAME path.
 *
 * The `realpath` is the point, not a normalization: the bounded cleanup
 * exceptions establish containment by resolving symlinks, and a snapshot that
 * kept an unresolved ancestor spelling would let a linked scratch path be
 * compared against a different real directory than the one the fence mounts.
 *
 * An unresolvable path yields `undefined`, which every consumer reads as "this
 * call has no cleanup scope" — the fail-toward-deny direction, never a
 * fabricated root. The empty string is NOT an acceptable stand-in: the
 * classifier treats a defined root as a real path and resolves `$TMPDIR`
 * operands against it, so `""` turned `rm -f $TMPDIR/etc/hostname` into a
 * claimed-inside-scratch target and removed a real hard-wall finding. Absence
 * and "the empty path" are different facts and only the first is safe.
 */
export function snapshotIdentityScratchRoot(
  tmpDir: string
): string | undefined {
  try {
    return realpathSync(tmpDir);
  } catch {
    return undefined;
  }
}

/**
 * The per-call root context the Bash handler hands to BOTH the fence-side
 * `$TMPDIR` decision and permission admission. One function, one value, so the
 * two gates cannot measure the same command against two different scratch
 * roots — the disagreement ADR-0132 forbids.
 *
 * `tmpDir` is the value the handler actually injects, so the snapshot and the
 * environment the command runs under cannot drift apart.
 */
export function snapshotBashCleanupRoots(input: {
  /** The value this call injects as `$TMPDIR` (already resolved or a fallback). */
  readonly tmpDir: string;
  /** The call's frozen working directory — the `taskRoot` the fence runs in. */
  readonly waveRoot: string;
}): CleanupRootSnapshot {
  const scratchRoot = snapshotIdentityScratchRoot(input.tmpDir);
  const taskRoot = snapshotIdentityScratchRoot(input.waveRoot);
  // Conditional spreads, not empty-string placeholders: the snapshot type
  // documents an absent root as "the host established no cleanup scope", and
  // the wall's all-or-nothing arm is only sound when absence is genuinely
  // distinguishable from a path.
  return {
    ...(scratchRoot !== undefined ? { scratchRoot } : {}),
    ...(taskRoot !== undefined ? { taskRoot } : {}),
  };
}

/** `<subagents>/<taskId>/` — new worker record + pad directory (ADR-0074). */
export function workerTaskDir(subagentsDir: string, taskId: string): string {
  return join(subagentsDir, taskId);
}

export function workerRecordPath(subagentsDir: string, taskId: string): string {
  return join(workerTaskDir(subagentsDir, taskId), `agent-${taskId}.jsonl`);
}

export function workerMetaPath(subagentsDir: string, taskId: string): string {
  return join(workerTaskDir(subagentsDir, taskId), `agent-${taskId}.meta.json`);
}

export function workerFenceTmpPath(
  subagentsDir: string,
  taskId: string
): string {
  return join(
    workerTaskDir(subagentsDir, taskId),
    MAIN_SESSION_FENCE_TMP_DIR_NAME
  );
}

/** `<subagents>/<taskId>/stderr.log` — crash diagnostics for a new-layout worker. */
export function workerStderrPath(subagentsDir: string, taskId: string): string {
  return join(workerTaskDir(subagentsDir, taskId), "stderr.log");
}

/**
 * Worker transcript location: `<subagents>/<taskId>/<taskId>.jsonl`. Same
 *
 // (ADR-0102)
 * directory as the per-agent trace (`agent-<taskId>.jsonl`) but a different
 * file. The name deliberately omits the `agent-` prefix so that
 * `listSubagentRecordPaths`' trace glob (`agent-*.jsonl`) never pulls the
 * transcript into the trace listing — transcript and trace stay separate.
 */
export function workerTranscriptPath(
  subagentsDir: string,
  taskId: string
): string {
  return join(workerTaskDir(subagentsDir, taskId), `${taskId}.jsonl`);
}

/** Pad sibling of a worker record file (`…/<taskId>/fence-tmp`). */
export function workerFenceTmpBesideRecord(traceFilePath: string): string {
  return join(dirname(traceFilePath), MAIN_SESSION_FENCE_TMP_DIR_NAME);
}

/** Create `subagents/<taskId>/` and its fence-tmp pad; return record + pad + transcript paths. */
export function ensureWorkerSessionLayout(
  subagentsDir: string,
  taskId: string
): {
  readonly taskDir: string;
  readonly recordPath: string;
  readonly pad: string;
  readonly transcriptPath: string;
} {
  const taskDir = workerTaskDir(subagentsDir, taskId);
  const pad = workerFenceTmpPath(subagentsDir, taskId);
  mkdirSync(pad, { recursive: true });
  return {
    taskDir,
    recordPath: workerRecordPath(subagentsDir, taskId),
    pad,
    transcriptPath: workerTranscriptPath(subagentsDir, taskId),
  };
}

/** Prefer the new layout, then fall back to a leftover flat `subagents/agent-<taskId>.jsonl`. */
export function resolveExistingSubagentRecordPath(
  subagentsDir: string,
  taskId: string
): string | undefined {
  const nested = workerRecordPath(subagentsDir, taskId);
  if (existsSync(nested)) return nested;
  const flat = join(subagentsDir, `agent-${taskId}.jsonl`);
  if (existsSync(flat)) return flat;
  return undefined;
}

/** readdir of `subagents/` failed for a reason other than missing directory. */
export class SubagentRecordListError extends Error {
  override readonly name = "SubagentRecordListError";
  readonly code: string;
  constructor(subagentsDir: string, cause: NodeJS.ErrnoException) {
    super(
      `listSubagentRecordPaths: cannot read '${subagentsDir}' (${cause.code ?? "UNKNOWN"})`
    );
    this.code = cause.code ?? "UNKNOWN";
  }
}

/**
 * Lists leftover flat `agent-*.jsonl` plus nested
 * `subagents/<taskId>/agent-<taskId>.jsonl`. Does not migrate files.
 */
export function listSubagentRecordPaths(subagentsDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(subagentsDir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      // EXIT: no subagents dir yet — list is empty, not a listing failure
      return [];
    }
    throw new SubagentRecordListError(subagentsDir, err);
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /^agent-.+\.jsonl$/.test(entry.name)) {
      out.push(join(subagentsDir, entry.name));
      continue;
    }
    if (!entry.isDirectory() || entry.name === "stderr") continue;
    const nested = join(subagentsDir, entry.name, `agent-${entry.name}.jsonl`);
    if (existsSync(nested)) out.push(nested);
  }
  return out;
}
