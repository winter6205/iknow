/**
 * Full-assembly prefix-stability matrix: for one session, the adjacent turns'
 * `promptTools()` + `deps.system()` must be deep-equal, across five scenarios:
 *
 *   a. MCP connects (injection window: connect-inside-window / window-timeout)
 *   b. graph off → on → off (three consecutive adjacent turns all deep-equal)
 *   c. memory file lands mid-session (session snapshot semantics: equal before/after)
 *   d. compact re-assembly (reactive compact path; messages may change,
 *      tools + system must not)
 *   e. git block static (session-level closure cache: multiple system() calls
 *      deep-equal, still unchanged after repo content changes)
 *
 * The per-scenario contracts are already pinned in
 * tests/harness/mcp/prefix-stability.test.ts,
 * tests/harness/graph/run-graph-assembly.test.ts,
 * tests/harness/memory/refresh.test.ts, and
 * tests/harness/identity/git-segment.test.ts; this file completes the matrix
 * without repeating their point assertions — only adjacent-turn deep-equal.
 */
import assert from "node:assert/strict";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import { createGraphModeContext } from "../../../src/harness/graph/mode.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import type { LoopEngineDeps } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { PromptTooLongError } from "../../../src/harness/errors.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import {
  GIT_SEGMENT_TITLE,
  createGitSnapshotProvider,
} from "../../../src/harness/identity/git-snapshot.ts";
import { createIknowSystemResolver } from "../../../src/harness/identity/assemble.ts";
import {
  makeInstantClient,
  makeGatedClient,
  makeNeverResolvingClient,
  plantMcpConfig,
  makeMatrixEnv,
  assertAdjacentTurnsStable,
  makeTempRoot,
} from "./_matrix-fixture.ts";

const cleanupRoots: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((f) => f()));
});

// ---------------------------------------------------------------------------
// a. MCP connects — in-window / window-timeout (real manager state machine + firstTurnReady seam)
// ---------------------------------------------------------------------------

/**
 * The window length is not what this scenario tests — what is tested is
 * "the directory freezes the moment the window expires and is never written
 * back afterwards". So a-ii / a-iii inject a small window through the
 * `mcpFirstTurnReadyTimeoutMs` seam and let the real window-polling path run
 * quickly; fake timers must NOT be used (they conflict with build-engine's
 * non-timer awaits) and the window must not be 0 (that would make the
 * connect-inside-window and window-timeout branches indistinguishable).
 *
 * A single server's own connect timeout still comes from
 * `makeMatrixEnv().mcp.connectTimeoutMs` = 60s: window < connect timeout ⇒
 * absent at expiry (the measured path for a-ii / a-iii).
 */
const MATRIX_FIRST_TURN_WINDOW_MS = 150;

