import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { kbRetrieve } from "../src/kb-retrieve/retrieve.ts";
import { kbCompile } from "../src/kb-compile/compile.ts";
import { createSession } from "../src/agent-loop/session.ts";
import { sha256Hex } from "../src/shared/hash.ts";
import { ValidationError } from "../src/shared/errors.ts";

describe("kb_retrieve", () => {
  it("keyword hit returns refund policy chunk", async () => {
    const store = createSeededStore();
    const out = await kbRetrieve(
      store,
      { query: "公司的退款政策是什么？" },
      createSession("employee"),
    );
    assert.ok(out.chunks.length > 0, "expected non-empty chunks");
    assert.ok(
      out.chunks.some(
        (c) =>
          c.chunk_id.includes("refund") ||
          /退款|30天/.test(c.summary) ||
          /退款/.test(c.doc_id),
      ),
      `expected refund-related hit, got ${out.chunks.map((c) => c.chunk_id).join(",")}`,
    );
  });

  it("fact text is never present in retrieve output", async () => {
    const store = createSeededStore();
    const content = store.getChunk("chunk-expense").text;
    kbCompile(store, {
      doc_id: "fin-expense",
      content,
      content_hash: sha256Hex(content),
      document_version: "2026.1",
    });

    const out = await kbRetrieve(
      store,
      { query: "报销流程", index: "both" },
      createSession("employee"),
    );
    assert.ok(out.chunks.length > 0);
    for (const c of out.chunks) {
      const keys = Object.keys(c);
      assert.equal(keys.includes("fact_text"), false);
      assert.equal(keys.includes("facts"), false);
      assert.equal(keys.includes("entity"), false);
      assert.equal(keys.includes("attributes"), false);
      assert.ok(c.chunk_id);
      assert.ok(c.summary);
      assert.ok(["compiled", "outdated", "missing"].includes(c.fact_status));
      const json = JSON.stringify(c);
      assert.equal(json.includes('"fact_text"'), false);
    }
  });

  it("freshness filter keeps only fresh docs when requested", async () => {
    const store = createSeededStore();
    const out = await kbRetrieve(
      store,
      {
        query: "年假",
        filter: { freshness_level: "fresh" },
      },
      createSession("employee"),
    );
    for (const c of out.chunks) {
      const doc = store.getDocument(c.doc_id);
      assert.equal(doc.freshness, "fresh", c.doc_id);
    }
    assert.equal(
      out.chunks.some((c) => c.chunk_id === "chunk-leave-2026-old"),
      false,
    );
  });

  it("permission filter hides competitor_external for non-admin", async () => {
    const store = createSeededStore();
    const employeeOut = await kbRetrieve(
      store,
      { query: "竞对 薪酬" },
      createSession("employee"),
    );
    assert.equal(
      employeeOut.chunks.some((c) => c.doc_id === "competitor-pay"),
      false,
      "employee must not see competitor_external",
    );

    const adminOut = await kbRetrieve(
      store,
      { query: "竞对 薪酬" },
      createSession("admin"),
    );
    assert.ok(
      adminOut.chunks.some((c) => c.doc_id === "competitor-pay"),
      "admin should see competitor_external chunk",
    );
  });

  it("rejects empty query", async () => {
    const store = createSeededStore();
    await assert.rejects(
      () => kbRetrieve(store, { query: "   " }, createSession()),
      (e: unknown) => e instanceof ValidationError,
    );
  });
});
