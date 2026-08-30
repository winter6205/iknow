import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseLspMcpArgs,
  resolveLspRoot,
  validateLspRoot,
} from "../../src/lsp-mcp/root.ts";

const scratch: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("lsp MCP root resolution", () => {
  it("prefers --root over IKNOW_LSP_ROOT and cwd", () => {
    expect(
      resolveLspRoot(["--root", "/from/flag"], {
        IKNOW_LSP_ROOT: "/from/env",
      })
    ).toBe("/from/flag");
    expect(
      resolveLspRoot([], {
        IKNOW_LSP_ROOT: "/from/env",
      })
    ).toBe("/from/env");
    expect(resolveLspRoot([], {}, "/cwd")).toBe("/cwd");
  });

  it("rejects an empty --root before starting", () => {
    expect(() => parseLspMcpArgs(["--root", ""])).toThrow(/empty/i);
  });

  it("rejects a missing directory", () => {
    const missing = join(
      mkdtempSync(join(tmpdir(), "iknow-lsp-mcp-missing-")),
      "nope"
    );
    scratch.push(dirname(missing));
    expect(() => validateLspRoot(missing)).toThrow(/does not exist/);
  });

  it("rejects a file used as root", () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-mcp-file-"));
    scratch.push(dir);
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => validateLspRoot(file)).toThrow(/not a directory/);
  });

  it("fails fast with stderr only when started against a missing root", async () => {
    const missing = join(
      mkdtempSync(join(tmpdir(), "iknow-lsp-mcp-start-")),
      "missing"
    );
    scratch.push(dirname(missing));
    const result = await runMain(["--root", missing]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/does not exist|iknow-lsp-mcp/i);
    expect(result.stdout).toBe("");
  });
});

function runMain(args: readonly string[]): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const mainPath = join(repoRoot, "src", "lsp-mcp", "main.ts");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", mainPath, ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, IKNOW_LSP_ROOT: undefined },
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
