/**
 * worker bash 围栏可见性 (ADR-0092 全局档)。
 *
 * 取代 T5b 的 `projectIdentityRoot` 读白名单接线:worker 的 bash 是真实执行面
 * (createWorkerRuntime → createDefaultAciRegistry → bash → createFsPolicy →
 * createBwrapFence)。Round 1 起全局档 `--bind / /` 让宿主真实路径本就可见,
 * 主仓 checkout / worktree 的 `.git` gitdir 都可达,不再是逐根读白名单——
 * 因此原本认证的 `--ro-bind <identityRoot>` 断言随闭世界退役。
 *
 * 仍然真实的命题:worker bash 围栏绑定宿主根(主仓可达),系统前缀只读,
 * 不存在逐根 identity/installRoot 读白名单。
 *
 * 手法:module-mock runner.js(捕获 fence,registry / bash.ts / fs-policy /
 * bwrap.ts 保持真实),穿整条 worker deps → registry → bash 工厂 →
 * createBwrapFence 链路拿 argv。
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
    // bash.ts 工厂期 requireBwrap();测试环境不假设 bwrap 在场。
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

/** task-worktree 形状的主仓 fixture:`<base>/repo/.iknow/worktrees/w1--conv1`。 */
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
