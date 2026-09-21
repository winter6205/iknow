import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOOL_RESULT_PREVIEW_CAP = 400;
const TRUNCATION_MARKER = "...[truncated]";

export interface ToolResultProjection {
  readonly tool_use_id: string;
  readonly name?: string;
  readonly is_error: boolean;
  readonly chars: number;
  readonly preview: string;
}

/**
 * One projected tool_result with the **full text**.
 *
 * Split from `ToolResultProjection` on purpose to say two different things:
 * this type is "the read side's complete reconstruction of one tool output"
 * (`get_record`'s window addresses against it); that type is the row axis's
 * one-page summary for callers (`preview` governed by
 * `TOOL_RESULT_PREVIEW_CAP`). Ordering, dedup, and same-id merging are
 * implemented once, here.
 */
export interface ProjectedToolResult {
  readonly tool_use_id: string;
  readonly name?: string;
  readonly is_error: boolean;
  readonly text: string;
}

export interface BlobReference {
  readonly sha: string;
  readonly bytes: number;
}

/**
 * Per ADR-0003, LLM-call `messages[].role` lives in the four-value domain
 * `user | assistant | tool | system`. This module exposes the union as
 * documentation; the runtime narrowing stays as loose as `typeof string` so
 * any future or cross-vendor role string passes through unchanged. Returning
 * `string | undefined` (not the narrower union) preserves the pre-helper
 * behavior at every call site: a non-record or a record whose `role` is not a
 * string maps to `undefined`, and any other string -- including ones outside
 * the four-value domain -- is returned verbatim so a future legal role does
 * not silently turn into "no role".
 */
export type MessageRole = "user" | "assistant" | "tool" | "system";

export function messageRole(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return typeof message.role === "string" ? message.role : undefined;
}

export type ReadBlob = (
  sha: string
) => string | Uint8Array | Promise<string | Uint8Array>;

export interface TraceMessageDereferenceOptions {
  /**
   * Absolute path of the main session's trace file. Since ADR-0071
   * `traceDir` is retired: blob directory = `dirname(traceFilePath) +
   * "/blobs"`, derived from the same source as
   * `<baseDir>/projects/<slug>/<convId>/blobs` (JsonlTraceService's default
   * write location in blob mode). Passing `traceFilePath` implicitly accepts
   * that blob path; a standalone `traceDir` is forbidden on the read side —
   * the file path alone carries all information needed for blob resolution.
   */
  readonly traceFilePath?: string;
  readonly readBlob?: ReadBlob;
}

/**
 * The list-axis summary of one record's tool results: `chars` is the result's
 * real length, `preview` its capped head. Full text is not part of this shape —
 * `collectToolResults` below is what `get_record` windows into.
 */
export function projectToolResults(
  messages: ReadonlyArray<unknown>
): readonly ToolResultProjection[] {
  return collectToolResults(messages).map((result) => ({
    tool_use_id: result.tool_use_id,
    ...(result.name === undefined ? {} : { name: result.name }),
    is_error: result.is_error,
    chars: result.text.length,
    preview: truncatePreview(result.text),
  }));
}

/**
 * Project tool results from already-dereferenced Anthropic messages, keeping
 * each result's full text.
 *
 * The result blocks remain the source of ordering and output cardinality.
 * Assistant tool_use blocks supply the optional tool name by tool_use_id.
 * Repeated blocks for one id concatenate in encounter order and OR their
 * `is_error`, so one `tool_use_id` stays one addressable part.
 */
export function collectToolResults(
  messages: ReadonlyArray<unknown>
): readonly ProjectedToolResult[] {
  const namesById = collectToolNames(messages);
  const resultsById = new Map<
    string,
    { readonly name?: string; text: string; isError: boolean }
  >();
  const order: string[] = [];

  for (const message of messages) {
    const content = messageContentBlocks(message);
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      if (typeof block.tool_use_id !== "string") continue;

      const id = block.tool_use_id;
      const text = toolResultText(block.content);
      const previous = resultsById.get(id);
      if (previous === undefined) {
        order.push(id);
        resultsById.set(id, {
          ...(namesById.has(id) ? { name: namesById.get(id) } : {}),
          text,
          isError: block.is_error === true,
        });
      } else {
        resultsById.set(id, {
          ...(previous.name === undefined ? {} : { name: previous.name }),
          text: previous.text + text,
          isError: previous.isError || block.is_error === true,
        });
      }
    }
  }

  return order.map((toolUseId) => {
    const result = resultsById.get(toolUseId)!;
    return {
      tool_use_id: toolUseId,
      ...(result.name === undefined ? {} : { name: result.name }),
      is_error: result.isError,
      text: result.text,
    };
  });
}

/**
 * Resolve `{sha, bytes}` message elements and then apply the pure projector.
 * A failed dereference fails closed for the whole projection.
 */
export async function projectToolResultsFromTrace(
  messages: ReadonlyArray<unknown>,
  options: TraceMessageDereferenceOptions = {}
): Promise<readonly ToolResultProjection[]> {
  const dereferenced = await dereferenceTraceMessages(messages, options);
  return projectToolResults(dereferenced);
}

