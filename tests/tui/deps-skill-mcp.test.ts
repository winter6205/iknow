/**
 * tests/tui/deps-skill-mcp.test.ts
 *
 * Unit coverage for the TUI assembling the skill catalog + MCP manager.
 *
 * Shares the assembly-assertion style with tests/tui/deps-tools.test.ts, but
 * isolates the real ~/.iknow / cwd — mkdtemp builds a tmp fixture, userHome
 * injects `<root>/home`, cwd injects `<root>`, and a planted SKILL.md lets the
 * skill scanner find it. Mirrors the shape of
 * tests/harness/build-engine.test.ts:257-315 (skill assembly) and :317-378
 * (MCP assembly).
 *
 * Three assertions:
 *   1. after buildTuiDeps, deps.registry.list() includes skill but not
 *      skill_search (skill_search was removed, only 1 tool left);
 *   2. the onExtensions callback receives skillCatalog (available() contains
 *      the planted skill) + mcp.status() returns a callable array;
 *   3. mcp reload does not throw (no mcp.json in tmp → servers empty → reload
 *      is an idempotent empty set).
 *
 * Implementation contract: buildTuiDeps is now async; every assertion awaits the assembly.
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

// Capture createMcpManager's args via the buildTuiDeps injection seam
// (opts.createMcpManager) delegating to the real implementation, without
// affecting existing assertions (skill catalog / reload / listMcpTools still
// go through the real manager). This avoids mock.module triggering the bun
// 1.3.14 require deadlock (see the createMcpManager seam comment in deps.ts).
const capturedMcpManagerOpts: Array<Record<string, unknown>> = [];

/** Minimal valid RuntimeBundle — buildTuiDeps reads only the env field; the rest are stubs. */
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
    // MCP connect timeout (default 60_000).
    mcp: { connectTimeoutMs: 60_000 },
    // subagent config arm (build-engine reads taskTimeoutMs).
    subagent: { taskTimeoutMs: undefined },
  };
  return { env } as unknown as RuntimeBundle;
}

/** Lay down a SKILL.md fixture under cwd (valid frontmatter). */
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

  test("skill 工具静态装配（deps.registry.list() 含 skill,不含 skill_search）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-skill-"));
    roots.push(root);
    await plantSkill(root, "echo", "echoes your message");

    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      // Isolate the real ~/.iknow: userHome points at an empty home subdir, cwd at root.
      userHome: join(root, "home"),
      cwd: root,
    });

    const names = new Set(deps.registry.list().map((d) => d.name));
    expect(names.has("skill")).toBe(true);
    // skill_search was deleted; not in the registry.
    expect(names.has("skill_search")).toBe(false);
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
    // skillCatalog: available() contains the planted "echo" (filtered by description, locale-sorted).
    const available = captured!.skillCatalog.available();
    expect(available.length).toBeGreaterThan(0);
    expect(available.find((e) => e.name === "echo")).toBeDefined();
    // The rescan seam must be exposed — TuiApp's slash-candidate surface relies on it being hot in-place.
    // This is a production-wiring assertion (the seam is built inside build-engine; if deps doesn't pass
    // it through, the TUI never gets a refresh path — the same defect shape as before this slice).
    expect(captured!.skillRescanner).toBeDefined();
    // The seam is live: rescan() yields a loadable surface (containing the planted echo).
    const rescanned = await captured!.skillRescanner!.rescan();
    expect(rescanned.loadable().find((e) => e.name === "echo")).toBeDefined();
    // mcp.status(): returns an array (even when servers are empty → []).
    const status = captured!.mcp.status();
    expect(Array.isArray(status)).toBe(true);
    // mcp.shutdown(): idempotent call does not throw (manager created + empty config → no client to close).
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
    // Reloading an empty set does not throw (manager internally: shutdown → rebuild([]) → bootstrapAll → all disabled/empty → no-op). Must complete before reload returns so it never blocks assembly.
    await expect(captured!.mcp.reload()).resolves.toBeUndefined();
    // A second reload is still idempotent: guarantees repeatable calls.
    await expect(captured!.mcp.reload()).resolves.toBeUndefined();
    // Tear down: avoid leaking manager state across tests.
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
    // no mcp.json → no mcp__* tools → empty array (idempotent, callable repeatedly).
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

    // makeBundle()'s mcp field defaults to 60_000 (matching loadIknowEnv when the env var is unset).
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

describe("T6 — buildTuiDeps stable productRoot threading", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  test("productRoot ≠ workspaceRoot：config 读 product，manager cwd 跟 task workspace", async () => {
    const productRoot = await mkdtemp(join(tmpdir(), "iknow-tui-t6-prod-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-tui-t6-task-"));
    roots.push(productRoot, workspaceRoot);

    await mkdir(join(productRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(productRoot, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "from-product": { type: "stdio", command: "node" },
        },
      }),
      "utf8"
    );
    await mkdir(join(workspaceRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "from-task": { type: "stdio", command: "node" },
        },
      }),
      "utf8"
    );

    const captured: Array<Record<string, unknown>> = [];
    let capturedExt: TuiExtensions | undefined;
    const built = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(productRoot, "home"),
      cwd: workspaceRoot,
      workspaceRoot,
      productRoot,
      createMcpManager: (opts) => {
        captured.push(opts as Record<string, unknown>);
        return createMcpManager(opts);
      },
      createMcpClient: () => ({
        connect: async () => {},
        listTools: async () => [],
        callTool: async () => ({ result: { content: [] } }),
        close: async () => {},
        onListChanged: () => {},
        onClose: () => {},
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
      }),
      onExtensions: (ext) => {
        capturedExt = ext;
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.workspaceRoot).toBe(workspaceRoot);
    const cfg = captured[0]!.config as Array<{ name: string }>;
    expect(cfg.map((s) => s.name)).toContain("from-product");
    expect(cfg.map((s) => s.name)).not.toContain("from-task");

    // reload still reads config from productRoot, never drifting to the task cwd
    await mkdir(join(productRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(productRoot, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "from-product": { type: "stdio", command: "node" },
          "after-reload": { type: "stdio", command: "node" },
        },
      }),
      "utf8"
    );
    await expect(capturedExt!.mcp.reload()).resolves.toBeUndefined();
    const statusNames = capturedExt!.mcp.status().map((s) => s.name);
    expect(statusNames).toContain("after-reload");
    expect(statusNames).not.toContain("from-task");

    if (built.shutdown) await built.shutdown();
  });

  test("run.tsx / hub-bridge：productRoot 透传；rebuild 只换 workspaceRoot", async () => {
    const { readFileSync } = await import("node:fs");
    const runSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "tui", "run.tsx"),
      "utf8"
    );
    const bridgeSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "tui", "hub-bridge.ts"),
      "utf8"
    );
    const depsSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "tui", "deps.ts"),
      "utf8"
    );
    expect(depsSrc).toMatch(/readonly productRoot\?/);
    expect(runSrc).toMatch(/productRoot/);
    expect(bridgeSrc).toMatch(/productRoot/);
    const buildEngineIdx = runSrc.indexOf("buildEngine:");
    expect(buildEngineIdx).toBeGreaterThanOrEqual(0);
    const block = runSrc.slice(buildEngineIdx, buildEngineIdx + 700);
    expect(block).toMatch(/workspaceRoot:\s*root/);
    expect(block).not.toMatch(/productRoot:\s*root\b/);
  });
});
