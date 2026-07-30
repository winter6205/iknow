import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import type { ChunkRecord } from "../src/core/types.js";
import { EMBEDDING_DIM, GraphragError } from "../src/core/errors.js";

/**
 * Helper: build a deterministic 1536-dim embedding pointing along `axis`.
 * axis=0 => vector is a * unit_e0; cosine between two such vectors =
 * dot(unit_ei, unit_ej) = 1 if i===j else 0. This lets us craft rank-ordered
 * results without needing real embeddings.
 */
function embeddingAlongAxis(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[axis] = 1;
  return v;
}

/**
 * Helper: chunk with sensible defaults. Override any field via patch.
 * Embedding defaults to axis 0 (matches a "default" query at axis 0).
 */
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

describe("MemoryBackend", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  describe("upsert", () => {
    it("stores chunks and returns their ids in input order", async () => {
      const chunks = [
        makeChunk({ id: "a" }),
        makeChunk({ id: "b" }),
        makeChunk({ id: "c" }),
      ];
      const ids = await backend.upsert(chunks);
      expect(ids).toEqual(["a", "b", "c"]);
    });

    it("returns an empty array when given no chunks", async () => {
      const ids = await backend.upsert([]);
      expect(ids).toEqual([]);
    });

    it("overwrites a chunk with the same id (last write wins)", async () => {
      await backend.upsert([makeChunk({ id: "x", content: "old" })]);
      await backend.upsert([makeChunk({ id: "x", content: "new" })]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2024-06-01T00:00:00Z",
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.content).toBe("new");
    });

    it("rejects an embedding whose length does not match EMBEDDING_DIM with GraphragError EMBEDDING_DIM_MISMATCH", async () => {
      const bad = makeChunk({
        id: "bad",
        embedding: [0.1, 0.2, 0.3], // 3-dim, not 1536
      });
      await expect(backend.upsert([bad])).rejects.toBeInstanceOf(GraphragError);
      await expect(backend.upsert([bad])).rejects.toMatchObject({
        code: "EMBEDDING_DIM_MISMATCH",
      });
    });

    it("reports dimension mismatch on the first offending chunk and aborts the batch", async () => {
      // First chunk valid, second chunk bad — the whole batch must throw.
      const chunks = [
        makeChunk({ id: "good" }),
        makeChunk({
          id: "bad",
          embedding: new Array<number>(EMBEDDING_DIM + 1).fill(0),
        }),
      ];
      await expect(backend.upsert(chunks)).rejects.toMatchObject({
        code: "EMBEDDING_DIM_MISMATCH",
      });
      // The good chunk must NOT have been persisted (atomic batch).
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2024-06-01T00:00:00Z",
      });
      expect(hits).toEqual([]);
    });
  });

  describe("search ranking + top-K", () => {
    it("returns chunks ranked by cosine similarity, highest first", async () => {
      // Chunks along axes 0, 1, 2, 3. Query along axis 3.
      // axis-3 has cosine 1 to the query; the other three are mutually
      // orthogonal to the query axis and to each other => cosine 0. On ties,
      // Array.prototype.sort (V8 stable since ES2019) preserves upsert order,
      // so the three zero-score chunks appear in insertion order: e0, e1, e2.
      await backend.upsert([
        makeChunk({ id: "e0", embedding: embeddingAlongAxis(0) }),
        makeChunk({ id: "e1", embedding: embeddingAlongAxis(1) }),
        makeChunk({ id: "e2", embedding: embeddingAlongAxis(2) }),
        makeChunk({ id: "e3", embedding: embeddingAlongAxis(3) }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(3), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
      });
      expect(hits.map((h) => h.id)).toEqual(["e3", "e0", "e1", "e2"]);
      expect(hits[0]?.score).toBeCloseTo(1, 10);
      // The rest are mutually orthogonal => cosine 0.
      expect(hits[1]?.score).toBeCloseTo(0, 10);
      expect(hits[2]?.score).toBeCloseTo(0, 10);
      expect(hits[3]?.score).toBeCloseTo(0, 10);
    });

    it("respects the limit parameter (top-K)", async () => {
      await backend.upsert([
        makeChunk({ id: "a" }),
        makeChunk({ id: "b" }),
        makeChunk({ id: "c" }),
        makeChunk({ id: "d" }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 2,
        validAt: "2025-01-01T00:00:00Z",
      });
      expect(hits).toHaveLength(2);
    });

    it("uses default zero-score order (deterministic) for ties", async () => {
      // All three are mutually orthogonal to the query axis — all score 0.
      await backend.upsert([
        makeChunk({ id: "a", embedding: embeddingAlongAxis(1) }),
        makeChunk({ id: "b", embedding: embeddingAlongAxis(2) }),
        makeChunk({ id: "c", embedding: embeddingAlongAxis(3) }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
      });
      // All scores must be 0; ids may appear in any order (stable tie is not
      // a documented contract here, but the score must be 0 for all of them).
      expect(hits).toHaveLength(3);
      for (const h of hits) {
        expect(h.score).toBeCloseTo(0, 10);
      }
    });

    it("populates the RetrievedChunk shape: id, content, source_ref, valid_window, score", async () => {
      await backend.upsert([
        makeChunk({
          id: "shape",
          content: "hello",
          source_ref: "docs/x.md",
          valid_from: "2024-03-01T00:00:00Z",
          valid_until: "2024-12-01T00:00:00Z",
        }),
      ]);
      const [hit] = await backend.search(embeddingAlongAxis(0), {
        limit: 1,
        validAt: "2024-06-01T00:00:00Z",
      });
      expect(hit).toBeDefined();
      expect(hit?.id).toBe("shape");
      expect(hit?.content).toBe("hello");
      expect(hit?.source_ref).toBe("docs/x.md");
      expect(hit?.valid_window).toEqual([
        "2024-03-01T00:00:00Z",
        "2024-12-01T00:00:00Z",
      ]);
      expect(hit?.score).toBeCloseTo(1, 10);
    });

    it("emits valid_window with null as the second element for forever-valid chunks", async () => {
      await backend.upsert([
        makeChunk({
          id: "forever",
          valid_from: "2024-03-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const [hit] = await backend.search(embeddingAlongAxis(0), {
        limit: 1,
        validAt: "2024-06-01T00:00:00Z",
      });
      expect(hit?.valid_window).toEqual(["2024-03-01T00:00:00Z", null]);
    });
  });

  describe("valid_window filtering", () => {
    it("does not return a chunk whose valid_until is strictly before validAt (expired)", async () => {
      await backend.upsert([
        makeChunk({
          id: "expired",
          valid_from: "2024-01-01T00:00:00Z",
          valid_until: "2024-06-01T00:00:00Z",
        }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        // validAt is strictly AFTER valid_until => expired
        validAt: "2024-06-01T00:00:01Z",
      });
      expect(hits).toEqual([]);
    });

    it("does not return a chunk whose valid_from is strictly after validAt (not yet valid)", async () => {
      await backend.upsert([
        makeChunk({
          id: "future",
          valid_from: "2025-01-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2024-12-31T23:59:59Z",
      });
      expect(hits).toEqual([]);
    });

    it("does return a chunk with valid_until === null (forever valid) regardless of validAt", async () => {
      await backend.upsert([
        makeChunk({
          id: "forever",
          valid_from: "2020-01-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const farFuture = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "9999-12-31T23:59:59Z",
      });
      expect(farFuture.map((h) => h.id)).toEqual(["forever"]);
    });

    it("includes a chunk whose valid_window contains validAt on both ends", async () => {
      // valid_window [from, until); validAt exactly equal to valid_from is OK,
      // validAt exactly equal to valid_until is NOT OK (until is exclusive).
      await backend.upsert([
        makeChunk({
          id: "mid",
          valid_from: "2024-03-01T00:00:00Z",
          valid_until: "2024-09-01T00:00:00Z",
        }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2024-03-01T00:00:00Z",
      });
      expect(hits).toHaveLength(1);
    });

    it("excludes a chunk at the exact valid_until instant (boundary)", async () => {
      await backend.upsert([
        makeChunk({
          id: "boundary",
          valid_from: "2024-03-01T00:00:00Z",
          valid_until: "2024-09-01T00:00:00Z",
        }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2024-09-01T00:00:00Z",
      });
      expect(hits).toEqual([]);
    });

    it("returns a mix of in-window and out-of-window chunks, filtering correctly", async () => {
      await backend.upsert([
        makeChunk({
          id: "in",
          valid_from: "2024-03-01T00:00:00Z",
          valid_until: "2024-09-01T00:00:00Z",
        }),
        makeChunk({
          id: "expired",
          valid_from: "2023-01-01T00:00:00Z",
          valid_until: "2024-01-01T00:00:00Z",
        }),
        makeChunk({
          id: "future",
          valid_from: "2025-01-01T00:00:00Z",
          valid_until: null,
        }),
        makeChunk({
          id: "forever",
          valid_from: "2020-01-01T00:00:00Z",
          valid_until: null,
        }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2024-06-01T00:00:00Z",
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["forever", "in"]);
    });
  });

  describe("filters (exact match)", () => {
    it("filters by source_ref", async () => {
      await backend.upsert([
        makeChunk({ id: "a", source_ref: "docs/a.md" }),
        makeChunk({ id: "b", source_ref: "docs/b.md" }),
        makeChunk({ id: "c", source_ref: "docs/a.md" }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
        filters: { source_ref: "docs/a.md" },
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["a", "c"]);
    });

    it("filters by a metadata key", async () => {
      await backend.upsert([
        makeChunk({
          id: "a",
          metadata: { category: "design", lang: "en" },
        }),
        makeChunk({
          id: "b",
          metadata: { category: "impl", lang: "en" },
        }),
        makeChunk({
          id: "c",
          metadata: { category: "design", lang: "zh" },
        }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
        filters: { "metadata.category": "design" },
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["a", "c"]);
    });

    it("AND-combines multiple filters (source_ref + metadata key)", async () => {
      await backend.upsert([
        makeChunk({
          id: "a",
          source_ref: "docs/a.md",
          metadata: { category: "design" },
        }),
        makeChunk({
          id: "b",
          source_ref: "docs/a.md",
          metadata: { category: "impl" },
        }),
        makeChunk({
          id: "c",
          source_ref: "docs/b.md",
          metadata: { category: "design" },
        }),
      ]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
        filters: {
          source_ref: "docs/a.md",
          "metadata.category": "design",
        },
      });
      expect(hits.map((h) => h.id)).toEqual(["a"]);
    });

    it("returns an empty array when filters match nothing", async () => {
      await backend.upsert([makeChunk({ id: "a" })]);
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
        filters: { source_ref: "docs/nonexistent.md" },
      });
      expect(hits).toEqual([]);
    });
  });

  describe("empty store", () => {
    it("returns an empty array when nothing has been upserted", async () => {
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
      });
      expect(hits).toEqual([]);
    });

    it("returns an empty array after close()", async () => {
      await backend.upsert([makeChunk({ id: "a" })]);
      await backend.close();
      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 10,
        validAt: "2025-01-01T00:00:00Z",
      });
      expect(hits).toEqual([]);
    });
  });

  describe("concurrency", () => {
    it("does not lose data when two upserts run in parallel (Promise.all)", async () => {
      const batchA = Array.from({ length: 25 }, (_, i) =>
        makeChunk({ id: `a${i}` })
      );
      const batchB = Array.from({ length: 25 }, (_, i) =>
        makeChunk({ id: `b${i}` })
      );
      const [idsA, idsB] = await Promise.all([
        backend.upsert(batchA),
        backend.upsert(batchB),
      ]);
      expect(idsA).toHaveLength(25);
      expect(idsB).toHaveLength(25);

      const hits = await backend.search(embeddingAlongAxis(0), {
        limit: 100,
        validAt: "2025-01-01T00:00:00Z",
      });
      // 50 distinct ids (each chunk's embedding is identical so they tie on
      // score, but every chunk must be retrievable).
      expect(hits).toHaveLength(50);
      const ids = new Set(hits.map((h) => h.id));
      expect(ids.size).toBe(50);
      for (let i = 0; i < 25; i++) {
        expect(ids.has(`a${i}`)).toBe(true);
        expect(ids.has(`b${i}`)).toBe(true);
      }
    });
  });

  describe("close", () => {
    it("resolves without error on a fresh backend", async () => {
      await expect(backend.close()).resolves.toBeUndefined();
    });

    it("resolves without error even after upserts", async () => {
      await backend.upsert([makeChunk({ id: "a" })]);
      await expect(backend.close()).resolves.toBeUndefined();
    });

    it("can be called multiple times without error", async () => {
      await backend.close();
      await expect(backend.close()).resolves.toBeUndefined();
    });
  });
});
