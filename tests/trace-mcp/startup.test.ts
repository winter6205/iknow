import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  parseTraceMcpArgs,
  resolveTraceDir,
  validateTraceDir,
} from "../../src/trace-mcp/trace-dir.js";

const scratchPaths: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
}, 120_000);

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

  it("preserves unexpected filesystem errors while mapping missing directories", () => {
    expect(() => validateTraceDir("trace\0directory")).toThrow(TypeError);
  });

  it("starts through the built package bin symlink and serves tools/list", async () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8")
    ) as { bin: { "iknow-trace-mcp": string } };
    const binPath = join(repoRoot, packageJson.bin["iknow-trace-mcp"]);
    expect(statSync(binPath).mode & 0o111).not.toBe(0);

    const binDirectory = mkdtempSync(
      join(tmpdir(), "iknow-trace-mcp-bin-startup-")
    );
    const traceDirectory = mkdtempSync(
      join(tmpdir(), "iknow-trace-mcp-trace-")
    );
    scratchPaths.push(binDirectory, traceDirectory);
    const binLink = join(binDirectory, "iknow-trace-mcp");
    symlinkSync(binPath, binLink);

    const child = spawn(binLink, ["--trace-out", traceDirectory], {
      cwd: repoRoot,
      env: { ...process.env, IKNOW_TRACE_OUT: undefined },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = await requestToolsList(child);
      const result = response.result as {
        tools?: Array<{ name?: string }>;
      };
      // 建好的 stdio 进程真的把三件都端出来（in-process 那两条面测碰不到 dist）。
      // 顺序即三轴顺序：目录 → 行 → 内容。
      expect(result.tools?.map((tool) => tool.name)).toEqual([
        "list_sessions",
        "query_trace",
        "get_record",
      ]);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("starts when the built main module is invoked through a symlink", async () => {
    const mainPath = join(repoRoot, "dist", "trace-mcp", "main.js");
    const binDirectory = mkdtempSync(
      join(tmpdir(), "iknow-trace-mcp-main-link-")
    );
    const traceDirectory = mkdtempSync(
      join(tmpdir(), "iknow-trace-mcp-trace-")
    );
    scratchPaths.push(binDirectory, traceDirectory);
    const mainLink = join(binDirectory, "main.js");
    symlinkSync(mainPath, mainLink);

    const child = spawn(
      process.execPath,
      [mainLink, "--trace-out", traceDirectory],
      {
        cwd: repoRoot,
        env: { ...process.env, IKNOW_TRACE_OUT: undefined },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    try {
      const response = await requestToolsList(child);
      const result = response.result as {
        tools?: Array<{ name?: string }>;
      };
      expect(result.tools?.map((tool) => tool.name)).toEqual([
        "list_sessions",
        "query_trace",
        "get_record",
      ]);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("fails fast with a readable stderr message for a missing trace directory", async () => {
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

  it("serves tools/list through the dev wrapper from any cwd (T8)", async () => {
    // plan `trace-mcp-read-side-split` T8: `.iknow/mcp.json` invokes the MCP
    // server through `scripts/iknow-trace-mcp-dev.cjs`. That wrapper resolves
    // both the script directory and the trace directory relative to itself,
    // so the host's cwd does not enter the equation. This test spawns the
    // wrapper from a foreign cwd (an empty temp dir) and asserts the same
    // three-tool tools/list it serves from the repo root — that's the assertion
    // a checkable `.iknow/mcp.json` cannot make on its own, since the live
    // invocation only happens inside an MCP host.
    const wrapperPath = join(repoRoot, "scripts", "iknow-trace-mcp-dev.cjs");
    // The wrapper runs under process.execPath; the executable bit is not on
    // the critical path of this assertion (and is a separate git-mode concern,
    // not a behaviour concern). What matters is the wrapper exists at the
    // documented path inside the repo.

    const foreignCwd = mkdtempSync(
      join(tmpdir(), "iknow-trace-mcp-foreign-cwd-")
    );
    const traceDirectory = mkdtempSync(
      join(tmpdir(), "iknow-trace-mcp-trace-")
    );
    scratchPaths.push(foreignCwd, traceDirectory);

    const child = spawn(
      process.execPath,
      [wrapperPath, "--trace-out", traceDirectory],
      {
        cwd: foreignCwd,
        env: { ...process.env, IKNOW_TRACE_OUT: undefined },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    try {
      const response = await requestToolsList(child);
      const result = response.result as {
        tools?: Array<{ name?: string }>;
      };
      // 三轴顺序：目录 → 行 → 内容。
      expect(result.tools?.map((tool) => tool.name)).toEqual([
        "list_sessions",
        "query_trace",
        "get_record",
      ]);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

function runMain(
  mainPath: string,
  args: readonly string[]
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
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

function requestToolsList(
  child: ChildProcessWithoutNullStreams
): Promise<{ readonly result?: unknown }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for tools/list response"));
    }, 5_000);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as {
          readonly id?: number;
          readonly result?: unknown;
        };
        if (message.id === 2) {
          cleanup();
          resolve(message);
          return;
        }
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null) => {
      cleanup();
      reject(new Error(`trace MCP exited before tools/list: ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "startup-test", version: "1.0.0" },
        },
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })}\n`
    );
  });
}
