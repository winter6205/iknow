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

import {
  createLspToolSet,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  DIAGNOSTICS_WAIT_MS,
  MAX_RESULT_BYTES,
} from "../../../src/harness/aci/tools/lsp.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";

function makeFakeClient(
  responder: (method: string, params: unknown) => unknown
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const opened: string[] = [];
  return {
    calls,
    opened,
    client: {
      connection: {} as never,
      process: {} as never,
      // #251:handler 层在每次请求前先 ensureOpen(发 didOpen) 建 tsserver
      // project。fake 记录打开的文件,供「先打开再请求」断言使用。
      ensureOpen: async (file: string) => {
        opened.push(file);
      },
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

// lsp_workspace_symbol 的 file / query 均改为可选（lsp-optimization plan T3），
// 不再属于 file-only 组；其 schema 断言见下方专用 describe。
const FILE_ONLY_OPS = [
  "lsp_document_symbol",
  "lsp_diagnostics",
] as const;

// lsp_workspace_symbol 单列（plan T3 后 schema 独立），但仍属 10 件全集。
const ALL_TOOL_NAMES = [
  ...POSITION_OPS,
  ...FILE_ONLY_OPS,
  "lsp_workspace_symbol",
] as const;

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
      ensureOpen: async () => undefined,
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
      ensureOpen: async () => undefined,
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
    // plan T3 后 getDiagnostics=undefined 会触发读前等待（deadline 2s）——
    // 用 fake 时钟直接推到 deadline,避免真等 2s。
    vi.useFakeTimers();
    try {
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      });
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WAIT_MS);
      const out = await p;
      expect(typeof out).toBe("string");
      expect(out).toContain("<diagnostics");
      expect(out).toContain("</diagnostics>");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── handler 层 ensureOpen（textDocument/didOpen）布线 ──────────────────────
//
// 锚点 client.ts:LspClient.ensureOpen + lsp.ts 各 handler：tsserver 对未打开
// 文件不建 project,符号类操作(definition/document_symbol/workspace_symbol/
// hover/implementation/call_hierarchy/diagnostics)全返空。handler 必须在
// 每次 sendRequest / getDiagnostics 前 ensureOpen(file),fake 客户端的
// ensureOpen 推入 opened[] 用于断言。
//
// 覆盖:
//   - 各 handler 调 ensureOpen(file) 一次
//   - 同一 handler 调两次：第二次不发新 didOpen(fake 自身做了去重)
//   - 跨 handler 同一 file：第一次打开后,第二次走 fake 的去重缓存
//   - ensureOpen 在 sendRequest 之前(handler await 顺序)

describe("handler ensureOpen before request (textDocument/didOpen)", () => {
  it("lsp_definition calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_hover calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => ({}));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_hover").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_document_symbol calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_document_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_workspace_symbol calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({
      file: "/work/src/a.ts",
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("lsp_diagnostics calls ensureOpen with the file", async () => {
    const { client, opened } = makeFakeClient(() => undefined);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    });
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("call-hierarchy tools (incoming/outgoing) call ensureOpen with the file", async () => {
    const item = { name: "x", uri: "file:///work/src/a.ts", range: {} };
    const { client, opened } = makeFakeClient((method) =>
      method === "textDocument/prepareCallHierarchy" ? [item] : []
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    await byName(tools, "lsp_outgoing_calls").handler({
      file: "/work/src/a.ts",
      line: 2,
      character: 1,
    });
    // 两次调用 → 两次 ensureOpen(fake 是空 opened 累加器,自身去重属 client.ts)。
    // 此处断言：handler 把 ensureOpen 嵌入到流程中,不被 call-hierarchy 多步吞掉。
    expect(opened).toEqual(["/work/src/a.ts", "/work/src/a.ts"]);
  });

  it("ensureOpen runs before sendRequest (sequence)", async () => {
    const sequence: string[] = [];
    const fakeClient = {
      connection: {} as never,
      process: {} as never,
      ensureOpen: async (_file: string) => {
        sequence.push("didOpen");
      },
      sendRequest: async (_method: string, _params: unknown) => {
        sequence.push("sendRequest");
        return [];
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      dispose: () => undefined,
    };
    mockGetClient.mockResolvedValue(fakeClient);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(sequence).toEqual(["didOpen", "sendRequest"]);
  });
});

// ── lsp_workspace_symbol 新 schema（lsp-optimization plan T3）────────────────
//
// file 改可选（工作区级查询无需文件锚点）、新增可选 query（旧实现恒 ""）。
// 覆盖：无 required / additionalProperties:false / query 透传 buildParams /
// file 缺省走 SERVERS 序试探（首试探 = Typescript 伪路径）/ 非法 query 拒绝。

describe("lsp_workspace_symbol schema (plan T3)", () => {
  it("schema has no required fields but keeps additionalProperties:false", () => {
    const tools = createLspToolSet(ctx);
    const schema = byName(tools, "lsp_workspace_symbol").inputSchema;
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      "file",
      "query",
    ]);
  });

  it("empty input (no file, no query) passes validation and sends empty query", async () => {
    const { client, calls, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_workspace_symbol").handler({});
    expect(out).toBe("[]");
    expect(calls[0].method).toBe("workspace/symbol");
    expect(calls[0].params).toEqual({ query: "" });
    // file 缺省 → 不 ensureOpen（无文件可打开）。
    expect(opened).toEqual([]);
  });

  it("omitted file resolves a client by probing SERVERS in declaration order (first = Typescript)", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({ query: "foo" });
    // 首个试探：Typescript.extensions[0] = ".ts" 拼在 ctx.directory 下。
    expect(mockGetClient).toHaveBeenCalledWith(
      ctx,
      "/work/iknow-workspace.ts",
      expect.objectContaining({ server: expect.objectContaining({ id: "typescript" }) })
    );
  });

  it("passes optional query through to buildParams (file present)", async () => {
    const { client, calls } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_workspace_symbol").handler({
      file: "/work/src/a.ts",
      query: "parseConfig",
    });
    expect(calls[0].method).toBe("workspace/symbol");
    expect(calls[0].params).toEqual({ query: "parseConfig" });
  });

  it("rejects non-string query and extra properties", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_workspace_symbol").handler({ query: 42 })
    ).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(
      byName(tools, "lsp_workspace_symbol").handler({ extra: true })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

// ── 输出封顶（lsp-optimization plan T3）───────────────────────────────────────
//
// stringifyResult 封顶 MAX_RESULT_BYTES（48KB）：>48KB 输入截断 + footer，
// N 为完整字节数。只截 stringify 后的结果。

describe("stringifyResult cap (plan T3)", () => {
  it("truncates oversized results with a byte-count footer", async () => {
    const big = "x".repeat(MAX_RESULT_BYTES + 10_000);
    const { client } = makeFakeClient(() => ({ blob: big }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    const total = Buffer.byteLength(
      JSON.stringify({ blob: big }, null, 2),
      "utf8"
    );
    // footer 格式：`...[truncated, N of M bytes shown]`，N = 实际展示字节数。
    const match = /\.\.\.\[truncated, (\d+) of (\d+) bytes shown\]$/.exec(out);
    expect(match).not.toBeNull();
    expect(match?.[2]).toBe(String(total));
    // N = 展示正文的精确字节数 = out 总字节 - footer（含换行）字节。
    const footer = `\n...[truncated, ${match?.[1]} of ${match?.[2]} bytes shown]`;
    expect(match?.[1]).toBe(
      String(Buffer.byteLength(out, "utf8") - Buffer.byteLength(footer, "utf8"))
    );
    // 展示正文 ≤ 48KB（cap），footer 有限长 → 总输出封顶在 cap + footer 内。
    expect(Number(match?.[1])).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(
      MAX_RESULT_BYTES + 200
    );
  });

  it("leaves results at or below the cap untouched (no footer)", async () => {
    const { client } = makeFakeClient(() => ({ blob: "y".repeat(1024) }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).not.toContain("truncated");
    expect(JSON.parse(out)).toEqual({ blob: "y".repeat(1024) });
  });
});

// ── lsp_diagnostics 读前等待（lsp-optimization plan T3）───────────────────────
//
// ensureOpen 后 push 诊断尚未到达 → 立即读会误报空。fake 时钟驱动轮询：
//   - 首查即有 → 立即返回（不进 timer）；
//   - 轮询期间到达 → 等到内容；
//   - deadline 到 → 用现有内容（undefined → 空渲染）；
//   - signal aborted → 立即结束等待。

describe("lsp_diagnostics wait for first push (plan T3)", () => {
  function diagItem(message: string) {
    return {
      severity: 1,
      range: { start: { line: 0, character: 0 } },
      message,
    };
  }

  it("returns immediately when diagnostics are already cached (first poll hits)", async () => {
    const { client } = makeFakeClient(() => undefined);
    (client as unknown as { getDiagnostics: () => unknown }).getDiagnostics =
      () => [diagItem("cached err")];
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_diagnostics").handler({
      file: "/work/src/a.ts",
    })) as string;
    expect(out).toContain("cached err");
  });

  it("waits for the diagnostics push to arrive within the deadline", async () => {
    vi.useFakeTimers();
    try {
      const items = [diagItem("late err")];
      let polls = 0;
      const { client } = makeFakeClient(() => undefined);
      (client as unknown as { getDiagnostics: () => unknown }).getDiagnostics =
        () => {
          polls += 1;
          return polls >= 3 ? items : undefined;
        };
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(250); // 2 次 100ms 轮询后第 3 查命中
      const out = await p;
      expect(out).toContain("late err");
      expect(polls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at the deadline and renders empty diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (client as unknown as { getDiagnostics: () => unknown }).getDiagnostics =
        () => undefined;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WAIT_MS + 100);
      const out = await p;
      expect(out).toContain('<diagnostics file="/work/src/a.ts">');
      expect(out).toContain("</diagnostics>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the wait early when execCtx.signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (client as unknown as { getDiagnostics: () => unknown }).getDiagnostics =
        () => undefined;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const ac = new AbortController();
      const p = byName(tools, "lsp_diagnostics").handler(
        { file: "/work/src/a.ts" },
        { signal: ac.signal }
      ) as Promise<string>;
      ac.abort(); // 首查未命中 → 等 abort 提前结束,不等满 deadline
      await vi.advanceTimersByTimeAsync(100);
      const out = await p;
      expect(out).toContain("<diagnostics");
      // 只消费了 abort 前挂起的那次 100ms sleep,远未到 deadline。
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── per-request 超时（lsp-optimization plan T1，工具层实现）──────────────────
//
// timer 到 DEFAULT_LSP_REQUEST_TIMEOUT_MS → CancellationTokenSource.cancel()
// （真实 vscode-jsonrpc token 语义：cancel 时自动向 server 发 $/cancelRequest，
// 不杀进程）→ pending sendRequest reject → 工具转译为 ToolExecutionError。

describe("per-request timeout (plan T1)", () => {
  it("cancels via token at 20s and throws ToolExecutionError with timeout message", async () => {
    const { client } = makeFakeClient(() => undefined);
    // hang 住的 sendRequest：仅在 token 被 cancel 时 reject（模拟
    // vscode-jsonrpc 对被取消 pending request 的 RequestCancelled 拒绝）。
    (client as unknown as { sendRequest: unknown }).sendRequest = (
      _method: string,
      _params: unknown,
      token: { onCancellationRequested(cb: () => void): unknown }
    ) =>
      new Promise((_resolve, reject) => {
        token.onCancellationRequested(() =>
          reject(new Error("Request cancelled"))
        );
      });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);

    vi.useFakeTimers();
    try {
      const p = byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      });
      const expectation = expect(p).rejects.toThrow(
        "[lsp_definition] LSP request textDocument/definition timed out after 20s (cancelled)"
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_LSP_REQUEST_TIMEOUT_MS + 1);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the timeout timer for requests that settle in time", async () => {
    const { client, calls } = makeFakeClient(() => ({ ok: true }));
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(JSON.parse(out)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});
