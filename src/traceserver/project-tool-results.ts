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
 * 一条投影后的 tool_result，带**全文**。
 *
 * 与 `ToolResultProjection` 分成两个类型是为了把两件不同的事说清楚：本类型是
 * 「读侧对一次工具输出的完整重建」（`get_record` 的窗按它寻址），那个类型是行轴
 * 给调用方看的一页摘要（`preview` 受 `TOOL_RESULT_PREVIEW_CAP` 管）。顺序、去重、
 * 同 id 合并只在这里实现一次。
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
   * 主会话 trace 文件绝对路径。T3 (SC7, plans/session-folder-consolidation.md /
   * ADR-0071 Decision 4) 起 `traceDir` 退役:blob 目录 = `dirname(traceFilePath) +
   * "/blobs"`,与 `<baseDir>/projects/<slug>/<convId>/blobs` 同源派生
   * (JsonlTraceService 在 blob 模式下的默认写盘位置)。传 `traceFilePath` 即隐含
   * 接受该 blob 路径;读侧禁止 `traceDir` 单独存在 —— 仅文件路径足以承载 blob
   * 解析的全部信息。
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
        if (!isRecord(message) || !("sha" in message)) return message;
        const reference = asBlobReference(message);
        const readBlob =
          options.readBlob ??
          (options.traceFilePath === undefined
            ? undefined
            : (sha: string) =>
                readFileSync(
                  join(dirname(options.traceFilePath!), "blobs", sha)
                ));
        if (readBlob === undefined)
          throw new Error(
            "traceFilePath is required to dereference blob references"
          );
        const raw = await readBlob(reference.sha);
        const serialized =
          typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        return JSON.parse(serialized) as unknown;
      })
    );
  } catch {
    // EXIT: a missing/corrupt blob must not throw into the caller turn.
    return [];
  }
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
