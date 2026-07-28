/**
 * T12 public-export + Gate B capability gate smoke test.
 *
 * Success Criteria 16 (spec):
 *   - src/harness/index.ts 公共导出 run / createLoopEngine /
 *     createAnthropicAdapter 等 Foundation 自治运行时入口;
 *   - src/harness/ 不含 Gate B 能力(重试 / 取消 / 超时 / trace /
 *     checkpoint / 并发调度)。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as harness from "../../src/harness/index.ts";

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

  it("Gate B capability gate: src/harness/ source has no retry/cancel/timeout/trace/checkpoint/concurrency keywords", () => {
    const files = listHarnessSource();
    assert.ok(files.length > 0, "expected harness source files");
    const violations: Array<{ file: string; line: number; keyword: string; snippet: string }> = [];
    const keywords = ["retry", "cancel", "timeout", "trace", "checkpoint", "AbortController", "setTimeout", "withResolvers"];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        const lower = line.toLowerCase();
        for (const kw of keywords) {
          if (lower.includes(kw.toLowerCase())) {
            const isDoc = /Gate B|rejects?|deferred|explicitly.*not|never.*build|never.*pre-?build/i.test(line);
            if (!isDoc) {
              violations.push({ file: f, line: idx + 1, keyword: kw, snippet: line.trim() });
            }
          }
        }
      });
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `${v.file}:${v.line} (${v.keyword}) ${v.snippet}`).join("\n");
      throw new Error(`Gate B capability violations found:\n${msg}`);
    }
  });
});