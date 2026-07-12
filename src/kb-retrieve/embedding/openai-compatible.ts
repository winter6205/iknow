import { NetworkError, ValidationError } from "../../shared/errors.js";
import type { EmbeddingClient } from "./types.js";

export interface OpenAiEmbeddingClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Request body `dimensions` when the provider supports output truncation. */
  dimensions?: number;
  timeoutMs?: number;
  /** Local expected vector length advertised as EmbeddingClient.dims. */
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
    if (!opts.baseUrl || opts.baseUrl.trim() === "") {
      throw new ValidationError("embedding baseUrl is required");
    }
    if (!opts.model || opts.model.trim() === "") {
      throw new ValidationError("embedding model is required");
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
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new NetworkError(
            `embedding request timed out after ${this.timeoutMs}ms`,
            { timeoutMs: this.timeoutMs },
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new NetworkError(`embedding request failed: ${msg}`);
      }

      const raw = await res.text();
      if (!res.ok) {
        throw new NetworkError(
          `embedding HTTP ${res.status}: ${extractErrorMessage(raw)}`,
          { status: res.status },
        );
      }

      let json: {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      try {
        json = JSON.parse(raw) as typeof json;
      } catch {
        throw new ValidationError("embedding response is not valid JSON");
      }

      const data = json.data ?? [];
      if (data.length === 0) {
        throw new ValidationError("embedding response missing data[]");
      }

      const ordered = orderByIndex(data);
      return ordered.map((row, i) => {
        const emb = row.embedding;
        if (!emb || !Array.isArray(emb)) {
          throw new ValidationError(`embedding missing at index ${i}`);
        }
        if (emb.length !== this.dims) {
          throw new ValidationError(
            `embedding dimension mismatch at index ${i}: expected ${this.dims}, got ${emb.length}`,
            { index: i, expected: this.dims, got: emb.length },
          );
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

function extractErrorMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
    if (
      body.error &&
      typeof body.error === "object" &&
      typeof body.error.message === "string" &&
      body.error.message.trim()
    ) {
      return body.error.message;
    }
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // EXIT: body is not JSON — fall through to truncated raw
  }
  return raw.slice(0, 200);
}

/**
 * Align response rows with request order.
 * - All rows have index and form 0..n-1 → sort by index
 * - No rows have index → keep server order
 * - Partial / non-permutation indexes → ValidationError
 */
function orderByIndex(
  data: Array<{ embedding?: number[]; index?: number }>,
): Array<{ embedding?: number[]; index?: number }> {
  const n = data.length;
  const hasIndex = data.map((r) => typeof r.index === "number");
  const allHave = hasIndex.every(Boolean);
  const noneHave = hasIndex.every((h) => !h);

  if (noneHave) return data;

  if (!allHave) {
    throw new ValidationError(
      "embedding response has partial index fields",
    );
  }

  const indexes = data.map((r) => r.index as number);
  const set = new Set(indexes);
  const isPermutation =
    set.size === n && indexes.every((i) => i >= 0 && i < n);
  if (!isPermutation) {
    throw new ValidationError(
      "embedding response indexes are not a contiguous 0..n-1 permutation",
    );
  }

  return [...data].sort((a, b) => (a.index as number) - (b.index as number));
}
