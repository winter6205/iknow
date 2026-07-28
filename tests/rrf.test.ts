import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { rrfFusion, RRF_K } from "../src/kb-retrieve/rrf.ts";

describe("rrfFusion", () => {
  it("uses RRF_K = 60", async () => {
    assert.equal(RRF_K, 60);
  });

  it("ranks shared id higher than single-list hits", async () => {
    const fused = rrfFusion(
      [
        [
          { id: "a", score: 1 },
          { id: "b", score: 0.5 },
        ],
        [
          { id: "b", score: 1 },
          { id: "c", score: 0.5 },
        ],
      ],
      RRF_K,
    );
    assert.ok(fused.length >= 2);
    assert.equal(fused[0]!.id, "b");
    // b appears in both lists → higher fused score than a or c
    const scoreB = fused.find((h) => h.id === "b")!.score;
    const scoreA = fused.find((h) => h.id === "a")!.score;
    const scoreC = fused.find((h) => h.id === "c")!.score;
    assert.ok(scoreB > scoreA);
    assert.ok(scoreB > scoreC);
    // normalized max = 1
    assert.equal(fused[0]!.score, 1);
  });

  it("returns empty for empty lists", async () => {
    assert.deepEqual(rrfFusion([]), []);
    assert.deepEqual(rrfFusion([[], []]), []);
  });

  it("handles single list", async () => {
    const fused = rrfFusion([[{ id: "only", score: 9 }]]);
    assert.equal(fused.length, 1);
    assert.equal(fused[0]!.id, "only");
    assert.equal(fused[0]!.score, 1);
  });
});
