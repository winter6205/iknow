import { NetworkError, ValidationError } from "../../shared/errors.js";
import type { EmbeddingClient } from "./types.js";

export interface OpenAiEmbeddingClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs?: number;
  dimsHint?: number;
}

/**
 * OpenAI-compatible POST /embeddings (9router, etc.).
 */
export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  readonly dims: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions?: number;
  private readonly timeoutMs: number;

  constructor(opts: OpenAiEmbeddingClientOptions) {
    if (!opts.apiKey) {
      throw new ValidationError("embedding apiKey is required");
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.dims = opts.dimsHint ?? opts.dimensions ?? 2048;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts.length === 1 ? texts[0] : texts,
    };
    if (this.dimensions && this.dimensions > 0) {
      body.dimensions = this.dimensions;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new NetworkError(
          `embedding HTTP ${res.status}: ${raw.slice(0, 200)}`,
          { status: res.status },
        );
      }
      const json = JSON.parse(raw) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      const data = json.data ?? [];
      if (data.length === 0) {
        throw new NetworkError("embedding response missing data[]");
      }
      // sort by index if present
      const sorted = [...data].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      return sorted.map((row, i) => {
        const emb = row.embedding;
        if (!emb || !Array.isArray(emb)) {
          throw new NetworkError(`embedding missing at index ${i}`);
        }
        return emb;
      });
    } catch (err) {
      if (err instanceof NetworkError || err instanceof ValidationError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`embedding request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
