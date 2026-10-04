import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isTraceBodyRepresentation,
  isTraceBodySha,
} from "../shared/trace-body-contract.js";
import { BLOBS_DIR_NAME } from "../shared/session-tree-names.js";

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

/**
 * The dereferenced messages plus whether any referenced body was refused or
 * unreadable. `messages: []` alone cannot say which happened: a record with no
 * messages and a record whose bodies are not readable look identical to a
 * caller, and the spec requires the second to read as visibly incomplete rather
 * than as full input evidence.
 */
export interface DereferencedTraceMessages {
  readonly messages: ReadonlyArray<unknown>;
  readonly evidenceGap: boolean;
}

export async function dereferenceTraceMessages(
  messages: ReadonlyArray<unknown>,
  options: TraceMessageDereferenceOptions = {}
): Promise<ReadonlyArray<unknown>> {
  return (await dereferenceTraceMessagesWithStatus(messages, options)).messages;
}

export async function dereferenceTraceMessagesWithStatus(
  messages: ReadonlyArray<unknown>,
  options: TraceMessageDereferenceOptions = {}
): Promise<DereferencedTraceMessages> {
  try {
    return {
      messages: await Promise.all(
        messages.map((message) => dereferenceMessage(message, options))
      ),
      evidenceGap: false,
    };
  } catch {
    // EXIT: a missing/corrupt/refused body must not throw into the caller
    // turn. The fail-closed empty result stays; `evidenceGap` is what keeps it
    // from being read as "this record has no content".
    return { messages: [], evidenceGap: true };
  }
}

async function dereferenceMessage(
  message: unknown,
  options: TraceMessageDereferenceOptions
): Promise<unknown> {
  if (!isRecord(message)) return message;
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
  //
  // Detection is by field shape only; the reference is *validated* in
  // `asTraceContentRef` / `asBlobReference`. Folding the two would make an
  // unrecognizable ref fall through to "not a ref" and be answered as inline
  // content — printing the raw reference literal as the record's body.
  if (isContentBlobReference(message)) {
    const reference = asTraceContentRef(message.content);
    return {
      role: message.role,
      content: await readBlobContent(reference, options),
    };
  }
  if (!("sha" in message)) return message;
  assertTracePermittedRepresentation(message);
  const reference = asBlobReference(message);
  return readBlobPayload(reference.sha, options);
}

/**
 * `content` field shaped `{ sha, bytes }` — the message is a content-level
 * ref, the surrounding `role` is inline. Detected by **field shape**, not by
 * `("sha" in message)` (which would also fire on whole-message refs and skip
 * the role).
 */
function isContentBlobReference(message: Record<string, unknown>): message is {
  readonly role: unknown;
  readonly content: {
    readonly sha: string;
    readonly bytes: number;
    readonly representation?: unknown;
  };
} {
  return isRecord(message.content) && isRecordContentRef(message.content);
}

/**
 * The content-level ref validator: a body address the pool can actually hold,
 * plus representation authority when the ref declares one.
 *
 * The address rule is `isTraceBodySha` from `src/shared/trace-body-contract.ts`
 * — the single source, shared with the write side. It is the *whole* rule here
 * and on the whole-message path (`asBlobReference`) and on an evidence body
 * (`asTraceBodyRef`): a pool filename is a lowercase 64-hex sha256, so no `sha`
 * can walk out of `blobs/` or name a sibling of it. Only the representation
 * check below still differs per ref shape, and it only ever *adds* refusals.
 */
function asTraceContentRef(ref: {
  readonly sha: string;
  readonly bytes: number;
  readonly representation?: unknown;
}): BlobReference {
  if (
    !isTraceBodySha(ref.sha) ||
    typeof ref.bytes !== "number" ||
    !Number.isFinite(ref.bytes) ||
    ref.bytes < 0
  ) {
    throw new Error("invalid trace content reference address");
  }
  assertTracePermittedRepresentation(ref);
  return { sha: ref.sha, bytes: ref.bytes };
}

/**
 * Representation authority for a ref that declares one, on either ref shape.
 *
 * Dual acceptance is deliberate back-compat, not a gap in the gate: the untagged
 * shape is what the ADR-0036 / ADR-0071 writer emits and what every legacy
 * fixture holds, so requiring the tag would make existing traces unreadable and
 * break the plan's "preserve existing query/get-record semantics". Its cost is
 * bounded by the address gate above, which every ref shape passes first: an
 * untagged ref still cannot address anything outside `blobs/`, so it cannot
 * reach native recovery state stored in a sibling directory even though the
 * pool is shared. What dual acceptance does *not* buy is representation
 * discrimination *within* the pool, which is why a ref that does declare one
 * must be trace-permitted — a reader must not be talked into handing out raw
 * native state that happens to sit at a legal body address.
 */
