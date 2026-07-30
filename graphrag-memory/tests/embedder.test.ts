import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeEmbedder, NineRouterEmbedder } from "../src/core/embedder.ts";
import { EMBEDDING_DIM, GraphragError } from "../src/core/errors.ts";

describe("FakeEmbedder", () => {
  it("returns deterministic 1536-dim vectors", async () => {
    const embedder = new FakeEmbedder();
    const vectors = await embedder.embed(["hello world"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIM);
  });

  it("is deterministic: same input produces the same vector", async () => {
    const embedder = new FakeEmbedder();
    const a = await embedder.embed(["repeatable text"]);
    const b = await embedder.embed(["repeatable text"]);
    expect(a).toEqual(b);
  });

  it("produces different vectors for different inputs", async () => {
    const embedder = new FakeEmbedder();
    const a = await embedder.embed(["alpha"]);
    const b = await embedder.embed(["beta"]);
    expect(a).not.toEqual(b);
  });

  it("batch embed and single embed produce the same vector for the same text", async () => {
    const embedder = new FakeEmbedder();
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

    const embedder = new NineRouterEmbedder(
      "https://api.example.test",
      "text-embedding-3-small",
      "sk-test"
    );
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

    const embedder = new NineRouterEmbedder(
      "https://api.example.test",
      "text-embedding-3-small",
      "sk-test"
    );
    await expect(embedder.embed(["hi"])).rejects.toBeInstanceOf(GraphragError);
    await expect(embedder.embed(["hi"])).rejects.toMatchObject({
      code: "EMBEDDING_FAILED",
    });
  });

  it("posts to <baseUrl>/v1/embeddings and parses the response", async () => {
    const validVector = new Array(EMBEDDING_DIM)
      .fill(0)
      .map((_, i) => i * 0.001);
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          input: string[];
          model: string;
        };
        expect(body.model).toBe("text-embedding-3-small");
        expect(body.input).toEqual(["a", "b"]);
        return new Response(
          JSON.stringify({
            data: [{ embedding: validVector }, { embedding: validVector }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new NineRouterEmbedder(
      "https://api.example.test",
      "text-embedding-3-small",
      "sk-test"
    );
    const result = await embedder.embed(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(validVector);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("https://api.example.test/v1/embeddings");
  });
});
