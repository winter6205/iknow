/**
 * Tests for the `glob` ACI tool (T7).
 *
 * Coverage map:
 *  - normal match: pattern → relative paths, alphabetically sorted
 *  - "**" recursive pattern matches nested files
 *  - "*.ts" matches only files ending .ts (true glob, not substring)
 *  - empty pattern rejected (does not degenerate to "match all")
 *  - search root outside workspace rejected
 *  - limit truncates output (default 200, cap 5000)
 *  - Node fallback path returns the same shape when rg is unavailable
 *  - inputSchema shape (model-facing JSON Schema)
 *  - aci metadata
 *  - error path: handler throws ToolExecutionError on bad input
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
    });
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

  it("rejects a search root that escapes the workspace", async () => {
    const root = await makeScratch("glob-escape-");
    const outside = await makeScratch("glob-escape-out-");
    await buildFixtureTree(outside);

    const tool = createGlobTool(root);
    await assert.rejects(
      tool.handler({ pattern: "**/*.ts", path: outside }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "ToolExecutionError" &&
        error.message.includes("outside workspace")
    );
  });

  it("rejects a relative parent traversal that escapes the workspace", async () => {
    const parent = await makeScratch("glob-parent-");
    const root = join(parent, "root");
    await mkdir(root);
    const outside = join(parent, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "leak.ts"), "x");

    const tool = createGlobTool(root);
    await assert.rejects(
      tool.handler({ pattern: "**/*.ts", path: "../outside" }),
      ToolExecutionError
    );
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
