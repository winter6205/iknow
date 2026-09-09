import { existsSync, mkdirSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeConversationSegment } from "../session-roots.js";
import { MAIN_SESSION_FENCE_TMP_DIR_NAME } from "../../shared/session-tree-names.js";

/** Host path of the main-session fence `/tmp` pad under a session folder. */
export function mainSessionFenceTmpPath(sessionFolder: string): string {
  return join(sessionFolder, MAIN_SESSION_FENCE_TMP_DIR_NAME);
}

/** Create (if needed) and return the main-session fence `/tmp` pad. */
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
 * Current-identity fence `/tmp` pad: explicit `tmpDir`, else
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

/** `<subagents>/<taskId>/stderr.log` — new-worker crash diagnostics (SC7). */
export function workerStderrPath(subagentsDir: string, taskId: string): string {
  return join(workerTaskDir(subagentsDir, taskId), "stderr.log");
}

/** Pad sibling of a worker record file (`…/<taskId>/fence-tmp`). */
export function workerFenceTmpBesideRecord(traceFilePath: string): string {
  return join(dirname(traceFilePath), MAIN_SESSION_FENCE_TMP_DIR_NAME);
}

/** Create `subagents/<taskId>/` and its fence-tmp pad; return record + pad paths. */
export function ensureWorkerSessionLayout(
  subagentsDir: string,
  taskId: string
): {
  readonly taskDir: string;
  readonly recordPath: string;
  readonly pad: string;
} {
  const taskDir = workerTaskDir(subagentsDir, taskId);
  const pad = workerFenceTmpPath(subagentsDir, taskId);
  mkdirSync(pad, { recursive: true });
  return {
    taskDir,
    recordPath: workerRecordPath(subagentsDir, taskId),
    pad,
  };
}

/**
 * SC8: new layout first, then leftover flat `subagents/agent-<taskId>.jsonl`.
 */
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

/**
 * SC8 list: leftover flat `agent-*.jsonl` plus nested
 * `subagents/<taskId>/agent-<taskId>.jsonl`. Does not migrate files.
 */
export function listSubagentRecordPaths(subagentsDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
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
