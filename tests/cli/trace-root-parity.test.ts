/**
 * 会话管理「分类升级」(session folder consolidation, ADR-0071 + ADR-0019)
 * 之后的读侧根派生回归测试。
 *
 * 认证的不变式：trace 读侧（CLI `--trace-out` 缺省派生 / TUI bridge 数据根）
 * 与写侧 SessionStore 数据根必须解析到**同一个** baseDir —— 否则写侧落
 * `<workspaceRoot>/.iknow`、读侧扫 `~/.iknow`，trace MCP / trace 面板对
 * workspaceRoot 会话恒空。
 *
 * 根因场景：run.tsx 写侧把 workspaceRoot 传进 resolveServeDataDir
 * (`<workspaceRoot>/.iknow`)，而 cli.ts:resolveTraceRoot 与
 * hub-bridge.ts 的读侧派生漏传 —— 根分叉。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveServeDataDir } from "../../src/session-api/serve.ts";
import { resolveTraceRoot } from "../../src/cli/trace-root.ts";

describe("trace read-side root == write-side data root (ADR-0019/0071)", () => {
  it("resolveTraceRoot follows the write-side dataDir (workspaceRoot sharded)", () => {
    const wsRoot = "/tmp/iknow-fixture-ws";
    const writeDataDir = resolveServeDataDir(undefined, wsRoot);
    assert.equal(
      writeDataDir,
      join(wsRoot, ".iknow"),
      "resolveServeDataDir contract: workspaceRoot shards the pool"
    );
    assert.equal(
      resolveTraceRoot(undefined, writeDataDir),
      writeDataDir,
      "trace read-side default must equal the write-side data root"
    );
  });

  it("explicit --trace-out flag still wins over the derived root", () => {
    assert.equal(
      resolveTraceRoot("/tmp/flag-root", "/tmp/iknow-fixture-ws/.iknow"),
      "/tmp/flag-root"
    );
  });

  it("IKNOW_TRACE_OUT still wins over the derived root", () => {
    const saved = process.env.IKNOW_TRACE_OUT;
    try {
      process.env.IKNOW_TRACE_OUT = "/tmp/env-root";
      assert.equal(
        resolveTraceRoot(undefined, "/tmp/iknow-fixture-ws/.iknow"),
        "/tmp/env-root"
      );
    } finally {
      if (saved === undefined) delete process.env.IKNOW_TRACE_OUT;
      else process.env.IKNOW_TRACE_OUT = saved;
    }
  });

  it("no flag, no env, no dataDir → legacy ~/.iknow pool", () => {
    assert.equal(
      resolveTraceRoot(undefined, undefined),
      join(homedir(), ".iknow")
    );
  });
});
