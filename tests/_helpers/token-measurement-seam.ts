/**
 * Shared capture shape + assertions for the two assembly-time token
 * measurement gates:
 *   - ADR-0043 built-in tool overflow judge
 *   - ADR-0046 MCP + skill index demotion
 *
 * Converges the two per-file copies in:
 *   - tests/harness/build-engine-tool-overflow.test.ts
 *   - tests/harness/disclosure-index-align/sc7-index-demotion.test.ts
 *
 * Both gates measure through the same `buildHarnessEngine({ countTokens })`
 * seam, and both pin the same two wire facts, so those live here:
 *   - every measurement carries exactly one non-empty stand-in user turn.
 *     Anthropic-compatible gateways reject `messages: []` (error 2013), so an
 *     empty array does not fail loudly — it silently disables the gate and the
 *     overflow/demotion behaviour under test never runs;
 *   - a seam that succeeded leaves no skip noise on either gate
 *     ("overflow judge skipped" / "index demotion skipped").
 *
 * Each gate's *own* measured surface stays asserted at the call site (the
 * builtin ladder carries `tools` + system text, the index gate carries only
 * the two rendered index segments): those differ by design and are not
 * duplication. Unlike `tests/session-api/_helpers/llm-capture.ts`, where each
 * call site proves different wire facts, here the wire facts are identical, so
 * converging them also converges the assertion.
 */
import { expect } from "vitest";

/** One `countTokens` request as seen by the assembly-time measurement seam. */
export interface TokenSeamMeasurement {
  readonly tools?: ReadonlyArray<unknown>;
  readonly system?: string;
  readonly messages?: ReadonlyArray<{
    readonly role: string;
    readonly content: ReadonlyArray<unknown>;
  }>;
}

/**
 * Assert every captured measurement is a gateway-reachable request: exactly one
 * stand-in `user` turn carrying one non-empty text block.
 */
export function assertStandInUserTurns(
  measurements: readonly TokenSeamMeasurement[]
): void {
  // Non-emptiness is part of the contract: without it a seam that was never
  // called would satisfy the loop below vacuously.
  expect(
    measurements.length,
    "countTokens seam captured nothing"
  ).toBeGreaterThan(0);
  for (const call of measurements) {
    expect(call.messages, `input=${JSON.stringify(call)}`).toHaveLength(1);
    expect(call.messages![0]!.role).toBe("user");
    const block = call.messages![0]!.content[0] as
      { type?: string; text?: string } | undefined;
    expect(block?.type).toBe("text");
    expect(typeof block?.text).toBe("string");
    expect(block!.text!.length).toBeGreaterThan(0);
  }
}

/** Assert neither first-turn gate reported a skip on the console.warn surface. */
export function assertNoGateSkipWarnings(warnings: readonly string[]): void {
  expect(
    warnings.filter(
      (w) =>
        w.includes("overflow judge skipped") ||
        w.includes("index demotion skipped")
    ),
    `warnings=${JSON.stringify(warnings)}`
  ).toEqual([]);
}
