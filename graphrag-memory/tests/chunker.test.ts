import { describe, it, expect } from "vitest";
import {
  chunkText,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  type TextChunk,
} from "../src/core/chunker.js";

describe("chunkText", () => {
  it("returns an empty array for an empty input string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns a single chunk when text length < chunkSize", () => {
    // Pass overlap=0 so it satisfies overlap < chunkSize regardless of DEFAULT_CHUNK_OVERLAP.
    const text = "hello world";
    const chunks = chunkText(text, 100, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ text, index: 0 });
  });

  it("returns a single chunk when text length === chunkSize", () => {
    // chunkSize=10, text length exactly 10
    const text = "abcdefghij";
    const chunks = chunkText(text, 10, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ text, index: 0 });
  });

  it("returns multiple chunks with correct overlap when text length > chunkSize", () => {
    // chunkSize=10, overlap=3, step=7
    // text length 24 ("abcdefghijklmnopqrstuvwx") -> chunks at [0..10), [7..17), [14..24)
    // chunk 0: "abcdefghij"      (chars 0..9)
    // chunk 1: "hijklmnopq"      (chars 7..16)
    // chunk 2: "opqrstuvwx"      (chars 14..23)
    const text = "abcdefghijklmnopqrstuvwx";
    const chunks = chunkText(text, 10, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.text).toBe("abcdefghij");
    expect(chunks[1]?.text).toBe("hijklmnopq");
    expect(chunks[2]?.text).toBe("opqrstuvwx");
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[1]?.index).toBe(1);
    expect(chunks[2]?.index).toBe(2);
  });

  it("preserves Chinese (Unicode) characters correctly", () => {
    // 4 Chinese chars; chunkSize=2, overlap=0
    // chunks: "你好" (0..2), "世界" (2..4)
    const text = "你好世界";
    const chunks = chunkText(text, 2, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe("你好");
    expect(chunks[1]?.text).toBe("世界");
  });

  it("preserves Chinese characters with overlap (multi-byte boundaries handled by JS string slicing)", () => {
    // 6 Chinese chars; chunkSize=4, overlap=2, step=2
    // chunk 0: chars [0..4) = "你好世界"
    // chunk 1: chars [2..6) = "世界你好" — end === text.length, loop breaks
    const text = "你好世界你好";
    const chunks = chunkText(text, 4, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe("你好世界");
    expect(chunks[1]?.text).toBe("世界你好");
  });

  it("holds the invariant overlap < chunkSize", () => {
    // overlap === chunkSize would create an infinite loop — must throw.
    expect(() => chunkText("abcdefghij", 5, 5)).toThrow();
    expect(() => chunkText("abcdefghij", 5, 6)).toThrow();
    expect(() => chunkText("abcdefghij", 5, -1)).toThrow();
  });

  it("uses DEFAULT_CHUNK_SIZE and DEFAULT_CHUNK_OVERLAP when called with no args", () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(2048);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(256);
    // 5000 chars default should produce ceil((5000 - 2048) / (2048 - 256)) + 1 = ceil(2952/1792) + 1 = 2 + 1 = 3 chunks
    const text = "a".repeat(5000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
    }
  });

  it("emits 0-based indices in order", () => {
    const chunks = chunkText("a".repeat(50), 20, 5);
    expect(chunks.map((c: TextChunk) => c.index)).toEqual(
      chunks.map((_, i) => i)
    );
  });

  it("handles overlap = 0 (non-overlapping chunks)", () => {
    // chunkSize=5, overlap=0, text length 12 -> 3 chunks
    const text = "abcdefghijkl";
    const chunks = chunkText(text, 5, 0);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.text).toBe("abcde");
    expect(chunks[1]?.text).toBe("fghij");
    expect(chunks[2]?.text).toBe("kl");
  });

  it("reconstructs text exactly when overlap = 0 (lossless tiling)", () => {
    const text = "abcdefghijklmnop";
    const chunks = chunkText(text, 4, 0);
    const joined = chunks.map((c) => c.text).join("");
    expect(joined).toBe(text);
  });

  it("overlap region appears in two adjacent chunks", () => {
    // With overlap > 0, the last `overlap` chars of chunk N == first `overlap` chars of chunk N+1
    const text = "abcdefghijklmnopqrst";
    const chunkSize = 8;
    const overlap = 3;
    const chunks = chunkText(text, chunkSize, overlap);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = chunks[0]!.text;
    const second = chunks[1]!.text;
    expect(first.slice(-overlap)).toBe(second.slice(0, overlap));
  });
});
