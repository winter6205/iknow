/**
 * T3 / ADR-0046 §3 — 直呼加载 SC3:未 discover 的 mcp__ 工具被直呼,
 * 该轮 hydrate(discover 副作用=尾部追加到下一轮 visibleSchemas);
 * input 通过 schema → 直接执行;否则非 error 文本投影 schema。
 *
 * 行为真值(spec Does #2 + SC3):
 *   - mcp__ 工具,not discovered → 触发 discover(name);
 *     gate.proceed;inner 真跑,handler 返回值原样进 ok payload;
 *     下一轮 visibleSchemas() 尾部追加该 schema(邻轮 deep-equal
 *     仅在该工具被 hydrate 时追加)。
 *   - mcp__ 工具,not discovered,input 不通过 schema → blocked + kind: "ok"
 *     + payload 文本 = JSON.stringify({name, description, inputSchema});
 *     is_error = false(模型可见的成功送达结果,引导模型补齐 input);
 *     discover 副作用照样发生(下一轮 tools 尾部可见 schema)。
 *   - 不抛 "tool <name> not loaded — call tool_search first"。
 *
 * 与 mcp-not-loaded-gate.test.ts 的区别:那里只验 gateOne 的 proceed/blocked
 * 判定,本文件验 end-to-end(hydrate → execute 或投影 + discover 副作用)。
 */
import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { createAciRegistry } from "../../../src/harness/aci/aci-registry.js";
import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import { createExecutor } from "../../../src/harness/tools/executor.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.js";

/** 构造一个 mcp__ 工具(lazy + write tier 与 MCP 工具同形态):
 *  必填 input `q`,handler 返 "ok:<q>"。 */
function makeMcpTool(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `mcp ${name}`,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", minLength: 1 } },
      required: ["q"],
      additionalProperties: false,
    },
    handler: async (input: unknown) => {
      const q = (input as { q: string }).q;
      return `ok:${q}`;
    },
    aci: Object.freeze({
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "long" as const,
      lazy: true,
    }),
  });
}

function makeInnerSpy(): { executor: Executor; calls: ToolCall[][] } {
  const calls: ToolCall[][] = [];
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      calls.push([...batch]);
      return batch.map((c) => ({
        kind: "ok" as const,
        toolUseId: c.id,
        payload: [{ type: "text" as const, text: `executed:${c.name}` }],
      }));
    },
  });
  return { executor, calls };
}

/** 构造一个装好 MCP 工具的 aci-registry(mcp__ 经 registerExternal,
 *  非 mcp__ 工具空位),让测试不踩 Gate 2 防撞。 */
function buildRegistry(): ReturnType<typeof createAciRegistry> {
  const reg = createAciRegistry([]);
  reg.registerExternal([makeMcpTool("mcp__svc__ping")]);
  return reg;
}

/** 把 aci-registry 投影成 permission-executor 接受的 `Registry` 形态。
 *  用 `registry.catalog`(含 registerExternal 注入的 mcp__ 工具),不用
 *  `registry.inner`(inner 仅含构造期 tools 快照,registerExternal 不动)。 */
function registrySurface(registry: ReturnType<typeof createAciRegistry>): {
  list: () => ReadonlyArray<AciToolDef>;
  get: (name: string) => AciToolDef | undefined;
} {
  return {
    list: () => registry.catalog.all(),
    get: (name: string) => registry.catalog.get(name),
  };
}

