/**
 * src/shared/streaming-block-freeze.ts
 *
 * 会变长的 markdown：钉住除最后一个顶层非空块以外的前缀。
 * 纯函数、无模块级可变边界；调用方（Markdown）保存 boundary。
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

/** 按 previousBoundary 只 lexer 后缀；新闭合块使边界单调前进。 */
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
