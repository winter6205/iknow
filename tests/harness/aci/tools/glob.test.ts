/**
 * Tests for the `glob` ACI tool (T7).
 *
 * Coverage map:
 *  - normal match: pattern → relative paths, alphabetically sorted
 *  - "**" recursive pattern matches nested files
 *  - "*.ts" matches only files ending .ts (true glob, not substring)
 *  - empty pattern rejected (does not degenerate to "match all")
 *  - search root outside workspace reachable through the canonical read
 *    policy (ADR-0128), protected roots still refused by the roster
 *  - limit truncates output (default 200, cap 5000)
 *  - Node fallback path returns the same shape when rg is unavailable
 *  - fallback triggers on the whole unstartable errno set, not just ENOENT
 *    (#1131: a PATH-less machine surfaced `spawn rg EACCES`)
 *  - the production path execs the install-root pinned binary, never a PATH
 *    `rg` (binding asserted in glob-engine-binding.test.ts)
 *  - inputSchema shape (model-facing JSON Schema)
 *  - aci metadata
 *  - error path: handler throws ToolExecutionError on bad input
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import type {
  AciToolDef,
  ToolExecutionContext,
} from "../../../../src/harness/aci/types.ts";
import {
  createGlobTool,
  type GlobToolDeps,
} from "../../../../src/harness/aci/tools/glob.ts";
import { engineBinaryPath } from "../../../../src/harness/aci/search/engine-manifest.ts";

/**
 * The engine `@vscode/ripgrep` provides, resolved once at module scope: the
 * resolver is async, and the two `it.skipIf(!enginePresent)` arms below read it
 * while their `describe` callbacks run (which are not async).
 */
const installedEngine: string | undefined = await engineBinaryPath();
const enginePresent =
  installedEngine !== undefined && existsSync(installedEngine);

const execFileAsync = promisify(execFile);

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

/**
 * Build a small mixed-extension tree:
 *   src/index.ts
 *   src/util/helper.ts
 *   src/util/notes.md
 *   README.md
 *   docs/intro.md
 */
