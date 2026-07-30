import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeEmbedder, NineRouterEmbedder } from "../src/core/embedder.ts";
import { GraphragError } from "../src/core/errors.ts";

/** Test dimension — injected into both embedders; the actual value is arbitrary. */
const TEST_DIM = 1536;

describe("FakeEmbedder", () => {
  it("returns deterministic vectors of the configured dimension", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    const vectors = await embedder.embed(["hello world"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(TEST_DIM);
  });

  it("is deterministic: same input produces the same vector", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    const a = await embedder.embed(["repeatable text"]);
    const b = await embedder.embed(["repeatable text"]);
    expect(a).toEqual(b);
  });

  it("produces different vectors for different inputs", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    const a = await embedder.embed(["alpha"]);
    const b = await embedder.embed(["beta"]);
    expect(a).not.toEqual(b);
  });

  it("batch embed and single embed produce the same vector for the same text", async () => {
    const embedder = new FakeEmbedder(TEST_DIM);
    const batch = await embedder.embed(["same", "different"]);
    const single = await embedder.embed(["same"]);
    expect(batch[0]).toEqual(single[0]);
    expect(batch).toHaveLength(2);
    expect(single).toHaveLength(1);
  });
});

describe("NineRouterEmbedder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws GraphragError with code EMBEDDING_DIM_MISMATCH on wrong dimension", async () => {
    const wrongDimVector = new Array(512).fill(0.1);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: wrongDimVector }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new NineRouterEmbedder({
      baseUrl: "https://api.example.test/v1",
      model: "test-embed-model",
      apiKey: "sk-test",
      dimensions: TEST_DIM,
    });
    await expect(embedder.embed(["hi"])).rejects.toBeInstanceOf(GraphragError);
    await expect(embedder.embed(["hi"])).rejects.toMatchObject({
      code: "EMBEDDING_DIM_MISMATCH",
    });
  });

  it("throws GraphragError with code EMBEDDING_FAILED on HTTP 500", async () => {
    const fetchMock = vi.fn(
      async () => new Response("internal server error", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new NineRouterEmbedder({
      baseUrl: "https://api.example.test/v1",
      model: "test-embed-model",
      apiKey: "sk-test",
      dimensions: TEST_DIM,
    });
    await expect(embedder.embed(["hi"])).rejects.toBeInstanceOf(GraphragError);
    await expect(embedder.embed(["hi"])).rejects.toMatchObject({
      code: "EMBEDDING_FAILED",
    });
  });

  it("posts to <baseUrl>/embeddings (base already contains /v1) and parses the response", async () => {
    const validVector = new Array(TEST_DIM).fill(0).map((_, i) => i * 0.001);
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          input: string[];
          model: string;
          dimensions?: number;
        };
        expect(body.model).toBe("test-embed-model");
        expect(body.input).toEqual(["a", "b"]);
        expect(body.dimensions).toBe(TEST_DIM);
        return new Response(
          JSON.stringify({
            data: [{ embedding: validVector }, { embedding: validVector }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new NineRouterEmbedder({
      baseUrl: "https://api.example.test/v1",
      model: "test-embed-model",
      apiKey: "sk-test",
      dimensions: TEST_DIM,
    });
    const result = await embedder.embed(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(validVector);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Base URL contains /v1; only /embeddings is appended.
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("https://api.example.test/v1/embeddings");
  });

  it("strips a trailing slash from baseUrl before appending /embeddings", async () => {
    const validVector = new Array(TEST_DIM).fill(0.1);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: validVector }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new NineRouterEmbedder({
      baseUrl: "https://api.example.test/v1/",
      model: "test-embed-model",
      apiKey: "sk-test",
      dimensions: TEST_DIM,
    });
    await embedder.embed(["hi"]);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("https://api.example.test/v1/embeddings");
  });
});
