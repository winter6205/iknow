import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TOOL_RESULT_PREVIEW_CAP = 400;
const TRUNCATION_MARKER = "...[truncated]";

export interface ToolResultProjection {
  readonly tool_use_id: string;
  readonly name?: string;
  readonly is_error: boolean;
  readonly chars: number;
  readonly preview: string;
}

export interface BlobReference {
  readonly sha: string;
  readonly bytes: number;
}

export type ReadBlob = (
  sha: string
) => string | Uint8Array | Promise<string | Uint8Array>;

export interface TraceMessageDereferenceOptions {
  readonly traceDir?: string;
  readonly readBlob?: ReadBlob;
}

/**
 * Project tool results from already-dereferenced Anthropic messages.
 *
 * The result blocks remain the source of ordering and output cardinality.
 * Assistant tool_use blocks supply the optional tool name by tool_use_id.
 */
export function projectToolResults(
  messages: ReadonlyArray<unknown>
): readonly ToolResultProjection[] {
  const namesById = collectToolNames(messages);
  const resultsById = new Map<
    string,
    { readonly name?: string; text: string; isError: boolean }
  >();
  const order: string[] = [];

  for (const message of messages) {
    const content = contentBlocks(message);
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
      chars: result.text.length,
      preview: truncatePreview(result.text),
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
          (options.traceDir === undefined
            ? undefined
            : (sha: string) =>
                readFileSync(join(options.traceDir!, "blobs", sha)));
        if (readBlob === undefined) throw new Error("traceDir is required");
        const raw = await readBlob(reference.sha);
        const serialized =
          typeof raw === "string"
            ? raw
            : Buffer.from(raw).toString("utf8");
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
    if (!isRecord(message) || message.role !== "assistant") continue;
    for (const block of contentBlocks(message)) {
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

function contentBlocks(message: unknown): ReadonlyArray<unknown> {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
