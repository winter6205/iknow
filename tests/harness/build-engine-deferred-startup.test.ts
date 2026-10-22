/**
 * Plan T2 (remote-sync-plan1) — build-engine side of the TUI readiness seam.
 *
 * `deferFirstTurnOptionalWork: true` moves the two optional first-turn
 * integrations (the ADR-0043 first-turn-ready window and the ADR-0043/0046
 * countTokens judgments) off the assembly path into one background task. This
 * file pins the other half of that contract: a task that HAS settled before
 * the first turn is applied exactly once, at the first `deps.system()`
 * resolution, with the same observable surface the eager assembly produces
 * (name directory, retired-builtin index, hidden schemas) and no drift across
 * later rounds.
 *
 * The unresolved / late / post-shutdown half lives at the TUI seam
 * (`tests/tui/deps-startup-readiness.test.ts`), where the assembly is the one
 * the TUI actually builds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { McpClientHandle } from "../../src/harness/mcp/manager.js";
import type { Tool as McpTool } from "@modelcontextprotocol/client";

function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    // contextWindow = 20_000 → threshold = 2_000 (10%).
    compress: { contextWindow: 20_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

function makeInstantClient(tools: readonly McpTool[]): McpClientHandle {
  return {
    connect: async () => {},
    listTools: async () => tools,
    callTool: async () => ({ result: { content: [] } }),
    close: async () => {},
    onListChanged: () => {},
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
}

async function plantMcpConfig(cwd: string, servers: string[]): Promise<void> {
  const entries = servers
    .map((name) => `"${name}": { "type": "stdio", "command": "node" }`)
    .join(", ");
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  await writeFile(
    join(cwd, ".iknow", "mcp.json"),
    `{ "mcpServers": { ${entries} } }`,
    "utf8"
  );
}

/** Poll until `pred` holds (the background task's progress is the ordering). */
async function waitFor(
  pred: () => boolean,
  label: string,
  ms = 10_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

/** Test-controlled latch (deterministic ordering, no sleep-as-sync). */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const roots: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
const warnings: string[] = [];
const originalWarn = console.warn;

beforeEach(() => {
  warnings.length = 0;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(async () => {
  console.warn = originalWarn;
  await Promise.all(shutdowns.splice(0).map((f) => f()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

describe("buildHarnessEngine — T2 延迟首轮工作（已就绪路径）", () => {
  it("任务在首轮前就绪 → 首次 system() 应用目录 + 退役清单，且之后逐字节恒定", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-deferred-settled-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    // 8_000 → retire one per re-measure; the 7th call is the index gate and
    // stays below the threshold (only the ladder is under test here).
    const measurements = [8_000, 6_500, 5_000, 3_500, 2_500, 500, 500];
    let callIdx = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-deferred-settled"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      deferFirstTurnOptionalWork: true,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      countTokens: async () => {
        const v = measurements[callIdx];
        callIdx += 1;
        if (v === undefined) throw new Error("countTokens: out of fixtures");
        return { inputTokens: v };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // The background task settles independently of assembly: wait for the
    // ladder (6 calls) + the index gate (1 call) to finish.
    await waitFor(() => callIdx >= 7, "background first-turn judgment settled");

    const first = await built.deps.system?.();
    expect(first).toBeDefined();
    // Applied at the first turn: directory + retirement index both present.
    expect(first).toContain("<mcp_name_directory>");
    expect(first).toContain("stubsvc");
    expect(first).toContain("<deferred_internal_tools>");
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    for (const retired of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      expect(visibleNames).not.toContain(retired);
    }
    expect(visibleNames).toContain("bash");

    // Frozen: a second round reads the exact same bytes.
    const second = await built.deps.system?.();
    expect(second).toBe(first);
    // The judgment ran once — no mid-session recompute.
    expect(callIdx).toBe(7);
    expect(warnings).toEqual([]);
  });

  it("eager 装配（未开 seam）仍 await 完工 → 同一首轮表面（chat/serve 不变）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-eager-same-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-eager-same"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      countTokens: async () => ({ inputTokens: 500 }),
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    const systemText = await built.deps.system?.();
    expect(systemText).toContain("<mcp_name_directory>");
    expect(systemText).toContain("stubsvc");
    expect(systemText).not.toContain("<deferred_internal_tools>");
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    // Under the threshold nothing retires — the apply wrote the (empty)
    // verdict and every deferrable built-in stays visible.
    for (const resident of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      expect(visibleNames).toContain(resident);
    }
    // The surface is applied exactly once at assembly: later rounds are
    // byte-identical and no second judgment runs.
    expect(await built.deps.system?.()).toBe(systemText);
  });

  it("deferred + 无 MCP 管理器（ask）→ 两个测量仍运行并在首轮冻结退役清单", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-deferred-no-mcp-"));
    roots.push(root);

    // Ladder fixture: 6 calls (initial + one re-measure per retirement). With
    // no MCP directory and no skills there are no index candidates, so the
    // index gate stays inert (no 7th call).
    const measurements = [8_000, 6_500, 5_000, 3_500, 2_500, 500];
    let callIdx = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-deferred-no-mcp"),
      askUser: createNoAskUser(),
      // ask = the no-manager path: only the MCP window is manager-gated, the
      // measurements do not depend on MCP.
      surface: "ask",
      userHome: join(root, "home"),
      cwd: root,
      deferFirstTurnOptionalWork: true,
      countTokens: async () => {
        const v = measurements[callIdx];
        callIdx += 1;
        if (v === undefined) throw new Error("countTokens: out of fixtures");
        return { inputTokens: v };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    await waitFor(
      () => callIdx >= 6,
      "no-manager background first-turn judgment settled"
    );

    const first = await built.deps.system?.();
    expect(first).toBeDefined();
    // No manager → no MCP section, but the measurement verdict still lands.
    expect(first).not.toContain("<mcp_name_directory>");
    expect(first).toContain("<deferred_internal_tools>");
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    for (const retired of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      expect(visibleNames).not.toContain(retired);
    }
    expect(visibleNames).toContain("bash");

    expect(await built.deps.system?.()).toBe(first);
    expect(callIdx).toBe(6);
    expect(warnings).toEqual([]);
  });

  it("deferred 冻结前只持有文档 fallback（close 后 system 不应用任何晚到结果）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-deferred-fallback-"));
    roots.push(root);

    const gate = deferred<{ inputTokens: number }>();
    let firstCall = false;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-deferred-fallback"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      deferFirstTurnOptionalWork: true,
      countTokens: () => {
        firstCall = true;
        return gate.promise;
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // The background judgment is parked on the gateway call when the barrier
    // closes, so the freeze point can never apply a settled surface.
    await waitFor(() => firstCall, "background judgment started");
    await built.shutdown!();

    // deps.system() runs freeze (a no-op after close) and reads the holders:
    // exactly the declared skip-path fallback, never a half-applied surface.
    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).not.toContain("<mcp_name_directory>");
    expect(systemText).not.toContain("<deferred_internal_tools>");
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    expect(visibleNames).toContain("query_trace");
    expect(visibleNames).toContain("web_fetch");
    expect(warnings).toEqual([]);

    gate.resolve({ inputTokens: 1_000_000 });
  });

  it("网关拒绝鉴权（countTokens reject）→ 跳过判断 + 各一次 warn；模型路由不变", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-gateway-refuse-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-gateway-refuse"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      deferFirstTurnOptionalWork: true,
      createMcpClient: () =>
        makeInstantClient([
          {
            name: "alpha",
            description: "alpha tool",
            inputSchema: { type: "object", properties: {} },
          },
        ]),
      // An auth-refusing gateway: the optional measurements fail, the local
      // assembly does not.
      countTokens: async () => {
        throw new Error("401 unauthorized: no active credentials");
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    await waitFor(
      () =>
        warnings.some((w) => w.includes("overflow judge skipped")) &&
        warnings.some((w) => w.includes("index demotion skipped")),
      "both optional gates skipped"
    );

    const systemText = await built.deps.system?.();
    // Degrades to the documented skip path: directory still applies (the MCP
    // window settled), nothing retired, no demotion.
    expect(systemText).toContain("<mcp_name_directory>");
    expect(systemText).not.toContain("<deferred_internal_tools>");
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    expect(promptTools().map((t) => t.name)).toContain("query_trace");
    // The failure never switches the model route (no silent re-route).
    expect(built.deps.parentModelRoute).toBe("test-model");
    expect(
      warnings.filter((w) => w.includes("overflow judge skipped"))
    ).toHaveLength(1);
    expect(
      warnings.filter((w) => w.includes("index demotion skipped"))
    ).toHaveLength(1);
  });
});
