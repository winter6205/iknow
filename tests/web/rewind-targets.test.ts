/**
 * Web rewind 锚点投影：对齐 TUI buildRewindTargets（keepTurns=0 总在；
 * 当前最后一 turn 作为 keepTurns=total 不列出）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildRewindTargetsFromTurns } from "../../web/src/lib/rewind-targets.ts";

describe("buildRewindTargetsFromTurns", () => {
  it("空会话 → 空数组", () => {
    assert.deepEqual(buildRewindTargetsFromTurns([]), []);
  });

  it("一回合：仅 keepTurns=0（截空）", () => {
    const t = buildRewindTargetsFromTurns([{ query: "hello" }]);
    assert.equal(t.length, 1);
    assert.equal(t[0]?.keepTurns, 0);
    assert.equal(t[0]?.label, "hello");
  });

  it("三回合：keepTurns 0,1,2（不含 no-op 的 3）", () => {
    const t = buildRewindTargetsFromTurns([
      { query: "a" },
      { query: "b" },
      { query: "c" },
    ]);
    assert.deepEqual(
      t.map((x) => x.keepTurns),
      [0, 1, 2]
    );
    assert.equal(t[2]?.label, "c");
  });
});
