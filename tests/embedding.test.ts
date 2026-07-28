import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  FakeEmbeddingClient,
  VectorIndex,
  cosine,
  l2normalize,
  resetVectorIndexForTests,
} from "../src/kb-retrieve/embedding/index.ts";
import { createIknowRuntime } from "../src/runtime/create-runtime.ts";

describe("FakeEmbeddingClient", () => {
  it("produces unit-length vectors with self cosine ~1", async () => {
    const client = new FakeEmbeddingClient(32);
    const [v] = await client.embed(["enterprise knowledge base policy"]);
    assert.ok(v);
    assert.equal(v.length, 32);
    let normSq = 0;
    for (const x of v) normSq += x * x;
    assert.ok(Math.abs(Math.sqrt(normSq) - 1) < 1e-9);
    assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
  });

  it("is deterministic for the same input", async () => {
    const client = new FakeEmbeddingClient(16);
    const a = await client.embed(["same text twice"]);
    const b = await client.embed(["same text twice"]);
    assert.deepEqual(a, b);
  });

  it("l2normalize zeros to safe unit vector", async () => {
    const z = l2normalize([0, 0, 0]);
    assert.equal(z.length, 3);
    // zero input → n=1 fallback → stays zero; callers treat as empty
    assert.deepEqual(z, [0, 0, 0]);
  });
});

describe("VectorIndex", () => {
  it("ranks identical text higher than unrelated", async () => {
    const client = new FakeEmbeddingClient(64);
    const index = new VectorIndex(client);

    await index.ensureChunks([
      {
        chunk_id: "c-match",
        text: "vacation leave policy requires manager approval",
        summary: "vacation leave policy",
      },
      {
        chunk_id: "c-noise",
        text: "office coffee machine cleaning schedule weekly",
        summary: "facilities cleaning",
      },
    ]);

    assert.equal(index.has("c-match"), true);
    assert.equal(index.has("c-missing"), false);
    assert.equal(index.size, 2);

    const ranked = await index.rankQuery(
      "vacation leave policy requires manager approval",
      10,
    );
    assert.ok(ranked.length >= 1);
    assert.equal(ranked[0]!.id, "c-match");
    const match = ranked.find((r) => r.id === "c-match")!;
    const noise = ranked.find((r) => r.id === "c-noise");
    assert.ok(match.score > 0.9);
    if (noise) {
      assert.ok(match.score > noise.score);
    }
  });

  it("re-embeds only missing chunk_ids", async () => {
    let embedCalls = 0;
    const base = new FakeEmbeddingClient(16);
    const counting: typeof base = {
      dims: base.dims,
      embed: async (texts) => {
        embedCalls += 1;
        return base.embed(texts);
      },
    };
    const index = new VectorIndex(counting);
    const chunks = [
      { chunk_id: "a", text: "alpha", summary: "a" },
      { chunk_id: "b", text: "beta", summary: "b" },
    ];
    await index.ensureChunks(chunks);
    const afterFirst = embedCalls;
    await index.ensureChunks(chunks);
    assert.equal(embedCalls, afterFirst, "second ensure should not re-embed");
    await index.ensureChunks([
      ...chunks,
      { chunk_id: "c", text: "gamma", summary: "c" },
    ]);
    assert.equal(embedCalls, afterFirst + 1);
    assert.equal(index.has("c"), true);
  });

  it("clear empties the index", async () => {
    const index = new VectorIndex(new FakeEmbeddingClient(8));
    await index.ensureChunks([
      { chunk_id: "x", text: "hello", summary: "h" },
    ]);
    index.clear();
    assert.equal(index.size, 0);
    assert.equal(index.has("x"), false);
    const ranked = await index.rankQuery("hello");
    assert.deepEqual(ranked, []);
  });
});

describe("createIknowRuntime embeddings wiring", () => {
  it("enableEmbeddings:false leaves vectorIndex undefined (CI path)", async () => {
    resetVectorIndexForTests();
    const rt = await createIknowRuntime({ enableEmbeddings: false });
    assert.equal(rt.vectorIndex, undefined);
    assert.ok(rt.store.listChunks().length > 0);
  });

  it("forceFakeEmbeddings indexes seed chunks offline", async () => {
    resetVectorIndexForTests();
    const rt = await createIknowRuntime({ forceFakeEmbeddings: true });
    assert.ok(rt.vectorIndex, "expected fake vector index");
    assert.ok(rt.vectorIndex!.size > 0);
    const ranked = await rt.vectorIndex!.rankQuery("退款政策");
    assert.ok(ranked.length > 0);
  });
});
