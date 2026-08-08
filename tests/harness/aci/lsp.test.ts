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
// 只替换 getClient；signalToCancellationToken 保留真实实现（token 布线测试需要）。
vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
  };
});

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

  it("diagnostics filter drops severity < 1 (negative and zero), keeps positive", async () => {
    const items = [
      {
        severity: -1,
        range: { start: { line: 0, character: 0 } },
        message: "neg msg",
      },
      {
        severity: 0,
        range: { start: { line: 1, character: 0 } },
        message: "zero msg",
      },
      {
        severity: 1,
        range: { start: { line: 2, character: 0 } },
        message: "err msg",
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
    // 生产实现 lsp.ts:316 过滤 `severity >= 1`：负值 -1 与 0 都被滤掉，
    // 仅保留 severity=1。断言两者都被丢弃、1 保留。
    expect(out).not.toContain("neg msg");
    expect(out).not.toContain("zero msg");
    expect(out).toContain("err msg");
  });
});

// ── stringifyResult(undefined) → ""（empty）─────────────────────────────────
//
// 锚点 lsp.ts:91：`if (result === undefined) return "";`（契约 Y1 纯字符串）。

describe("undefined sendRequest result", () => {
  it("undefined sendRequest result renders empty string", async () => {
    const { client } = makeFakeClient(() => undefined);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(out).toBe("");
  });
});

// ── handler 层 cancel token 布线（empty/concurrent）─────────────────────────
//
// 锚点 lsp.ts:198-206（makeOperationTool）与 238-258（makeCallHierarchyCallTool）：
// `execCtx?.signal` 存在时桥接成 token 作为第 3 实参传给 client.sendRequest，
// 请求完成后 `cancel?.dispose()`。

describe("handler cancel token wiring", () => {
  it("position tool forwards cancellation token and disposes after request", async () => {
    const gotMethod: string[] = [];
    const sentArgs: unknown[] = [];
    const fakeClient = {
      connection: {} as never,
      process: {} as never,
      sendRequest: async (method: string, params: unknown, token?: unknown) => {
        gotMethod.push(method);
        sentArgs.push(token);
        return [];
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      dispose: () => undefined,
    };
    mockGetClient.mockResolvedValue(fakeClient);

    const tools = createLspToolSet(ctx);
    const signal = new AbortController().signal;
    // dispose 会 removeEventListener("abort", onAbort) → 断言已移除。
    const removeSpy = vi.spyOn(signal, "removeEventListener");
    // 传入 execCtx.signal → 桥接 token → 第 3 实参非 undefined。
    await byName(tools, "lsp_definition").handler(
      { file: "/work/src/a.ts", line: 1, character: 0 },
      { signal }
    );

    expect(gotMethod).toEqual(["textDocument/definition"]);
    expect(sentArgs).toHaveLength(1);
    // 第 3 实参是 vscode-jsonrpc CancellationToken（非 undefined）。
    expect(sentArgs[0]).toBeDefined();
    expect(sentArgs[0]).toHaveProperty("isCancellationRequested", false);
    // cancel.dispose() 被调用 → "abort" listener 已移除。
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("call-hierarchy tool forwards token on both requests and disposes after", async () => {
    const item = { name: "foo", uri: "file:///work/src/a.ts", range: {} };
    const sentTokens: unknown[] = [];
    const fakeClient = {
      connection: {} as never,
      process: {} as never,
      sendRequest: async (
        method: string,
        _params: unknown,
        token?: unknown
      ) => {
        sentTokens.push(token);
        return method === "textDocument/prepareCallHierarchy" ? [item] : [];
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      dispose: () => undefined,
    };
    mockGetClient.mockResolvedValue(fakeClient);

    const tools = createLspToolSet(ctx);
    const signal = new AbortController().signal;
    // call-hierarchy handler 内两次 sendRequest 各自桥接 token；每次桥接后
    // finally 调 cancel.dispose() → removeEventListener("abort", fn)。
    // spy 整个 signal 的 removeEventListener：必须被调用 ≥2 次。
    const removeSpy = vi.spyOn(signal, "removeEventListener");
    await byName(tools, "lsp_incoming_calls").handler(
      { file: "/work/src/a.ts", line: 2, character: 1 },
      { signal }
    );

    // 两次 sendRequest 都收到 token（非 undefined）。
    expect(sentTokens).toHaveLength(2);
    for (const t of sentTokens) expect(t).toBeDefined();
    // cancel.dispose() 每次 sendRequest 后都被调 → 移除 "abort" listener。
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

// ── 边界补充：aci/tools/lsp.ts（overflow / negative / empty / exception）─────
// 复用既有 makeFakeClient / mockGetClient 基建;覆盖:
//   - lsp_diagnostics 诊断封顶截断细节(total 25 → 显示 20,截断标注)
//   - MAX_SAFE_INTEGER line/character 放行
//   - 空字符串 file 放行
//   - sendRequest 抛错 → 契约 Y1 纯字符串(非抛 ToolExecutionError)

describe("lsp_diagnostics cap at exactly 20 (overflow)", () => {
  it("renders exactly 20 lines and reports total when over cap", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
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
    const shown = (out.match(/^error/gm) ?? []).length;
    expect(shown).toBe(20); // 封顶 20 条
    expect(out).toContain("total 30");
    expect(out).toContain("(10 more issue(s) truncated");
  });

  it("exactly 20 items shows no truncation marker", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
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
    expect(out).not.toContain("truncated");
    expect(out).not.toContain("total 20");
  });
});

describe("overflow line/character MAX_SAFE_INTEGER (overflow)", () => {
  it("accepts line=MAX_SAFE_INTEGER (valid integer ≥ 1)", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const MAX = Number.MAX_SAFE_INTEGER;
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: MAX,
      character: 0,
    });
    expect(calls[0].method).toBe("textDocument/definition");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
      position: { line: MAX - 1, character: 0 },
    });
  });

  it("accepts character=MAX_SAFE_INTEGER", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const MAX = Number.MAX_SAFE_INTEGER;
    await byName(tools, "lsp_hover").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: MAX,
    });
    expect(calls[0].method).toBe("textDocument/hover");
  });
});

describe("empty-string file passes ajv (empty)", () => {
  it("file:'' passes file-only schema and routes to getClient", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_document_symbol").handler({
      file: "",
    });
    expect(typeof out).toBe("string");
    expect(mockGetClient).toHaveBeenCalledWith(ctx, "");
  });
});

describe("initialize handshake failure propagates as tool error (exception)", () => {
  it("sendRequest throw (spawn-ok but initialize reject) rejects, not stringified", async () => {
    const { client } = makeFakeClient(() => {
      throw new Error("initialize handshake failed");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      })
    ).rejects.toThrow("initialize handshake failed");
  });

  it("diagnostics handler tolerates getDiagnostics returning non-array (empty)", async () => {
    const { client } = makeFakeClient(() => undefined);
    (client as unknown as { getDiagnostics: () => unknown }).getDiagnostics =
      () => undefined;
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(typeof out).toBe("string");
    expect(out).toContain("<diagnostics");
    expect(out).toContain("</diagnostics>");
  });
});