function assertTracePermittedRepresentation(ref: {
  readonly representation?: unknown;
}): void {
  if (ref.representation === undefined) return;
  if (!isTraceBodyRepresentation(ref.representation)) {
    throw new Error("trace blob reference declares a non-trace representation");
  }
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
 * One governed SDK invocation's final request with every referenced body
 * resolved to text. Key names match the stored `dispatch_evidence` entry, so a
 * reader lines the resolved entry up against the references on the row; only
 * the three refs are replaced by their content.
 */
export interface ResolvedDispatchEvidence {
  readonly invocationId: string;
  readonly stream: boolean;
  readonly messages: string;
  readonly system?: string;
  readonly tools?: string;
}

/**
 * The resolved entries plus whether an entry was refused or unreadable. Same
 * honesty rule as the message channel: a reference nothing authorized must not
 * read as a complete request.
 */
export interface DereferencedDispatchEvidence {
  readonly entries: ReadonlyArray<ResolvedDispatchEvidence>;
  readonly evidenceGap: boolean;
}

/**
 * Resolve the final-request evidence of one record, entry by entry, in row
 * order. An entry is all-or-nothing: an invocation whose system instructions
 * cannot be read is dropped rather than reported as a request that carried
 * none. Absent `dispatch_evidence` is not a gap — a record that recorded no
 * governed invocation has nothing to show.
 */
export async function dereferenceDispatchEvidenceWithStatus(
  dispatchEvidence: unknown,
  options: TraceMessageDereferenceOptions = {}
): Promise<DereferencedDispatchEvidence> {
  if (dispatchEvidence === undefined) {
    return { entries: [], evidenceGap: false };
  }
  if (!Array.isArray(dispatchEvidence)) {
    return { entries: [], evidenceGap: true };
  }
  const entries: ResolvedDispatchEvidence[] = [];
  let evidenceGap = false;
  for (const raw of dispatchEvidence) {
    const entry = await dereferenceEvidenceEntry(raw, options);
    if (entry === undefined) {
      evidenceGap = true;
      continue;
    }
    entries.push(entry);
  }
  return { entries, evidenceGap };
}

async function dereferenceEvidenceEntry(
  raw: unknown,
  options: TraceMessageDereferenceOptions
): Promise<ResolvedDispatchEvidence | undefined> {
  if (!isRecord(raw) || typeof raw.invocationId !== "string") return undefined;
  const messages = await resolveEvidenceBody(raw.messages, options);
  if (messages === undefined) return undefined;
  const system = await resolveOptionalEvidenceBody(raw.system, options);
  const tools = await resolveOptionalEvidenceBody(raw.tools, options);
  if (system === undefined && raw.system !== undefined) return undefined;
  if (tools === undefined && raw.tools !== undefined) return undefined;
  return {
    invocationId: raw.invocationId,
    stream: raw.stream === true,
    messages,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
  };
}

/** A body the invocation did not carry stays absent; a body it carried but
 *  that cannot be read is a gap, and the two must not look alike. */
async function resolveOptionalEvidenceBody(
  ref: unknown,
  options: TraceMessageDereferenceOptions
): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  return resolveEvidenceBody(ref, options);
}

/**
 * The one path from an evidence ref to pool content: the same body-address gate
 * and the same representation authority the message refs pass, then the same
 * read. A refused or unreadable body yields `undefined` instead of throwing, so
 * a broken reference cannot take the caller's turn down with it.
 */
async function resolveEvidenceBody(
  value: unknown,
  options: TraceMessageDereferenceOptions
): Promise<string | undefined> {
  try {
    const reference = asTraceBodyRef(value);
    return renderTraceText(await readBlobPayload(reference.sha, options));
  } catch {
    // EXIT: a refused address, a foreign representation, a missing or corrupt
    // body, and an unparseable payload all exit the same way — `undefined`,
    // which the caller reads as "this body is not evidence". The substitute is
    // bounded: one entry is dropped and its `evidenceGap` set, never a
    // partially-resolved entry and never a throw into the caller's turn.
    return undefined;
  }
}

/**
 * The same two gates `asTraceContentRef` applies, with the representation tag
 * **required** rather than dual-accepted. Dual acceptance is right for message
 * blobs — the untagged shape is what the ADR-0036 / ADR-0071 writer emitted
 * and what every legacy fixture holds — but `writeTraceBody` stamps the tag on
 * every body it stores, so an untagged evidence reference names bytes nothing
 * authorized the reader to hand out.
 */
function asTraceBodyRef(value: unknown): BlobReference {
  if (!isRecord(value)) throw new Error("invalid dispatch evidence reference");
  if (!isTraceBodySha(value.sha)) {
    throw new Error("invalid dispatch evidence reference address");
  }
  // The message path's own authority check, then its stricter form: an evidence
  // ref must carry the tag, not merely a permitted one.
  assertTracePermittedRepresentation(value);
  if (value.representation === undefined) {
    throw new Error("dispatch evidence reference declares no representation");
  }
  return {
    sha: value.sha,
    bytes: typeof value.bytes === "number" ? value.bytes : 0,
  };
}

/**
 * The reader's single rendering rule, shared with the window arm: a bare string
 * as itself, everything else as its JSON text. One place, so a part's `chars`
 * and its windowed `text` — and a resolved request body — cannot drift apart.
 */
export function renderTraceText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function readBlobContent(
  ref: { readonly sha: string },
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

/**
 * The one place an address becomes a filesystem path, and therefore the point
 * every caller must have passed the shared address gate before reaching: `sha`
 * arrives here already known to be a lowercase 64-hex body name, so `join`'s
 * normalization cannot carry it out of `BLOBS_DIR_NAME`. The pool directory
 * name comes from `src/shared/session-tree-names.ts` so the write side, the
 * read side, and the layout documentation cannot spell it three ways.
 */
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
            join(dirname(options.traceFilePath!), BLOBS_DIR_NAME, shaToRead)
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

/**
 * The whole-message ref validator, the historical shape. Same address gate as
 * the content-level ref — `isTraceBodySha`, before any read — plus this shape's
 * own requirement that `bytes` be a real non-negative count. It used to reject
 * only `/` and `\`, which left a bare `..` or `.` free to resolve out of the
 * pool and let any non-hex name through; the uniform rule is what closes both.
 */
function asBlobReference(value: Record<string, unknown>): BlobReference {
  if (
    !isTraceBodySha(value.sha) ||
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
