/**
 * Worker bash fence visibility (ADR-0092 global mode).
 *
 * Replaces the old per-root `projectIdentityRoot` read-whitelist wiring:
 * worker bash is a real execution surface (createWorkerRuntime →
 * createDefaultAciRegistry → bash → createFsPolicy → createBwrapFence). Since
 * the global-mode `--bind / /`, host real paths are already visible — main
 * checkout and worktree gitdirs are all reachable — so the former
 * `--ro-bind <identityRoot>` assertions retired with the closed world.
 *
 * Still-true propositions: the worker bash fence binds the host root (main
 * repo reachable), system prefixes are read-only, and no per-root
 * identity/installRoot read whitelist exists.
 *
 * Method: module-mock runner.js (capture the fence; registry / bash.ts /
 * fs-policy / bwrap.ts stay real) and drive the whole
 * worker deps → registry → bash factory → createBwrapFence chain to get argv.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/sandbox/runner.js")
    >();
  return {
    ...actual,
    // bash.ts calls requireBwrap() at factory time; do not assume bwrap exists here.
    requireBwrap: () => {},
    runInSandbox: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
});

import { runInSandbox } from "../../src/harness/sandbox/runner.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { READ_ONLY_SYSTEM_PATHS } from "../../src/harness/sandbox/fs-policy.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/** Main-repo fixture in task-worktree shape: `<base>/repo/.iknow/worktrees/w1--conv1`. */
async function makeWorktreeFixture(prefix: string): Promise<{
  readonly repo: string;
  readonly worktree: string;
}> {
  const base = await makeScratch(prefix);
  const repo = join(base, "repo");
  const worktree = join(repo, ".iknow", "worktrees", "w1--conv1");
  await mkdir(worktree, { recursive: true });
  return { repo, worktree };
}

async function buildWorkerDeps(opts: {
  readonly sandboxRoot: string;
  readonly projectIdentityRoot?: string;
}) {
  return createWorkerDeps({
    env: TEST_ENV,
    sandboxRoot: opts.sandboxRoot,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    ...(opts.projectIdentityRoot !== undefined
      ? { projectIdentityRoot: opts.projectIdentityRoot }
      : {}),
  });
}

function roBindIndex(argv: readonly string[], root: string): number {
  for (let i = 0; i + 2 < argv.length; i++) {
    if (
      argv[i] === "--ro-bind" &&
      argv[i + 1] === root &&
      argv[i + 2] === root
    ) {
      return i;
    }
  }
  return -1;
}

function hasHostRootBind(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) => arg === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/"
  );
}

async function runBashAndGetArgv(
  deps: Awaited<ReturnType<typeof buildWorkerDeps>>
): Promise<readonly string[]> {
  const bash = deps.registry.get("bash");
  if (!bash || typeof bash.handler !== "function") {
    throw new Error("bash tool missing from worker registry");
  }
  await bash.handler({ command: "echo hi" });
  const calls = vi.mocked(runInSandbox).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1]!;
  return last[0]!.fence.argv;
}

afterEach(async () => {
  vi.mocked(runInSandbox).mockClear();
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("createWorkerDeps — worker bash fence is global mode (ADR-0092)", () => {
  it("rebound worker exposes the host root (main checkout reachable), no per-root identity ro-bind", async () => {
    const { repo, worktree } = await makeWorktreeFixture(
      "worker-identity-root-verbatim-"
    );
    const identity = join(await makeScratch("worker-identity-root-src-"), "id");
    await mkdir(identity, { recursive: true });
    const deps = await buildWorkerDeps({
      sandboxRoot: worktree,
      projectIdentityRoot: identity,
    });
    const argv = await runBashAndGetArgv(deps);
    expect(hasHostRootBind(argv)).toBe(true);
    expect(roBindIndex(argv, identity)).toBe(-1);
    expect(roBindIndex(argv, repo)).toBe(-1);
  });

  it("plain worker sandboxRoot also binds the host root", async () => {
    const sandboxRoot = await makeScratch("worker-identity-root-plain-");
    const deps = await buildWorkerDeps({ sandboxRoot });
    const argv = await runBashAndGetArgv(deps);
    expect(hasHostRootBind(argv)).toBe(true);
    expect(roBindIndex(argv, sandboxRoot)).toBe(-1);
  });

  it("system prefixes stay read-only in the worker fence", async () => {
    const sandboxRoot = await makeScratch("worker-identity-root-ro-");
    const deps = await buildWorkerDeps({ sandboxRoot });
    const argv = await runBashAndGetArgv(deps);
    for (const path of READ_ONLY_SYSTEM_PATHS) {
      expect(roBindIndex(argv, path)).toBeGreaterThan(-1);
    }
  });
});