describe("断言② 场景 a — MCP 连上(窗口定稿)", () => {
  it("a-i 窗口内连上 → 相邻两轮 tools + system deep-equal(connected 后定稿)", async () => {
    const { root, cleanup } = await makeTempRoot("mcp-in-window");
    cleanupRoots.push(cleanup);
    await plantMcpConfig(root, ["fastsvc"]);

    const built = await buildHarnessEngine({
      env: makeMatrixEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () =>
        makeInstantClient([{ name: "alpha", description: "d" }]),
      mcpFirstTurnReadyTimeoutMs: MATRIX_FIRST_TURN_WINDOW_MS,
    });
    try {
      // Assembly already awaited firstTurnReady → fastsvc should be connected.
      const status = built.mcpManager!.status();
      assert.equal(
        status.find((s) => s.name === "fastsvc")!.state,
        "connected"
      );

      // Adjacent turns (compare the round with itself + take one more turn): directory already frozen → deep-equal.
      await assertAdjacentTurnsStable(built, "a-i adjacent turns");
      const system = await built.deps.system!();
      assert.ok(system!.includes("<mcp_name_directory>"));
      assert.ok(system!.includes("fastsvc"));
      assert.ok(system!.includes("mcp__fastsvc__alpha"));
    } finally {
      await built.shutdown?.();
    }
  }, 20_000);

  it("a-ii 窗口超时 server 迟到连上 → 目录不回写,相邻轮 system 仍 deep-equal(产品 bug 已修)", async () => {
    // The spec says a server that times out is absent for the whole session
    // (never enters the name directory). A flip-back would turn a late
    // connection back to connected and call registerExternal (on the tools
    // side lazy schemas keep it out of the visible prefix, so tools don't
    // shift); if the directory read manager.status() live it would leak back
    // in → system would wobble. That wobble was demonstrated and fixed: the
    // name directory freezes once the firstTurnReady window resolves.
    const { root, cleanup } = await makeTempRoot("mcp-late");
    cleanupRoots.push(cleanup);
    await plantMcpConfig(root, ["latesvc"]);

    const gated = makeGatedClient();
    const built = await buildHarnessEngine({
      env: makeMatrixEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () => gated.handle,
      mcpFirstTurnReadyTimeoutMs: MATRIX_FIRST_TURN_WINDOW_MS,
    });
    try {
      const before = await built.deps.system!();
      assert.ok(!before!.includes("latesvc"), "窗口超时 → 缺席,不进目录");

      // Late connect (the assembly window already expired; the test releases the gate directly).
      gated.release();
      await new Promise((r) => setTimeout(r, 100));

      const after = await built.deps.system!();
      assert.equal(after, before, "迟到连上不得渗回名字目录");
      assert.ok(!after!.includes("latesvc"));
      const status = built.mcpManager!.status();
      assert.equal(
        status.find((s) => s.name === "latesvc")!.state,
        "connected",
        "连接状态机自身照常 flip-back(tools 侧 lazy 纪律不受影响)"
      );
    } finally {
      await built.shutdown?.();
    }
  }, 30_000);

  it("a-iii 全部 server 窗口超时 → 段缺席,相邻轮 deep-equal", async () => {
    const { root, cleanup } = await makeTempRoot("mcp-timeout");
    cleanupRoots.push(cleanup);
    await plantMcpConfig(root, ["slowsvc"]);

    const built = await buildHarnessEngine({
      env: makeMatrixEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () => makeNeverResolvingClient(),
      mcpFirstTurnReadyTimeoutMs: MATRIX_FIRST_TURN_WINDOW_MS,
    });
    try {
      // The server's own connect never resolves (its 60s connect timeout far exceeds
      // the injected window) → absent the moment the window expires.
      const system = await built.deps.system!();
      assert.ok(!system!.includes("<mcp_name_directory>"));
      await assertAdjacentTurnsStable(built, "a-iii adjacent turns");
    } finally {
      await built.shutdown?.();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// b. graph off → on → off — three consecutive adjacent turns all deep-equal
// ---------------------------------------------------------------------------

describe("断言② 场景 b — graph 翻图(关→开→关)", () => {
  it("b-i 三次相邻轮 tools + system 全 deep-equal;切换只落 messages 尾", async () => {
    const { root, cleanup } = await makeTempRoot("graph-flip");
    cleanupRoots.push(cleanup);
    await mkdir(join(root, "home"), { recursive: true });
    const mode = createGraphModeContext();

    const built = await buildHarnessEngine({
      env: makeMatrixEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      graphMode: mode,
    });
    try {
      // off → on
      await assertAdjacentTurnsStable(built, "b off→on", () => {
        mode.setEnabled(true);
        built.graphAssembly!.beginRound();
      });
      // on → off
      await assertAdjacentTurnsStable(built, "b on→off", () => {
        mode.setEnabled(false);
        built.graphAssembly!.beginRound();
      });
      // one more off turn (off → off)
      await assertAdjacentTurnsStable(built, "b off→off");

      // run_graph stays resident in tools (registered permanently; graph flips never remove it)
      const names = built.deps.promptTools!().map((t) => t.name);
      assert.ok(names.includes("run_graph"));
    } finally {
      await built.shutdown?.();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// c. memory file landing mid-session — session snapshot semantics
// ---------------------------------------------------------------------------

describe("断言② 场景 c — 会话内记忆文件落盘", () => {
  it("c-i 落盘前后相邻轮 system deep-equal(catalog 段冻结在首次装配)", async () => {
    const { root, cleanup } = await makeTempRoot("memory-persist");
    cleanupRoots.push(cleanup);
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(join(root, "home", ".iknow"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "b7-memory-project", "utf8");

    const built = await buildHarnessEngine({
      env: makeMatrixEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: { memory: { autoExtract: true } },
    });
    try {
      const system0 = await built.deps.system!();
      assert.ok(system0!.includes("b7-memory-project"));

      // A memory file lands mid-session (ADR-0031 auto-memory product shape)
      const { serializeMemoryEntry } =
        await import("../../../src/harness/memory/frontmatter.ts");
      const { defaultMemoryEntry } =
        await import("../../../src/harness/memory/schema.ts");
      const memoryDir = join(root, ".iknow", "memory");
      await mkdir(memoryDir, { recursive: true });
      await writeFile(
        join(memoryDir, "b7entry.md"),
        serializeMemoryEntry({
          ...defaultMemoryEntry(),
          id: "b7entry",
          title: "Late landing entry",
          body: "body",
          importance: 3,
          updated_at: "2026-09-04T00:00:00.000Z",
        }),
        "utf8"
      );
      // Also mutate a static layer mid-session (the very mechanism that once dragged the catalog into the prefix)
      await writeFile(join(root, "AGENTS.md"), "b7-memory-project-v2", "utf8");

      const system1 = await built.deps.system!();
      assert.equal(
        system1,
        system0,
        "落盘 + 静态层变更后 system 必须逐字节不变(会话级快照)"
      );
      assert.ok(!system1!.includes("Late landing entry"));
      assert.ok(!system1!.includes("b7-memory-project-v2"));
      await assertAdjacentTurnsStable(built, "c adjacent turns");
    } finally {
      await built.shutdown?.();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// d. compact re-assembly — messages may change, tools + system must not
// ---------------------------------------------------------------------------

describe("断言② 场景 d — compact 重装配", () => {
  it("d-i reactive compact(PromptTooLongError)前后 tools + system deep-equal", async () => {
    // Real assembly chain (deps.system / promptTools are build-engine products);
    // the adapter is a stub: turn 1 throws PromptTooLongError to trigger
    // reactive compact, turn 2 closes with plain text. Compact only rewrites
    // messages — the tools/system seams never read messages.
    const { root, cleanup } = await makeTempRoot("compact");
    cleanupRoots.push(cleanup);
    await mkdir(join(root, "home"), { reactive: true } as never);
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "b7-compact-project", "utf8");

    const built = await buildHarnessEngine({
      env: makeMatrixEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
    });

    const toolsBefore = built.deps.promptTools!();
    const systemBefore = await built.deps.system!();

    // Long history (makes splitForCompaction drop the prefix) + compression threshold + reactive trigger.
    const bigText = "payload ".repeat(120);
    let stepCount = 0;
    const stubModel = {
      step: async () => {
        stepCount += 1;
        if (stepCount === 1) {
          throw new PromptTooLongError();
        }
        return assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
      encodeUserText: (t: string) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: t }],
      }),
      encodeToolResults: createStubModel({ responses: [] }).encodeToolResults,
    };

    const history = Array.from({ length: 12 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `${bigText} turn ${i}` }],
    }));

    const deps: LoopEngineDeps = {
      ...(built.deps as LoopEngineDeps),
      adapter: stubModel as never,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
      trace: undefined,
    };

    const { result } = await run("hello", deps, undefined, {
      priorMessages: history,
    });

    assert.equal(result.stopReason, "completed");
    // compact really happened: message count far below the input (1 + 12).
    assert.ok(
      result.messages.length < 13,
      `compact 应截短 messages,实际 ${result.messages.length}`
    );
    // Core of this assertion: tools + system byte-identical across compact.
    assert.deepEqual(
      built.deps.promptTools!().map((t) => t.name),
      toolsBefore.map((t) => t.name)
    );
    for (let i = 0; i < toolsBefore.length; i++) {
      assert.deepEqual(
        JSON.stringify(built.deps.promptTools!()[i]),
        JSON.stringify(toolsBefore[i])
      );
    }
    assert.equal(await built.deps.system!(), systemBefore);
    await built.shutdown?.();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// e. git block static — session-level closure cache
// ---------------------------------------------------------------------------

describe("断言② 场景 e — git 块静态(仓库内容变化后仍不变)", () => {
  it("e-i 同一 provider 多轮 system deep-equal;仓库新增 commit 后 provider 返回不变", async () => {
    const { spawnSync } = await import("node:child_process");
    const gitOk =
      spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
    if (!gitOk) return; // skipped when git is not on PATH (same concession as the unit-level git tests)

    const repo = await mkdtemp(join(tmpdir(), "iknow-b7-git-repo-"));
    cleanupRoots.push(async () => rm(repo, { recursive: true, force: true }));
    const git = (args: readonly string[]): void => {
      const r = spawnSync("git", [...args], {
        cwd: repo,
        encoding: "utf8",
      });
      if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      }
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "T"]);
    git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(repo, "a.txt"), "one\n", "utf8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "c1"]);

    const provider = createGitSnapshotProvider({ cwd: repo });
    const home = await mkdtemp(join(tmpdir(), "iknow-b7-git-home-"));
    cleanupRoots.push(async () => rm(home, { recursive: true, force: true }));

    const resolver = createIknowSystemResolver({
      projectIdentityRoot: repo,
      userHome: home,
      surface: "chat",
      memoryEnabled: false,
      git: provider,
    });

    const s0 = await resolver();
    const s1 = await resolver();
    assert.equal(s1, s0);
    assert.ok(s0!.includes(GIT_SEGMENT_TITLE));

    // Repo content changes: new commit + new file — the closure snapshot never re-samples.
    await writeFile(join(repo, "b.txt"), "two\n", "utf8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "c2"]);
    git(["checkout", "-q", "-b", "feature-branch"]);

    const s2 = await resolver();
    const p2 = provider();
    assert.equal(s2, s0, "仓库变化后 system 必须仍逐字节不变");
    assert.ok(p2, "provider 仍返回会话级冻结快照");
    assert.ok(!s2!.includes("feature-branch"));
    assert.ok(!s2!.includes("c2"));
  });

  it("e-ii build-engine 装配(真实项目根)相邻轮 system deep-equal 且含 git 块", async () => {
    const { spawnSync } = await import("node:child_process");
    const gitOk =
      spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
    if (!gitOk) return;

    const { root, cleanup } = await makeTempRoot("git-engine");
    cleanupRoots.push(cleanup);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    const git = (args: readonly string[]): void => {
      spawnSync("git", [...args], {
        cwd: repo,
        encoding: "utf8",
      });
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "T"]);
    await writeFile(join(repo, "x.txt"), "x\n", "utf8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);

    const built = await buildHarnessEngine({
      env: makeMatrixEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: repo,
    });
    try {
      await assertAdjacentTurnsStable(built, "e-ii adjacent turns");
      const system = await built.deps.system!();
      assert.ok(system!.includes(GIT_SEGMENT_TITLE));
    } finally {
      await built.shutdown?.();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Matrix close-out: consistency smoke for the five scenarios (not
// deep-equal; only asserts the matrix's coverage shapes)
// ---------------------------------------------------------------------------

describe("断言② 矩阵收口", () => {
  it("M-1 tools 侧元素级比较 helper 与 B4 同形态", () => {
    const reg = createRegistry([
      createStubTool({ name: "bash", next: () => "ok" }),
      createStubTool({ name: "read_file", next: () => "ok" }),
    ]);
    const list1 = reg.list();
    const list2 = reg.list();
    assert.deepEqual(
      list2.map((t) => t.name),
      list1.map((t) => t.name)
    );
  });

  it("M-2 makeInstantClient 返回 schema 化工具(供目录渲染)", async () => {
    const handle = makeInstantClient([{ name: "zed" }]);
    const tools = await handle.listTools();
    assert.equal(tools[0]?.name, "zed");
    expect(tools).toBeDefined();
  });
});
