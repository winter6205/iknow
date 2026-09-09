import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
