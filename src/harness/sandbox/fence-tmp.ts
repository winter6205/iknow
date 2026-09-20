import { existsSync, mkdirSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeConversationSegment } from "../session-roots.js";
import { MAIN_SESSION_FENCE_TMP_DIR_NAME } from "../../shared/session-tree-names.js";

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
