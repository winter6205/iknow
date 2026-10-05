/**
 * Engine-binding tests for the `glob` ACI tool (#1131).
 *
 * Pins the contract that glob's production path execs the absolute binary
 * `@vscode/ripgrep` provides — the same resolution as grep — and never a
 * bare `"rg"` for the OS to look up on PATH. The spawn layer
 * (`sandbox/runner`) is mocked so the exec'd command is observable and the
 * test runs on machines with or without any rg (PATH or provisioned).
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  spawnCalls: [] as {
    command: string;
    args: readonly string[];
    cwd: string;
  }[],
  next: { kind: "ok", stdout: "" } as
    | { kind: "ok"; stdout: string }
    | { kind: "reject"; error: NodeJS.ErrnoException },
}));

vi.mock("../../../../src/harness/sandbox/runner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/harness/sandbox/runner.ts")
    >();
  return {
    ...actual,
    spawnWithStopSignal: (
      command: string,
      args: readonly string[],
      options: { cwd: string }
    ) => {
      harness.spawnCalls.push({ command, args, cwd: options.cwd });
      if (harness.next.kind === "reject") {
        return {
          child: {} as ChildProcess,
          done: Promise.reject(harness.next.error),
        };
      }
      return {
        child: {} as ChildProcess,
        done: Promise.resolve({
          code: 0,
          signal: null,
          stdout: harness.next.stdout,
          stderr: "",
        }),
      };
    },
  };
});

const { createGlobTool } =
  await import("../../../../src/harness/aci/tools/glob.ts");
const { engineBinaryPath } =
  await import("../../../../src/harness/aci/search/engine-manifest.ts");

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  harness.spawnCalls.length = 0;
  harness.next = { kind: "ok", stdout: "" };
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("glob — production engine binding (#1131)", () => {
  it('execs the absolute pinned engine, never a PATH-resolved bare "rg"', async () => {
    const root = await makeScratch("glob-binding-");
    await writeFile(join(root, "index.ts"), "export {};\n");
    // Canned engine stdout: what a real `rg --files --glob **/*.ts` would
    // print here; the test's subject is the exec'd command, not rg output.
    harness.next = { kind: "ok", stdout: "index.ts\n" };

    const tool = createGlobTool(root);
    const result = await tool.handler({ pattern: "**/*.ts" });

    assert.equal(harness.spawnCalls.length, 1);
    const { command, args } = harness.spawnCalls[0];
    assert.equal(
      command,
      await engineBinaryPath(),
      "glob must exec the engine the dependency provides"
    );
    assert.ok(isAbsolute(command), `pinned path must be absolute: ${command}`);
    assert.notEqual(command, "rg", "a PATH lookup is never the main path");
    assert.deepEqual([...args], ["--files", "--glob", "**/*.ts"]);
    assert.equal(String(result), "index.ts");
  });

  it("an EACCES spawn failure degrades to the Node walker instead of throwing", async () => {
    const root = await makeScratch("glob-eacces-");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export {};\n");

    // The exact #1131 shape: exec of the engine is refused (EACCES, not
    // ENOENT). The call must still answer from the Node walker.
    const error = new Error("spawn pinned rg EACCES") as NodeJS.ErrnoException;
    error.code = "EACCES";
    harness.next = { kind: "reject", error };

    const tool = createGlobTool(root);
    const result = await tool.handler({ pattern: "src/*.ts" });

    assert.equal(harness.spawnCalls.length, 1);
    assert.equal(String(result), "src/index.ts");
  });
});