describe("T3 SC3 — 未 discover 的 mcp__ 工具直呼:hydrate + 执行", () => {
  it("合法 input:gate.proceed → inner 真跑,handler 输出进 ok payload", async () => {
    const registry = buildRegistry();
    const discoveredSet = new Set<string>();
    // 把 mcp__ 工具的 def 直接交到 inner executor —— createAciRegistry 的
    // `registerExternal` 不动 inner,所以这里用 catalog 的 def 显式构造一个
    // 含 mcp__ 工具的 inner registry(给 createExecutor)。这只在测试装配
    // 内出现,生产路径由 manager.registerExternal + aci-executor 装配保证。
    const mcpDef = registry.catalog.get("mcp__svc__ping")!;
    // ajv 编译 def.inputSchema —— 与 aci-registry.registerExternal 同源。
    const ajv = new Ajv.default({ strict: true, allErrors: true });
    addFormats.default(ajv);
    const mcpValidator = ajv.compile(mcpDef.inputSchema);
    const realExecutor = createExecutor({
      list: () => [mcpDef],
      get: (n: string) => (n === "mcp__svc__ping" ? mcpDef : undefined),
      getValidator: (n: string) =>
        n === "mcp__svc__ping" ? mcpValidator : undefined,
    });
    const perm = createPermissionRuntime({
      inner: realExecutor,
      registry: registrySurface(registry),
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discoveredSet.has(name),
      discover: (name: string) => registry.discover(name),
    });

    const call: ToolCall = {
      id: "sc3-1",
      name: "mcp__svc__ping",
      input: { q: "hello" },
    };
    const gate = await perm.gateOne(call, undefined);
    // 关键:不该返 blocked,不该含 "not loaded"。
    assert.equal(gate.kind, "proceed");
    if (gate.kind === "proceed") {
      assert.ok(gate.def, "proceed 应带回 def");
      assert.equal(gate.def!.name, "mcp__svc__ping");
    }

    // 模拟上层驱动 runAllowed:调用真 inner executor。
    const [result] = await realExecutor.executeAll([call]);
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      const text = result.payload[0];
      expect(text?.type).toBe("text");
      expect(text?.text).toBe("ok:hello");
    }

    // 副作用:discover 已被触发 → registry.isDiscovered(name) === true。
    expect(registry.isDiscovered("mcp__svc__ping")).toBe(true);
    // 下一轮 visibleSchemas 尾部追加(mcp__ lazy: true + 已 discover):
    expect(registry.visibleSchemas().map((t) => t.name)).toContain(
      "mcp__svc__ping"
    );
  });

  it("缺参 input:gate 返回 ok 文本投影(含 name/description/inputSchema),非 error", async () => {
    const registry = buildRegistry();
    const discoveredSet = new Set<string>();
    const { executor: inner } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: registrySurface(registry),
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discoveredSet.has(name),
    });

    const call: ToolCall = {
      id: "sc3-2",
      name: "mcp__svc__ping",
      input: {}, // 缺 required `q`
    };
    const gate = await perm.gateOne(call, undefined);

    // 关键契约:
    //   - kind: blocked (gate 不放行,因为 input 校验失败)
    //   - result.kind: "ok" —— 非 error,文本投影送达模型
    //   - result.payload 文本 = JSON.stringify({name, description, inputSchema})
    //   - 不再含 "not loaded — call tool_search first"
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "ok");
      assert.equal(gate.result.toolUseId, "sc3-2");
      const payload = (gate.result as { payload: unknown }).payload as Array<{
        type: string;
        text: string;
      }>;
      expect(payload).toHaveLength(1);
      const text = payload[0]?.text ?? "";
      expect(text).not.toContain("not loaded");
      expect(text).not.toContain("call tool_search first");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.name).toBe("mcp__svc__ping");
      expect(parsed.description).toBe("mcp mcp__svc__ping");
      expect(parsed.inputSchema).toBeDefined();
      // schema 字段必须是对象,含 properties + required。
      const schema = parsed.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["q"]);
    }
  });

  it("非法 input(类型错):同样返 ok 文本投影", async () => {
    const registry = buildRegistry();
    const discoveredSet = new Set<string>();
    const { executor: inner } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: registrySurface(registry),
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discoveredSet.has(name),
    });

    const call: ToolCall = {
      id: "sc3-3",
      name: "mcp__svc__ping",
      input: { q: 123 }, // q 必须是 string
    };
    const gate = await perm.gateOne(call, undefined);
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "ok");
      const payload = (gate.result as { payload: unknown }).payload as Array<{
        text: string;
      }>;
      const parsed = JSON.parse(payload[0]!.text) as Record<string, unknown>;
      expect(parsed.name).toBe("mcp__svc__ping");
    }
  });

  it("discover 副作用:aci registry.discover 后 isDiscovered === true + visibleSchemas 仍含", () => {
    // 直验 aci-registry 的 discover 副作用契约 —— permission-executor
    // 调过 discover 后,这两条不变式必须成立(permission-executor 自身的
    // hydrate 由其内 catalog.discover seam 触发;此处仅校验 ACI registry
    // 端语义未被破坏)。
    const registry = buildRegistry();
    expect(registry.isDiscovered("mcp__svc__ping")).toBe(false);
    // 初始:lazy 工具不在 visibleSchemas
    expect(registry.visibleSchemas().map((t) => t.name)).not.toContain(
      "mcp__svc__ping"
    );

    registry.discover("mcp__svc__ping");
    expect(registry.isDiscovered("mcp__svc__ping")).toBe(true);

    const after = registry.visibleSchemas().map((t) => t.name);
    expect(after).toContain("mcp__svc__ping");
    // 邻轮 deep-equal:再次调 visibleSchemas 应字节级一致。
    const again = registry.visibleSchemas().map((t) => t.name);
    expect(again).toEqual(after);
  });
});
