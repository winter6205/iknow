import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { ToolExecutionError } from "../../src/harness/errors.js";
import { toAciToolDef } from "../../src/harness/mcp/adapter.js";

const tool = (overrides: Partial<McpTool> = {}): McpTool => ({
  name: "foo/bar",
  description: "Does MCP work",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
  ...overrides,
});

const textResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
});

describe("toAciToolDef", () => {
  it("sanitizes server and tool name segments independently", () => {
    const definition = toAciToolDef({
      server: "my server",
      tool: tool(),
      call: vi.fn(),
      timeoutMs: 1234,
    });

    expect(definition.name).toBe("mcp__my_server__foo_bar");
  });

  it("sets conservative ACI metadata and preserves the tool schema", () => {
    const definition = toAciToolDef({
      server: "server",
      tool: tool(),
      call: vi.fn(),
      timeoutMs: 1234,
    });

    expect(definition.aci).toEqual({
      category: "write",
      lazy: true,
      isConcurrencySafe: false,
      interruptBehavior: "cancel",
      timeoutTier: "long",
    });
    expect(definition.inputSchema).toEqual(tool().inputSchema);
  });

  it("不落输出闸豁免声明（ADR-0083：MCP 不可取得）", () => {
    // 转换路径只映射 name / description / inputSchema / aci / handler，
    // 外部源天然是第三方数据 —— 豁免只对内建 createSkillTool 装配期落值。
    const definition = toAciToolDef({
      server: "server",
      tool: tool({ exemptFromOutputCap: true } as Partial<McpTool>),
      call: vi.fn(),
      timeoutMs: 1234,
    });

    expect(definition.exemptFromOutputCap).toBeUndefined();
    expect("exemptFromOutputCap" in definition).toBe(false);
  });

  it("剥掉顶层 $schema —— 宿主 Ajv 仅 bundle draft-07 元模式，带 2020-12 anchor 的 schema 无法 compile", () => {
    const definition = toAciToolDef({
      server: "server",
      tool: tool({
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            value: { type: "string" },
            // 非顶层的 $schema 出现处必须原样保留，只剥顶层一处
            nested: {
              type: "object",
              properties: {
                $schema: { type: "string" },
              },
            },
          },
          required: ["value"],
        },
      }),
      call: vi.fn(),
      timeoutMs: 1234,
    });

    expect(definition.inputSchema).toEqual({
      type: "object",
      properties: {
        value: { type: "string" },
        nested: {
          type: "object",
          properties: {
            $schema: { type: "string" },
          },
        },
      },
      required: ["value"],
    });
    expect("$schema" in definition.inputSchema).toBe(false);
  });

  it("无顶层 $schema 的 inputSchema 保留原对象引用（不 spread 复制）", () => {
    const inputSchema = tool().inputSchema!;
    const definition = toAciToolDef({
      server: "server",
      tool: tool({ inputSchema }),
      call: vi.fn(),
      timeoutMs: 1234,
    });

    expect(definition.inputSchema).toBe(inputSchema);
  });

  it("uses an empty object schema when inputSchema is absent", () => {
    const definition = toAciToolDef({
      server: "server",
      tool: tool({ inputSchema: undefined }),
      call: vi.fn(),
      timeoutMs: 1234,
    });

    expect(definition.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("prefers structuredContent and forwards timeout and abort options", async () => {
    const call = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "fallback" }],
      structuredContent: { answer: 42 },
    } satisfies CallToolResult);
    const definition = toAciToolDef({
      server: "server",
      tool: tool(),
      call,
      timeoutMs: 1234,
    });
    const controller = new AbortController();

    await expect(
      definition.handler({ value: "x" }, { signal: controller.signal })
    ).resolves.toBe('{"answer":42}');
    expect(call).toHaveBeenCalledWith(
      "foo/bar",
      { value: "x" },
      {
        timeout: 1234,
        resetTimeoutOnProgress: true,
        signal: controller.signal,
      }
    );
  });

  it("returns text from an MCP error result without throwing", async () => {
    const definition = toAciToolDef({
      server: "server",
      tool: tool(),
      call: vi.fn().mockResolvedValue({
        ...textResult("recoverable failure"),
        isError: true,
        structuredContent: { ignored: true },
      } satisfies CallToolResult),
      timeoutMs: 1234,
    });

    await expect(definition.handler({})).resolves.toBe("recoverable failure");
  });

  it("joins all text blocks when structuredContent is absent", async () => {
    const definition = toAciToolDef({
      server: "server",
      tool: tool(),
      call: vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "AA==", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
      } satisfies CallToolResult),
      timeoutMs: 1234,
    });

    await expect(definition.handler({})).resolves.toBe("firstsecond");
  });

  it("translates call rejection to ToolExecutionError", async () => {
    const definition = toAciToolDef({
      server: "server",
      tool: tool(),
      call: vi.fn().mockRejectedValue(new Error("disconnected")),
      timeoutMs: 1234,
    });

    await expect(definition.handler({})).rejects.toBeInstanceOf(
      ToolExecutionError
    );
  });
});
