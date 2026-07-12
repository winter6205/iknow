import { createHash } from "node:crypto";
import type { EmbeddingClient } from "./types.js";
import { l2normalize } from "./math.js";

/** Deterministic unit-length vectors for offline tests (no network). */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly dims: number;

  constructor(dims = 32) {
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      v[0] = 1;
      return v;
    }
    for (const tok of tokens) {
      const h = createHash("sha256").update(tok).digest();
      for (let i = 0; i < this.dims; i++) {
        const b = h[i % h.length]!;
        v[i]! += (b / 255) * 2 - 1;
      }
    }
    return l2normalize(v);
  }
}
