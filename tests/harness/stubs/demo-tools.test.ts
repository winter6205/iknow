/**
 * 019 T3 demo 工具单元测试。
 *
 * 覆盖:
 *  - createEchoTool / createGetTimeTool 通过 createRegistry 构造期校验
 *    (ajv strict + additionalProperties:false 编译过)
 *  - handler 在严格校验后返回正确 payload
 *    (echo input {text:"hi"} -> "hi";get_time -> ISO 字符串)
 *  - schema 拒绝额外字段,Executor 路径返回 validation_failed
 *    (echo + {extra:1};get_time + {tz:"x"})
 */

import { describe, it, expect } from "vitest";
import {
  createEchoTool,
  createGetTimeTool,
} from "../../../src/harness/stubs/demo-tools.js";
import { createRegistry } from "../../../src/harness/tools/registry.js";
import { createExecutor } from "../../../src/harness/tools/executor.js";

describe("createEchoTool (019 T3)", () => {
  it("通过 createRegistry 构造期校验 (schema 编译通过)", () => {
    expect(() => createRegistry([createEchoTool()])).not.toThrow();
  });

  it("handler({text:'hi'}) 返回字符串 'hi'", async () => {
    const tool = createEchoTool();
    const out = await tool.handler({ text: "hi" });
    expect(out).toBe("hi");
  });

  it("Executor 拒绝额外字段:additionalProperties:false 走 validation_failed", async () => {
    const registry = createRegistry([createEchoTool()]);
    const executor = createExecutor(registry);
    const results = await executor.executeAll([
      { id: "t1", name: "echo", input: { text: "hi", extra: 1 } },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("validation_failed");
    if (results[0]?.kind === "validation_failed") {
      expect(results[0].message).toMatch(/invalid input/i);
    }
  });
});

describe("createGetTimeTool (019 T3)", () => {
  it("通过 createRegistry 构造期校验", () => {
    expect(() => createRegistry([createGetTimeTool()])).not.toThrow();
  });

  it("handler() 返回 ISO 字符串", async () => {
    const tool = createGetTimeTool();
    const out = await tool.handler({});
    expect(typeof out).toBe("string");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("Executor 拒绝额外字段:走 validation_failed", async () => {
    const registry = createRegistry([createGetTimeTool()]);
    const executor = createExecutor(registry);
    const results = await executor.executeAll([
      { id: "t1", name: "get_time", input: { tz: "x" } },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("validation_failed");
  });
});

describe("demo tools 共享 (019 T3)", () => {
  it("createRegistry([echo, get_time]) 同时注册通过", () => {
    expect(() =>
      createRegistry([createEchoTool(), createGetTimeTool()])
    ).not.toThrow();
  });
});
