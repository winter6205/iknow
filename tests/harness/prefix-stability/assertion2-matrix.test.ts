/**
 * B7 / spec model-prefix-layering SC2 — 断言②总装矩阵:同一会话相邻两轮
 * 装配 `promptTools()` + `deps.system()` deep-equal,五场景收齐:
 *
 *   a. MCP 连上(fake timer 控制窗口内连上 / 窗口超时两种)
 *   b. graph 关 → 开 → 关(连续三次相邻轮全 deep-equal)
 *   c. 会话内记忆文件落盘(B2 快照语义:落盘前后 deep-equal)
 *   d. compact 重装配(reactive compact 路径;spec §G5:messages 会废,
 *      tools + system 必须不变)
 *   e. git 块静态(会话级闭包缓存:多次 system() deep-equal + git 仓库
 *      内容变化后仍不变)
 *
 * 各场景的单场景契约分别在 tests/harness/mcp/prefix-stability.test.ts (B4)、
 * tests/harness/graph/run-graph-assembly.test.ts (B3)、
 * tests/harness/memory/refresh.test.ts (B2)、
 * tests/harness/identity/git-segment.test.ts (B5) 钉死;本文件收全矩阵,
 * 不重复其单点断言,只断言相邻轮 deep-equal。
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
import { createExecutor } from "../../../src/harness/tools/executor.ts";
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
// a. MCP 连上 — 窗口内连上 / 窗口超时(实测 = 真实 manager 状态机 + B4 缝)
// ---------------------------------------------------------------------------

/**
 * build-engine 硬编码 firstTurnReady 窗口 30s(生产契约)。a-ii / a-iii 用
 * 真实窗口等待(测试超时 60s 给足);fake timer 快进与 build-engine 内部
 * 非 timer 等待点实测相冲(见 a-iii 走真实窗口通过的对照),不采用。
 */

describe("断言② 场景 a — MCP 连上(fake timer 控制窗口)", () => {
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
    });
    try {
      // 装配期已 await firstTurnReady → fastsvc 应已 connected。
      const status = built.mcpManager!.status();
      assert.equal(
        status.find((s) => s.name === "fastsvc")!.state,
        "connected"
      );

      // 相邻两轮(同 round 自比 + 再取一轮):目录已定稿 → deep-equal。
      await assertAdjacentTurnsStable(built, "a-i adjacent turns");
      const system = await built.deps.system!();
      assert.ok(system!.includes("<mcp_name_directory>"));
      assert.ok(system!.includes("fastsvc"));
      assert.ok(system!.includes("mcp__fastsvc__alpha"));
    } finally {
      await built.shutdown?.();
    }
  }, 30_000);

  it("a-ii 窗口超时 server 迟到连上 → 目录不回写,相邻轮 system 仍 deep-equal(产品 bug 已修)", async () => {
    // spec §4:超时者本会话缺席(不进名字目录)。#378 flip-back 会让迟到
    // 连接翻回 connected 并 registerExternal(tools 侧 lazy 不进 visible
    // 前缀,tools 不抖);目录若现读 manager.status() 则会渗回 → system 抖。
    // B7 实证该抖动后修复:名字目录在 firstTurnReady 窗口 resolve 后冻结。
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
    });
    try {
      const before = await built.deps.system!();
      assert.ok(!before!.includes("latesvc"), "窗口超时 → 缺席,不进目录");

      // 迟到连上(远超 30s 窗口之后的真实时点;测试直接 release 闸门)。
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
  }, 60_000);

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
    });
    try {
      // own connect-timeout 60s > 30s firstTurnReady 窗口 → 窗口到点即缺席。
      const system = await built.deps.system!();
      assert.ok(!system!.includes("<mcp_name_directory>"));
      await assertAdjacentTurnsStable(built, "a-iii adjacent turns");
    } finally {
      await built.shutdown?.();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// b. graph 关 → 开 → 关 — 连续三次相邻轮全 deep-equal
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
      // 关 → 开
      await assertAdjacentTurnsStable(built, "b off→on", () => {
        mode.setEnabled(true);
        built.graphAssembly!.beginRound();
      });
      // 开 → 关
      await assertAdjacentTurnsStable(built, "b on→off", () => {
        mode.setEnabled(false);
        built.graphAssembly!.beginRound();
      });
      // 再关一轮(关 → 关)
      await assertAdjacentTurnsStable(built, "b off→off");

      // run_graph 常驻在 tools(常驻注册,翻图不减员)
      const names = built.deps.promptTools!().map((t) => t.name);
      assert.ok(names.includes("run_graph"));
    } finally {
      await built.shutdown?.();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// c. 会话内记忆文件落盘 — B2 快照语义
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

      // 会话内记忆文件落盘(ADR-0031 auto-memory 产物形态)
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
      // 再补一个静态层 mid-session 变更(曾经会把 catalog 拖进前缀的机制)
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
// d. compact 重装配 — spec §G5:messages 会废,tools + system 必须不变
// ---------------------------------------------------------------------------

describe("断言② 场景 d — compact 重装配", () => {
  it("d-i reactive compact(PromptTooLongError)前后 tools + system deep-equal", async () => {
    // 真实装配链(deps.system / promptTools 即 build-engine 产物),adapter
    // 换成 stub:第一回合抛 PromptTooLongError 触发 reactive compact,第二
    // 回合纯文本收尾。compact 只重排 messages,tools/system 缝不读 messages。
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

    // 长历史(触发 splitForCompaction 丢前缀)+ 压缩门槛 + reactive 触发器。
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
    // compact 确实发生:messages 数量远小于输入(1 + 12)。
    assert.ok(
      result.messages.length < 13,
      `compact 应截短 messages,实际 ${result.messages.length}`
    );
    // 断言② core:compact 前后 tools + system 逐字节不变。
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
// e. git 块静态 — 会话级闭包缓存
// ---------------------------------------------------------------------------

describe("断言② 场景 e — git 块静态(仓库内容变化后仍不变)", () => {
  it("e-i 同一 provider 多轮 system deep-equal;仓库新增 commit 后 provider 返回不变", async () => {
    const { spawnSync } = await import("node:child_process");
    const gitOk =
      spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
    if (!gitOk) return; // git 不在 PATH 时跳过(与 B5 同退让)

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

    // 仓库内容变化:新 commit + 新文件 —— 闭包快照不重采。
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
// 矩阵收口:五场景一致性冒烟(非 deep-equal,只断言矩阵覆盖形态)
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
    assert.equal((tools as { name: string }[])[0]!.name, "zed");
    expect(tools).toBeDefined();
  });
});
