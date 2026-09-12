/**
 * 会话文件夹归并（ADR-0071 + ADR-0087）之后的读侧根派生回归测试。
 *
 * 不变式：trace 读侧缺省派生与写侧 SessionStore 数据根必须是同一个
 * baseDir。会话池不跟 workspaceRoot 分片（显式 dataDir 除外）。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveServeDataDir } from "../../src/session-api/serve.ts";
import { resolveTraceRoot } from "../../src/cli/trace-root.ts";

describe("trace read-side root == write-side data root (ADR-0087)", () => {
  it("workspaceRoot does not shard the session pool", () => {
    const writeDataDir = resolveServeDataDir();
    assert.equal(writeDataDir, join(homedir(), ".iknow"));
    assert.equal(
      resolveTraceRoot(undefined, writeDataDir),
      writeDataDir,
      "trace read-side default must equal the write-side data root"
    );
  });

  it("explicit --data-dir still wins", () => {
    assert.equal(
      resolveServeDataDir("/tmp/iknow-explicit-pool"),
      "/tmp/iknow-explicit-pool"
    );
  });

  it("explicit --trace-out flag still wins over the derived root", () => {
    assert.equal(
      resolveTraceRoot("/tmp/flag-root", join(homedir(), ".iknow")),
      "/tmp/flag-root"
    );
  });

  it("IKNOW_TRACE_OUT still wins over the derived root", () => {
    const saved = process.env.IKNOW_TRACE_OUT;
    try {
      process.env.IKNOW_TRACE_OUT = "/tmp/env-root";
      assert.equal(
        resolveTraceRoot(undefined, join(homedir(), ".iknow")),
        "/tmp/env-root"
      );
    } finally {
      if (saved === undefined) delete process.env.IKNOW_TRACE_OUT;
      else process.env.IKNOW_TRACE_OUT = saved;
    }
  });

  it("no flag, no env, no dataDir → ~/.iknow pool", () => {
    assert.equal(
      resolveTraceRoot(undefined, undefined),
      join(homedir(), ".iknow")
    );
  });
});
