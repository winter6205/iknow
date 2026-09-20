import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseTraceMcpArgs,
  resolveTraceDir,
  validateTraceDir,
} from "../../src/trace-mcp/trace-dir.js";

const scratchPaths: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// dist/ is a gitignored build artifact; this file does not build inside the test body
// (that would be a full-project tsc competing for CPU with sibling forks). Who provides
// dist: `npm test`'s pretest already runs `npm run build` first; when running
// `npx vitest run <file>` directly, the caller builds first. The two cases that truly
// depend on dist (the bin and dist-main startup faces) use ctx.skip(note) when the
// artifact is missing, skipping explicitly and putting the reason on screen — when dist
// exists they must really run; skip recognizes only "artifact absent" and hides no other failure.
const distMainPath = join(repoRoot, "dist", "trace-mcp", "main.js");
const distMissingNote =
  "dist/trace-mcp/main.js 不存在（dist/ 不随 checkout 存在）：" +
  "先跑 `npm run build`（`npm test` 已由 pretest 代为构建）。";

// These four cases each spawn a real node process (tsx-loaded or dist); cold start can
// take seconds on a loaded machine, and vitest's default 5s would misread a normal cold
// start as timeout. Give a real budget instead of treating timeout as a failure signal.
// The ceiling is "process ready + tools/list round-trip" summed: the test-level budget
// must exceed the helper's in-body response wait, or the helper's reject fires first.
const TOOLS_LIST_RESPONSE_TIMEOUT_MS = 20_000;
const SPAWN_TEST_TIMEOUT_MS = 30_000;

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

  it(
    "starts through the built package bin symlink and serves tools/list",
    async (ctx) => {
      // The bin entry scripts/iknow-trace-mcp.cjs only forwards; the real entry is
      // dist/trace-mcp/main.js — no artifact, no service to start.
      ctx.skip(!existsSync(distMainPath), distMissingNote);

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
        // The spawned stdio process really serves all three (the in-process face tests never touch dist).
        // Order is the three-axis order: catalog → row → content.
        expect(result.tools?.map((tool) => tool.name)).toEqual([
          "list_sessions",
          "query_trace",
          "get_record",
        ]);
      } finally {
        child.kill("SIGTERM");
      }
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "starts when the built main module is invoked through a symlink",
    async (ctx) => {
      // This face test targets the build artifact itself (the symlink is just an invocation form).
      ctx.skip(!existsSync(distMainPath), distMissingNote);

      const mainPath = distMainPath;
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
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "fails fast with a readable stderr message for a missing trace directory",
    async () => {
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
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    "serves tools/list through the dev wrapper from any cwd (T8)",
    async () => {
      // `.iknow/mcp.json` invokes the MCP server through
      // `scripts/iknow-trace-mcp-dev.cjs`. That wrapper resolves
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
        // Three-axis order: catalog → row → content.
        expect(result.tools?.map((tool) => tool.name)).toEqual([
          "list_sessions",
          "query_trace",
          "get_record",
        ]);
      } finally {
        child.kill("SIGTERM");
      }
    },
    SPAWN_TEST_TIMEOUT_MS
  );
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
    }, TOOLS_LIST_RESPONSE_TIMEOUT_MS);

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
