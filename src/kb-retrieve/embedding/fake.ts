import { createHash } from "node:crypto";
import type { EmbeddingClient } from "./types.js";

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

export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
