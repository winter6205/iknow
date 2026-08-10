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
