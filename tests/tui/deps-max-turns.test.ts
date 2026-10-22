/**
 * tests/tui/deps-max-turns.test.ts
 *
 * The `--max-turns` flag at the TUI assembly layer (bun runner: tests/tui is
 * driven by bun).
 *
 * `buildHarnessEngine` seeds `LoopEngineDeps.maxTurns` from `env.llm.maxTurns`,
 * which is env/settings only — so a flag the CLI parsed had no way to reach the
 * engine through the TUI entry, while chat / ask already apply
 * `parsed.maxTurns ?? built.deps.maxTurns` at their own assembly point. These
 * cases pin the TUI's two requirements: an explicit flag wins over env, and an
 * absent flag leaves the env value untouched (absent = byte-identical, not
 * "undefined = unlimited").
 *
 * The two root-switch cases stand in for a worktree rebind: one builds at
 * another root, the other drives the hub's per-root delegation. Neither calls
 * `runTui`, so `run.tsx`'s own carrier is pinned by the source guard below —
 * `depsOpts` is local to `runTui` and nothing importable exposes it short of
 * starting a renderer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildTuiDeps } from "../../src/tui/deps.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import type { LoopEngineDeps } from "../../src/harness/index.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";

/** Minimal valid RuntimeBundle (same shape as deps-isolation.test.ts). */
function makeBundle(llmMaxTurns?: number): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-tui",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
      ...(llmMaxTurns !== undefined ? { maxTurns: llmMaxTurns } : {}),
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
  return { env } as unknown as RuntimeBundle;
}

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** Session-root seam: absent `dataDir`, resolveServeDataDir defaults to the real homedir(). */
function dataDirOf(rootDir: string): string {
  return join(rootDir, "data");
}

afterAll(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

describe("buildTuiDeps — --max-turns reaches the engine deps", () => {
  test("opts.maxTurns wins over env.llm.maxTurns", async () => {
    const cwd = await root("iknow-tui-max-turns-flag-");
    const deps = await buildTuiDeps(makeBundle(7), {
      askUser: createNoAskUser(),
      userHome: join(cwd, "home"),
      cwd,
      dataDir: dataDirOf(cwd),
      maxTurns: 2,
    });
    expect(deps.maxTurns).toBe(2);
    if (deps.shutdown) await deps.shutdown();
  });

  test("no opts.maxTurns → the env value stays exactly as today (absent flag is not unlimited)", async () => {
    const cwd = await root("iknow-tui-max-turns-env-");
    const deps = await buildTuiDeps(makeBundle(7), {
      askUser: createNoAskUser(),
      userHome: join(cwd, "home"),
      cwd,
      dataDir: dataDirOf(cwd),
    });
    expect(deps.maxTurns).toBe(7);
    if (deps.shutdown) await deps.shutdown();
  });

  test("no opts.maxTurns and no env value → the field stays undefined (ADR-0012 unlimited default)", async () => {
    const cwd = await root("iknow-tui-max-turns-none-");
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(cwd, "home"),
      cwd,
      dataDir: dataDirOf(cwd),
    });
    expect(deps.maxTurns).toBeUndefined();
    if (deps.shutdown) await deps.shutdown();
  });

  // A rebound session builds at the worktree root with a stable productRoot;
  // this pins the flag still wins in that option shape (a single build).
  test("a build at a worktree root (moved cwd / workspaceRoot, stable productRoot) still honors the flag", async () => {
    const startup = await root("iknow-tui-max-turns-root-a-");
    const taskRoot = await root("iknow-tui-max-turns-root-b-");
    const deps = await buildTuiDeps(makeBundle(7), {
      askUser: createNoAskUser(),
      userHome: join(startup, "home"),
      cwd: taskRoot,
      workspaceRoot: taskRoot,
      productRoot: startup,
      dataDir: dataDirOf(startup),
      maxTurns: 3,
    });
    expect(deps.maxTurns).toBe(3);
    if (deps.shutdown) await deps.shutdown();
  });

  /**
   * The hub side only: the `buildEngine` here is a fixture, so the cap it
   * asserts comes from the options it hands to `buildTuiDeps`, not from
   * production wiring — that run.tsx feeds the flag into the real seam is
   * pinned by the source guard below. What this case does prove is the real
   * `ensureDeps` delegation: a root other than the injected one returns the
   * seam's deps, and those deps honor `opts.maxTurns`.
   */
  test("hub.ensureDeps hands a moved root to the injected seam and gets deps honoring opts.maxTurns", async () => {
    const startup = await root("iknow-tui-max-turns-seam-a-");
    const taskRoot = await root("iknow-tui-max-turns-seam-b-");
    const dataDir = dataDirOf(startup);
    const sharedOpts = {
      askUser: createNoAskUser(),
      userHome: join(startup, "home"),
      cwd: startup,
      workspaceRoot: startup,
      productRoot: startup,
      dataDir,
      maxTurns: 2,
    };
    const initial = await buildTuiDeps(makeBundle(9), sharedOpts);
    expect(initial.maxTurns).toBe(2);
    const bridge = createTuiBridge({
      dataDir,
      workspaceRoot: startup,
      deps: initial,
      inflight: createInflightRegistry(),
      engineRoot: startup,
      buildEngine: async (root) => ({
        deps: await buildTuiDeps(makeBundle(9), {
          ...sharedOpts,
          cwd: root,
          workspaceRoot: root,
        }),
      }),
    });
    const rebuilt = await (
      bridge.hub as unknown as {
        ensureDeps: (root?: string) => Promise<LoopEngineDeps>;
      }
    ).ensureDeps(taskRoot);
    // Delegation actually ran: without this the hub could return the cached
    // injected deps and the cap assertion above would prove nothing.
    expect(rebuilt).not.toBe(initial);
    expect(rebuilt.maxTurns).toBe(2);
    if (initial.shutdown) await initial.shutdown();
  });
});

// A source guard is the only available evidence below: `depsOpts` is local to
// `runTui` and the seam is one of its call arguments, so no test can read the
// carrier without starting a renderer.
describe("run.tsx — one carrier takes the cap to both build sites", () => {
  const runSrc = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "tui", "run.tsx"),
    "utf8"
  );

  test("the shared depsOpts takes the cap from runTui's option", () => {
    const optsIdx = runSrc.indexOf("const depsOpts: BuildTuiDepsOptions = {");
    expect(optsIdx).toBeGreaterThanOrEqual(0);
    // Pin the block end: an unfound terminator makes slice() swallow the rest of
    // the file, which would let a later maxTurns satisfy the match.
    const optsEnd = runSrc.indexOf("\n    };", optsIdx);
    expect(optsEnd).toBeGreaterThan(optsIdx);
    expect(runSrc.slice(optsIdx, optsEnd)).toMatch(
      /maxTurns: options\.maxTurns/
    );
  });

  // The drift this guards: a seam that spelled its own maxTurns (or omitted it)
  // would drift from the initial build and a rebound session would lose the cap.
  test("the rebind seam re-spreads depsOpts instead of spelling its own cap", () => {
    const seamIdx = runSrc.indexOf("buildEngine:");
    expect(seamIdx).toBeGreaterThanOrEqual(0);
    // Windowed to the seam callback so the negative match is a claim about the
    // seam, not about the rest of the file.
    const seamBlock = runSrc.slice(seamIdx, seamIdx + 900);
    expect(seamBlock).toMatch(/\.\.\.depsOpts/);
    expect(seamBlock).not.toMatch(/maxTurns/);
  });
});
