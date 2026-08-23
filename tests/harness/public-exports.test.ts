/**
 * T12 public-export + Gate B capability gate smoke test.
 *
 * Success Criteria 16 (spec):
 *   - src/harness/index.ts 公共导出 run / createLoopEngine /
 *     createAnthropicAdapter 等 Foundation 自治运行时入口;
 *   - 016:src/harness/ 不含 Gate B 能力(当时禁:重试 / 取消 / 超时 /
 *     trace / checkpoint / 并发调度)。
 *   - 017:取消 / 超时 / trace / setTimeout / AbortController 经 spec+plan+ACR
 *     授权为物理必需层;守门对齐条件式修复层——禁止自动重试 / checkpoint 落盘 /
 *     token-cost 护栏 / OTel 导出提前入内核(扫可执行面,不扫注释用词)。
 *   - #160 / ADR-0008(accepted):TokenUsage 域类型经 spec+plan+ACR 授权为显示路径
 *     观测字段;token-cost 护栏(runtime ledger / CostTracker)仍禁——
 *     ADR-0008 Decision 1 明示否决。
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

  it("条件式修复层:src/harness/ executable surface has no retry/checkpoint/cost/OTel/session-api leaks", () => {
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
