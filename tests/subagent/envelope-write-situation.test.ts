/**
 * T6 (plans/write-situation-disclosure.md) — WorkerEnvelope 新增处境枚举
 * 字段 `writeSituation`（ADR-0069 D2; spec SC4 / OQ1）。
 *
 * Acceptance:
 *   - envelope 上 writeSituation 是 optional + 三态枚举;
 *   - 旧 envelope（无 writeSituation 字段）仍可被 ajv 接受,wire 向后兼容;
 *   - WORKER_SCHEMA 锁 enum = writable_main / writable_tree / no_writable_root
 *     —— 与枚举类型 `WriteSituation` 同源;
 *   - OQ1 采纳 (b): 旧 envelope 解析后 writeSituation === undefined
 *     (typed skip 的判定源)。
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
    // 旧 worker bootstrap / 跨版本 resume: envelope 上没有 writeSituation。
    // ajv 接受 → worker 据此走 typed skip(OQ1 采纳 (b))。
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
    // 与 status / reason 同样锁 enum —— 防止任意字符串污染。
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
    // 静态类型守卫: WriteSituation 三态在编译期穷尽。本断言保证这三态在
    // session-roots.ts 一直存在 —— 防止有人误删枚举成员造成 worker 渲染
    // 路径分支缺失。
    const allSituations: ReadonlyArray<WriteSituation> = [
      "writable_main",
      "writable_tree",
      "no_writable_root",
    ];
    assert.equal(allSituations.length, 3);
  });
});

/**
 * T8 (plans/parent-visible-tmp.md) — 写处境 / 写根段仍只点名交付根
 * （ADR-0069：不把 `/tmp` 揉进写根段）。Boundaries 两句落在 bash / 写工具
 * description，不进本段。
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