export async function dereferenceTraceMessages(
  messages: ReadonlyArray<unknown>,
  options: TraceMessageDereferenceOptions = {}
): Promise<ReadonlyArray<unknown>> {
  try {
    return await Promise.all(
      messages.map(async (message) => {
        // Two valid blob-ref shapes coexist:
        //   (a) whole-message ref (the historical full-message replacement,
        //         legacy fixture residue):
        //         { sha, bytes }  — the whole message stored as one blob
        //   (b) content-level ref:
        //         { role, content: { sha, bytes } }  — role inline, content in a blob
        // The deref point descends into (b)'s `content` so the post-derf shape
        // matches the inline form: `{role, content}` where `content` is a
        // string (kind="str") or array (kind="blocks"). Whole-message (a) keeps
        // its historical escape-hatch behavior — JSON.parse the blob and
        // return as-is — so legacy fixtures stay readable.
        if (!isRecord(message)) return message;
        if (isContentBlobReference(message)) {
          const inner = await readBlobContent(message.content, options);
          return { role: message.role, content: inner };
        }
        if (!("sha" in message)) return message;
        const reference = asBlobReference(message);
        const inner = await readBlobPayload(reference.sha, options);
        return inner;
      })
    );
  } catch {
    // EXIT: a missing/corrupt blob must not throw into the caller turn.
    return [];
  }
}

/**
 * `content` field shaped `{ sha, bytes }` — the message is a content-level
 * ref, the surrounding `role` is inline. Detected by **field shape**, not by
 * `("sha" in message)` (which would also fire on whole-message refs and skip
 * the role).
 */
function isContentBlobReference(
  message: Record<string, unknown>
): message is { role: unknown; content: { sha: string; bytes: number } } {
  return isRecord(message.content) && isRecordContentRef(message.content);
}

function isRecordContentRef(value: unknown): value is {
  sha: string;
  bytes: number;
} {
  return (
    isRecord(value) &&
    "sha" in value &&
    "bytes" in value &&
    !("role" in value) &&
    !("content" in value)
  );
}

/**
 * ADR-0116: resolve one llm_call row's `system` field — a `{sha, bytes}` ref
 * (kind="str") into the same content-addressed pool messages use — to the
 * full text this step sent. Absent / missing / corrupt / wrong-shape all
 * resolve to `undefined` (Postel on the read side: "no system body here",
 * never a throw and never an empty-string fake).
 */
export async function dereferenceSystemBody(
  system: unknown,
  options: TraceMessageDereferenceOptions = {}
): Promise<string | undefined> {
  if (!isRecord(system) || !isRecordContentRef(system)) return undefined;
  try {
    const payload = await readBlobPayload(system.sha, options);
    if (
      isRecord(payload) &&
      payload.kind === "str" &&
      typeof payload.v === "string"
    ) {
      return payload.v;
    }
    return undefined;
  } catch {
    // EXIT: a missing/corrupt blob means the body is unreadable here — the
    // caller treats it exactly like an absent system field.
    return undefined;
  }
}

async function readBlobContent(
  ref: { sha: string; bytes: number },
  options: TraceMessageDereferenceOptions
): Promise<unknown> {
  // Writer's toBlobReferences shape: {kind:"str"|"blocks", v: content}.
  // Reader restores both: kind="str" → string; kind="blocks" → array (v as-is).
  // Corrupt / missing / shape-mismatch → throw to the outer try/catch,
  // degrading to an empty array.
  const payload = await readBlobPayload(ref.sha, options);
  if (
    isRecord(payload) &&
    (payload.kind === "str" || payload.kind === "blocks")
  ) {
    return payload.v;
  }
  // Not the content-level shape — possibly a whole-message ref mis-routed
  // here; return the JSON.parsed payload as-is.
  return payload;
}

async function readBlobPayload(
  sha: string,
  options: TraceMessageDereferenceOptions
): Promise<unknown> {
  const readBlob =
    options.readBlob ??
    (options.traceFilePath === undefined
      ? undefined
      : (shaToRead: string) =>
          readFileSync(
            join(dirname(options.traceFilePath!), "blobs", shaToRead)
          ));
  if (readBlob === undefined)
    throw new Error("traceFilePath is required to dereference blob references");
  const raw = await readBlob(sha);
  const serialized =
    typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  return JSON.parse(serialized) as unknown;
}

function collectToolNames(
  messages: ReadonlyArray<unknown>
): ReadonlyMap<string, string> {
  const namesById = new Map<string, string>();
  for (const message of messages) {
    if (messageRole(message) !== "assistant") continue;
    for (const block of messageContentBlocks(message)) {
      if (
        isRecord(block) &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        !namesById.has(block.id)
      ) {
        namesById.set(block.id, block.name);
      }
    }
  }
  return namesById;
}

/**
 * The content parts of one message: an array `content` verbatim, a bare-string
 * `content` as exactly one part (both forms occur on the write side), anything
 * else as none.
 *
 * Shared with `get_record`, which addresses these parts by `part_index`, so
 * "what parts does this message have" has one definition. The tool-result
 * projection is unaffected by the string case: a string block matches neither
 * `tool_use` nor `tool_result`.
 */
export function messageContentBlocks(message: unknown): ReadonlyArray<unknown> {
  if (!isRecord(message)) return [];
  if (typeof message.content === "string") return [message.content];
  if (!Array.isArray(message.content)) return [];
  return message.content;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { readonly type: "text"; readonly text: string } =>
          isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string"
      )
      .map((block) => block.text)
      .join(" ");
  }
  if (content === undefined) return "";
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return String(content);
  }
}

function truncatePreview(text: string): string {
  if (text.length <= TOOL_RESULT_PREVIEW_CAP) return text;
  return (
    text.slice(0, TOOL_RESULT_PREVIEW_CAP - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

function asBlobReference(value: Record<string, unknown>): BlobReference {
  if (
    typeof value.sha !== "string" ||
    value.sha.length === 0 ||
    value.sha.includes("/") ||
    value.sha.includes("\\") ||
    typeof value.bytes !== "number" ||
    !Number.isFinite(value.bytes) ||
    value.bytes < 0
  ) {
    throw new Error("invalid trace blob reference");
  }
  return { sha: value.sha, bytes: value.bytes };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
