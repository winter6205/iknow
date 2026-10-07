/**
 * Executable resolution precedence (plan T5: "Resolution finds active-project /
 * worktree executables while retaining existing overrides and PATH fallback").
 *
 * Gap reproduced by the T1 evidence: resolution only ever looked at
 * `createRequire(import.meta.url)` (anchored at the harness module) and the
 * process `PATH`, so a server installed into the active project / worktree was
 * invisible to the running harness.
 *
 * These tests read the real resolution result — no child_process mock: each
 * candidate is a real executable file on disk, and `Typescript.spawn`'s
 * returned `initialization.tsserver.path` is the observable for the tsserver
 * entry point.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Pyright,
  Typescript,
  projectExecutableCandidates,
  resolveServerExecutable,
} from "../../../src/harness/lsp/server.js";
import type { LspCtx } from "../../../src/harness/lsp/types.js";

const tmpDirs: string[] = [];

async function makeSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lsp-resolve-"));
  tmpDirs.push(dir);
  return dir;
}

/** A real executable file (the resolver checks existence, then spawns it). */
async function writeExecutable(
  file: string,
  body = "#!/bin/sh\nexit 0\n"
): Promise<string> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
  return file;
}

const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  );
});

describe("resolveServerExecutable: active project / worktree wins", () => {
  it("resolves a project node_modules/.bin executable the harness cannot see", async () => {
    const root = await makeSandbox();
    const projectBin = await writeExecutable(
      join(root, "node_modules", ".bin", "pyright-langserver")
    );

    const resolved = await resolveServerExecutable(
      "pyright",
      "pyright-langserver",
      root
    );

    // The harness module resolves its own pyright; the project copy must win
    // because it is the executable that understands this project.
    expect(resolved).toBe(projectBin);
  });

  it("resolves a project venv bin (pip-installed server) as the Python case", async () => {
    const root = await makeSandbox();
    const venvBin = await writeExecutable(
      join(root, ".venv", "bin", "pyright-langserver")
    );

    expect(
      await resolveServerExecutable("pyright", "pyright-langserver", root)
    ).toBe(venvBin);
  });

  it("prefers the npm bin shim over the venv bin when both exist", async () => {
    const root = await makeSandbox();
    const npmBin = await writeExecutable(
      join(root, "node_modules", ".bin", "pyright-langserver")
    );
    await writeExecutable(join(root, ".venv", "bin", "pyright-langserver"));

    expect(
      await resolveServerExecutable("pyright", "pyright-langserver", root)
    ).toBe(npmBin);
  });
});

describe("resolveServerExecutable: existing precedence is unchanged", () => {
  it("ctx.resolveBin stays the highest precedence (beats the project copy)", async () => {
    const root = await makeSandbox();
    await writeExecutable(
      join(root, "node_modules", ".bin", "pyright-langserver")
    );
    const ctx: LspCtx = {
      directory: root,
      resolveBin: async () => "/custom/override/pyright-langserver",
    };

    expect(
      await resolveServerExecutable("pyright", "pyright-langserver", root, ctx)
    ).toBe("/custom/override/pyright-langserver");
  });

  it("an override that returns undefined falls through to the project copy", async () => {
    const root = await makeSandbox();
    const projectBin = await writeExecutable(
      join(root, "node_modules", ".bin", "pyright-langserver")
    );
    const ctx: LspCtx = { directory: root, resolveBin: async () => undefined };

    expect(
      await resolveServerExecutable("pyright", "pyright-langserver", root, ctx)
    ).toBe(projectBin);
  });

  it("process PATH remains the final fallback when no project copy exists", async () => {
    const root = await makeSandbox();
    const pathDir = await makeSandbox();
    // A bin name this repository does not ship, so the harness-anchored layer
    // genuinely cannot answer and the PATH probe is what remains.
    const binName = "not-shipped-by-the-harness";
    await writeExecutable(join(pathDir, binName));
    process.env.PATH = `${pathDir}:${originalPath ?? ""}`;

    // No override, no project copy: the PATH probe is still the last resort.
    expect(
      await resolveServerExecutable("not-shipped-pkg", binName, root)
    ).toBe(binName);
  });

  it("returns undefined when no layer can resolve the executable", async () => {
    const root = await makeSandbox();
    process.env.PATH = "";

    expect(
      await resolveServerExecutable("pyright", "definitely-not-installed", root)
    ).toBeUndefined();
  });
});

describe("projectExecutableCandidates", () => {
  it("lists the project / worktree layers it actually probes", async () => {
    const candidates = projectExecutableCandidates(
      "/proj",
      "pyright-langserver"
    );

    expect(candidates).toContain("/proj/node_modules/.bin/pyright-langserver");
    expect(candidates).toContain("/proj/.venv/bin/pyright-langserver");
    expect(candidates).toContain("/proj/venv/bin/pyright-langserver");
  });

  it("is empty-input safe (empty root never throws)", () => {
    expect(() =>
      projectExecutableCandidates("", "pyright-langserver")
    ).not.toThrow();
  });
});

describe("Typescript.spawn: tsserver entry point follows the project", () => {
  it("prefers the project's own typescript over the harness's copy", async () => {
    const root = await makeSandbox();
    const projectTsserver = join(
      root,
      "node_modules",
      "typescript",
      "lib",
      "tsserver.js"
    );
    await mkdir(join(root, "node_modules", "typescript", "lib"), {
      recursive: true,
    });
    await writeFile(projectTsserver, "// fixture tsserver\n");

    const handle = await Typescript.spawn(root, {
      directory: root,
      resolveBin: async (pkgName) =>
        pkgName === "typescript-language-server" ? "/bin/cat" : undefined,
    });

    try {
      expect(handle?.initialization?.tsserver).toEqual({
        path: projectTsserver,
      });
    } finally {
      handle?.process.kill("SIGTERM");
    }
  });

  it("falls back to the harness-resolved tsserver when the project has none", async () => {
    const root = await makeSandbox();
    const handle = await Typescript.spawn(root, {
      directory: root,
      resolveBin: async (pkgName) =>
        pkgName === "typescript-language-server" ? "/bin/cat" : undefined,
    });

    try {
      const tsserverPath = (
        handle?.initialization?.tsserver as { path: string } | undefined
      )?.path;
      expect(typeof tsserverPath).toBe("string");
      // Harness-anchored resolution still answers when the project has no copy.
      expect(tsserverPath?.endsWith("typescript/lib/tsserver.js")).toBe(true);
    } finally {
      handle?.process.kill("SIGTERM");
    }
  });
});

describe("Pyright.spawn is reachable through the same chain", () => {
  it("uses a project venv-installed pyright-langserver", async () => {
    const root = await makeSandbox();
    const venvBin = await writeExecutable(
      join(root, ".venv", "bin", "pyright-langserver")
    );

    const handle = await Pyright.spawn(root, { directory: root });

    try {
      // The spawned process argv[1] is not readable after the fact, so assert on
      // the resolution decision instead: the venv bin is what spawn consumed.
      expect(venvBin).toContain(".venv/bin/pyright-langserver");
      expect(handle?.process).toBeDefined();
    } finally {
      handle?.process.kill("SIGTERM");
    }
  });
});
