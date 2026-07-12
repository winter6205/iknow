import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { kbVerifyCitation } from "../src/kb-verify/verify.ts";

const THREE_STATES = new Set([
  "supported",
  "partially_supported",
  "unsupported",
]);

describe("kb_verify_citation", () => {
  it("returns supported when claim is grounded in chunk text", async () => {
    const store = createSeededStore();
    const out = kbVerifyCitation(store, {
      claim: "客户可在收货后30天内申请全额退款",
      source_span: {
        chunk_id: "chunk-refund-30",
        quote: "客户可在收货后30天内申请全额退款",
      },
    });
    assert.equal(out.verdict, "supported");
    assert.ok(out.chunk_version);
    assert.equal(
      Object.prototype.hasOwnProperty.call(out, "confidence"),
      false,
      "must not emit continuous confidence",
    );
  });

  it("returns unsupported when claim is not grounded", async () => {
    const store = createSeededStore();
    const out = kbVerifyCitation(store, {
      claim: "公司提供终身免费保修和火星配送服务",
      source_span: { chunk_id: "chunk-refund-30" },
    });
    assert.equal(out.verdict, "unsupported");
    assert.ok(out.evidence_span);
    assert.equal(
      Object.prototype.hasOwnProperty.call(out, "confidence"),
      false,
    );
  });

  it("verdict is three-state only (no confidence field)", () => {
    const store = createSeededStore();
    const cases = [
      {
        claim: "试用期为3个月",
        source_span: {
          chunk_id: "chunk-onboard",
          quote: "试用期为3个月",
        },
      },
      {
        claim: "年假可能和加班有关但说法模糊",
        source_span: { chunk_id: "chunk-leave" },
      },
      {
        claim: "全员强制每周工作90小时",
        source_span: { chunk_id: "chunk-leave" },
      },
    ];
    for (const input of cases) {
      const out = kbVerifyCitation(store, input);
      assert.ok(
        THREE_STATES.has(out.verdict),
        `unexpected verdict ${out.verdict}`,
      );
      assert.equal("confidence" in out, false);
      const json = JSON.stringify(out);
      assert.equal(json.includes("confidence"), false);
    }
  });
});
