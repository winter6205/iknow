/**
 * auto-memory T4: the composition seam between the harness and the memory
 * context's extraction port.
 *
 * Spec: specs/auto-memory.md D1; ADR-0031 Decision 1/2. `src/harness/memory/`
 * declares a two-line `MemoryExtractLlm` port on purpose — it must not know
 * about `ModelAdapter`, streaming, or turn state. This file is where the
 * harness's adapter is adapted to that port, and where a run's messages are
 * rendered into the transcript slice the extraction prompt mines.
 *
 * Nothing here decides whether to ingest; that gate lives in
 * `memory/auto-hook.ts`.
 */
import type { MemoryExtractLlm } from "./memory/index.js";
import type {
  AnthropicNativeMessage,
  ModelAdapter,
} from "./model-adapter/types.js";

/** Cap on the rendered transcript so one long turn cannot blow the prompt. */
export const TRANSCRIPT_CHAR_CAP = 12_000;

/** How many trailing messages the transcript slice may cover. */
export const TRANSCRIPT_MESSAGE_CAP = 40;

/**
 * Bridge a `ModelAdapter` to the extraction port: one prompt in, the
 * assistant's concatenated text out.
 *
 * The call is a bare single-turn request with no tools — extraction must not
 * be able to touch the filesystem or the network on its own.
 */
export function createAdapterExtractLlm(
  adapter: ModelAdapter
): MemoryExtractLlm {
  return {
    complete: async (prompt: string, signal?: AbortSignal): Promise<string> => {
      const turn = await adapter.step(
        {
          messages: [
            { role: "user", content: [{ type: "text", text: prompt }] },
          ],
          turnCount: 0,
        },
        {},
        signal
      );
      return turn.projection.texts.join("\n").trim();
    },
  };
}

/**
 * Render the tail of a conversation as `role: text` lines.
 *
 * Only text blocks are kept: tool calls and tool results are per-task state,
 * which ADR-0009 Decision 4 bars from the store, so feeding them to the
 * extractor would only invite candidates that must then be rejected.
 */
export function renderTranscript(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const lines: string[] = [];
  for (const message of messages.slice(-TRANSCRIPT_MESSAGE_CAP)) {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n")
      .trim();
    if (text.length === 0) continue;
    lines.push(`${message.role}: ${text}`);
  }
  const rendered = lines.join("\n\n");
  return rendered.length <= TRANSCRIPT_CHAR_CAP
    ? rendered
    : rendered.slice(-TRANSCRIPT_CHAR_CAP);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join(" ");
}

/**
 * True when this message slice contains a successful `memory_save`.
 * Hosts pass only this-turn messages so a prior save does not skip extract.
 */
export function hasSuccessfulMemorySave(
  messages: ReadonlyArray<AnthropicNativeMessage>
): boolean {
  const results = new Map<string, { readonly isError: boolean; readonly text: string }>();
  const saveIds: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.name === "memory_save") {
        saveIds.push(block.id);
      } else if (block.type === "tool_result") {
        results.set(block.tool_use_id, {
          isError: block.is_error === true,
          text: toolResultText(block.content),
        });
      }
    }
  }
  for (const id of saveIds) {
    const result = results.get(id);
    if (!result || result.isError) continue;
    if (result.text.includes("[memory_save] persisted as")) return true;
  }
  return false;
}
