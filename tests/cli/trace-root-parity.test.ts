/**
 * Read-side root-derivation regression after session-folder consolidation
 * (ADR-0071 + ADR-0087).
 *
 * Invariant: the trace read-side default must resolve to the same baseDir as
 * the write-side SessionStore data root. The session pool does not shard by
 * workspaceRoot (explicit dataDir excepted).
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
