/**
 * tests/tui/deps-skill-mcp.test.ts
 *
 * #337 Phase B：TUI 装配 skill catalog + MCP manager 的单测覆盖。
 *
 * 与 tests/tui/deps-tools.test.ts 共享同一 #343 装配断言取向，但本文件
 * 隔离真实 ~/.iknow / cwd —— 用 mkdtemp 造 tmp fixture，userHome 注入
 * `<root>/home`，cwd 注入 `<root>`，plant 一个 SKILL.md 让 skill scanner
 * 发现。镜像 tests/harness/build-engine.test.ts:257-315（#337 T8 skill
 * 装配）与 :317-378（#337 T8 MCP 装配）的形态。
 *
 * 三个断言（与 task brief 一致）：
 *   1. buildTuiDeps 装配后 deps.registry.list() 含 skill + skill_search；
 *   2. onExtensions 回调收到 skillCatalog（available() 含 planted skill）
 *      + mcp.status() 返回数组（可调用）；
 *   3. mcp reload 不抛（tmp 无 mcp.json → servers 空 → reload 空集幂等）。
 *
 * #337 Phase B 实现契约：buildTuiDeps 现在 async；所有断言 await 装配。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTuiDeps,
  mcpServerOfToolName,
  type BuildTuiDepsOptions,
  type TuiExtensions,
} from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { createMcpManager } from "../../src/harness/mcp/manager.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";

// #378 根因 B: 捕获 createMcpManager 入参 —— 通过 buildTuiDeps 注入缝
// (opts.createMcpManager) 委托真实实现, 不影响既有断言(skill catalog /
// reload / listMcpTools 仍走真实 manager)。避免 mock.module 触发 bun 1.3.14
// require 死锁(见 deps.ts createMcpManager 缝注释)。
const capturedMcpManagerOpts: Array<Record<string, unknown>> = [];

/** 最小合法 RuntimeBundle — buildTuiDeps 只读 env 字段，其余 stub。 */
function makeBundle(): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-tui-skill-mcp",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // #378 根因 B: MCP 连接超时(默认 60_000)。
    mcp: { connectTimeoutMs: 60_000 },
    // #358 T2: subagent 配置臂 (build-engine 读取 taskTimeoutMs)。
    subagent: { taskTimeoutMs: undefined },
  };
  return { env } as unknown as RuntimeBundle;
}

