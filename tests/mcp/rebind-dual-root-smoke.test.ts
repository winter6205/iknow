/**
 * Smoke — dual-root after worktree rebind (productRoot=main, workspaceRoot=task).
 *
 * Proves with REAL stdio MCP (fixture server):
 *  1. loadMcpConfig reads main's `.iknow/mcp.json` when mcpConfigRoot=main
 *     even if the task worktree has a decoy / no project config.
 *  2. Stdio child process.cwd() === worktree (relative print-cwd under worktree).
 *  3. createMcpManager + createRealClient connects to the fixture server.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMcpRoots } from "../../src/harness/mcp/roots.ts";
import { loadMcpConfig } from "../../src/harness/mcp/config.ts";
import {
  createMcpManager,
  createRealClient,
  type McpManager,
} from "../../src/harness/mcp/manager.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureServer = join(
  repoRoot,
  "tests",
  "fixtures",
  "mcp-server",
  "server.ts"
);

const tmpRoots: string[] = [];

async function mkTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const d = tmpRoots.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function waitForConnected(
  manager: McpManager,
  name: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = manager.status().find((x) => x.name === name);
    if (s?.state === "connected") return;
    if (s?.state === "failed") {
      throw new Error(
        `server ${name} failed before connected: ${s.error ?? "(no error)"}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const s = manager.status().find((x) => x.name === name);
  throw new Error(
    `waitForConnected: ${name} state=${s?.state} after ${timeoutMs}ms`
  );
}

describe("smoke — dual-root MCP after rebind", () => {
  it("config from productRoot + stdio cwd=worktree + real fixture connect", async () => {
    const home = await mkTemp("iknow-rebind-smoke-home-");
    const productRoot = await mkTemp("iknow-rebind-smoke-main-");
    const worktree = await mkTemp("iknow-rebind-smoke-wt-");

    // Main checkout: project mcp.json points at absolute fixture MCP server.
    await mkdir(join(productRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(productRoot, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          rebind_echo: {
            type: "stdio",
            command: process.execPath,
            args: [fixtureServer],
          },
        },
      }),
      "utf8"
    );

    // Task worktree: no project mcp.json; decoy would be wrong if ever read.
    // Relative print-cwd script lives only under worktree (cwd contract).
    await writeFile(
      join(worktree, "print-cwd.mjs"),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "writeFileSync(join(process.cwd(), 'child-cwd.txt'), process.cwd());",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8"
    );

    // 1) Resolver: mcpConfigRoot stays on productRoot; workspaceRoot = worktree.
    const roots = resolveMcpRoots({
      workspaceRoot: worktree,
      productRoot,
    });
    expect(roots.mcpConfigRoot).toBe(productRoot);
    expect(roots.workspaceRoot).toBe(worktree);

    // 2) Config loads from main even though workspaceRoot is the empty worktree.
    const cfg = await loadMcpConfig({
      home,
      mcpConfigRoot: roots.mcpConfigRoot,
    });
    expect(cfg.servers.map((s) => s.name)).toEqual(["rebind_echo"]);
    expect(cfg.servers[0]?.source).toBe("project");
    expect(cfg.servers[0]?.kind).toBe("stdio");
    if (cfg.servers[0]?.kind === "stdio") {
      expect(cfg.servers[0].entry.args).toEqual([fixtureServer]);
    }

    // 3) Stdio child cwd === worktree (T4 print-cwd relative script pattern).
    const cwdProbe = createRealClient(
      {
        name: "cwd-probe",
        kind: "stdio",
        source: "user",
        status: "enabled",
        entry: {
          command: process.execPath,
          args: ["./print-cwd.mjs"],
        },
      },
      { cwd: roots.workspaceRoot }
    );
    await Promise.race([
      cwdProbe.connect().catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 800)),
    ]);
    const marker = join(worktree, "child-cwd.txt");
    const deadline = Date.now() + 3000;
    let childCwd = "";
    while (Date.now() < deadline) {
      try {
        childCwd = (await readFile(marker, "utf8")).trim();
        if (childCwd.length > 0) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(childCwd).toBe(worktree);
    await cwdProbe.close().catch(() => undefined);

    // 4) Manager connects to real fixture with workspaceRoot=worktree.
    const mgr = createMcpManager({
      workspaceRoot: roots.workspaceRoot,
      config: cfg.servers,
      registerExternal: () => {},
      createClient: createRealClient,
    });
    try {
      await mgr.start();
      await waitForConnected(mgr, "rebind_echo");
      const st = mgr.status().find((s) => s.name === "rebind_echo");
      expect(st?.state).toBe("connected");
    } finally {
      await mgr.shutdown();
    }
  }, 30_000);
});
