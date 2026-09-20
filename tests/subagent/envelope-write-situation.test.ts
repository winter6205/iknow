/**
 * WorkerEnvelope's new situation enum field `writeSituation` (wire-additive).
 *
 * Acceptance:
 *   - writeSituation on the envelope is optional + a three-state enum;
 *   - old envelopes (no writeSituation field) are still accepted by ajv — wire backward compatible;
 *   - WORKER_SCHEMA locks enum = writable_main / writable_tree / no_writable_root
 *     —— same source as the `WriteSituation` enum type;
 *   - old envelopes parse to writeSituation === undefined (the typed-skip decision source).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  parseWorkerEnvelope,
  WORKER_SCHEMA,
} from "../../src/harness/subagent/envelope.ts";
import type { WriteSituation } from "../../src/harness/session-roots.ts";
import { writeRootSegment } from "../../src/harness/skill/body.ts";

describe("WorkerEnvelope.writeSituation — T6 wire schema (additive)", () => {
  it("envelope 缺 writeSituation（旧 wire）→ 解析成功,writeSituation = undefined", () => {
    // Old worker bootstrap / cross-version resume: no writeSituation on the
    // envelope. ajv accepts it → the worker performs a typed skip accordingly.
    const json = JSON.stringify({ task: "x", sandboxRoot: "/tmp/sb" });
    const env = parseWorkerEnvelope(json);
    assert.equal(env.writeSituation, undefined);
  });

  it("envelope.writeSituation = writable_main（隔离 OFF 形态）→ 解析透传", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      writeSituation: "writable_main",
    });
    const env = parseWorkerEnvelope(json);
    assert.equal(env.writeSituation, "writable_main");
  });

  it("envelope.writeSituation = writable_tree（隔离 ON + 树形根）→ 解析透传", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/repo/.iknow/worktrees/conv1234",
      writeSituation: "writable_tree",
    });
    const env = parseWorkerEnvelope(json);
    assert.equal(env.writeSituation, "writable_tree");
  });

  it("envelope.writeSituation = no_writable_root（隔离 ON + 未绑树）→ 解析透传", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/repo/main",
      writeSituation: "no_writable_root",
    });
    const env = parseWorkerEnvelope(json);
    assert.equal(env.writeSituation, "no_writable_root");
  });

  it("envelope.writeSituation = 非法值（不在三态枚举内）→ ajv 拒收", () => {
    // Locked to an enum like status / reason — prevents arbitrary-string pollution.
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      writeSituation: "bogus_state",
    });
    assert.throws(() => parseWorkerEnvelope(json), /writeSituation/);
  });

  it("envelope.writeSituation = 非字符串（数字）→ ajv 拒收", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      writeSituation: 42,
    });
    assert.throws(() => parseWorkerEnvelope(json));
  });

  it("WORKER_SCHEMA.writeSituation enum 锁为三态，与 WriteSituation 类型同源", () => {
    const properties = WORKER_SCHEMA.properties as Record<
      string,
      { readonly enum?: ReadonlyArray<string> }
    >;
    assert.ok(properties.writeSituation, "writeSituation 字段在 schema");
    assert.deepEqual([...(properties.writeSituation.enum ?? [])].sort(), [
      "no_writable_root",
      "writable_main",
      "writable_tree",
    ]);
  });

  it("WriteSituation 类型契约：writable_main / writable_tree / no_writable_root", () => {
    // Static type guard: the three WriteSituation states are exhaustive at compile
    // time. This assertion ensures they keep existing in session-roots.ts — guards
    // against someone deleting an enum member and leaving a worker render path branchless.
    const allSituations: ReadonlyArray<WriteSituation> = [
      "writable_main",
      "writable_tree",
      "no_writable_root",
    ];
    assert.equal(allSituations.length, 3);
  });
});

/**
 * The write-situation / write-root segment still names only the delivery root
 * (do not fold `/tmp` into the write-root segment). The two boundary sentences
 * live in the bash / write-tool descriptions, not in this segment.
 */
describe("T8 write-root segment names the delivery root only (ADR-0069)", () => {
  it("writeRootSegment 三态都不提 /tmp（交付根路径本身也不在 /tmp 下）", () => {
    const deliveryRoot = "/repo/.iknow/worktrees/conv-t8";
    const situations: ReadonlyArray<WriteSituation> = [
      "writable_main",
      "writable_tree",
      "no_writable_root",
    ];
    for (const situation of situations) {
      const segment = writeRootSegment(situation, deliveryRoot);
      assert.ok(segment, `writeRootSegment(${situation}) must render`);
      assert.equal(
        segment.includes("/tmp"),
        false,
        `${situation} write-root segment must not mention /tmp; got ${JSON.stringify(segment)}`
      );
      if (situation !== "no_writable_root") {
        assert.ok(
          segment.includes(deliveryRoot),
          `${situation} must name the delivery root`
        );
      }
    }
  });
});
