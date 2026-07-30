/**
 * SessionFileV1 schema (022 spec L183-192) + validation helper.
 *
 * Why a separate validator: JSON.parse success != schema success. parse_failed
 * is for malformed JSON; schema_invalid is for well-formed but wrong-shape
 * data. Hub maps these to different wire kinds (422 + 422, but distinct).
 */
import type { AnthropicNativeMessage } from "../../harness/index.js";

/** 022 Q2-G1: 单会话 JSON 文件 schema。文件路径 = data/sessions/<conversation_id>.json。 */
export interface SessionFileV1 {
  readonly schemaVersion: 1;
  readonly conversation_id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly jsonMode: boolean;
  readonly turnCount: number;
  readonly updatedAt: string;
}

/** Schema version this store understands. New versions require a new branch. */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * Validate parsed JSON against SessionFileV1 shape.
 * Returns the field name that failed; caller throws `{ kind: "schema_invalid", field }`.
 *
 * Returns null when valid.
 */
export function validateSessionFile(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return "root";
  }
  const obj = value as Record<string, unknown>;
  if (obj["schemaVersion"] !== CURRENT_SCHEMA_VERSION) {
    return "schemaVersion";
  }
  if (typeof obj["conversation_id"] !== "string") {
    return "conversation_id";
  }
  if (!Array.isArray(obj["messages"])) {
    return "messages";
  }
  if (typeof obj["jsonMode"] !== "boolean") {
    return "jsonMode";
  }
  if (typeof obj["turnCount"] !== "number") {
    return "turnCount";
  }
  if (typeof obj["updatedAt"] !== "string") {
    return "updatedAt";
  }
  return null;
}

/** Type guard companion to validateSessionFile for callers that want a boolean. */
export function isSessionFileV1(value: unknown): value is SessionFileV1 {
  return validateSessionFile(value) === null;
}
