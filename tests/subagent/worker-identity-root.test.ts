/**
 * T5b (ADR-0037 §9.2 #6, plans/closed-world-bash-fence.md) — worker bash
 * 围栏接 projectIdentityRoot 读白名单成员。
 *
 * 查证结论(T5 移交观察的裁决依据):worker 的 bash 是**真实执行面** ——
 * createWorkerRuntime 经 createDefaultAciRegistry 装配真实 registry,bash
 * handler per-call 经 createFsPolicy / createBwrapFence 构造闭世界围栏。
 * worker registry 调用此前不传 projectIdentityRoot → 闭世界读白名单缺
 * §9.2 #6 合同读根(主仓 checkout):worker cwd 是 task worktree 时,
 * worktree 的 `.git` file 指向主仓 gitdir,主仓不可达 → `git status` 等
 * exit 128 `fatal: not a git repository`(T1 盘点实测断链)。
 *
 * 条件化(与主链 isolationEnabled 对齐,不更宽):worker 进程没有
 * isolationEnabled 信号,但 worker 围栏 taskRoot = sandboxRoot(spawn 期
 * 冻结),主链「rebind 后 identity 根才装载」的谓词在 worker 侧的等价形式
 * = sandboxRoot 是 task-worktree 形状(taskWorktreeOwnerOf,与 build-engine
 * spawn 处 sessionRoot 的判定同源):
 *   - OFF / 未改绑(sandboxRoot = 主仓):不传 —— .git 就在 cwd 内,本不缺
 *     读通道(ADR §9.2 #6 括号理由),字节同今日;
 *   - ON + 已改绑(sandboxRoot = task worktree):传父会话 verbatim 的
 *     sessionRoots.projectIdentityRoot(T3 IKNOW_PRODUCT_ROOT wire 已送达),
 *     缺席(旧 wire)回落 mainCheckoutOf(sandboxRoot) —— 与 build-engine
 *     sessionRoots 派生同一 SSOT 纯路径推导,不新造状态源。
 *
 * 手法:module-mock runner.js(捕获 fence,registry / bash.ts / fs-policy /
 * bwrap.ts 保持真实)—— 断言穿过整条 worker deps → registry → bash 工厂 →
 * createFsPolicy → createBwrapFence 链路落到 argv 的 identity ro-bind,
 * 比 factory-opts 捕获多一轴端到端(policy 读白名单)证据。
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
import { mainCheckoutOf } from "../../src/harness/isolation/worktree-gate.ts";
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

/** fence.argv 里 `--ro-bind <root> <root>` 三元组的下标;缺席 → -1。 */
function identityBindIndex(argv: readonly string[], root: string): number {
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

describe("createWorkerDeps — projectIdentityRoot threaded into the bash fence read whitelist (T5b)", () => {
  it("rebound worker (worktree-shaped sandboxRoot) + explicit root → verbatim identity ro-bind in the fence argv", async () => {
    const { repo, worktree } = await makeWorktreeFixture(
      "worker-identity-root-verbatim-"
    );
    // 用独立于 mainCheckoutOf(worktree) 的另一棵盘上树作 opts 值,证明
    // 透传是 verbatim(不是 worker 侧再派生)。
    const identity = join(await makeScratch("worker-identity-root-src-"), "id");
    await mkdir(identity, { recursive: true });
    const deps = await buildWorkerDeps({
      sandboxRoot: worktree,
      projectIdentityRoot: identity,
    });
    const argv = await runBashAndGetArgv(deps);
    expect(identityBindIndex(argv, identity)).toBeGreaterThan(-1);
    // repo(= mainCheckoutOf(worktree))不因派生而混入 —— 透传值唯一。
    expect(identityBindIndex(argv, repo)).toBe(-1);
  });

  it("unbound worker (plain sandboxRoot) → conditional absence: no identity root even when opts.projectIdentityRoot is provided", async () => {
    const sandboxRoot = await makeScratch("worker-identity-root-plain-");
    const identity = join(await makeScratch("worker-identity-root-src-"), "id");
    await mkdir(identity, { recursive: true });
    const deps = await buildWorkerDeps({
      sandboxRoot,
      projectIdentityRoot: identity,
    });
    const argv = await runBashAndGetArgv(deps);
    expect(identityBindIndex(argv, identity)).toBe(-1);
  });

  it("rebound worker without the T3 wire → mainCheckoutOf(sandboxRoot) SSOT fallback lands in the read whitelist", async () => {
    const { repo, worktree } = await makeWorktreeFixture(
      "worker-identity-root-fallback-"
    );
    expect(mainCheckoutOf(worktree)).toBe(repo);
    const deps = await buildWorkerDeps({ sandboxRoot: worktree });
    const argv = await runBashAndGetArgv(deps);
    expect(identityBindIndex(argv, repo)).toBeGreaterThan(-1);
  });

  it("identity enters as a READ member (--ro-bind), not a writable bind", async () => {
    const { repo, worktree } = await makeWorktreeFixture(
      "worker-identity-root-readonly-"
    );
    const deps = await buildWorkerDeps({ sandboxRoot: worktree });
    const argv = await runBashAndGetArgv(deps);
    const idx = identityBindIndex(argv, repo);
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx]).toBe("--ro-bind");
  });
});
