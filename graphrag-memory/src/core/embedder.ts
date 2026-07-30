/**
 * Embedding client abstraction for graphrag-memory.
 *
 * EmbeddingClient is the interface; NineRouterEmbedder is the production impl
 * (calls 9router /v1/embeddings via Node fetch); FakeEmbedder is the test
 * double (deterministic, no network).
 *
 * Why an interface: the ingest handler depends only on the contract, which
 * lets tests inject FakeEmbedder and skips the network in CI / local dev.
 */
import { GraphragError, EMBEDDING_DIM } from "./errors.js";

/** Abstraction over any embedding provider. */
export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Production embedder: calls an OpenAI-compatible /v1/embeddings endpoint
 * over Node's built-in fetch (no SDK dependency).
 *
 * The API key is read from environment by NAME and passed in by the caller
 * (config.ts) — never stored in source. The embedder is otherwise stateless
 * except for the immutable constructor parameters.
 */
export class NineRouterEmbedder implements EmbeddingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/embeddings`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (err) {
      // Network/transport errors come back as fetch rejections in Node.
      throw new GraphragError(
        `embedding request failed: ${(err as Error).message}`,
        "EMBEDDING_FAILED"
      );
    }

    if (!response.ok) {
      throw new GraphragError(
        `embedding HTTP ${response.status}: ${response.statusText}`,
        "EMBEDDING_FAILED"
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new GraphragError(
        `embedding response JSON parse failed: ${(err as Error).message}`,
        "EMBEDDING_FAILED"
      );
    }

    const embeddings = extractEmbeddings(payload);
    if (embeddings.length !== texts.length) {
      throw new GraphragError(
        `embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`,
        "EMBEDDING_FAILED"
      );
    }

    for (let i = 0; i < embeddings.length; i += 1) {
      const vec = embeddings[i];
      if (!vec || vec.length !== EMBEDDING_DIM) {
        throw new GraphragError(
          `embedding dim mismatch at index ${i}: expected ${EMBEDDING_DIM}, got ${vec?.length ?? 0}`,
          "EMBEDDING_DIM_MISMATCH"
        );
      }
    }

    return embeddings;
  }
}

/**
 * Test double: returns deterministic vectors derived from text content.
 * No network, no randomness. Same text → same vector, always.
 *
 * Derivation: FNV-1a-ish 32-bit accumulator seeded from the text's UTF-8
 * codepoints, spread across 1536 dimensions by repeatedly mixing the
 * accumulator with the index. Values are L2-normalized so cosine is well-
 * behaved. Determinism is the only property callers depend on; the specific
 * distribution is not.
 */
export class FakeEmbedder implements EmbeddingClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deriveVector(text, EMBEDDING_DIM));
  }
}

function deriveVector(text: string, dim: number): number[] {
  const out = new Array<number>(dim);
  let acc = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    acc ^= text.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }

  // Seed per-index from a hash of (acc, index) so different texts diverge
  // across the whole vector, not just the first few slots.
  let state = (acc ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < dim; i += 1) {
    state = Math.imul(state ^ (i + 1), 0x85ebca6b) >>> 0;
    state ^= state >>> 13;
    state = Math.imul(state, 0xc2b2ae35) >>> 0;
    state ^= state >>> 16;
    // Map to [-1, 1].
    out[i] = (state / 0xffffffff) * 2 - 1;
  }

  // L2 normalize so vectors are unit length.
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) {
    out[i] = out[i]! / norm;
  }
  return out;
}

function extractEmbeddings(payload: unknown): number[][] {
  if (!payload || typeof payload !== "object") {
    throw new GraphragError(
      "embedding response: expected object payload",
      "EMBEDDING_FAILED"
    );
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new GraphragError(
      "embedding response: missing data array",
      "EMBEDDING_FAILED"
    );
  }
  const out: number[][] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") {
      throw new GraphragError(
        "embedding response: malformed data entry",
        "EMBEDDING_FAILED"
      );
    }
    const embedding = (item as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding)) {
      throw new GraphragError(
        "embedding response: missing embedding array",
        "EMBEDDING_FAILED"
      );
    }
    const vec: number[] = [];
    for (const v of embedding) {
      if (typeof v !== "number") {
        throw new GraphragError(
          "embedding response: non-numeric embedding entry",
          "EMBEDDING_FAILED"
        );
      }
      vec.push(v);
    }
    out.push(vec);
  }
  return out;
}
