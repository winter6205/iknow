/**
 * LSP 工具集单测 — spec 251-lsp-tool（§ Testing Strategy：8 件 operation handler
 * 输入校验 / lsp_diagnostics handler）。
 *
 * 覆盖：
 *   1. ajv 拒非法类型（file=number 等）→ ToolExecutionError。
 *   2. ajv 拒缺参（position op 缺 line/character）→ ToolExecutionError。
 *   3. 无 client（getClient 返 undefined）→ `"(no LSP server available for file)"`。
 *   4. 10 件 inputSchema 必需字段：position op 含 file/line/character；
 *      file-only（document_symbol / workspace_symbol / diagnostics）仅 file。
 *   5. 契约 Y1：mock client.sendRequest 返回对象 → handler 输出 JSON 字符串，非对象。
 *   6. lsp_diagnostics 无 position schema（仅 file 必填）。
 *   7. aci 元数据：read-only / isConcurrencySafe=false / interruptBehavior=cancel /
 *      timeoutTier=default。
 *
 * Mock 策略：模块级 `vi.mock` stub `getClient`（对齐 client.test.ts 的 vi.hoisted
 * 捕获引用手法），避免触碰真实 tsserver / vscode-jsonrpc。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolExecutionError } from "../../../src/harness/errors.ts";

const { mockGetClient } = vi.hoisted(() => ({
  mockGetClient: vi.fn<() => Promise<unknown>>(),
}));

// 动态导入必须在 mock 安装之后（对齐 client.test.ts）。
vi.mock("../../../src/harness/lsp/client.js", () => ({
  getClient: (...args: unknown[]) => mockGetClient(...args),
}));

import { createLspToolSet } from "../../../src/harness/aci/tools/lsp.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";

function makeFakeClient(
  responder: (method: string, params: unknown) => unknown
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    client: {
      connection: {} as never,
      process: {} as never,
      sendRequest: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return responder(method, params);
      },
      sendNotification: async () => undefined,
      // #251:lsp_diagnostics 读 push 缓存(latest-wins),fake 默认空数组;
      // 需要覆盖时在测试里 `client.getDiagnostics = () => items`。
      getDiagnostics: (_uri: string) => [] as ReadonlyArray<unknown>,
      dispose: () => undefined,
    },
  };
}

const ctx = { directory: "/work" };

function byName(tools: ReadonlyArray<AciToolDef>, name: string): AciToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

const POSITION_OPS = [
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_go_to_implementation",
  "lsp_prepare_call_hierarchy",
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
] as const;

const FILE_ONLY_OPS = [
  "lsp_document_symbol",
  "lsp_workspace_symbol",
  "lsp_diagnostics",
] as const;

const ALL_TOOL_NAMES = [...POSITION_OPS, ...FILE_ONLY_OPS] as const;

beforeEach(() => {
  mockGetClient.mockReset();
});

describe("createLspToolSet shape", () => {
  it("exports 10 tools (9 operations + lsp_diagnostics)", () => {
    const tools = createLspToolSet(ctx);
    expect(tools).toHaveLength(10);
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it("exposes all 10 frozen tool defs", () => {
    for (const tool of createLspToolSet(ctx)) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });

  it("sets aci metadata (read-only / non-concurrent / cancel / default tier)", () => {
    for (const tool of createLspToolSet(ctx)) {
      expect(tool.aci.category).toBe("read-only");
      expect(tool.aci.isConcurrencySafe).toBe(false);
      expect(tool.aci.interruptBehavior).toBe("cancel");
      expect(tool.aci.timeoutTier).toBe("default");
    }
  });
});

describe("inputSchema required fields", () => {
  it("position ops require file, line, character", () => {
    const tools = createLspToolSet(ctx);
    for (const name of POSITION_OPS) {
      const schema = byName(tools, name).inputSchema;
      const required = schema.required as string[];
      expect(required).toContain("file");
      expect(required).toContain("line");
      expect(required).toContain("character");
    }
  });

  it("file-only ops require only file (no position)", () => {
    const tools = createLspToolSet(ctx);
    for (const name of FILE_ONLY_OPS) {
      const schema = byName(tools, name).inputSchema;
      const required = schema.required as string[];
      expect(required).toEqual(["file"]);
    }
  });
});

describe("ajv validation", () => {
  it("rejects invalid input types (file must be a string)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({ file: 123 })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects missing line/character for position ops", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({ file: "x.ts" })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects non-integer line", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 1.5,
        character: 0,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects line below minimum (1-based)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 0,
        character: 0,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects character below minimum (0-based)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 1,
        character: -1,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects extra properties (additionalProperties: false)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "x.ts",
        line: 1,
        character: 0,
        extra: true,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("no client path", () => {
  it("returns the no-server string when getClient returns undefined", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    for (const name of ALL_TOOL_NAMES) {
      const input =
        name === "lsp_diagnostics" ||
        name === "lsp_document_symbol" ||
        name === "lsp_workspace_symbol"
          ? { file: "x.ts" }
          : { file: "x.ts", line: 1, character: 0 };
      const out = await byName(tools, name).handler(input);
      expect(out).toBe("(no LSP server available for file)");
    }
  });
});

describe("contract Y1 — pure string output", () => {
  it("returns a JSON string for a structured sendRequest result", async () => {
    const { client } = makeFakeClient(() => ({ some: "object", n: 42 }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_definition").handler({
      file: "x.ts",
      line: 1,
      character: 0,
    });
    expect(typeof out).toBe("string");
    expect(JSON.parse(out as string)).toEqual({ some: "object", n: 42 });
  });
});

describe("operation params mapping", () => {
  it("lsp_definition sends textDocument/definition with 0-based position", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 3,
      character: 2,
    });
    expect(calls[0].method).toBe("textDocument/definition");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
      position: { line: 2, character: 2 },
    });
  });

  it("lsp_references adds includeDeclaration context", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_references").handler({
      file: "/work/src/a.ts",
      line: 3,
      character: 2,
    });
    expect(calls[0].method).toBe("textDocument/references");
    expect(calls[0].params).toMatchObject({
      context: { includeDeclaration: true },
    });
  });

  it("lsp_hover sends textDocument/hover", async () => {
    const { client, calls } = makeFakeClient(() => ({}));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_hover").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/hover");
  });

  it("lsp_document_symbol sends textDocument/documentSymbol without position", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_document_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(calls[0].method).toBe("textDocument/documentSymbol");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
    });
  });

  it("lsp_workspace_symbol sends workspace/symbol with empty query", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(calls[0].method).toBe("workspace/symbol");
    expect(calls[0].params).toEqual({ query: "" });
  });

  it("lsp_go_to_implementation sends textDocument/implementation", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_go_to_implementation").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/implementation");
  });

  it("lsp_prepare_call_hierarchy sends textDocument/prepareCallHierarchy", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_prepare_call_hierarchy").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/prepareCallHierarchy");
  });
});

describe("call hierarchy multi-step forwarding", () => {
  it("lsp_incoming_calls prepares items then forwards callHierarchy/incomingCalls", async () => {
    const item = { name: "foo", uri: "file:///work/src/a.ts", range: {} };
    const { client, calls } = makeFakeClient((method) =>
      method === "textDocument/prepareCallHierarchy" ? [item] : []
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    expect(calls[0].method).toBe("textDocument/prepareCallHierarchy");
    expect(calls[1].method).toBe("callHierarchy/incomingCalls");
    expect(calls[1].params).toEqual({ item });
  });

  it("lsp_outgoing_calls forwards callHierarchy/outgoingCalls", async () => {
    const item = { name: "bar", uri: "file:///work/src/a.ts", range: {} };
    const { client, calls } = makeFakeClient((method) =>
      method === "textDocument/prepareCallHierarchy" ? [item] : []
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_outgoing_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    expect(calls[1].method).toBe("callHierarchy/outgoingCalls");
    expect(calls[1].params).toEqual({ item });
  });

  it("returns empty string when prepareCallHierarchy yields no item", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    expect(out).toBe("[]");
  });
});

describe("lsp_diagnostics", () => {
  it("filters severity 0 (hint) and renders <diagnostics> XML summary", async () => {
    const items = [
      {
        severity: 1,
        range: { start: { line: 0, character: 0 } },
        message: "err msg",
      },
      {
        severity: 2,
        range: { start: { line: 1, character: 4 } },
        message: "warn msg",
      },
      {
        severity: 0,
        range: { start: { line: 2, character: 0 } },
        message: "hint msg",
      },
    ];
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnostics: (uri: string) => ReadonlyArray<unknown>;
      }
    ).getDiagnostics = () => items;
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(typeof out).toBe("string");
    expect(out).toContain('<diagnostics file="/work/src/a.ts">');
    expect(out).toContain("error 1:0 err msg");
    expect(out).toContain("warning 2:4 warn msg");
    expect(out).not.toContain("hint msg");
    expect(out).toContain("</diagnostics>");
  });

  it("caps entries at 20 per file and reports truncation", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      severity: 1,
      range: { start: { line: i, character: 0 } },
      message: `msg ${i}`,
    }));
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnostics: (uri: string) => ReadonlyArray<unknown>;
      }
    ).getDiagnostics = () => items;
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(out).toContain("...(");
    expect(out).toContain("total 25");
    const shownCount = (out.match(/^error/gm) ?? []).length;
    expect(shownCount).toBe(20);
  });

  it("requires only file (no position schema)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    const schema = byName(tools, "lsp_diagnostics").inputSchema;
    expect(schema.required).toEqual(["file"]);
  });
});
