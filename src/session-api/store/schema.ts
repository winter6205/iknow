/**
 * SessionFileV1 schema (022 spec L183-192) + sanitize (#120 T1).
 *
 * Why a separate validator: JSON.parse success != schema success. parse_failed
 * is for malformed JSON; schema_invalid is for well-formed but wrong-shape
 * data. Hub maps these to different wire kinds (422 + 422, but distinct).
 *
 * #120 adds: schemaVersion range check (≤ CURRENT accepted → sanitize, >
 * CURRENT rejected); sanitizeSessionFile (pure, backfills summary/cwd/sanitized_at
 * for v1 inputs and validates message element shape); extractSummary (first
 * user message's first text block, trimmed, truncated to 80 chars).
 */
import type { AnthropicNativeMessage } from "../../harness/index.js";

/** Session file shape (#120 schema v2). Loaders sanitize legacy v1 files. */
export interface SessionFileV1 {
  readonly schemaVersion: number;
  readonly conversation_id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly jsonMode: boolean;
  readonly turnCount: number;
  readonly updatedAt: string;
  /** v2: first user message text, trimmed, truncated to 80 chars. */
  readonly summary: string;
  /** v2: working directory the session was created in. */
  readonly cwd: string;
  /** v2: ISO timestamp of when sanitize last normalized this file. */
  readonly sanitized_at: string;
}

export const CURRENT_SCHEMA_VERSION = 2 as const;

/**
 * Validate parsed JSON against the session-file shape.
 * schemaVersion uses a range check (≤ CURRENT accepted → sanitize, > CURRENT
 * rejected) so old files load and future files fail loudly (#120 Boundaries).
 * Returns the failed field name, or null when valid.
 */
export function validateSessionFile(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return "root";
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj["schemaVersion"] !== "number" ||
    obj["schemaVersion"] > CURRENT_SCHEMA_VERSION
  ) {
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

/**
 * Extract a one-line summary: the first text block of the first user message
 * that has one, trimmed then truncated to 80 chars. Markdown is NOT stripped —
 * the storage layer stays format-agnostic. "" if no user message has a text
 * block (skips pure tool_result user messages).
 */
export function extractSummary(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const firstText = msg.content.find((b) => b.type === "text");
    if (firstText && firstText.type === "text") {
      return firstText.text.trim().slice(0, 80);
    }
  }
  return "";
}

/**
 * Sanitize a parsed session file of any ≤ CURRENT version into the current shape.
 *
 * Pure, no IO, no reads, no writes — load-time normalize.
 *
 * Reject-first: schemaVersion > CURRENT fails immediately, never entering the
 * field-preservation branch (so unknown future-version fields can not leak
 * past a too-new schema check).
 *
 * Backfills v2 fields (summary/cwd/sanitized_at) for v1 inputs; preserves
 * unknown top-level fields on ≤ CURRENT files so future versions round-trip
 * (#120 Boundaries Never: future fields must be preserved, not dropped).
 *
 * Throws { kind: "schema_invalid", field } (matches session-store.ts:49-53
 * `satisfies SessionStoreError` style — structured object literal, not a bare
 * Error) so the caller can attach `conversation_id` and rethrow a full
 * SessionStoreError.
 *
 * Why sanitize never repairs `messages`: authoritative history is immutable
 * (#120 Boundaries Never). A malformed message element is a hard reject.
 */
export function sanitizeSessionFile(raw: unknown): SessionFileV1 {
  const field = validateSessionFile(raw);
  if (field !== null) throw invalid(field);
  const obj = raw as Record<string, unknown>;
  const messagesRaw = obj["messages"] as ReadonlyArray<unknown>;
  if (!isValidMessagesList(messagesRaw)) throw invalid("messages");
  const messages = messagesRaw as ReadonlyArray<AnthropicNativeMessage>;
  return {
    ...obj,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    summary:
      typeof obj["summary"] === "string"
        ? obj["summary"]
        : extractSummary(messages),
    cwd: typeof obj["cwd"] === "string" ? obj["cwd"] : "",
    sanitized_at:
      typeof obj["sanitized_at"] === "string"
        ? obj["sanitized_at"]
        : (obj["updatedAt"] as string),
  } as SessionFileV1;
}

// -- module-level helpers ----------------------------------------------------

/**
 * Structured `schema_invalid` throw payload (subset of SessionStoreError —
 * the `conversation_id` is filled by the caller from the load path, since
 * sanitize is a pure function on the raw object and doesn't carry store state).
 */
function invalid(field: string): { kind: "schema_invalid"; field: string } {
  return { kind: "schema_invalid", field };
}

/** Deep-validate every element of `messages` (role ∈ {user, assistant}; each
 *  content block matches an AnthropicContentBlock shape). Returns true on OK. */
function isValidMessagesList(messages: ReadonlyArray<unknown>): boolean {
  for (const m of messages) {
    if (!isValidMessage(m)) return false;
  }
  return true;
}

function isValidMessage(m: unknown): boolean {
  if (m === null || typeof m !== "object") return false;
  const msg = m as Record<string, unknown>;
  if (msg["role"] !== "user" && msg["role"] !== "assistant") return false;
  if (!Array.isArray(msg["content"])) return false;
  return (msg["content"] as ReadonlyArray<unknown>).every(isValidContentBlock);
}

function isValidContentBlock(b: unknown): boolean {
  if (b === null || typeof b !== "object") return false;
  const block = b as Record<string, unknown>;
  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string";
    case "tool_use":
      return (
        typeof block["id"] === "string" &&
        typeof block["name"] === "string" &&
        "input" in block
      );
    case "tool_result":
      return typeof block["tool_use_id"] === "string" && "content" in block;
    // thinking / redacted_thinking：harness 权威消息可含（#151 thinking
    // 启用后 anthropic-adapter 原样保留）；形状对齐 AnthropicContentBlock。
    // T1: harness retains thinking blocks (with signature) in the
    // authoritative history. The session store must accept them on save
    // and replay them verbatim — otherwise the wire thinking view has
    // nothing to project after a real thinking turn.
    case "thinking":
      return (
        typeof block["thinking"] === "string" &&
        typeof block["signature"] === "string"
      );
    case "redacted_thinking":
      // `data` is the encrypted blob — kept verbatim so replays stay byte-
      // identical with the LLM-emitted history (mirror of `thinking`).
      return typeof block["data"] === "string";
    default:
      return false;
  }
}
