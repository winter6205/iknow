import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createAciRegistry } from "../../src/harness/aci/aci-registry.ts";
import type { AciToolDef } from "../../src/harness/aci/types.ts";
import { RegistryConstructionError } from "../../src/harness/errors.ts";
import { toAciToolDef } from "../../src/harness/mcp/adapter.ts";

function makeTool(name: string, lazy = false): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      ...(lazy ? { lazy: true } : {}),
    },
  });
}

describe("ACI registry external registration — ADR-0083 输出闸豁免不可自称", () => {
  it("mcp__ def 携带 exemptFromOutputCap 声明 → 存储侧剥离（注册仍成功，功能面不变）", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const dirty = Object.freeze({
      ...makeTool("mcp__server__big"),
      exemptFromOutputCap: true,
    }) as AciToolDef;

    registry.registerExternal([dirty]);

    const stored = registry.catalog.get(dirty.name);
    // 结构闸：存储的 def 上不再有该键，executor 的 safeContent 结构上读不到。
    assert.ok(stored !== undefined);
    assert.equal("exemptFromOutputCap" in stored!, false);
    assert.equal(stored!.exemptFromOutputCap, undefined);
    // 剥离 ≠ 拒绝：handler 身份保留，注册未被拒。
    assert.equal(stored!.handler, dirty.handler);
    assert.equal(stored!.aci.category, "read-only");
  });

  it("未携带声明的 mcp__ def → 原样存储（对象身份不变）", () => {
    // 既有身份契约（catalog.get(name) === 注册入参）不得因剥离而漂移。
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__server__lookup");

    registry.registerExternal([external]);

    assert.equal(registry.catalog.get(external.name), external);
  });

  it("内建工具路径不受剥离影响：createAciRegistry 入参保留声明（豁免 home = 内建装配期声明）", () => {
    // ADR-0083 的豁免只对 mcp__ 外部源设结构闸；内建 def 的声明经
    // createRegistry 冻结快照原样存活（skill 工具即此路径）。
    const builtin = Object.freeze({
      ...makeTool("skill"),
      exemptFromOutputCap: true,
    }) as AciToolDef;
    const registry = createAciRegistry([builtin]);

    assert.equal(registry.catalog.get("skill")?.exemptFromOutputCap, true);
    assert.equal(registry.inner.get("skill")?.exemptFromOutputCap, true);
  });
});

describe("ACI registry external registration", () => {
  it("adds an mcp__ tool to catalog, discovery, and visible schemas", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__server__lookup");

    registry.registerExternal([external]);

    assert.equal(registry.catalog.get(external.name), external);
    assert.deepEqual(
      registry.catalog.all().map((tool) => tool.name),
      ["read_file", external.name]
    );
    assert.equal(registry.discover(external.name), external);
    assert.deepEqual(
      registry.visibleSchemas().map((tool) => tool.name),
      ["read_file", external.name]
    );
  });

  it("rejects an external tool outside the mcp__ namespace", () => {
    const registry = createAciRegistry([makeTool("read_file")]);

    assert.throws(
      () => registry.registerExternal([makeTool("external_lookup")]),
      RegistryConstructionError
    );
  });

  it("rejects an external tool that duplicates a static tool name", () => {
    const registry = createAciRegistry([makeTool("read_file")]);

    assert.throws(
      () => registry.registerExternal([makeTool("read_file")]),
      RegistryConstructionError
    );
  });

  it("keeps inner.list() as the construction-time snapshot", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const before = registry.inner.list();

    registry.registerExternal([makeTool("mcp__server__lookup")]);

    assert.equal(registry.inner.list(), before);
    assert.equal(registry.inner.list().length, 1);
  });

  it("promotes a lazy external tool only after discovery", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__server__lazy_lookup", true);

    registry.registerExternal([external]);
    assert.deepEqual(
      registry.visibleSchemas().map((tool) => tool.name),
      ["read_file"]
    );

    assert.equal(registry.discover(external.name), external);
    assert.deepEqual(
      registry.visibleSchemas().map((tool) => tool.name),
      ["read_file", external.name]
    );
  });

  it("unregisterExternal removes a tool from catalog, discover, and visible schemas", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__a__x");

    registry.registerExternal([external]);
    assert.equal(registry.catalog.get(external.name), external);

    registry.unregisterExternal([external.name]);

    // 三个下游视图都从 externalByExt live 读，应同步收敛
    assert.equal(registry.catalog.get(external.name), undefined);
    assert.equal(registry.discover(external.name), undefined);
    assert.deepEqual(
      registry.visibleSchemas().map((tool) => tool.name),
      ["read_file"]
    );
    assert.deepEqual(
      registry.catalog.all().map((tool) => tool.name),
      ["read_file"]
    );
  });

  it("re-registers the same name after unregister (reload contract)", () => {
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__a__x");

    registry.registerExternal([external]);
    registry.unregisterExternal([external.name]);

    // unregister 清掉了名字 → Gate2 duplicate 不再触发，同名可重新注册
    assert.doesNotThrow(() => registry.registerExternal([external]));
    assert.equal(registry.catalog.get(external.name), external);
  });

  it("unregister of unregistered names is idempotent (no throw)", () => {
    const registry = createAciRegistry([makeTool("read_file")]);

    assert.doesNotThrow(() =>
      registry.unregisterExternal(["mcp__never__registered", "mcp__a__x"])
    );
    // 未注册名字被忽略后，仍可正常注册
    assert.doesNotThrow(() =>
      registry.registerExternal([makeTool("mcp__a__x")])
    );
  });

  it("B4 isDiscovered:未 discover 的名字返 false,discover 后返 true", () => {
    // B4 / ADR-0043 §2:permission-executor 据此拒绝未 discover 即调的
    // mcp__ 工具调用。catalog 上同形暴露 isDiscovered,供闸门读取。
    const registry = createAciRegistry([makeTool("read_file")]);
    const external = makeTool("mcp__server__check");

    registry.registerExternal([external]);

    // 未 discover：catalog.isDiscovered 返 false（gate 拒调）
    assert.equal(registry.catalog.isDiscovered?.(external.name), false);
    assert.equal(registry.isDiscovered(external.name), false);

    // discover 标记后：返 true（gate 放行）
    registry.discover(external.name);
    assert.equal(registry.catalog.isDiscovered?.(external.name), true);
    assert.equal(registry.isDiscovered(external.name), true);

    // 未注册的名字也返 false（不抛）
    assert.equal(registry.isDiscovered("mcp__ghost__unknown"), false);
  });
});

describe("2020-12 $schema inputSchema — 经 adapter 剥顶层后可过宿主 draft-07-only Ajv 编译闸", () => {
  const schema2020 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };

  it("raw 带顶层 $schema 的 def 被 compile 闸拒；toAciToolDef 转换后的同名 def 注册成功", () => {
    const registry = createAciRegistry([makeTool("read_file")]);

    // 负对照：证明拒因就是 $schema（同名尚未占用，非 duplicate 路径）。
    const raw = makeTool("mcp__server__lookup");
    assert.throws(
      () =>
        registry.registerExternal([
          Object.freeze({ ...raw, inputSchema: schema2020 }) as AciToolDef,
        ]),
      RegistryConstructionError
    );

    const def = toAciToolDef({
      server: "server",
      tool: { name: "lookup", description: "d", inputSchema: schema2020 },
      call: async () => ({ content: [] }),
      timeoutMs: 1000,
    });

    assert.doesNotThrow(() => registry.registerExternal([def]));
    assert.equal(registry.catalog.get(def.name), def);
    assert.equal("$schema" in def.inputSchema, false);
  });
});
