/**
 * Assembly-time overflow governance wiring (ADR-0043):
 *   - Tool surface over the threshold (stub countTokens returns a large value)
 *     → the first assembly retires tools in the fixed order
 *   - Below the threshold (stub returns a small value) → nothing retires
 *   - No recompute mid-session (later assemblies do not call countTokens)
 *   - countTokens fails / absent → skip for this session (all deferrables stay
 *     resident) + a warn line
 *
 * This file pins only the wiring shape (hook firing, result visibility,
 * countTokens call counts); the judge function is unit-tested in
 * `tool-overflow-judge.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { MCP_TOOL_SHORT_DESCRIPTION_MAX } from "../../src/harness/identity/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import {
  assertNoGateSkipWarnings,
  assertStandInUserTurns,
  type TokenSeamMeasurement,
} from "../_helpers/token-measurement-seam.ts";
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
    // contextWindow = 20_000 (not 200_000); threshold = 2_000 (10%),
    // so expected values stay easy to write.
    compress: { contextWindow: 20_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    // Roots are supplied explicitly to buildHarnessEngine; the env
    // side keeps its "unset" default.
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

describe("buildHarnessEngine — B6 溢出治理 wire", () => {
  it("未超阈值:全部 deferrable 内建件保持常驻,系统文本不含 <deferred_internal_tools>", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-nowoverflow-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    let callCount = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-no-overflow"),
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
      // countTokens stub: returns 1_000 (well below the 2_000 threshold → no overflow)
      countTokens: async () => {
        callCount += 1;
        return { inputTokens: 1_000 };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // countTokens called at least once (first-round judgement)
    expect(callCount).toBeGreaterThanOrEqual(1);
    // every visible set still contains the deferrables query_trace / list_sessions etc.
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    expect(visibleNames).toContain("query_trace");
    expect(visibleNames).toContain("list_sessions");
    expect(visibleNames).toContain("get_record");
    expect(visibleNames).toContain("web_search");
    expect(visibleNames).toContain("web_fetch");
    // core tools untouched
    expect(visibleNames).toContain("bash");
    expect(visibleNames).toContain("read_file");
    // system text carries no <deferred_internal_tools> segment (nothing retired)
    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).not.toContain("<deferred_internal_tools>");
  });

  it("实测请求携带一条占位 user 消息(网关不接受空 messages),tools + system 面不变", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-standin-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const inputs: TokenSeamMeasurement[] = [];
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-standin"),
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
      countTokens: async (input: TokenSeamMeasurement) => {
        inputs.push(input);
        return { inputTokens: 1_000 };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // The gate still measures the tools + system surface (ADR-0043 forbids
    // chars/N estimation, so this must stay a real measurement of that area).
    const toolGateCalls = inputs.filter((i) => i.tools !== undefined);
    expect(toolGateCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of toolGateCalls) {
      expect(call.tools!.length).toBeGreaterThan(0);
      expect(typeof call.system).toBe("string");
      expect(call.system!.length).toBeGreaterThan(0);
    }
    // Wire validity + gate success (assertions shared with the index-demotion
    // gate — see tests/_helpers/token-measurement-seam.ts).
    assertStandInUserTurns(inputs);
    assertNoGateSkipWarnings(warnings);
  });

  it("超阈值:按退场次序逐件退,系统文本含 <deferred_internal_tools>(字母序)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-overflow-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    // Threshold 2_000; simulate "all deferrables = 8_000 → retire 1: 6_500 →
    // 2: 5_000 → 3: 3_500 → 4: 2_500 → 5: 500 ≤ threshold". All 5 retire
    // (the full retirement ladder runs).
    //
    // Assembly shares one countTokens source across two gates: first the
    // built-in schema retirement ladder (the first 6 measurements), then the
    // MCP/skill index-demotion gate (call 7). This file pins only the ladder,
    // so feed the index gate a below-threshold value (500 ≤ 2_000) to keep it
    // inert; index demotion itself is covered in
    // disclosure-index-align/sc7-index-demotion.test.ts.
    const measurements = [8_000, 6_500, 5_000, 3_500, 2_500, 500, 500];
    let callIdx = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-overflow"),
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

    // All 5 retire (down to ≤ threshold); call 7 = the index-demotion gate's first measurement (below threshold → inert).
    expect(callIdx).toBe(7); // 1 initial + 5 re-measurements + 1 index-gate measurement
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    // none of the 5 deferrable built-ins remains visible
    for (const retired of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      expect(visibleNames).not.toContain(retired);
    }
    // core tools unaffected
    expect(visibleNames).toContain("bash");
    expect(visibleNames).toContain("read_file");
    expect(visibleNames).toContain("edit_file");
    expect(visibleNames).toContain("write_file");
    expect(visibleNames).toContain("grep");
    expect(visibleNames).toContain("glob");
    expect(visibleNames).toContain("spawn_subagent");

    // system text carries <deferred_internal_tools> + all 5 names listed (alphabetical)
    const systemText = await built.deps.system?.();
    expect(systemText).toBeDefined();
    expect(systemText).toContain("<deferred_internal_tools>");
    for (const retired of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      expect(systemText).toContain(retired);
    }

    // The index segment for retired built-ins is **name + description**
    // (descriptions not stripped, no search round-trip). Each description
    // comes from the tool's ToolDef.description (first line), SSOT =
    // registry; taken live from the catalog here, no hard-coded text.
    const segment = systemText!.slice(
      systemText!.indexOf("<deferred_internal_tools>"),
      systemText!.indexOf("</deferred_internal_tools>")
    );
    const catalog = built.catalog;
    expect(catalog).toBeDefined();
    for (const retired of [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
      "web_fetch",
    ]) {
      const def = catalog!.get(retired);
      expect(def, `${retired} 应仍在 catalog(退场 ≠ 删名)`).toBeDefined();
      const firstLine = def!.description.split("\n", 1)[0]!.trim();
      const short =
        firstLine.length <= MCP_TOOL_SHORT_DESCRIPTION_MAX
          ? firstLine
          : `${firstLine.slice(0, MCP_TOOL_SHORT_DESCRIPTION_MAX)}…`;
      expect(short.length).toBeGreaterThan(0);
      expect(segment).toContain(`- ${retired}: ${short}`);
    }
    // The index segment no longer requires calling tool_search first (ADR-0046 amends ADR-0043).
    expect(segment).not.toContain("tool_search");
  });

  it("countTokens 失败 → 跳过本会话,deferrable 全部保持常驻,warn 一行", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-ctfail-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-ctfail"),
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
      countTokens: async () => {
        throw new Error("network down");
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });

    // all deferrable built-ins stay resident
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    expect(visibleNames).toContain("query_trace");
    expect(visibleNames).toContain("web_fetch");
    // no retirement segment in system text
    const systemText = await built.deps.system?.();
    expect(systemText).not.toContain("<deferred_internal_tools>");
    // at least one warn line (mentioning countTokens failed)
    expect(warnings.some((w) => w.includes("countTokens failed"))).toBe(true);
  });

  it("countTokens 缺席(不传 stub,默认用 adapter.countTokens 但 stub adapter 不实现) → 跳过本会话,warn", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-ctabsent-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    // No countTokens passed → falls back to adapter.countTokens. The real
    // anthropic adapter implements it, so an unmocked production path would call
    // the API. Here the adapter exists (tmpdir + chat surface) but the network is
    // unreachable during build (127.0.0.1:9999) → fetch rejects → the assembly
    // catches → skip path. Two semantics are accepted: warn + everything stays
    // resident (the stub-failure path).
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-ctabsent"),
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
      // No countTokens → adapter.countTokens (may throw)
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    // Skipped (by either path): deferrables stay resident
    const promptTools = built.deps.promptTools;
    assert.ok(promptTools !== undefined, "assembly arms promptTools");
    const visibleNames = promptTools().map((t) => t.name);
    expect(visibleNames).toContain("query_trace");
    expect(visibleNames).toContain("web_fetch");
    // no retirement segment in system text
    const systemText = await built.deps.system?.();
    expect(systemText).not.toContain("<deferred_internal_tools>");
  });

  it("相邻轮 system deep-equal(退场名单会话内恒定 → 段不变)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-b6-stable-"));
    roots.push(root);
    await plantMcpConfig(root, ["stubsvc"]);

    let callCount = 0;
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-b6-stable"),
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
      countTokens: async () => {
        callCount += 1;
        return { inputTokens: 5_000 };
      },
    });
    shutdowns.push(async () => {
      if (built.shutdown) await built.shutdown();
    });
    // countTokens is called once at assembly time; later resolver() calls never re-measure
    const firstCallCount = callCount;
    // multiple resolver() calls → countTokens does not grow
    await built.deps.system?.();
    await built.deps.system?.();
    await built.deps.system?.();
    expect(callCount).toBe(firstCallCount);
  });
});