/** 在 cwd 下铺一个 SKILL.md fixture（合法 frontmatter）。 */
async function plantSkill(
  cwd: string,
  skillName: string,
  description: string
): Promise<void> {
  const dir = join(cwd, ".iknow", "skills", skillName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\nbody`,
    "utf8"
  );
}

describe("buildTuiDeps — #337 Phase B skill + MCP 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  test("skill 工具静态装配（deps.registry.list() 含 skill + skill_search）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-skill-"));
    roots.push(root);
    await plantSkill(root, "echo", "echoes your message");

    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      // 隔离真实 ~/.iknow：userHome 注入空 home 子目录，cwd 注入 root。
      userHome: join(root, "home"),
      cwd: root,
    });

    const names = new Set(deps.registry.list().map((d) => d.name));
    expect(names.has("skill")).toBe(true);
    expect(names.has("skill_search")).toBe(true);
  });

  test("onExtensions 回调收到 skillCatalog（available() 含 planted skill）+ mcp.status() 可调用", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-ext-"));
    roots.push(root);
    await plantSkill(root, "echo", "echoes your message");

    let captured: TuiExtensions | undefined;
    const opts: BuildTuiDepsOptions = {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      onExtensions: (ext) => {
        captured = ext;
      },
    };
    await buildTuiDeps(makeBundle(), opts);

    expect(captured).toBeDefined();
    // skillCatalog：available() 含 planted "echo"（按 description 过滤、localesort）。
    const available = captured!.skillCatalog.available();
    expect(available.length).toBeGreaterThan(0);
    expect(available.find((e) => e.name === "echo")).toBeDefined();
    // mcp.status()：返回数组（即使 servers 空 → []）。
    const status = captured!.mcp.status();
    expect(Array.isArray(status)).toBe(true);
    // mcp.shutdown()：幂等调用不抛（manager 创建 + 空 config → 无 client 关闭）。
    await captured!.shutdown();
  });

  test("mcp reload 幂等（tmp 无 mcp.json → servers 空 → reload 空集）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-reload-"));
    roots.push(root);

    let captured: TuiExtensions | undefined;
    await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      onExtensions: (ext) => {
        captured = ext;
      },
    });

    expect(captured).toBeDefined();
    // reload 空集不抛（manager 内部 shutdown → rebuild([]) → bootstrapAll → 全部
    // disabled/空 → no-op）。配合 SC8 不阻塞装配：reload 返回前必须完成。
    await expect(captured!.mcp.reload()).resolves.toBeUndefined();
    // 二次 reload 仍幂等：保证可重复调用。
    await expect(captured!.mcp.reload()).resolves.toBeUndefined();
    // 收口：避免跨测试泄漏 manager 状态。
    await captured!.shutdown();
  });

  test("onExtensions 透出 listMcpTools（#361 Phase D）：可调用 + 无 mcp.json 时为空数组", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-mcptools-"));
    roots.push(root);

    let captured: TuiExtensions | undefined;
    await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      onExtensions: (ext) => {
        captured = ext;
      },
    });

    expect(captured).toBeDefined();
    expect(typeof captured!.listMcpTools).toBe("function");
    // 无 mcp.json → 无 mcp__* 工具 → 空数组（幂等，可重复调用）。
    const tools = captured!.listMcpTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toEqual([]);
    expect(captured!.listMcpTools()).toEqual([]);
    await captured!.shutdown();
  });
});

describe("buildTuiDeps — #378 根因 B timeoutMsOverride 透传", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
    capturedMcpManagerOpts.length = 0;
  });

  test("装配链把 env.mcp.connectTimeoutMs 透传为 createMcpManager.timeoutMsOverride", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-timeout-"));
    roots.push(root);

    const env = {
      ...makeBundle().env,
      mcp: { connectTimeoutMs: 90_000 },
    } as unknown as IknowEnv;
    await buildTuiDeps({ env } as unknown as RuntimeBundle, {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      createMcpManager: (opts) => {
        capturedMcpManagerOpts.push(opts as Record<string, unknown>);
        return createMcpManager(opts);
      },
    });

    const last = capturedMcpManagerOpts.at(-1);
    expect(last).toBeDefined();
    expect(last!.timeoutMsOverride).toBe(90_000);
  });

  test("默认 env.mcp.connectTimeoutMs=60_000 透传（未设 env 时 env.ts 已回退默认）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-timeout-default-"));
    roots.push(root);

    // makeBundle() 的 mcp 字段默认 60_000（与 loadIknowEnv 未设 env 时一致）。
    await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
      createMcpManager: (opts) => {
        capturedMcpManagerOpts.push(opts as Record<string, unknown>);
        return createMcpManager(opts);
      },
    });

    const last = capturedMcpManagerOpts.at(-1);
    expect(last).toBeDefined();
    expect(last!.timeoutMsOverride).toBe(60_000);
  });
});

describe("mcpServerOfToolName（#361 Phase D server 反解）", () => {
  test("标准形态：mcp__<server>__<tool> → server", () => {
    expect(mcpServerOfToolName("mcp__fileserver__read")).toBe("fileserver");
    expect(mcpServerOfToolName("mcp__codebase-memory__search")).toBe(
      "codebase-memory"
    );
  });

  test("server / tool 段含下划线：只取首段（server 名带 _ 保留）", () => {
    expect(mcpServerOfToolName("mcp__my_server__do_thing")).toBe("my_server");
  });

  test("非 mcp__ 前缀 → 原名", () => {
    expect(mcpServerOfToolName("read")).toBe("read");
  });

  test("仅 mcp__server 无工具段（畸形）→ 返回原名（不会匹配任何 status，安全降级）", () => {
    expect(mcpServerOfToolName("mcp__solo")).toBe("mcp__solo");
  });
});