async function buildFixtureTree(root: string): Promise<void> {
  await mkdir(join(root, "src", "util"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export {};\n");
  await writeFile(join(root, "src", "util", "helper.ts"), "export {};\n");
  await writeFile(join(root, "src", "util", "notes.md"), "# notes\n");
  await writeFile(join(root, "README.md"), "# readme\n");
  await writeFile(join(root, "docs", "intro.md"), "# intro\n");
  await mkdir(join(root, "empty"));
}

async function gather(input: {
  pattern: string;
  path?: string;
  limit?: number;
  root: string;
  deps?: GlobToolDeps;
  ctx?: ToolExecutionContext;
}): Promise<string> {
  const tool = createGlobTool(input.root, input.deps);
  const handler = tool.handler;
  const payload: Record<string, unknown> = { pattern: input.pattern };
  if (input.path !== undefined) payload.path = input.path;
  if (input.limit !== undefined) payload.limit = input.limit;
  const result = await handler(payload, input.ctx);
  return String(result);
}

async function rgIsAvailable(): Promise<boolean> {
  try {
    await execFileAsync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe("createGlobTool — factory shape", () => {
  it("exposes name 'glob' and frozen AciToolDef", () => {
    const root = "/tmp";
    const tool = createGlobTool(root);
    assert.equal(tool.name, "glob");
    assert.equal(typeof tool.handler, "function");
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    assert.deepEqual(tool.aci, {
      category: "read-only",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "fast",
    });
  });

  it("不带输出闸豁免声明（ADR-0083 只对 skill 内建落值）", () => {
    // glob output still goes through the executor's fallback cap: narrowing
    // pattern / path / limit and retrying is a valid recovery path, so no exemption.
    const tool = createGlobTool("/tmp");

    assert.equal(tool.exemptFromOutputCap, undefined);
  });

  it("inputSchema declares the contract surface (pattern/path/limit)", () => {
    const tool = createGlobTool("/tmp");
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["pattern"]);
    const props = schema.properties;
    assert.ok(props.pattern, "pattern must be present");
    assert.ok(props.path, "path must be present");
    assert.ok(props.limit, "limit must be present");
    const patternType = (props.pattern as { type: string }).type;
    const pathType = (props.path as { type: string }).type;
    const limitType = (props.limit as { type: string }).type;
    assert.equal(patternType, "string");
    assert.equal(pathType, "string");
    assert.equal(limitType, "integer");
  });
});

describe("createGlobTool — rg happy path", () => {
  it("returns .ts files matching a basic glob pattern, alphabetically sorted", async () => {
    const root = await makeScratch("glob-rg-basic-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "src/*.ts",
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines, ["src/index.ts"]);
  });

  it("matches nested files with ** and returns them sorted alphabetically", async () => {
    const root = await makeScratch("glob-rg-recursive-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "**/*.ts",
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines, ["src/index.ts", "src/util/helper.ts"]);
  });

  it("does not treat pattern as a substring (true glob semantics)", async () => {
    const root = await makeScratch("glob-rg-truth-");
    await buildFixtureTree(root);

    // "*.ts" should NOT match "notes.md" which contains the substring ".md"-ish.
    // Use a pattern that would falsely match if substring semantics leaked in.
    const output = await gather({
      root,
      pattern: "src/*.ts",
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.every((line) => line.endsWith(".ts")));
    assert.ok(lines.every((line) => line.startsWith("src/")));
    assert.equal(
      lines.some((line) => line.endsWith("notes.md")),
      false
    );
  });

  it("returns an empty string when no files match", async () => {
    const root = await makeScratch("glob-rg-empty-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "**/*.go",
    });

    // Contract: no matches → empty string (not error, not a stash of header).
    assert.equal(output, "");
  });

  it("truncates results to limit", async () => {
    const root = await makeScratch("glob-rg-limit-");
    await mkdir(join(root, "many"), { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      await writeFile(
        join(root, "many", `f${i.toString().padStart(2, "0")}.txt`),
        "x"
      );
    }

    const output = await gather({
      root,
      pattern: "many/*.txt",
      limit: 3,
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "many/f00.txt");
    assert.equal(lines[1], "many/f01.txt");
    assert.equal(lines[2], "many/f02.txt");
  });

  /**
   * Parse-logic coverage that does NOT depend on a real `rg` binary.
   * Injects canned `rg --files --glob` stdout and asserts the seam path
   * (deps.spawnRg) parses, prepends the search prefix, and sorts the
   * result exactly as the production rg path would. This guarantees
   * coverage on CI runners without ripgrep installed.
   *
   * The seam bypasses rg itself — it must return whatever rg *would have*
   * printed for the given pattern. So we hand-feed paths that already
   * satisfy the pattern (rg-side filtering is not the seam's job).
   */
  it("parses injected rg stdout through the seam (CI without rg)", async () => {
    const root = await makeScratch("glob-rg-seam-");
    await buildFixtureTree(root);

    // Canned rg stdout: paths rg would print for `**/*.ts`, with a
    // trailing newline (rg always emits one between files and at end).
    // Deliberately unsorted to also assert the sort step.
    const canned = "src/util/helper.ts\nsrc/index.ts\n";
    let receivedArgs: readonly string[] = [];
    let receivedCwd = "";
    const deps: GlobToolDeps = {
      spawnRg: async (args, cwd) => {
        receivedArgs = args;
        receivedCwd = cwd;
        return { stdout: canned, stderr: "" };
      },
    };

    const output = await gather({
      root,
      pattern: "**/*.ts",
      deps,
    });

    // Seam was driven with the production arg + cwd shape.
    assert.deepEqual([...receivedArgs], ["--files", "--glob", "**/*.ts"]);
    assert.ok(receivedCwd.length > 0, "seam must receive a non-empty cwd");
    // Sorted, root-relative (searchPrefix="" since path === root).
    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines, ["src/index.ts", "src/util/helper.ts"]);
  });

  /**
   * Same parse path with a non-empty search prefix to cover the
   * joinPosix prepend branch on the seam side.
   */
  it("prepends search prefix to injected rg stdout (seam)", async () => {
    const root = await makeScratch("glob-rg-seam-prefix-");
    await buildFixtureTree(root);

    // When path: "src" narrows the search root, the tool runs rg with
    // cwd=src and pattern "**/*.ts". A fake rg would emit paths like
    // "index.ts" (relative to cwd), and the tool must prepend "src/" so
    // the result is root-relative. Canned output is intentionally
    // unsorted and includes only .ts entries — the seam does not
    // re-filter by glob, so the test must hand-feed matching paths.
    const canned = "util/helper.ts\nindex.ts\n";
    const deps: GlobToolDeps = {
      spawnRg: async () => ({ stdout: canned, stderr: "" }),
    };

    const output = await gather({
      root,
      pattern: "**/*.ts",
      path: "src",
      deps,
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines, ["src/index.ts", "src/util/helper.ts"]);
  });
});

describe("createGlobTool — Node fallback path", () => {
  /**
   * Build a deps seam that pretends rg is missing; the tool must fall back to
   * the Node walker and still produce the same string-shape output.
   */
  function makeFallbackDeps(): GlobToolDeps {
    return {
      spawnRg: async () => {
        const error = new Error("spawn rg ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    };
  }

  it("falls back to Node walker when rg is unavailable and returns sorted results", async () => {
    const root = await makeScratch("glob-fallback-basic-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "src/*.ts",
      deps: makeFallbackDeps(),
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines, ["src/index.ts"]);
  });

  /**
   * #1131: which errno the OS reports for an unusable engine is platform- and
   * shape-dependent (missing file → ENOENT; present-but-not-executable or
   * restricted exec → EACCES/EPERM). The degrade gate must cover the whole
   * set, or the contract's fallback silently never fires.
   */
  for (const code of ["EACCES", "EPERM"] as const) {
    it(`falls back when the spawn rejects with ${code}`, async () => {
      const root = await makeScratch(`glob-fallback-${code}-`);
      await buildFixtureTree(root);

      const deps: GlobToolDeps = {
        spawnRg: async () => {
          const error = new Error(`spawn rg ${code}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        },
      };

      const output = await gather({ root, pattern: "src/*.ts", deps });
      const lines = output.split("\n").filter((line) => line.length > 0);
      assert.deepEqual(lines, ["src/index.ts"]);
    });
  }

  it("fallback supports ** recursive matching", async () => {
    const root = await makeScratch("glob-fallback-recursive-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "**/*.md",
      deps: makeFallbackDeps(),
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines, [
      "README.md",
      "docs/intro.md",
      "src/util/notes.md",
    ]);
  });

  it("fallback returns empty string when nothing matches", async () => {
    const root = await makeScratch("glob-fallback-empty-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "**/*.go",
      deps: makeFallbackDeps(),
    });

    assert.equal(output, "");
  });

  it("fallback honours limit", async () => {
    const root = await makeScratch("glob-fallback-limit-");
    await mkdir(join(root, "many"), { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      await writeFile(
        join(root, "many", `f${i.toString().padStart(2, "0")}.txt`),
        "x"
      );
    }

    const output = await gather({
      root,
      pattern: "many/*.txt",
      limit: 4,
      deps: makeFallbackDeps(),
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "many/f00.txt");
    assert.equal(lines[3], "many/f03.txt");
  });

  it("fallback resolves the search root via the path argument (relative subdir)", async () => {
    const root = await makeScratch("glob-fallback-subpath-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "**/*.ts",
      path: "src",
      deps: makeFallbackDeps(),
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    // Paths are root-relative even when a `path` sub-arg narrows the search.
    assert.deepEqual(lines, ["src/index.ts", "src/util/helper.ts"]);
  });

  it("fallback ignores node_modules / .git directories", async () => {
    const root = await makeScratch("glob-fallback-ignored-");
    await buildFixtureTree(root);
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "pkg", "index.ts"),
      "export {};\n"
    );
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await writeFile(join(root, ".git", "objects", "thing.ts"), "export {};\n");

    const output = await gather({
      root,
      pattern: "**/*.ts",
      deps: makeFallbackDeps(),
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    // No node_modules / .git entries should leak through.
    assert.ok(
      lines.every((line) => !line.includes("node_modules")),
      `node_modules leaked: ${lines.join(", ")}`
    );
    assert.ok(
      lines.every((line) => !line.includes(".git")),
      `.git leaked: ${lines.join(", ")}`
    );
  });
});

describe("createGlobTool — pinned engine binding", () => {
  /**
   * The production path execs `deps.engineBinaryPath` when given. Pointing it
   * at a nonexistent file drives the real `spawnWithStopSignal` → ENOENT →
   * walker chain (no seam injection), proving the pinned path — not a PATH
   * `rg` — is what gets spawned. Runnable on CI without any engine install.
   */
  it("degrades to the walker when the pinned binary path does not exist", async () => {
    const root = await makeScratch("glob-pinned-missing-");
    await buildFixtureTree(root);

    const output = await gather({
      root,
      pattern: "src/*.ts",
      deps: { engineBinaryPath: join(root, "__no_such_engine__", "rg") },
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines, ["src/index.ts"]);
  });

  /**
   * With the engine installed (and, on the reporting machine, no rg on PATH
   * at all), the default no-deps call must answer from the real binary.
   * Skipped only when this machine has no engine.
   */
  it.skipIf(!enginePresent)(
    "default binding hits the provisioned engine (no PATH involvement)",
    async () => {
      const root = await makeScratch("glob-pinned-real-");
      await buildFixtureTree(root);

      const output = await gather({ root, pattern: "**/*.ts" });

      const lines = output.split("\n").filter((line) => line.length > 0);
      assert.deepEqual(lines, ["src/index.ts", "src/util/helper.ts"]);
    }
  );
});

describe("createGlobTool — input validation", () => {
  it("rejects an empty pattern (does not degenerate to match-all)", async () => {
    const root = await makeScratch("glob-empty-pattern-");
    await buildFixtureTree(root);

    const tool = createGlobTool(root);
    await assert.rejects(
      tool.handler({ pattern: "" }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "ToolExecutionError" &&
        error.message.includes("pattern")
    );
  });

  it("lists an ordinary search root outside the workspace (ADR-0128 host reach)", async () => {
    const root = await makeScratch("glob-escape-");
    const outside = await realpath(await makeScratch("glob-escape-out-"));
    await buildFixtureTree(outside);

    const tool = createGlobTool(root);
    const output = String(
      await tool.handler({ pattern: "**/*.ts", path: outside })
    );
    assert.match(output, /index\.ts/);
    assert.match(output, /helper\.ts/);
    // Paths stay root-relative: reaching the outside tree shows through the
    // `..` segments, same shape as the identity-root surface has always had.
    assert.ok(
      output.split("\n").every((line) => line.startsWith("../")),
      `root-relative widened paths: ${output}`
    );
  });

  it("a relative parent traversal to an ordinary outside directory is listed (host reach)", async () => {
    const parent = await makeScratch("glob-parent-");
    const root = join(parent, "root");
    await mkdir(root);
    const outside = join(parent, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "leak.ts"), "x");

    const tool = createGlobTool(root);
    const output = String(
      await tool.handler({ pattern: "**/*.ts", path: "../outside" })
    );
    assert.match(output, /leak\.ts/);
  });

  it("returns the real file under the workspace when the search root exists", async () => {
    const root = await makeScratch("glob-resolve-");
    const target = join(root, "src", "deep");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "leaf.ts"), "export {};\n");

    // The tool must look up the absolute path through the resolved real root.
    await access(target);
    const tool = createGlobTool(root);
    // No throws during the search-root resolution.
    const result = await tool.handler({ pattern: "**/*.ts" });
    assert.equal(typeof result, "string");
  });
});

describe("createGlobTool — result paths are relative to root", () => {
  it("never returns absolute paths", async () => {
    const root = await makeScratch("glob-relative-");
    await buildFixtureTree(root);

    // Run both paths if rg is available; otherwise just the fallback.
    const deps: GlobToolDeps | undefined = (await rgIsAvailable())
      ? undefined
      : {
          spawnRg: async () => {
            const error = new Error("spawn rg ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          },
        };

    const output = await gather({
      root,
      pattern: "**/*.md",
      deps,
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      assert.ok(!line.startsWith(sep), `absolute path leaked: ${line}`);
      assert.ok(
        !line.startsWith(root),
        `root-prefixed absolute path leaked: ${line} (root=${root})`
      );
    }
    assert.ok(lines.length > 0, "expected at least one match");
  });
});

describe("createGlobTool — return type", () => {
  it("returns a string (not a structured object)", async () => {
    const root = await makeScratch("glob-string-shape-");
    await buildFixtureTree(root);

    const tool = createGlobTool(root);
    const result = await tool.handler({ pattern: "**/*.md" });
    assert.equal(typeof result, "string");
  });
});

describe("createGlobTool — handler signature", () => {
  it("returns an AciToolDef with frozen handler", () => {
    const tool: AciToolDef = createGlobTool("/tmp");
    assert.equal(tool.name, "glob");
    assert.equal(typeof tool.handler, "function");
  });
});

describe("createGlobTool — limit cap", () => {
  it("clamps an over-cap limit to 5000", async () => {
    const root = await makeScratch("glob-cap-");
    await buildFixtureTree(root);

    const deps: GlobToolDeps = {
      spawnRg: async () => {
        const error = new Error("spawn rg ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    };

    // limit above cap must not throw; must simply be clamped.
    const output = await gather({
      root,
      pattern: "**/*.md",
      limit: 99999,
      deps,
    });

    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length <= 5000);
    assert.ok(lines.length > 0);
  });
});

// ───────────────────────── protected-path policy (host-read-policy SC2/SC3) ─────────────────────────

describe("glob — protected-path policy enforcement", () => {
  async function makePolicyTree(prefix: string): Promise<string> {
    const root = await makeScratch(prefix);
    await mkdir(join(root, ".ssh"), { recursive: true });
    await mkdir(join(root, "certs"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_rsa"), "SSHSECRET\n");
    await writeFile(join(root, "certs", "server.pem"), "PEMSECRET\n");
    await writeFile(join(root, ".env"), "ENVSECRET\n");
    await writeFile(join(root, "notes.txt"), "benign\n");
    await symlink(join(root, ".ssh", "id_rsa"), join(root, "alias.txt"));
    return root;
  }

  /**
   * Node walker form: the pinned binary path is missing, so collection runs
   * walkAndMatch — which enumerates dotfiles and must therefore lean on the
   * policy filter for leaks.
   */
  it("walker form never emits protected paths and refuses a protected search root", async () => {
    const root = await makePolicyTree("glob-policy-walk-");
    const deps: GlobToolDeps = {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    };
    const output = await gather({ root, pattern: "**", deps });
    for (const leak of ["id_rsa", "server.pem", ".env"]) {
      assert.ok(!output.includes(leak), `listing leaked ${leak}: ${output}`);
    }
    assert.ok(output.includes("notes.txt"), `benign file lost: ${output}`);

    for (const path of [
      ".ssh",
      ".env",
      join(root, "certs", "server.pem"),
      "alias.txt",
    ]) {
      await assert.rejects(
        () => toolHandlerFor(root, deps)({ pattern: "*", path }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /protected-path roster/.test(error.message) &&
          !/outside workspace|not a file/.test(error.message)
      );
    }
  });

  /**
   * Widened root half (ADR-0128 T4): the same no-leak invariant on a search
   * root **outside** the live task root — reach was granted by the policy's
   * allow verdict, the per-emission filter still drops protected paths under
   * it, and naming a protected entry there is refused by the roster (never
   * as an escape).
   */
  it("walker form on a widened outside root leaks nothing and refuses protected names", async () => {
    const taskRoot = await makeScratch("glob-policy-widened-task-");
    const outside = await realpath(
      await makeScratch("glob-policy-widened-tree-")
    );
    await mkdir(join(outside, ".ssh"), { recursive: true });
    await writeFile(join(outside, ".ssh", "id_rsa"), "SSHSECRET\n");
    await writeFile(join(outside, ".env"), "ENVSECRET\n");
    await writeFile(join(outside, "notes.txt"), "benign\n");
    await symlink(join(outside, ".ssh", "id_rsa"), join(outside, "alias.txt"));

    const deps: GlobToolDeps = {
      engineBinaryPath: join(taskRoot, "__no_such_engine__", "rg"),
    };
    const output = await gather({
      root: taskRoot,
      pattern: "**",
      path: outside,
      deps,
    });
    for (const leak of ["id_rsa", ".env", "alias.txt"]) {
      assert.ok(
        !output.includes(leak),
        `widened listing leaked ${leak}: ${output}`
      );
    }
    assert.ok(
      output.includes("notes.txt"),
      `benign widened file lost: ${output}`
    );

    for (const path of [
      join(outside, ".ssh"),
      join(outside, ".env"),
      join(outside, "alias.txt"),
    ]) {
      await assert.rejects(
        () => toolHandlerFor(taskRoot, deps)({ pattern: "*", path }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /protected-path roster/.test(error.message) &&
          !/outside workspace|not a file/.test(error.message)
      );
    }
  });

  /**
   * Real pinned rg half of the widened-root matrix: traversal of the outside
   * tree answers from the real engine; protected entries are dropped by
   * the same per-emission filter the Node walker uses (its filter position is
   * pinned engine-independent by the canned-output test below).
   */
  it.skipIf(!enginePresent)(
    "real rg on a widened outside root leaks no protected paths",
    async () => {
      const taskRoot = await makeScratch("glob-policy-widened-rg-task-");
      const outside = await realpath(
        await makeScratch("glob-policy-widened-rg-tree-")
      );
      await mkdir(join(outside, ".ssh"), { recursive: true });
      await writeFile(join(outside, ".ssh", "id_rsa"), "SSHSECRET\n");
      await writeFile(join(outside, ".env"), "ENVSECRET\n");
      await writeFile(join(outside, "notes.txt"), "benign\n");

      const output = await gather({
        root: taskRoot,
        pattern: "**",
        path: outside,
      });
      for (const leak of ["id_rsa", ".env", "SSHSECRET", "ENVSECRET"]) {
        assert.ok(
          !output.includes(leak),
          `real-rg widened listing leaked ${leak}: ${output}`
        );
      }
      assert.ok(
        output.includes("notes.txt"),
        `benign widened file lost: ${output}`
      );
    }
  );

  /**
   * rg-output form: the seam stands in for the spawned engine, so the filter
   * position on the engine-merged result list is what this pins — paths that
   * a real rg (with --hidden during traversal) could hand back are dropped.
   */
  it("canned rg output is filtered before sorting / limiting", async () => {
    const root = await makePolicyTree("glob-policy-rg-");
    const canned = [
      "notes.txt",
      ".ssh/id_rsa",
      ".env",
      "certs/server.pem",
    ].join("\n");
    const output = await gather({
      root,
      pattern: "**",
      deps: { spawnRg: async () => ({ stdout: canned, stderr: "" }) },
    });
    assert.equal(output, "notes.txt");
  });

  it("symlink alias as search root is refused; ordinary chains stay listable", async () => {
    const root = await makePolicyTree("glob-policy-link-");
    await mkdir(join(root, "realdir"));
    await writeFile(join(root, "realdir", "ok.txt"), "o\n");
    await symlink(join(root, "realdir"), join(root, "dirlink"));
    const deps: GlobToolDeps = {
      engineBinaryPath: join(root, "__no_such_engine__", "rg"),
    };
    await assert.rejects(
      () => toolHandlerFor(root, deps)({ pattern: "*", path: "alias.txt" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /protected-path roster/.test(error.message)
    );
    const out = await gather({ root, pattern: "*.txt", path: "dirlink", deps });
    assert.ok(out.includes("ok.txt"), `benign chain listing: ${out}`);
  });
});

function toolHandlerFor(root: string, deps: GlobToolDeps) {
  return createGlobTool(root, deps).handler as (
    input: unknown
  ) => Promise<unknown>;
}
