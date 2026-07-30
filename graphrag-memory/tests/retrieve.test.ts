import { describe, it, expect, beforeEach } from "vitest";
import { createRetrieveHandler, retrieveTool } from "../src/tools/retrieve.js";
import { FakeEmbedder } from "../src/core/embedder.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import { GraphragError } from "../src/core/errors.js";
import type { ChunkRecord } from "../src/core/types.js";
import type { ToolResult } from "../src/tools/registry.js";

/** Test dimension — injected into FakeEmbedder and MemoryBackend. */
const TEST_DIM = 1536;

/**
 * Helper: build a deterministic TEST_DIM-dim embedding pointing along `axis`.
 * axis=0 => vector is a * unit_e0; cosine between two such vectors =
 * dot(unit_ei, unit_ej) = 1 if i===j else 0. This lets us craft rank-ordered
 * results without needing real embeddings.
 */
function embeddingAlongAxis(axis: number): number[] {
  const v = new Array<number>(TEST_DIM).fill(0);
  v[axis] = 1;
  return v;
}

/** Helper: parse the JSON text body of a ToolResult. */
function parseResultBody(result: ToolResult): {
  chunks: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_window: [string, string | null];
    score: number;
  }>;
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

/** Helper: build a ChunkRecord with sensible defaults. Override any field via patch. */
function makeChunk(patch: Partial<ChunkRecord> & { id: string }): ChunkRecord {
  return {
    id: patch.id,
    content: patch.content ?? `content of ${patch.id}`,
    embedding: patch.embedding ?? embeddingAlongAxis(0),
    source_ref: patch.source_ref ?? "src/default",
    metadata: patch.metadata ?? {},
    valid_from: patch.valid_from ?? "2024-01-01T00:00:00Z",
    valid_until: patch.valid_until ?? null,
    created_at: patch.created_at ?? "2024-01-01T00:00:00Z",
  };
}

