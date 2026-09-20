// Offline half of the soul/usage 轨迹集 (ADR-0117). Locks the
// fixture roster, the vacuity guard, the deciding-tool semantics, and the
// STATIC contracts the set stands on. The model-running half is
// archive/tests-real-llm/tool-role-substitution.test.ts (npm run test:real-llm).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IKNOW_USAGE_DEFAULT } from "../../../src/harness/identity/usage.ts";
import { SYMBOL_QUERY_TOOL_NAMES } from "../../../src/harness/aci/tools/role-substitution.ts";
import {
  FORBIDDEN_PROMPT_TOKENS,
  ROLE_SUBSTITUTION_PREFIX,
  SOUL_USAGE_CASES,
  SYMBOL_QUERY_SURFACE,
  soulUsageDecidingToolIndex,
  type SoulUsageCase,
} from "./soul-usage-symbol-first.fixtures.ts";

function expectShape(c: SoulUsageCase) {
  expect(c.id.trim(), "case id").not.toBe("");
  expect(c.title.trim(), "case title").not.toBe("");
  expect(c.userPrompt.trim(), "case userPrompt").not.toBe("");
  expect(c.spec.trim(), "case spec").not.toBe("");
  expect(c.userPrompt.trim().length, "prompt bounded").toBeLessThanOrEqual(1024);
}

describe("soul/usage golden set fixture roster", () => {
  it("carries >=3 structure-question cases and >=1 shell-tempting case", () => {
    const tempting = SOUL_USAGE_CASES.filter((c) =>
      c.toleratedPreludeTools.includes("bash"),
    );
    expect(SOUL_USAGE_CASES.length).toBeGreaterThanOrEqual(4);
    expect(tempting.length).toBeGreaterThanOrEqual(1);
    expect(SOUL_USAGE_CASES.length - tempting.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps unique ids and well-shaped cases", () => {
    for (const c of SOUL_USAGE_CASES) expectShape(c);
    const ids = SOUL_USAGE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("requires the deciding tool to be a query-side symbol name, never bash or grep", () => {
    for (const c of SOUL_USAGE_CASES) {
      expect(SYMBOL_QUERY_SURFACE).toContain(c.expectedFirstTool);
      expect(c.toleratedPreludeTools).not.toContain(c.expectedFirstTool);
      // bash/grep as the deciding tool would make the case self-contradictory.
      expect(c.expectedFirstTool).not.toBe("bash");
      expect(c.expectedFirstTool).not.toBe("grep");
    }
  });

  it("never names a tool or technique in a prompt (vacuity guard)", () => {
    for (const c of SOUL_USAGE_CASES) {
      for (const forbidden of FORBIDDEN_PROMPT_TOKENS) {
        expect(
          c.userPrompt.includes(forbidden),
          `${c.id} prompt must not leak token "${forbidden}"`,
        ).toBe(false);
      }
    }
  });
});

describe("soul/usage golden set deciding-tool semantics", () => {
  it("skips role-refused dispatches: a refused attempt is enforcement success, not a decision", () => {
    expect(
      soulUsageDecidingToolIndex(
        [
          { name: "bash", refused: true },
          { name: "grep", refused: true },
          { name: "find_symbol", refused: false },
        ],
        [],
      ),
    ).toBe(2);
  });

  it("treats a non-refused, untolerated dispatch outside the surface before any surface hit as a fixture failure", () => {
    expect(
      soulUsageDecidingToolIndex(
        [
          { name: "bash", refused: false },
          { name: "find_symbol", refused: false },
        ],
        [],
      ),
    ).toBeUndefined();
    // An effective ACI grep deciding the case is the false-positive the ADR
    // refuses — toleratedPreludeTools must not silently cover it.
    expect(
      soulUsageDecidingToolIndex(
        [
          { name: "grep", refused: false },
          { name: "find_symbol", refused: false },
        ],
        [],
      ),
    ).toBeUndefined();
  });

  it("skips only the tolerated prelude to find the deciding dispatch", () => {
    expect(
      soulUsageDecidingToolIndex(
        [
          { name: "bash", refused: false },
          { name: "bash", refused: false },
          { name: "find_symbol", refused: false },
        ],
        ["bash"],
      ),
    ).toBe(2);
  });

  it("accepts any surface member as the deciding dispatch, not one canonical tool", () => {
    expect(
      soulUsageDecidingToolIndex([{ name: "find_referencing_symbols", refused: false }], []),
    ).toBe(0);
    expect(
      soulUsageDecidingToolIndex([{ name: "get_symbols_overview", refused: false }], []),
    ).toBe(0);
  });

  it("returns -1 when no effective dispatch exists (all refused or all tolerated)", () => {
    expect(
      soulUsageDecidingToolIndex(
        [
          { name: "bash", refused: true },
          { name: "grep", refused: true },
        ],
        [],
      ),
    ).toBe(-1);
    expect(
      soulUsageDecidingToolIndex([{ name: "bash", refused: false }], ["bash"]),
    ).toBe(-1);
    expect(soulUsageDecidingToolIndex([], [])).toBe(-1);
  });
});

describe("soul/usage golden set STATIC locks", () => {
  it("pins the refusal-tag literal without importing the gate module", () => {
    // The fixtures stay an independent contract witness (no gate import);
    // the seam tests below bind witness to implementation, so drift on
    // either side fails here instead of diverging silently.
    expect(ROLE_SUBSTITUTION_PREFIX).toBe("[role_substitution]");
  });

  it("pins the ten-name query-side symbol surface (docs/CONTEXT.md 符号工具面)", () => {
    expect(SYMBOL_QUERY_SURFACE).toEqual([
      "find_symbol",
      "find_declaration",
      "find_referencing_symbols",
      "find_implementations",
      "get_symbols_overview",
      "get_diagnostics_for_file",
      "prepare_call_hierarchy",
      "list_incoming_calls",
      "list_outgoing_calls",
      "get_hover",
    ]);
  });

  it("keeps the usage contract's fallback framing that the set routes against", () => {
    expect(IKNOW_USAGE_DEFAULT).toContain("three fallback situations");
    expect(IKNOW_USAGE_DEFAULT).toContain("do not start with grep");
    expect(IKNOW_USAGE_DEFAULT).toContain(
      "Do not use grep as the first move for code structure",
    );
  });

  it("keeps the usage face free of any import from the detection face", () => {
    // ADR-0117 Decision 1: enforcement lives in the gate, never in the
    // usage text — a text constant must not pull the gate module into identity.
    const source = readFileSync(
      fileURLToPath(new URL("../../../src/harness/identity/usage.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("role-substitution");
  });
});

describe("soul/usage golden set seam locks (fixture witness vs gate tables)", () => {
  it("binds the fixture query surface to the gate module's query-side table", () => {
    // Set equality, not shared import: each side stays an independent
    // witness, and either table drifting fails this seam.
    expect([...SYMBOL_QUERY_SURFACE].sort()).toEqual([...SYMBOL_QUERY_TOOL_NAMES].sort());
  });

  it("binds the fixture refusal tag to the gate module's prefix constant", async () => {
    const gate = await import("../../../src/harness/aci/tools/role-substitution.ts");
    expect(ROLE_SUBSTITUTION_PREFIX).toBe(gate.ROLE_SUBSTITUTION_PREFIX);
  });
});
