/**
 * Public-export + Gate B capability gate smoke test.
 *
 * Pinned criteria:
 *   - src/harness/index.ts publicly exports the Foundation-owned runtime
 *     entries: run / createLoopEngine / createAnthropicAdapter and friends;
 *   - src/harness/ carries no Gate B capabilities (retry / cancel / timeout /
 *     trace / checkpoint / concurrency scheduling were all barred at the gate);
 *   - cancel / timeout / trace / setTimeout / AbortController are later
 *     authorized as the physically-necessary layer; the guard tracks the
 *     conditional-repair layer instead — checkpoint persistence, token-cost
 *     guardrails, and early OTel export into the kernel stay banned (scan the
 *     executable surface, not comment wording);
 *   - the FaultClass closed set includes `retry`, so that identifier is
 *     allowed on the executable surface;
 *   - ADR-0008 (accepted): the TokenUsage domain type is authorized as an
 *     observability field on the display path; token-cost guardrails (runtime
 *     ledger / CostTracker) remain banned — ADR-0008 Decision 1 explicitly
 *     rejects them.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as harness from "../../src/harness/index.ts";
import { findGateBViolations } from "./gate-b-capability.ts";
import type { GateBViolation } from "./gate-b-capability.ts";

const HARNESS_DIR = join(import.meta.dirname, "..", "..", "src", "harness");

function listHarnessSource(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(HARNESS_DIR);
  return out;
}

describe("T12 public exports + Gate B gate", () => {
  it("public exports run / createLoopEngine / createRegistry / createExecutor / createAnthropicAdapter", () => {
    assert.equal(typeof harness.run, "function");
    assert.equal(typeof harness.createLoopEngine, "function");
    assert.equal(typeof harness.createRegistry, "function");
    assert.equal(typeof harness.createExecutor, "function");
    assert.equal(typeof harness.createAnthropicAdapter, "function");
    assert.equal(typeof harness.createStubModel, "function");
    assert.equal(typeof harness.createStubTool, "function");
  });

  it("errors are exported and mutually distinguishable", () => {
    assert.equal(typeof harness.RegistryConstructionError, "function");
    assert.equal(typeof harness.ProtocolError, "function");
    assert.equal(typeof harness.ToolExecutionError, "function");
    const r = new harness.RegistryConstructionError("x");
    const p = new harness.ProtocolError("y");
    assert.ok(r instanceof harness.RegistryConstructionError);
    assert.ok(!(p instanceof harness.RegistryConstructionError));
  });

  it("条件式修复层:src/harness/ executable surface has no checkpoint/cost/OTel/session-api leaks", () => {
    const files = listHarnessSource();
    assert.ok(files.length > 0, "expected harness source files");
    const violations: Array<{ file: string } & GateBViolation> = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const hit of findGateBViolations(src)) {
        violations.push({ file: f, ...hit });
      }
    }
    if (violations.length > 0) {
      const msg = violations
        .map((v) => `${v.file}:${v.line} (${v.keyword}) ${v.snippet}`)
        .join("\n");
      throw new Error(`Gate B capability violations found:\n${msg}`);
    }
  });
});
