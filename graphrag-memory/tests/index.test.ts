import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/index.ts";

/**
 * Construct a server with the stage 1 env vars forced to their defaults.
 *
 * Why: `loadEnv()` reads `process.env` at construction time, and a developer
 * machine (or CI secret) may well have a real `NINE_ROUTER_KEY` exported. If
 * we let that through, `createServer()` builds a NineRouterEmbedder and these
 * tests silently start making paid network calls — which is both slow and a
 * false signal. Clearing the vars for the duration of the call pins the
 * memory + FakeEmbedder path these tests are written against.
 */
const ENV_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "NINE_ROUTER_KEY",
] as const;

async function createOfflineServer(): Promise<ReturnType<typeof createServer>> {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  // Dimensions is always required; FakeEmbedder path only needs this single
  // field to construct successfully.
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  try {
    return await createServer();
  } finally {
    for (const [k, v] of saved) {
      if (v !== undefined) process.env[k] = v;
    }
  }
}

describe("createServer", () => {
  it("returns a constructed McpServer with a connect() method", async () => {
    const server = await createOfflineServer();
    expect(server).toBeDefined();
    assert.equal(
      typeof (server as unknown as { connect: unknown }).connect,
      "function"
    );
  });

  it("returns a fresh server on each call (no shared mutable state)", async () => {
    const a = await createOfflineServer();
    const b = await createOfflineServer();
    assert.notEqual(a, b);
  });
});

/**
 * T7 wiring: the tool set the server actually advertises and serves.
 *
 * Why an in-process linked transport instead of spawning dist/index.js
 * (the host-smoke pattern): these tests assert the wiring inside a single
 * `createServer()` instance. Storage is a per-instance `MemoryBackend`, so
 * ingest -> retrieve only round-trips when the client and server share one
 * process. Spawning would also require a build step per run.
 *
 * Default env (no NINE_ROUTER_KEY, no GRAPHRAG_MEMORY_STORAGE) puts the
 * server in memory + FakeEmbedder mode, so nothing here touches the network.
 */
async function connectInProcess(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = await createOfflineServer();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "index-test", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Concatenate the text content blocks of a tools/call result. */
function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

describe("createServer — registered tool set (T7)", () => {
  it("tools/list advertises echo, ingest, and retrieve", async () => {
    const { client, close } = await connectInProcess();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "echo",
        "ingest",
        "retrieve",
      ]);
      for (const tool of tools) {
        expect((tool.inputSchema as { type?: string }).type).toBe("object");
      }
    } finally {
      await close();
    }
  });

  it("tools/call ingest returns chunk_ids", async () => {
    const { client, close } = await connectInProcess();
    try {
      const result = await client.callTool({
        name: "ingest",
        arguments: {
          content: "The capital of France is Paris.",
          source_ref: "test://ingest-round-trip",
        },
      });
      expect(result.isError).not.toBe(true);

      const payload = JSON.parse(textOf(result)) as { chunk_ids: string[] };
      expect(Array.isArray(payload.chunk_ids)).toBe(true);
      expect(payload.chunk_ids.length).toBeGreaterThan(0);
      for (const id of payload.chunk_ids) {
        expect(typeof id).toBe("string");
      }
    } finally {
      await close();
    }
  });

  it("tools/call retrieve returns a chunks array", async () => {
    const { client, close } = await connectInProcess();
    try {
      const result = await client.callTool({
        name: "retrieve",
        arguments: { query: "anything at all" },
      });
      expect(result.isError).not.toBe(true);

      // Empty store: the shape must still be well-formed (empty array),
      // not an error — "no results" is a valid answer, not a failure.
      const payload = JSON.parse(textOf(result)) as { chunks: unknown[] };
      expect(Array.isArray(payload.chunks)).toBe(true);
      expect(payload.chunks).toEqual([]);
    } finally {
      await close();
    }
  });

  it("ingest -> retrieve round-trips within one server instance", async () => {
    const { client, close } = await connectInProcess();
    try {
      const content = "GraphRAG stores chunks with temporal validity windows.";
      const ingested = await client.callTool({
        name: "ingest",
        arguments: { content, source_ref: "test://e2e", metadata: { k: "v" } },
      });
      expect(ingested.isError).not.toBe(true);
      const { chunk_ids } = JSON.parse(textOf(ingested)) as {
        chunk_ids: string[];
      };

      const retrieved = await client.callTool({
        name: "retrieve",
        arguments: { query: content, limit: 5 },
      });
      expect(retrieved.isError).not.toBe(true);
      const { chunks } = JSON.parse(textOf(retrieved)) as {
        chunks: Array<{
          id: string;
          content: string;
          source_ref: string;
          valid_window: [string, string | null];
          score: number;
        }>;
      };

      expect(chunks.length).toBeGreaterThan(0);
      // FakeEmbedder is deterministic, so embedding the same text twice
      // yields the same vector — the ingested chunk must be the top hit
      // with a cosine of ~1.
      expect(chunks[0]!.content).toBe(content);
      expect(chunks[0]!.source_ref).toBe("test://e2e");
      expect(chunk_ids).toContain(chunks[0]!.id);
      expect(chunks[0]!.score).toBeGreaterThan(0.99);
      expect(chunks[0]!.valid_window[1]).toBeNull();
    } finally {
      await close();
    }
  });

  it("each server instance owns its storage (no cross-instance leakage)", async () => {
    const first = await connectInProcess();
    try {
      await first.client.callTool({
        name: "ingest",
        arguments: { content: "isolated payload", source_ref: "test://iso" },
      });
    } finally {
      await first.close();
    }

    const second = await connectInProcess();
    try {
      const result = await second.client.callTool({
        name: "retrieve",
        arguments: { query: "isolated payload" },
      });
      const { chunks } = JSON.parse(textOf(result)) as { chunks: unknown[] };
      expect(chunks).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("ingest surfaces handler errors as isError results", async () => {
    const { client, close } = await connectInProcess();
    try {
      // valid_from >= valid_until is a semantic (not schema) violation, so
      // it reaches the handler and comes back through registerOne's catch.
      const result = await client.callTool({
        name: "ingest",
        arguments: {
          content: "reversed window",
          source_ref: "test://bad-window",
          valid_from: "2030-01-02T00:00:00.000Z",
          valid_until: "2030-01-01T00:00:00.000Z",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/valid_from must be strictly before/);
    } finally {
      await close();
    }
  });
});
