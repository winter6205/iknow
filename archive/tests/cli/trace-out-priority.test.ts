/**
 * 归档自 tests/cli/trace-out.test.ts (T3, plans/session-folder-consolidation.md
 * SC6 / ADR-0071 Decision 1)。归档原因:`DEFAULT_TRACE_DIR = "./trace/"` 已退役
 * —— trace 锚点迁入会话文件夹
 * (`<baseDir>/projects/<slug>/<convId>/trace.jsonl`),不再 cwd-relative。
 * 本文件钉死的「flag > env > 默认 `./trace/`」优先级链随默认值一起失效。
 *
 * 仍然真实的不变式(flag 优先于 env 优先于默认)由 `cli.ts:resolveTraceRoot`
 * 承接,新默认 = `resolveServeDataDir()`(≈ `<home>/.iknow`,与读侧同源);
 * T6 (traceserver 读侧 discovery) 落地时再为其补测试。按 test.md 过时测试
 * 规则,归档而不机械改断言制造伪覆盖。
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";

describe("trace path priority resolution (RETIRED by T3 SC6)", () => {
  function resolveTracePath(flag: string | undefined): string {
    return flag ?? process.env.IKNOW_TRACE_OUT ?? "./trace/";
  }

  let savedEnv: string | undefined;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.IKNOW_TRACE_OUT;
    else process.env.IKNOW_TRACE_OUT = savedEnv;
  });

  it("flag wins over IKNOW_TRACE_OUT env", () => {
    savedEnv = process.env.IKNOW_TRACE_OUT;
    process.env.IKNOW_TRACE_OUT = "/tmp/env.jsonl";
    assert.equal(resolveTracePath("/tmp/flag.jsonl"), "/tmp/flag.jsonl");
  });

  it("env wins over default when no flag", () => {
    savedEnv = process.env.IKNOW_TRACE_OUT;
    process.env.IKNOW_TRACE_OUT = "/tmp/env.jsonl";
    assert.equal(resolveTracePath(undefined), "/tmp/env.jsonl");
  });

  it("default ./trace/ when no flag and no env", () => {
    savedEnv = process.env.IKNOW_TRACE_OUT;
    process.env.IKNOW_TRACE_OUT = undefined;
    assert.equal(resolveTracePath(undefined), "./trace/");
  });
});
