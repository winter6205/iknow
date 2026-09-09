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
