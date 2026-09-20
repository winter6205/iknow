/**
 * src/shared/streaming-block-freeze.ts
 *
 * For growing markdown: freeze as a stable prefix every top-level non-empty
 * block except the last. Pure function, no module-level mutable state; the
 * caller (Markdown) stores the boundary.
 */
import { marked } from "marked";

export type StreamingFreezeSplit = {
  readonly prefixRaw: string;
  readonly tailRaw: string;
  readonly boundary: number;
};

function isNonEmptyTopLevel(type: string): boolean {
  return type !== "space" && type !== "hr";
}

/** Lex only the suffix after previousBoundary; newly closed blocks move the boundary forward monotonically. */
export function splitStreamingMarkdown(
  text: unknown,
  previousBoundary = 0
): StreamingFreezeSplit {
  if (typeof text !== "string") {
    throw new TypeError("streaming markdown text must be a string");
  }
  if (text.length === 0) {
    return { prefixRaw: "", tailRaw: "", boundary: 0 };
  }

  let start = previousBoundary;
  if (!Number.isFinite(start) || start < 0 || start > text.length) {
    start = 0; // EXIT: invalid cursor — recompute from the full string
  }

  const chunk = text.slice(start);
  const tokens = marked.lexer(chunk);
  let lastRenderable = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (isNonEmptyTopLevel(tokens[i]!.type)) {
      lastRenderable = i;
      break;
    }
  }
  if (lastRenderable <= 0) {
    return {
      prefixRaw: text.slice(0, start),
      tailRaw: chunk,
      boundary: start,
    };
  }

  let freezeEndInChunk = 0;
  for (let i = 0; i < lastRenderable; i++) {
    freezeEndInChunk += tokens[i]!.raw.length;
  }
  const boundary = start + freezeEndInChunk;
  return {
    prefixRaw: text.slice(0, boundary),
    tailRaw: text.slice(boundary),
    boundary,
  };
}
