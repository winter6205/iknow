/**
 * Fixed-window sliding chunker (graphrag-memory stage 1).
 *
 * Splits `text` into fixed-size chunks with `overlap` character overlap.
 * Stage 1 deliberately has NO sentence/paragraph awareness (spec assumption #4):
 * chunking operates on raw character positions, never rebalancing at
 * whitespace or punctuation. The trade-off is some chunks may cut mid-word,
 * but it keeps the chunker deterministic and trivially testable — a
 * prerequisite before considering sentence-aware splitters in later stages.
 *
 * Token estimation: ≈ 4 chars/token for English. Default chunkSize=2048 chars
 * (≈ 512 tokens), overlap=256 chars (≈ 64 tokens). These match the embedder's
 * context budget (text-embedding-3-small accepts up to 8192 tokens).
 *
 * Pure function — no I/O, no side effects.
 */

/** A single chunk of the input text plus its 0-based sequence index. */
export interface TextChunk {
  text: string;
  index: number;
}

/** Default chunk size in characters (≈ 512 tokens for English text). */
export const DEFAULT_CHUNK_SIZE = 2048;

/** Default overlap in characters (≈ 64 tokens for English text). */
export const DEFAULT_CHUNK_OVERLAP = 256;

/**
 * Chunk `text` into overlapping windows.
 *
 * Step = chunkSize - overlap. The invariant overlap < chunkSize (i.e. step > 0)
 * is required to make progress; violating it throws — an infinite-loop guard.
 *
 * The final chunk may be shorter than `chunkSize` (a partial tail); it is
 * always emitted rather than discarded.
 *
 * @param text      Input text. Empty string → empty array.
 * @param chunkSize Window size in characters (default 2048). Must be > 0.
 * @param overlap   Trailing overlap in characters (default 256). Must satisfy 0 ≤ overlap < chunkSize.
 */
export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_CHUNK_OVERLAP
): TextChunk[] {
  if (chunkSize <= 0) {
    throw new RangeError(`chunkText: chunkSize must be > 0 (got ${chunkSize})`);
  }
  if (overlap < 0 || overlap >= chunkSize) {
    throw new RangeError(
      `chunkText: overlap must satisfy 0 <= overlap < chunkSize (got overlap=${overlap}, chunkSize=${chunkSize})`
    );
  }

  if (text.length === 0) {
    return [];
  }

  const step = chunkSize - overlap;
  const chunks: TextChunk[] = [];
  let index = 0;

  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push({ text: text.slice(start, end), index });
    index++;
    // If we hit the end exactly, no further chunk is needed.
    if (end === text.length) {
      break;
    }
  }

  return chunks;
}
