/**
 * #672 T1: FaultClass 策略表（G2 in/out）。
 *
 * 纯分类，不接传输重试循环、不接环检测。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifyFault,
  type FaultClass,
  type FaultEvent,
} from "../../src/harness/fault-class.ts";
import { findGateBViolations } from "./gate-b-capability.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLOSED: ReadonlySet<FaultClass> = new Set(["retry", "fuse", "none"]);

describe("classifyFault G2 table", () => {
  it("empty / missing event → none", () => {
    assert.equal(classifyFault(null), "none");
    assert.equal(classifyFault(undefined), "none");
  });

  it("API 429 sample → retry", () => {
    const event: FaultEvent = { kind: "llm_http", status: 429 };
    assert.equal(classifyFault(event), "retry");
    assert.ok(CLOSED.has(classifyFault(event)));
  });

  it("API 5xx and network → retry", () => {
    assert.equal(classifyFault({ kind: "llm_http", status: 503 }), "retry");
    assert.equal(classifyFault({ kind: "llm_network" }), "retry");
  });

  it("negative: permission deny is none, not retry", () => {
    assert.equal(classifyFault({ kind: "permission_deny" }), "none");
  });

  it("verify FAIL / cancel / timeout are out → none", () => {
    assert.equal(classifyFault({ kind: "verify_fail" }), "none");
    assert.equal(classifyFault({ kind: "user_cancel" }), "none");
    assert.equal(classifyFault({ kind: "timeout" }), "none");
  });

  it("single execution_failed (non-permission) → none", () => {
    assert.equal(
      classifyFault({ kind: "execution_failed", occurrenceCount: 1 }),
      "none"
    );
  });

  it("repeated same-args execution_failed → fuse", () => {
    assert.equal(
      classifyFault({ kind: "execution_failed", occurrenceCount: 2 }),
      "fuse"
    );
  });

  it("overflow: huge occurrenceCount still fuse (closed set)", () => {
    assert.equal(
      classifyFault({
        kind: "execution_failed",
        occurrenceCount: Number.MAX_SAFE_INTEGER,
      }),
      "fuse"
    );
  });

  it("negative occurrenceCount is not fuse", () => {
    assert.equal(
      classifyFault({ kind: "execution_failed", occurrenceCount: -1 }),
      "none"
    );
  });

  it("compact / protocol / emptyFinalResponse → none (no fuse)", () => {
    assert.equal(classifyFault({ kind: "compact_failed" }), "none");
    assert.equal(classifyFault({ kind: "protocol_error" }), "none");
    assert.equal(classifyFault({ kind: "empty_final_response" }), "none");
    assert.equal(classifyFault({ kind: "prompt_too_long" }), "none");
  });

  it("non-transient HTTP (401) → none", () => {
    assert.equal(classifyFault({ kind: "llm_http", status: 401 }), "none");
  });

  it("clock_timeout: 不可见 → retry;可见 → none(已出字不重试)", () => {
    assert.equal(
      classifyFault({ kind: "clock_timeout", source: "idle", visible: false }),
      "retry"
    );
    assert.equal(
      classifyFault({
        kind: "clock_timeout",
        source: "hardCap",
        visible: false,
      }),
      "retry"
    );
    assert.equal(
      classifyFault({ kind: "clock_timeout", source: "idle", visible: true }),
      "none"
    );
  });

  // ADR-0111 不变式 (a):stream_incomplete 与 clock_timeout 同判据 —— 不可见 =
  // 本次 attempt 无任何模型输出增量,整 step 重试安全;已出字不自动重试。
  it("stream_incomplete: 不可见 → retry;可见 → none(已出字不重试)", () => {
    assert.equal(
      classifyFault({ kind: "stream_incomplete", visible: false }),
      "retry"
    );
    assert.equal(
      classifyFault({ kind: "stream_incomplete", visible: true }),
      "none"
    );
  });

  it("concurrent classify calls are isolated", async () => {
    const events: FaultEvent[] = [
      { kind: "llm_http", status: 429 },
      { kind: "permission_deny" },
      { kind: "execution_failed", occurrenceCount: 4 },
    ];
    const expected: FaultClass[] = ["retry", "none", "fuse"];
    const runs = await Promise.all(
      events.map((e) => Promise.resolve(classifyFault(e)))
    );
    assert.deepEqual(runs, expected);
  });
});

describe("Gate B: retry identifier allowed for FaultClass", () => {
  it("fault-class.ts may use retry on the executable surface", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "harness", "fault-class.ts"),
      "utf8"
    );
    const hits = findGateBViolations(src);
    assert.equal(
      hits.filter((h) => h.keyword === "retry").length,
      0,
      JSON.stringify(hits)
    );
  });
});
