// Full re-estimate from characters x 4/3 padding; pure function, no lastUsage.
// Imports use .js extensions to match the existing src/ convention (e.g.
// model-adapter/types.ts -> ../stream.js); under NodeNext +
// verbatimModuleSyntax without allowImportingTsExtensions this is required.
import {
  TOKEN_ESTIMATION_PADDING,
  VISION_IMAGE_TOKEN_CEILING,
} from "./constant.js";
import { estimateImageTokensFromBase64 } from "./image-tokens.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../model-adapter/types.js";

const FALLBACK_CONTENT_ESTIMATE_TOKENS = 1;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

function isTextContentBlock(
  value: unknown
): value is { readonly type: "text"; readonly text: string } {
  if (typeof value !== "object" || value === null) return false;
  const block = value as { readonly type?: unknown; readonly text?: unknown };
  return block.type === "text" && typeof block.text === "string";
}

function isImageContentBlock(
  value: unknown
): value is { readonly type: "image"; readonly source?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  return (value as { readonly type?: unknown }).type === "image";
}

function estimateToolResultContent(content: unknown): number {
  if (content === undefined || content === "") return 0;
  if (typeof content === "string") return estimateTokens(content);

  try {
    if (Array.isArray(content)) {
      if (content.length === 0) return 0;
      let total = 0;
      for (const block of content) {
        if (isTextContentBlock(block)) {
          total += estimateTokens(block.text);
        } else if (isImageContentBlock(block)) {
          total += estimateImageTokens(block.source);
        } else {
          total += FALLBACK_CONTENT_ESTIMATE_TOKENS;
        }
      }
      return total;
    }
  } catch {
    // EXIT: malformed content must not abort compact-trigger evaluation.
    return FALLBACK_CONTENT_ESTIMATE_TOKENS;
  }

  // EXIT: preserve a bounded, non-zero estimate for legacy scalar/object shapes.
  return FALLBACK_CONTENT_ESTIMATE_TOKENS;
}

/** A top-level or nested image: pixels, not text. `image-tokens.ts` reads the
 *  header dimensions from a bounded base64 prefix. The danger this arm exists
 *  to remove is a block reading as FREE (an unlisted type contributes 0
 *  without ever throwing, which would under-report occupancy to autocompact
 *  for the rest of the session). A payload without a readable header keeps the
 *  ceiling for the same reason: this function has no throw path. */
function estimateImageTokens(source: unknown): number {
  const data =
    typeof source === "object" && source !== null
      ? (source as { readonly data?: unknown }).data
      : undefined;
  if (typeof data !== "string" || data.length === 0) {
    return VISION_IMAGE_TOKEN_CEILING;
  }
  return estimateImageTokensFromBase64(data);
}

type ThinkingContentBlock = Extract<
  AnthropicContentBlock,
  { type: "thinking" | "redacted_thinking" }
>;

/** Thinking is excluded from the history copy and summary tail unless the
 *  caller opts in; the outbound projection's no-anchor path does, because the
 *  provider replays signed thinking. */
function estimateThinkingTokens(
  block: ThinkingContentBlock,
  countThinking: boolean
): number {
  if (!countThinking) return 0;
  return block.type === "thinking"
    ? estimateTokens(block.thinking)
    : estimateTokens(block.data);
}

export interface EstimateMessagesOptions {
  /** Count `thinking` / `redacted_thinking` blocks. Default false: this
   *  estimator sizes the history copy and the summary tail, where thinking is
   *  not part of the input. The outbound projection's no-anchor path opts in
   *  because the provider replays signed thinking. */
  readonly countThinking?: boolean;
}

export function estimateMessagesTokens(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  options: EstimateMessagesOptions = {}
): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += estimateTokens(block.text);
          break;
        case "tool_use":
          total +=
            estimateTokens(block.name) +
            estimateTokens(JSON.stringify(block.input));
          break;
        case "tool_result":
          total += estimateToolResultContent(block.content);
          break;
        case "image":
          total += estimateImageTokens(block.source);
          break;
        case "thinking":
        case "redacted_thinking":
          total += estimateThinkingTokens(
            block,
            options.countThinking === true
          );
          break;
      }
    }
  }
  return Math.ceil(total * TOKEN_ESTIMATION_PADDING);
}
