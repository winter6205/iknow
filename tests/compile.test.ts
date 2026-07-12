import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { kbCompile } from "../src/kb-compile/compile.ts";
import { sha256Hex } from "../src/shared/hash.ts";

describe("kb_compile", () => {
  it("content_hash dedups second compile of same content", () => {
    const store = createSeededStore();
    const content = store.getChunk("chunk-expense").text;
    const hash = sha256Hex(content);

    const first = kbCompile(store, {
      doc_id: "fin-expense",
      content,
      content_hash: hash,
      document_version: "2026.1",
    });
    assert.ok(first.facts.length > 0);
    assert.ok(["ok", "partial"].includes(first.compile_status));

    const factCountAfterFirst = store.listFacts().length;

    const second = kbCompile(store, {
      doc_id: "fin-expense",
      content,
      content_hash: hash,
      document_version: "2026.1",
    });
    assert.equal(second.compile_status, "ok");
    assert.ok(second.facts.length > 0);
    // dedup: no additional facts written for same content_hash
    assert.equal(store.listFacts().length, factCountAfterFirst);
  });

  it("facts link chunk_version from source chunks", () => {
    const store = createSeededStore();
    const chunk = store.getChunk("chunk-leave");
    // No inline content: extraction uses store chunks so source_chunk_id links.
    const hash = sha256Hex(chunk.text);

    const out = kbCompile(store, {
      doc_id: "hr-leave",
      content_hash: hash,
      document_version: "2026.2",
    });

    assert.ok(out.facts.length > 0);
    for (const fact of out.facts) {
      assert.ok(fact.chunk_version, "chunk_version required on fact");
      assert.equal(fact.source_chunk_id, chunk.chunk_id);
      assert.equal(fact.chunk_version, chunk.chunk_version);
      assert.equal(fact.source_doc_id, "hr-leave");
    }

    // store records also retain chunk_version
    for (const stored of store.listFactsForChunk(chunk.chunk_id)) {
      assert.equal(stored.chunk_version, chunk.chunk_version);
      assert.equal(stored.content_hash, hash);
    }
  });

  it("content_hash mismatch throws ValidationError unless force", () => {
    const store = createSeededStore();
    assert.throws(
      () =>
        kbCompile(store, {
          doc_id: "fin-expense",
          content: "something else entirely",
          content_hash: "deadbeefdeadbeef",
          document_version: "2026.1",
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.name === "ValidationError" &&
        /content_hash/.test(err.message),
    );
  });
});
