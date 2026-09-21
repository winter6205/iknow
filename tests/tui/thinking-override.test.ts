/**
 * tests/tui/thinking-override.test.ts
 *
 * Pure-function unit tests for thinking-gate.ts (bun:test; no React
 * dependency — a standalone module avoids the app.tsx import chain pulling in
 * the renderer). Reviewer "Spec Low#3": extracting runTurnOnce's
 * stateChanged / override decision makes it independently verifiable.
 */
import { describe, expect, test } from "bun:test";
import {
  computeThinkingOverride,
  formatEffortLabel,
} from "../../src/tui/thinking-gate.js";
import type { ThinkingEffortWire } from "../../src/session-api/contract.js";

/** Minimal defaultThinking projection: default{adaptive,""} = {mode:"adaptive", effort:""}. */
const ADAPTIVE_EMPTY = { mode: "adaptive", effort: "" } as const;
const OFF_EMPTY = { mode: "off", effort: "" } as const;
const ADAPTIVE_HIGH = { mode: "adaptive", effort: "high" } as const;

describe("computeThinkingOverride: 档位/开关 vs env 默认 → wire override", () => {
  test('default={adaptive,""} + enabled=true + effort="low" → {mode:adaptive, effort:low}', () => {
    expect(
      computeThinkingOverride(ADAPTIVE_EMPTY, true, "low" as ThinkingEffortWire)
    ).toEqual({ mode: "adaptive", effort: "low" });
  });

  test('default={adaptive,""} + enabled=false + effort="" → {mode:off}', () => {
    expect(
      computeThinkingOverride(ADAPTIVE_EMPTY, false, "" as ThinkingEffortWire)
    ).toEqual({ mode: "off" });
  });

  test('default={off,""} + enabled=false + effort="" → undefined（cached path）', () => {
    expect(
      computeThinkingOverride(OFF_EMPTY, false, "" as ThinkingEffortWire)
    ).toBeUndefined();
  });

  test('default={off,""} + enabled=true + effort="high" → {mode:adaptive, effort:high}', () => {
    expect(
      computeThinkingOverride(OFF_EMPTY, true, "high" as ThinkingEffortWire)
    ).toEqual({ mode: "adaptive", effort: "high" });
  });

  test('default={off,""} + enabled=false + effort="high" → undefined（disabled 时 effort 维度被 enabled 覆盖）', () => {
    expect(
      computeThinkingOverride(OFF_EMPTY, false, "high" as ThinkingEffortWire)
    ).toBeUndefined();
  });

  test('default={adaptive,high} + enabled=true + effort="high" → undefined（无实际变更）', () => {
    expect(
      computeThinkingOverride(ADAPTIVE_HIGH, true, "high" as ThinkingEffortWire)
    ).toBeUndefined();
  });

  test('default 缺省(undefined) + enabled=false + effort="" → undefined', () => {
    expect(
      computeThinkingOverride(undefined, false, "" as ThinkingEffortWire)
    ).toBeUndefined();
  });
});

describe("formatEffortLabel", () => {
  test('"" → "auto"', () => {
    expect(formatEffortLabel("" as ThinkingEffortWire)).toBe("auto");
  });

  test("其余档位原样（low / high / max）", () => {
    expect(formatEffortLabel("low" as ThinkingEffortWire)).toBe("low");
    expect(formatEffortLabel("high" as ThinkingEffortWire)).toBe("high");
    expect(formatEffortLabel("max" as ThinkingEffortWire)).toBe("max");
  });
});