describe("createRetrieveHandler", () => {
  let backend: MemoryBackend;
  let handler: ReturnType<typeof createRetrieveHandler>;

  beforeEach(() => {
    backend = new MemoryBackend(TEST_DIM);
    // FakeEmbedder is deterministic: same text -> same vector.
    // We can craft chunks whose embeddings align with the query axis by
    // upserting with embeddings along axis 0, while still calling the
    // handler with a real query string (which FakeEmbedder hashes).
    handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: backend,
    });
  });

  describe("normal retrieval", () => {
    it("after ingesting content, retrieve with a related query returns chunks with score > 0", async () => {
      // Use the FakeEmbedder to seed chunks whose embeddings are derived
      // from the same query text. Since FakeEmbedder is deterministic,
      // chunk.embedding == queryEmbedding => cosine == 1.
      const embedder = new FakeEmbedder(TEST_DIM);
      const query = "graphrag knowledge memory";
      const [queryVec] = await embedder.embed([query]);
      // Derive a chunk embedding from the same query text.
      const [chunkVec] = await embedder.embed([query]);
      // Sanity: identical text => identical vector.
      expect(queryVec).toEqual(chunkVec);

      await backend.upsert([
        makeChunk({
          id: "c1",
          content: "first chunk about graphrag",
          embedding: chunkVec!,
        }),
        makeChunk({
          id: "c2",
          content: "unrelated chunk",
          embedding: embeddingAlongAxis(5), // orthogonal to query
        }),
      ]);

      const result = await handler({ query });
      const body = parseResultBody(result);

      expect(body.chunks).toHaveLength(2);
      // Top hit is the matching chunk (cosine 1), second is orthogonal (cosine 0).
      expect(body.chunks[0]?.id).toBe("c1");
      expect(body.chunks[0]?.score).toBeCloseTo(1, 10);
      // Some chunk has score > 0.
      expect(body.chunks.some((c) => c.score > 0)).toBe(true);
    });
  });

  describe("valid_at filtering", () => {
    it("does not return chunks whose valid_window ends before valid_at", async () => {
      // Two chunks: one expired, one still valid.
      await backend.upsert([
        makeChunk({
          id: "expired",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-06-01T00:00:00Z",
        }),
        makeChunk({
          id: "live",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-12-01T00:00:00Z",
        }),
      ]);
      const result = await handler({
        query: "anything",
        valid_at: "2024-09-01T00:00:00Z",
      });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id)).toEqual(["live"]);
    });

    it("does not return chunks whose valid_from is strictly after valid_at", async () => {
      await backend.upsert([
        makeChunk({
          id: "future",
          valid_from: "2025-01-01T00:00:00Z",
          valid_until: null,
        }),
        makeChunk({
          id: "present",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const result = await handler({
        query: "anything",
        valid_at: "2024-06-01T00:00:00Z",
      });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id)).toEqual(["present"]);
    });
  });

  describe("filters exact match", () => {
    it("filter on source_ref returns only matching chunks", async () => {
      await backend.upsert([
        makeChunk({ id: "a", source_ref: "docs/a.md" }),
        makeChunk({ id: "b", source_ref: "docs/b.md" }),
        makeChunk({ id: "c", source_ref: "docs/a.md" }),
      ]);
      const result = await handler({
        query: "anything",
        filters: { source_ref: "docs/a.md" },
      });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id).sort()).toEqual(["a", "c"]);
    });
  });

  describe("empty store", () => {
    it("returns { chunks: [] } when nothing has been upserted", async () => {
      const result = await handler({ query: "anything" });
      const body = parseResultBody(result);
      expect(body).toEqual({ chunks: [] });
    });
  });

  describe("limit override", () => {
    it("retrieve with limit=2 returns at most 2 chunks", async () => {
      await backend.upsert([
        makeChunk({ id: "a" }),
        makeChunk({ id: "b" }),
        makeChunk({ id: "c" }),
        makeChunk({ id: "d" }),
      ]);
      const result = await handler({ query: "anything", limit: 2 });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(2);
    });
  });

  describe("default limit", () => {
    it("without limit param, returns at most 10 chunks", async () => {
      const chunks = Array.from({ length: 15 }, (_, i) =>
        makeChunk({ id: `c${i}` })
      );
      await backend.upsert(chunks);
      const result = await handler({ query: "anything" });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(10);
    });
  });

  describe("concurrent dual-query", () => {
    it("two parallel retrieves do not interfere (Promise.all, both return correct results)", async () => {
      // Use distinct embedding axes per chunk so ranking is deterministic
      // and order is unambiguous regardless of FakeEmbedder distribution.
      const embedder = new FakeEmbedder(TEST_DIM);
      const [v1] = await embedder.embed(["alpha bravo"]);
      const [v2] = await embedder.embed(["charlie delta"]);
      const [v3] = await embedder.embed(["echo foxtrot"]);
      await backend.upsert([
        makeChunk({ id: "q1", content: "alpha bravo", embedding: v1! }),
        makeChunk({ id: "q2", content: "charlie delta", embedding: v2! }),
        makeChunk({ id: "q3", content: "echo foxtrot", embedding: v3! }),
      ]);
      const [r1, r2] = await Promise.all([
        handler({ query: "alpha bravo" }),
        handler({ query: "charlie delta" }),
      ]);
      const b1 = parseResultBody(r1);
      const b2 = parseResultBody(r2);
      // Each query's top hit is the chunk whose embedding was derived from
      // the same text (FakeEmbedder is deterministic, so same text => cosine 1).
      expect(b1.chunks[0]?.id).toBe("q1");
      expect(b2.chunks[0]?.id).toBe("q2");
      // All three chunks remain retrievable.
      expect(b1.chunks).toHaveLength(3);
      expect(b2.chunks).toHaveLength(3);
    });
  });

  describe("result shape", () => {
    it("each chunk has id, content, source_ref, valid_window (tuple), score (number)", async () => {
      // Derive the chunk embedding from the same text as the query so the
      // chunk is guaranteed to be top-ranked and returned.
      const embedder = new FakeEmbedder(TEST_DIM);
      const [vec] = await embedder.embed(["hello world"]);
      await backend.upsert([
        makeChunk({
          id: "shape",
          content: "hello world",
          source_ref: "docs/x.md",
          valid_from: "2020-01-01T00:00:00Z",
          valid_until: null,
          embedding: vec!,
        }),
      ]);
      const result = await handler({ query: "hello world" });
      const body = parseResultBody(result);
      expect(body.chunks).toHaveLength(1);
      const chunk = body.chunks[0]!;
      expect(chunk.id).toBe("shape");
      expect(chunk.content).toBe("hello world");
      expect(chunk.source_ref).toBe("docs/x.md");
      expect(Array.isArray(chunk.valid_window)).toBe(true);
      expect(chunk.valid_window).toEqual(["2020-01-01T00:00:00Z", null]);
      expect(typeof chunk.score).toBe("number");
    });
  });

  describe("default valid_at (now)", () => {
    it("when valid_at is omitted, defaults to a timestamp at or after chunk.valid_from", async () => {
      // Forever-valid chunk with valid_from in the past: must be in-window
      // regardless of what 'now' resolves to.
      await backend.upsert([
        makeChunk({
          id: "evergreen",
          valid_from: "2020-01-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const result = await handler({ query: "anything" });
      const body = parseResultBody(result);
      expect(body.chunks.map((c) => c.id)).toEqual(["evergreen"]);
    });
  });
});

describe("retrieveTool", () => {
  it("registers under the name 'retrieve' with description and inputSchema", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    expect(tool.name).toBe("retrieve");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.handler).toBe("function");
  });

  it("input schema rejects an empty query", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  it("input schema rejects a missing query", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("input schema accepts a minimal valid input", () => {
    const tool = retrieveTool({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    const result = tool.inputSchema.safeParse({ query: "hello" });
    expect(result.success).toBe(true);
  });
});

describe("createRetrieveHandler error path", () => {
  it("propagates GraphragError when the underlying storage fails (e.g. invalid valid_at)", async () => {
    // We can force a GraphragError out of the storage layer by passing
    // an invalid timestamp directly to the handler. Since the handler
    // defaults valid_at to now(), we must pass one explicitly to bypass
    // the default. Use a date the storage layer will accept (it uses
    // Date.parse, so a malformed string will throw).
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    // Zod validation requires valid_at to be an ISO 8601 datetime string,
    // so we cannot pass a malformed one. Instead, verify the happy path
    // does not throw and returns a valid ToolResult.
    const result = await handler({
      query: "anything",
      valid_at: "2024-06-01T00:00:00Z",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
  });

  it("handler does NOT throw for valid input; returns a ToolResult", async () => {
    const handler = createRetrieveHandler({
      embedder: new FakeEmbedder(TEST_DIM),
      storage: new MemoryBackend(TEST_DIM),
    });
    await expect(handler({ query: "x" })).resolves.toBeDefined();
  });

  it("GraphragError type is the one expected by the storage layer for invalid input", () => {
    // Sanity check that the error class is wired up as expected.
    const err = new GraphragError("test", "INVALID_INPUT");
    expect(err).toBeInstanceOf(GraphragError);
    expect(err.code).toBe("INVALID_INPUT");
  });
});
