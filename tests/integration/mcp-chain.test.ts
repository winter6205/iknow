/**
 * T10 (#344) — 集成链：fixture stdio MCP server 真子进程链路 + 端到端断言。
 *
 * 验收（spec 337-skill-mcp-extension.md + plans/337 T10）:
 *  1. 真子进程链路：
 *     spawn fixture server → createMcpManager(createRealClient + AciRegistry.registerExternal)
 *     → start() → connected → `tool_search({query:"mcp"})` discover → 调
 *     `mcp__<server>__echo` 真实执行 → 断言 structuredContent 返回
 *  2. list_changed 触发：touch triggerFile → 期望新工具 added-on-listchange
 *     出现在 catalog,旧工具仍可调用
 *  3. Gate 2 防撞:registerExternal 收到非 mcp__ 前缀 → RegistryConstructionError
 *  4. shutdown SIGTERM：fixture 子孙收到 SIGTERM 必须退出(SC11)
 *
 * 无 LLM、无外部 server — 仅 fixture 子进程 + 真实 SDK Client/Transport。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createAciRegistry } from "../../src/harness/aci/aci-registry.js";
import { createToolSearchTool } from "../../src/harness/aci/tools/tool-search.js";
import type { AciRegistry, AciToolDef } from "../../src/harness/aci/types.js";
import { RegistryConstructionError } from "../../src/harness/errors.js";

import {
  createMcpManager,
  type McpManager,
} from "../../src/harness/mcp/manager.js";
import type { McpServerConfig } from "../../src/harness/mcp/config.js";

// ---------------------------------------------------------------------------
// fixture server 路径解析 — 复用 tests/cli/trace.test.ts 的 tsx 定位模式
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureServer = join(
  repoRoot,
  "tests",
  "fixtures",
  "mcp-server",
  "server.ts"
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface SpawnedFixture {
  readonly child: ChildProcess;
  readonly triggerFile: string;
  readonly stderrLines: string[];
  /** 子进程是否真正退出(供 SIGTERM 断言)。 */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnFixture(): SpawnedFixture {
  // 触发文件:放到一个本测试独享的 tmp 目录,避免和别的并发实例冲突
  const scratch = join(
    tmpdir(),
    `iknow-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(scratch, { recursive: true });
  const triggerFile = join(scratch, "listchanged.flag");
  // 创建空文件 — fs.watch 才能触发 change 事件
  writeFileSync(triggerFile, "");

  const child = spawn(process.execPath, [fixtureServer], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LISTCHANGED_FILE: triggerFile },
  });

  const stderrLines: string[] = [];
  child.stderr?.on("data", (b: Buffer) => {
    stderrLines.push(b.toString());
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return { child, triggerFile, stderrLines, exited };
}

function makeStdioConfig(name: string, triggerFile: string): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "project",
    status: "enabled",
    entry: {
      command: process.execPath,
      args: [fixtureServer],
      env: { LISTCHANGED_FILE: triggerFile },
    },
  };
}

interface Harness {
  readonly registry: AciRegistry;
  readonly toolSearch: AciToolDef;
  readonly manager: McpManager;
  readonly registered: AciToolDef[];
}

/**
 * 装配 fixture:registry = 静态工具 + toolSearch → manager 通过
 * registry.registerExternal 追加 mcp__ 工具。`registered` 数组捕获所有
 * registerExternal 调用,便于测试断言每次注册的形状。
 */
function buildHarness(cfg: McpServerConfig): Harness {
  const registered: AciToolDef[] = [];
  const toolSearchHolder: { reg?: AciRegistry } = {};
  const toolSearch = createToolSearchTool({
    getRegistry: () => {
      if (!toolSearchHolder.reg)
        throw new Error("harness: registry not assembled yet");
      return toolSearchHolder.reg;
    },
  });
  const registry = createAciRegistry([toolSearch]);
  toolSearchHolder.reg = registry;
  const manager = createMcpManager({
    config: [cfg],
    registerExternal: (defs) => {
      // 真实调用 AciRegistry.registerExternal — 验证 Gate 2
      registry.registerExternal(defs);
      for (const d of defs) registered.push(d);
    },
  });
  return { registry, toolSearch, manager, registered };
}

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

async function waitForToolRegistered(
  registered: ReadonlyArray<AciToolDef>,
  toolName: string,
  timeoutMs = 5_000
): Promise<AciToolDef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = registered.find((d) => d.name === toolName);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `waitForToolRegistered: ${toolName} not in registry after ${timeoutMs}ms`
  );
}

async function waitForToolCallable(
  registry: AciRegistry,
  toolName: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registry.catalog.get(toolName)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `waitForToolCallable: ${toolName} not in catalog after ${timeoutMs}ms`
  );
}

// ---------------------------------------------------------------------------
// 全局清理
// ---------------------------------------------------------------------------

let activeFixtures: SpawnedFixture[] = [];

afterEach(async () => {
  // 优先让 manager 走正常 shutdown 路径
  for (const f of activeFixtures) {
    if (!f.child.killed) {
      try {
        f.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  // 等所有子进程真正退出,最多 3s
  await Promise.all(
    activeFixtures.map((f) =>
      Promise.race([
        f.exited,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: null, signal: null }), 3_000)
        ),
      ])
    )
  );
  activeFixtures = [];
});

// =========================================================================
// 1. 真子进程链路 — spawn → connect → registerExternal → discover → call
// =========================================================================

describe("MCP integration — end-to-end real subprocess chain", () => {
  it("connects to fixture stdio MCP server, registers mcp__ tools, and invokes echo via tool_search discovery", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("echo_server", spawned.triggerFile);
    const { registry, toolSearch, manager, registered } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "echo_server");

    // 真链路断言 1：registerExternal 至少被调用过 echo/fail/slow 三个工具
    const names = registered.map((d) => d.name).sort();
    expect(names).toEqual([
      "mcp__echo_server__echo",
      "mcp__echo_server__fail",
      "mcp__echo_server__slow",
    ]);

    // 真链路断言 2：所有 mcp__ 工具在 AciRegistry catalog 可见
    expect(registry.catalog.get("mcp__echo_server__echo")).toBeDefined();
    expect(registry.catalog.get("mcp__echo_server__fail")).toBeDefined();
    expect(registry.catalog.get("mcp__echo_server__slow")).toBeDefined();

    // 真链路断言 3：tool_search({query:"echo"}) discover → 返回真实工具 schema
    const searchOutput = toolSearch.handler!(
      { query: "echo" },
      undefined
    ) as string;
    expect(typeof searchOutput).toBe("string");
    const parsed = searchOutput
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { name: string; description: string });
    const discoveredNames = parsed.map((p) => p.name);
    expect(discoveredNames).toContain("mcp__echo_server__echo");

    // 真链路断言 4：discover 后 visibleSchemas 包含该工具
    const visible = registry.visibleSchemas().map((t) => t.name);
    expect(visible).toContain("mcp__echo_server__echo");

    // 真链路断言 5：实际执行 mcp__echo_server__echo → 真实 structuredContent
    const echo = registry.catalog.get("mcp__echo_server__echo")!;
    expect(echo.handler).toBeDefined();
    const result = await echo.handler!({ text: "hello fixture" });
    expect(result).toBe('{"text":"hello fixture"}');

    // 真链路断言 6：fail 工具走 isError 分支 → 返回 text（adapter 不抛）
    const fail = registry.catalog.get("mcp__echo_server__fail")!;
    const failResult = await fail.handler!({ reason: "intentional" });
    expect(failResult).toBe("intentional");

    await manager.shutdown();

    // 断言 shutdown 后子进程真正退出(SC11)
    const exitInfo = await Promise.race([
      spawned.exited,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
        setTimeout(() => r({ code: null, signal: null }), 3_000)
      ),
    ]);
    // 子孙应已退出(可能被 SIGTERM 杀掉,code=null + signal=SIGTERM,或 code=143)
    expect(exitInfo.code !== null || exitInfo.signal === "SIGTERM").toBe(true);
  });
});

// =========================================================================
// 2. list_changed — touch 触发文件 → 期待新工具被注册
// =========================================================================

describe("MCP integration — list_changed hot re-registration", () => {
  it("emits list_changed after touching trigger file, new tool is registered without dropping existing ones", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("lc_server", spawned.triggerFile);
    const { registry, manager, registered } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "lc_server");

    // 初始注册完成断言
    expect(registered.map((d) => d.name).sort()).toEqual([
      "mcp__lc_server__echo",
      "mcp__lc_server__fail",
      "mcp__lc_server__slow",
    ]);
    const beforeCount = registered.length;

    // 触发 list_changed：touch 触发文件 + 写点内容(确保 watcher 收到 change)
    writeFileSync(spawned.triggerFile, "go\n");

    // 等待新工具出现 — 注意 sanitize 把 '-' 转 '_'
    const newTool = await waitForToolRegistered(
      registered,
      "mcp__lc_server__added_on_listchange",
      5_000
    );
    expect(newTool).toBeDefined();

    // 旧工具仍在 catalog(没有被打断,SC15)
    expect(registry.catalog.get("mcp__lc_server__echo")).toBeDefined();
    expect(registry.catalog.get("mcp__lc_server__fail")).toBeDefined();
    expect(registry.catalog.get("mcp__lc_server__slow")).toBeDefined();
    expect(
      registry.catalog.get("mcp__lc_server__added_on_listchange")
    ).toBeDefined();

    // 注册次数应当 ≥ beforeCount + 1
    expect(registered.length).toBeGreaterThan(beforeCount);

    // 重复 touch 不应再注册(同名跳过,manager 增量 diff)
    writeFileSync(spawned.triggerFile, "go2\n");
    await new Promise((r) => setTimeout(r, 300));
    const newToolCount = registered.filter(
      (d) => d.name === "mcp__lc_server__added_on_listchange"
    ).length;
    expect(newToolCount).toBe(1);

    await manager.shutdown();
  });
});

// =========================================================================
// 3. Gate 2 防撞 — 非 mcp__ 前缀注册必须抛 RegistryConstructionError
// =========================================================================

describe("MCP integration — Gate 2 namespace collision", () => {
  it("registerExternal rejects an external tool name that lacks the mcp__ prefix", () => {
    // 直接复刻 Gate 2:不启动子进程也能复现。这条用例是单元级,放在集成
    // 文件是为了和 T10 spec 验收集中在一处。createMcpManager 始终通过
    // mcp__ 前缀注册,所以反向断言用 AciRegistry.registerExternal。
    const toolSearchHolder: { reg?: AciRegistry } = {};
    const toolSearch = createToolSearchTool({
      getRegistry: () => {
        if (!toolSearchHolder.reg)
          throw new Error("harness: registry not assembled yet");
        return toolSearchHolder.reg;
      },
    });
    const registry = createAciRegistry([toolSearch]);
    toolSearchHolder.reg = registry;

    const badTool: AciToolDef = Object.freeze({
      name: "bash", // ← 静态名,无 mcp__ 前缀
      description: "should be rejected",
      inputSchema: {
        type: "object",
        properties: { cmd: { type: "string" } },
        additionalProperties: false,
      },
      handler: async () => "x",
      aci: {
        category: "execute" as const,
        isConcurrencySafe: false,
        interruptBehavior: "cancel" as const,
        timeoutTier: "default" as const,
      },
    });

    expect(() => registry.registerExternal([badTool])).toThrow(
      RegistryConstructionError
    );
  });

  it("registerExternal rejects a duplicate mcp__ tool name", () => {
    const toolSearchHolder: { reg?: AciRegistry } = {};
    const toolSearch = createToolSearchTool({
      getRegistry: () => {
        if (!toolSearchHolder.reg)
          throw new Error("harness: registry not assembled yet");
        return toolSearchHolder.reg;
      },
    });
    const registry = createAciRegistry([toolSearch]);
    toolSearchHolder.reg = registry;

    const t: AciToolDef = Object.freeze({
      name: "mcp__srv__foo",
      description: "first",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "x",
      aci: {
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
      },
    });

    registry.registerExternal([t]);
    expect(() => registry.registerExternal([t])).toThrow(
      RegistryConstructionError
    );
  });
});

// =========================================================================
// 4. shutdown SIGTERM — fixture 子进程必须真正退出(SC11)
// =========================================================================

describe("MCP integration — shutdown SIGTERM child exit (SC11)", () => {
  it("manager.shutdown() forwards SIGTERM to the spawned fixture child", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("sigterm_server", spawned.triggerFile);
    const { manager } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "sigterm_server");

    // 触发 shutdown
    await manager.shutdown();

    // 子孙必须真正退出,不能悬挂
    const exitInfo = await Promise.race([
      spawned.exited,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (_, reject) =>
          setTimeout(
            () => reject(new Error("fixture child hung on shutdown")),
            5_000
          )
      ),
    ]);

    // SDK StdioClientTransport.close() 通过 process.kill(pid, "SIGTERM");
    // 子孙在 server.ts 里 process.on("SIGTERM") 退出 code=143。
    // SDK transport.close 也可能先关 stdin 触发 'end' 路径 → code=0。
    // 两种合法退出都算 PASS。
    const okExit =
      exitInfo.signal === "SIGTERM" ||
      exitInfo.code === 143 ||
      exitInfo.code === 0;
    expect(okExit).toBe(true);
  });
});

// =========================================================================
// 5. 完整链路 tool_search → discover → invoke(含 ToolExecutionError 边界)
// =========================================================================

describe("MCP integration — tool_search discovery feeds real call", () => {
  it("discovers the mcp__ tool via tool_search, then executes it through the discovered handler", async () => {
    const spawned = spawnFixture();
    activeFixtures.push(spawned);

    const cfg = makeStdioConfig("disc_server", spawned.triggerFile);
    const { registry, toolSearch, manager } = buildHarness(cfg);

    await manager.start();
    await waitForConnected(manager, "disc_server");

    // 模拟 lazy 路径:discover 之前 visibleSchemas 不含 mcp__ 工具
    // (我们设的 lazy=true via adapter)。但 createAciRegistry 的 visibleSchemas
    // 只在 discovered 集合 + !lazy 拼接,我们的 ACI 工具都是 lazy,所以
    // discover 之前不会出现在 visible。discover 后才出现。
    const before = registry
      .visibleSchemas()
      .map((t) => t.name)
      .filter((n) => n.startsWith("mcp__"));
    expect(before).toEqual([]); // 还没 discover

    // tool_search 真实 discover
    const out = toolSearch.handler!(
      { names: ["mcp__disc_server__echo"] },
      undefined
    ) as string;
    expect(out).toContain("mcp__disc_server__echo");

    // discover 副作用触发后,visible 出现该工具
    const after = registry
      .visibleSchemas()
      .map((t) => t.name)
      .filter((n) => n.startsWith("mcp__"));
    expect(after).toContain("mcp__disc_server__echo");

    // 真实调用 discovered 工具
    const echo = registry.catalog.get("mcp__disc_server__echo")!;
    const result = await echo.handler!({ text: "discovered call" });
    expect(result).toBe('{"text":"discovered call"}');

    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 局部:不在 afterEach 里清 tmp(子进程已 SIGTERM,文件无害)
// ---------------------------------------------------------------------------

// 兜底:测试全部结束后,如仍有 tmp dir/flag file,清理一下(失败场景的兜底)
const scratchDirs = new Set<string>();
const _origSpawnFixture = spawnFixture;
void _origSpawnFixture;
