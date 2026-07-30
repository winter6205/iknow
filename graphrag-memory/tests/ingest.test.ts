import { describe, it, expect, beforeEach } from "vitest";
import {
  IngestInputSchema,
  createIngestHandler,
  ingestTool,
} from "../src/tools/ingest.js";
import { GraphragError, MAX_CONTENT_BYTES } from "../src/core/errors.js";
import { FakeEmbedder } from "../src/core/embedder.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import type { IngestDeps } from "../src/tools/ingest.js";
import type { RetrievedChunk, SearchOptions } from "../src/core/types.js";

/**
 * Helper: build a fully-wired IngestDeps pair (FakeEmbedder + MemoryBackend).
 * The tests below exercise the real handler pipeline end-to-end; only the
 * embedder is the deterministic test double (no network).
 */
function makeDeps(): IngestDeps & {
  storage: MemoryBackend;
  embedder: FakeEmbedder;
} {
  const embedder = new FakeEmbedder();
  const storage = new MemoryBackend();
  return { embedder, storage };
}

describe("IngestInputSchema", () => {
  it("accepts the minimal required input (content + source_ref)", () => {
    const result = IngestInputSchema.safeParse({
      content: "hello",
      source_ref: "docs/x.md",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full input with metadata and valid_from/valid_until", () => {
    const result = IngestInputSchema.safeParse({
      content: "hello",
      source_ref: "docs/x.md",
      metadata: { category: "design" },
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: "2024-12-31T23:59:59Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty content string", () => {
    const result = IngestInputSchema.safeParse({
      content: "",
      source_ref: "docs/x.md",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing source_ref", () => {
    const result = IngestInputSchema.safeParse({ content: "hello" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty source_ref", () => {
    const result = IngestInputSchema.safeParse({
      content: "hello",
      source_ref: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO valid_from", () => {
    const result = IngestInputSchema.safeParse({
      content: "hello",
      source_ref: "docs/x.md",
      valid_from: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO valid_until", () => {
    const result = IngestInputSchema.safeParse({
      content: "hello",
      source_ref: "docs/x.md",
      valid_until: "2024-13-99",
    });
    expect(result.success).toBe(false);
  });
});

describe("ingestHandler — normal write", () => {
  let deps: IngestDeps;
  let handler: ReturnType<typeof createIngestHandler>;

  beforeEach(() => {
    deps = makeDeps();
    handler = createIngestHandler(deps);
  });

  it("returns a non-empty chunk_ids array on a successful write", async () => {
    const result = await handler({
      content: "hello world",
      source_ref: "docs/x.md",
    });
    expect(result.isError).toBeFalsy();
    // result.content[0].text is JSON: { chunk_ids: [...] }
    const parsed = JSON.parse(result.content[0]!.text) as {
      chunk_ids: string[];
    };
    expect(Array.isArray(parsed.chunk_ids)).toBe(true);
    expect(parsed.chunk_ids.length).toBeGreaterThan(0);
  });

  it("returns one chunk_id for content smaller than the default chunk size", async () => {
    const result = await handler({
      content: "short content",
      source_ref: "docs/x.md",
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      chunk_ids: string[];
    };
    expect(parsed.chunk_ids).toHaveLength(1);
  });

  it("returns multiple chunk_ids when content exceeds the default chunk size", async () => {
    // 5000 chars > DEFAULT_CHUNK_SIZE (2048) → at least 3 chunks
    const long = "x".repeat(5000);
    const result = await handler({
      content: long,
      source_ref: "docs/x.md",
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      chunk_ids: string[];
    };
    expect(parsed.chunk_ids.length).toBeGreaterThan(1);
  });

  it("returns chunk_ids that are unique strings (UUIDs)", async () => {
    const result = await handler({
      content: "hello world",
      source_ref: "docs/x.md",
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      chunk_ids: string[];
    };
    const ids = parsed.chunk_ids;
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      // UUID v4 format (8-4-4-4-12 hex)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
  });

  it("persists chunks to the storage backend (search returns them)", async () => {
    const handler = createIngestHandler(deps);
    const storage = deps.storage as MemoryBackend;
    await handler({
      content: "searchable content",
      source_ref: "docs/x.md",
    });

    // The same embedder was used to embed the content, so the same input
    // produces the same query vector → cosine 1 against the stored chunk.
    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const queryVec = await new FakeEmbedder().embed(["searchable content"]);
    const opts: SearchOptions = {
      limit: 10,
      validAt: new Date().toISOString(),
    };
    const hits: RetrievedChunk[] = await storage.search(queryVec[0]!, opts);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toBe("searchable content");
    expect(hits[0]?.source_ref).toBe("docs/x.md");
  });
});

describe("ingestHandler — validation errors", () => {
  let deps: IngestDeps;
  let handler: ReturnType<typeof createIngestHandler>;

  beforeEach(() => {
    deps = makeDeps();
    handler = createIngestHandler(deps);
  });

  it("throws GraphragError INVALID_INPUT when valid_from > valid_until", async () => {
    await expect(
      handler({
        content: "hello",
        source_ref: "docs/x.md",
        valid_from: "2024-12-31T00:00:00Z",
        valid_until: "2024-01-01T00:00:00Z",
      })
    ).rejects.toBeInstanceOf(GraphragError);
    await expect(
      handler({
        content: "hello",
        source_ref: "docs/x.md",
        valid_from: "2024-12-31T00:00:00Z",
        valid_until: "2024-01-01T00:00:00Z",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws GraphragError INVALID_INPUT when valid_from === valid_until", async () => {
    await expect(
      handler({
        content: "hello",
        source_ref: "docs/x.md",
        valid_from: "2024-06-01T00:00:00Z",
        valid_until: "2024-06-01T00:00:00Z",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("accepts a valid window where valid_from < valid_until", async () => {
    await expect(
      handler({
        content: "hello",
        source_ref: "docs/x.md",
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: "2024-12-31T00:00:00Z",
      })
    ).resolves.toBeDefined();
  });

  it("accepts only valid_from with no valid_until (forever-valid from that point)", async () => {
    await expect(
      handler({
        content: "hello",
        source_ref: "docs/x.md",
        valid_from: "2024-01-01T00:00:00Z",
      })
    ).resolves.toBeDefined();
  });

  it("throws GraphragError CONTENT_TOO_LARGE when content exceeds MAX_CONTENT_BYTES", async () => {
    const oversized = "a".repeat(MAX_CONTENT_BYTES + 1);
    await expect(
      handler({
        content: oversized,
        source_ref: "docs/x.md",
      })
    ).rejects.toBeInstanceOf(GraphragError);
    await expect(
      handler({
        content: oversized,
        source_ref: "docs/x.md",
      })
    ).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
  });

  it("accepts content at exactly MAX_CONTENT_BYTES (boundary)", async () => {
    const exact = "a".repeat(MAX_CONTENT_BYTES);
    await expect(
      handler({
        content: exact,
        source_ref: "docs/x.md",
      })
    ).resolves.toBeDefined();
  });
});

describe("ingestHandler — stored ChunkRecord shape", () => {
  let deps: IngestDeps;
  let storage: MemoryBackend;

  beforeEach(() => {
    deps = makeDeps();
    storage = deps.storage as MemoryBackend;
  });

  it("passes metadata through to the stored chunks (round-trip via search)", async () => {
    const handler = createIngestHandler(deps);
    await handler({
      content: "tagged content",
      source_ref: "docs/x.md",
      metadata: { category: "design", lang: "en", tag: "important" },
    });

    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const queryVec = await new FakeEmbedder().embed(["tagged content"]);
    const hits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: "2099-01-01T00:00:00Z",
      filters: { "metadata.category": "design" },
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("passes source_ref through to the stored chunks", async () => {
    const handler = createIngestHandler(deps);
    await handler({
      content: "source-tagged",
      source_ref: "docs/important.md",
    });

    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const queryVec = await new FakeEmbedder().embed(["source-tagged"]);
    const hits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: "2099-01-01T00:00:00Z",
      filters: { source_ref: "docs/important.md" },
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("stores the user-supplied valid_from and valid_until verbatim", async () => {
    const handler = createIngestHandler(deps);
    const validFrom = "2024-03-01T00:00:00Z";
    const validUntil = "2024-09-01T00:00:00Z";
    await handler({
      content: "windowed content",
      source_ref: "docs/x.md",
      valid_from: validFrom,
      valid_until: validUntil,
    });

    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const queryVec = await new FakeEmbedder().embed(["windowed content"]);
    const hits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: "2024-06-01T00:00:00Z",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.valid_window).toEqual([validFrom, validUntil]);
  });

  it("defaults valid_until to null (forever valid) when not provided", async () => {
    const handler = createIngestHandler(deps);
    await handler({
      content: "forever content",
      source_ref: "docs/x.md",
    });

    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const queryVec = await new FakeEmbedder().embed(["forever content"]);
    const hits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: "9999-12-31T23:59:59Z",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.valid_window[1]).toBeNull();
  });

  it("defaults valid_from to a recent timestamp (within a few seconds of now) when not provided", async () => {
    const before = Date.now();
    const handler = createIngestHandler(deps);
    await handler({
      content: "default-from content",
      source_ref: "docs/x.md",
    });
    const after = Date.now();

    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const queryVec = await new FakeEmbedder().embed(["default-from content"]);
    // Search at a time comfortably after the ingest → chunk must be in-window.
    const futureIso = new Date(after + 60_000).toISOString();
    const hits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: futureIso,
    });
    expect(hits).toHaveLength(1);

    // Also: search at a time BEFORE the ingest should miss it.
    const beforeIso = new Date(before - 60_000).toISOString();
    const pastHits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: beforeIso,
    });
    expect(pastHits).toHaveLength(0);
  });

  it("sets created_at to a recent timestamp on each stored chunk", async () => {
    const before = Date.now();
    const handler = createIngestHandler(deps);
    await handler({
      content: "fresh content",
      source_ref: "docs/x.md",
    });
    const after = Date.now();

    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const queryVec = await new FakeEmbedder().embed(["fresh content"]);
    const hits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: new Date(after + 1000).toISOString(),
    });
    expect(hits).toHaveLength(1);
    // The valid_window's [0] (valid_from) is the ingest-time default, which
    // doubles as a created_at proxy when created_at is not exposed by search.
    const validFrom = hits[0]?.valid_window[0];
    expect(validFrom).toBeDefined();
    const validFromMs = Date.parse(validFrom!);
    expect(validFromMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(validFromMs).toBeLessThanOrEqual(after + 1_000);
  });

  it("stores embeddings with the FakeEmbedder-derived vector (cosine 1 to itself)", async () => {
    const handler = createIngestHandler(deps);
    await handler({
      content: "vector content",
      source_ref: "docs/x.md",
    });

    const { FakeEmbedder } = await import("../src/core/embedder.js");
    const embedder = new FakeEmbedder();
    const queryVec = await embedder.embed(["vector content"]);
    const hits = await storage.search(queryVec[0]!, {
      limit: 10,
      validAt: "2099-01-01T00:00:00Z",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.score).toBeCloseTo(1, 6);
  });
});

describe("ingestTool registration", () => {
  it("exposes name, description, inputSchema, and handler", () => {
    const deps = makeDeps();
    const tool = ingestTool(deps);
    expect(tool.name).toBe("ingest");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBe(IngestInputSchema);
    expect(typeof tool.handler).toBe("function");
  });

  it("wires the deps into the returned handler (closed-over)", async () => {
    const deps = makeDeps();
    const tool = ingestTool(deps);
    const result = await tool.handler({
      content: "via tool",
      source_ref: "docs/x.md",
    });
    const parsed = JSON.parse(result.content[0]!.text) as {
      chunk_ids: string[];
    };
    expect(parsed.chunk_ids.length).toBeGreaterThan(0);
  });
});
