import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseTraceMcpArgs,
  resolveTraceDir,
} from "../../src/trace-mcp/trace-dir.js";

const scratchPaths: string[] = [];

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("trace MCP startup", () => {
  it("resolves --trace-out before IKNOW_TRACE_OUT and the default", () => {
    expect(
      resolveTraceDir(["--trace-out", "/from/flag"], {
        IKNOW_TRACE_OUT: "/from/env",
      })
    ).toBe("/from/flag");
    expect(
      resolveTraceDir([], {
        IKNOW_TRACE_OUT: "/from/env",
      })
    ).toBe("/from/env");
    expect(resolveTraceDir([], {})).toBe("./trace/");
  });

  it("rejects an empty trace-out argument before starting the server", () => {
    expect(() => parseTraceMcpArgs(["--trace-out", ""])).toThrow(
      /trace-out.*empty/i
    );
  });

  it("fails fast with a readable stderr message for a missing trace directory", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const mainPath = join(repoRoot, "src", "trace-mcp", "main.ts");
    const missingPath = join(
      mkdtempSync(join(tmpdir(), "iknow-trace-mcp-startup-")),
      "missing"
    );
    scratchPaths.push(dirname(missingPath));

    const result = await runMain(mainPath, ["--trace-out", missingPath]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/trace.*directory|trace-out/i);
    assert.equal(result.stdout, "");
  });
});

function runMain(
  mainPath: string,
  args: readonly string[]
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", mainPath, ...args],
      {
        cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
        env: { ...process.env, IKNOW_TRACE_OUT: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
