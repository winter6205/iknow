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

const { mockGetClient, mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClient: vi.fn<() => Promise<unknown>>(),
  mockGetClientDetailed: vi.fn<() => Promise<unknown>>(),
}));

// 动态导入必须在 mock 安装之后（对齐 client.test.ts）。
// 只替换 getClient；signalToCancellationToken 保留真实实现（token 布线测试需要）。
vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
    // 二期 B3：工具层统一走 getClientDetailed（哨兵分层）；默认实现委托
    // mockGetClient（保住既有 toHaveBeenCalledWith 断言），client 缺失时
    // 归一为 no-server failure。
    getClientDetailed: (...args: unknown[]) => mockGetClientDetailed(...args),
  };
});

import {
  createLspToolSet,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  DIAGNOSTICS_WAIT_MS,
  MAX_RESULT_BYTES,
  isLspFailureSentinel,
  isMethodNotFoundSentinel,
  renderMethodNotFound,
} from "../../../src/harness/aci/tools/lsp.ts";
import {
  createSymbolQueryToolSet,
  SYMBOL_QUERY_TOOL_NAMES,
} from "../../../src/harness/aci/tools/symbol.ts";
import {
  createSymbolMutateToolSet,
  SYMBOL_MUTATE_TOOL_NAMES,
} from "../../../src/harness/aci/tools/symbol-mutate.ts";
import { classifyProbeResult } from "../../../scripts/lsp-probe.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";

function makeFakeClient(
  responder: (method: string, params: unknown) => unknown,
  capabilities: Record<string, unknown> = {}
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const opened: string[] = [];
  // 请求级作用域（spec 251 生命周期合同）：fake 记录开/关事件，供
  // 「didOpen 窗口罩住整次请求」断言使用；`opened` 保留为该窗口的进入侧。
  const closed: string[] = [];
  return {
    calls,
    opened,
    closed,
    client: {
      connection: {} as never,
      process: {} as never,
      // spec 251「initialize 能力广告 + 缺方法哨兵」：工具层在发 RPC 前查
      // server capabilities 是否**显式** `provider: false`。默认空对象 =
      // 全部缺席 → 照发（缺席 ≠ 不支持）。
      getServerCapabilities: () => capabilities,
      // #251:handler 层在每次请求前先 ensureOpen(发 didOpen) 建 tsserver
      // project。fake 记录打开的文件,供「先打开再请求」断言使用。
      ensureOpen: async (file: string) => {
        opened.push(file);
      },
      // spec 251：请求级作用域 —— 打开窗口覆盖 fn 全程（含抛错路径）。
      withDocumentOpen: async <T>(
        file: string,
        fn: () => Promise<T>
      ): Promise<T> => {
        opened.push(file);
        try {
          return await fn();
        } finally {
          closed.push(file);
        }
      },
      sendRequest: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return responder(method, params);
      },
      sendNotification: async () => undefined,
      // #251:lsp_diagnostics 读 push 缓存(latest-wins),fake 默认空数组;
      // 需要覆盖时在测试里 `client.getDiagnosticsEntry = () => ({ items })`。
      getDiagnostics: (_uri: string) => [] as ReadonlyArray<unknown>,
      // 二期 B1:诊断 entry（含 pushVersion）+ didChange 版本。默认"首推已到、
      // 未编辑"（openVersion=1）→ 等待逻辑立即返回空 items。
      getDiagnosticsEntry: (_uri: string) =>
        ({ items: [] as ReadonlyArray<unknown> }) as
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined,
      getOpenVersion: (_uri: string) => 1,
      // 符号解析层的缓存键：同步给 server 的文本内容指纹（client.ts
      // LspClient.getDocumentFingerprint）。默认恒定 → 两次解析命中同一快照；
      // 需要模拟盘外改写时由测试覆写本函数。
      getDocumentFingerprint: (_uri: string): string | undefined => "fp-1",
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
const FILE_ONLY_OPS = ["lsp_document_symbol", "lsp_diagnostics"] as const;

// lsp_workspace_symbol 单列（plan T3 后 schema 独立），但仍属 10 件全集。
const ALL_TOOL_NAMES = [
  ...POSITION_OPS,
  ...FILE_ONLY_OPS,
  "lsp_workspace_symbol",
] as const;

beforeEach(() => {
  mockGetClient.mockReset();
  mockGetClientDetailed.mockReset();
  // 默认：detailed 委托 mockGetClient（同参透传），undefined → no-server failure。
  mockGetClientDetailed.mockImplementation(async (...args: unknown[]) => {
    const client = (await mockGetClient(...args)) as unknown;
    return client ? { client } : { failure: { reason: "no-server" as const } };
  });
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

  it("document_symbol requires only file (no position)", () => {
    const tools = createLspToolSet(ctx);
    const schema = byName(tools, "lsp_document_symbol").inputSchema;
    expect(schema.required).toEqual(["file"]);
  });

  it("lsp_diagnostics has no required fields (file / files exclusive, B2)", () => {
    const tools = createLspToolSet(ctx);
    const schema = byName(tools, "lsp_diagnostics").inputSchema;
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      "file",
      "files",
    ]);
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
  it("returns the tiered no-server sentinel when no client is available (B3)", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const tools = createLspToolSet(ctx);
    for (const name of ALL_TOOL_NAMES) {
      const input =
        name === "lsp_diagnostics" ||
        name === "lsp_document_symbol" ||
        name === "lsp_workspace_symbol"
          ? { file: "x.ts" }
          : { file: "x.ts", line: 1, character: 0 };
      const out = (await byName(tools, name).handler(input)) as string;
      expect(out).toMatch(
        /^\(no LSP server configured for x\.ts; supported extensions: /
      );
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
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
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
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
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

  it("rejects file and files together (exactly-one-of, B2)", async () => {
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
        files: ["/work/src/b.ts"],
      })
    ).rejects.toThrow("exactly one of `file` or `files`");
    await expect(byName(tools, "lsp_diagnostics").handler({})).rejects.toThrow(
      "exactly one of `file` or `files`"
    );
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
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
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
      // 能力缺席 → 照发（缺席 ≠ 不支持）。
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(
        _file: string,
        fn: () => Promise<T>
      ): Promise<T> => fn(),
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
      // 能力缺席 → 照发（缺席 ≠ 不支持）。
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(
        _file: string,
        fn: () => Promise<T>
      ): Promise<T> => fn(),
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
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
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
        getDiagnosticsEntry: (uri: string) =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items });
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
    (
      client as unknown as {
        getDiagnosticsEntry: () =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => undefined;
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

  it("didOpen window covers the request (open → request → close)", async () => {
    // spec 251 生命周期合同：handler 不再裸 ensureOpen，而走请求级作用域 —
    // didOpen 窗口必须罩住 sendRequest 全程，退出即 didClose（两次调用之间
    // 文件不对 server 保持打开）。
    const sequence: string[] = [];
    const fakeClient = {
      connection: {} as never,
      process: {} as never,
      // 能力缺席 → 照发（缺席 ≠ 不支持）。
      getServerCapabilities: () => ({}),
      ensureOpen: async (_file: string) => {
        sequence.push("didOpen");
      },
      withDocumentOpen: async <T>(
        _file: string,
        fn: () => Promise<T>
      ): Promise<T> => {
        sequence.push("didOpen");
        try {
          return await fn();
        } finally {
          sequence.push("didClose");
        }
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
    expect(sequence).toEqual(["didOpen", "sendRequest", "didClose"]);
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
      expect.objectContaining({
        server: expect.objectContaining({ id: "typescript" }),
      })
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
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(MAX_RESULT_BYTES + 200);
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
    (
      client as unknown as {
        getDiagnosticsEntry: () =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items: [diagItem("cached err")] });
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
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
        }
      ).getDiagnosticsEntry = () => {
        polls += 1;
        return polls >= 3 ? { items } : undefined;
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
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
        }
      ).getDiagnosticsEntry = () => undefined;
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
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
        }
      ).getDiagnosticsEntry = () => undefined;
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

// ── 二期 B2：批量诊断（files）─────────────────────────────────────────────────
//
// 覆盖：互斥报错（上方 schema describe）/ 封顶 10 / 分组输出（每文件一段
// `<diagnostics file=...>`，段落间空行）/ 无 server 文件降级为哨兵段。

describe("lsp_diagnostics batch files (B2)", () => {
  function diagItem(message: string) {
    return {
      severity: 1,
      range: { start: { line: 0, character: 0 } },
      message,
    };
  }

  it("renders one <diagnostics> segment per file, blank-line separated", async () => {
    const { client } = makeFakeClient(() => undefined);
    (
      client as unknown as {
        getDiagnosticsEntry: () =>
          | {
              readonly items: ReadonlyArray<unknown>;
              readonly pushVersion?: number;
            }
          | undefined;
      }
    ).getDiagnosticsEntry = () => ({ items: [diagItem("batch err")] });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_diagnostics").handler({
      files: ["/work/src/a.ts", "/work/src/b.ts"],
    })) as string;
    expect(out).toContain('<diagnostics file="/work/src/a.ts">');
    expect(out).toContain('<diagnostics file="/work/src/b.ts">');
    expect(out).toContain("batch err");
    // 段落间空行：`</diagnostics>\n\n<diagnostics`。
    expect(out).toContain("</diagnostics>\n\n<diagnostics");
  });

  it("rejects files with more than 10 entries", async () => {
    const tools = createLspToolSet(ctx);
    const files = Array.from({ length: 11 }, (_, i) => `/work/f${i}.ts`);
    await expect(
      byName(tools, "lsp_diagnostics").handler({ files })
    ).rejects.toThrow(/must NOT have more than 10 items|at most 10 entries/);
  });

  it("degrades a no-server file to a sentinel segment and keeps the rest", async () => {
    const fake = makeFakeClient(() => undefined);
    (
      fake.client as unknown as {
        getDiagnosticsEntry: () => unknown;
      }
    ).getDiagnosticsEntry = () => ({ items: [diagItem("ok err")] });
    mockGetClient
      .mockResolvedValueOnce(undefined) // 第一个文件无 server
      .mockResolvedValueOnce(fake.client);
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_diagnostics").handler({
      files: ["/work/none.ts", "/work/src/b.ts"],
    })) as string;
    expect(out).toContain("(no LSP server configured for /work/none.ts;");
    expect(out).toContain('<diagnostics file="/work/src/b.ts">');
    expect(out).toContain("ok err");
  });
});

// ── 二期 B1：编辑后诊断收敛（pushVersion 追平 openVersion）───────────────────

describe("lsp_diagnostics edit-aware wait (B1)", () => {
  function diagItem(message: string) {
    return {
      severity: 1,
      range: { start: { line: 0, character: 0 } },
      message,
    };
  }

  it("waits for pushVersion to catch up with openVersion after an edit", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      let openVersion = 2; // 编辑过（didChange 后）
      let entry:
        | {
            readonly items: ReadonlyArray<unknown>;
            readonly pushVersion?: number;
          }
        | undefined = { items: [diagItem("stale")], pushVersion: 1 };
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
          getOpenVersion: () => number | undefined;
        }
      ).getDiagnosticsEntry = () => entry;
      (
        client as unknown as { getOpenVersion: () => number | undefined }
      ).getOpenVersion = () => openVersion;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      // 轮询进行中：server 基于新内容重推（pushVersion 追平 openVersion）。
      await vi.advanceTimersByTimeAsync(150);
      entry = { items: [diagItem("fresh")], pushVersion: 2 };
      // 再推一轮 timer：让下一次 100ms 轮询读到 fresh entry 后返回。
      await vi.advanceTimersByTimeAsync(100);
      const out = await p;
      expect(out).toContain("fresh");
      expect(out).not.toContain("stale");
      void openVersion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the stale content at the deadline when pushVersion never catches up", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (
        client as unknown as {
          getDiagnosticsEntry: () =>
            | {
                readonly items: ReadonlyArray<unknown>;
                readonly pushVersion?: number;
              }
            | undefined;
          getOpenVersion: () => number | undefined;
        }
      ).getDiagnosticsEntry = () => ({
        items: [diagItem("stale")],
        pushVersion: 1,
      });
      (
        client as unknown as { getOpenVersion: () => number | undefined }
      ).getOpenVersion = () => 2;
      mockGetClient.mockResolvedValue(client);
      const tools = createLspToolSet(ctx);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WAIT_MS + 100);
      const out = await p;
      expect(out).toContain("stale"); // deadline 到 → 用现有内容
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes diagnosticsWaitMs from ctx (B7)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeFakeClient(() => undefined);
      (
        client as unknown as {
          getDiagnosticsEntry: () => undefined;
          getOpenVersion: () => number | undefined;
        }
      ).getDiagnosticsEntry = () => undefined;
      (
        client as unknown as { getOpenVersion: () => number | undefined }
      ).getOpenVersion = () => 2;
      mockGetClient.mockResolvedValue(client);
      const ctxCustom = { ...ctx, diagnosticsWaitMs: 500 };
      const tools = createLspToolSet(ctxCustom);
      const p = byName(tools, "lsp_diagnostics").handler({
        file: "/work/src/a.ts",
      }) as Promise<string>;
      await vi.advanceTimersByTimeAsync(600);
      const out = await p;
      expect(out).toContain('<diagnostics file="/work/src/a.ts">');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 二期 B3：哨兵分层（no-server / no-root / spawn-failed）───────────────────

describe("tiered no-server sentinel (B3)", () => {
  it("no-root failure renders the missing-root-marker message", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-root", serverId: "typescript" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe(
      "(no LSP project root found above /work/src/a.ts within /work; missing root marker for typescript)"
    );
  });

  it("spawn-failed failure renders the installHint from the server declaration", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "spawn-failed", serverId: "pyright" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.py",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe(
      "(LSP server pyright unavailable; hint: npm i -g pyright)"
    );
  });

  it("spawn-failed without installHint omits the hint sentence", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "spawn-failed", serverId: "no-hint-server" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe("(LSP server no-hint-server unavailable)");
  });

  it("disabledServers hit renders no-server with serverId (B7)", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-server", serverId: "typescript" },
    });
    const tools = createLspToolSet(ctx);
    const out = (await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    })) as string;
    expect(out).toBe(
      "(no LSP server configured for /work/src/a.ts; supported extensions: .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts, .py, .pyi, .yaml, .yml, .json, .dockerfile, Dockerfile)"
    );
  });
});

// ── 二期 B7：requestTimeoutMs 从 ctx 消费─────────────────────────────────────

describe("ctx.requestTimeoutMs consumption (B7)", () => {
  it("times out at the ctx-configured deadline instead of the 20s default", async () => {
    const { client } = makeFakeClient(() => undefined);
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
    const ctxCustom = { ...ctx, requestTimeoutMs: 1_000 };
    const tools = createLspToolSet(ctxCustom);

    vi.useFakeTimers();
    try {
      const p = byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      });
      const expectation = expect(p).rejects.toThrow(
        "[lsp_definition] LSP request textDocument/definition timed out after 1s (cancelled)"
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isLspFailureSentinel (probe FAIL detection, B3 closeout)", () => {
  it("treats no-server / no-root / spawn-failed strings as failure sentinels", () => {
    expect(
      isLspFailureSentinel(
        "(no LSP server configured for /work/a.ts; supported extensions: .ts)"
      )
    ).toBe(true);
    expect(
      isLspFailureSentinel(
        "(no LSP project root found above /work/a.ts within /work; missing root marker for typescript)"
      )
    ).toBe(true);
    expect(
      isLspFailureSentinel(
        "(LSP server pyright unavailable; hint: npm i -g pyright)"
      )
    ).toBe(true);
    expect(
      isLspFailureSentinel("(LSP server no-hint-server unavailable)")
    ).toBe(true);
  });

  it("does not treat a successful hover or empty diagnostics payload as a sentinel", () => {
    expect(isLspFailureSentinel('{"contents":"ok"}')).toBe(false);
    expect(
      isLspFailureSentinel('<diagnostics file="a.ts">\n</diagnostics>')
    ).toBe(false);
    expect(isLspFailureSentinel("")).toBe(false);
    expect(isLspFailureSentinel(undefined)).toBe(false);
  });

  it("does not treat the method-not-found sentinel as a failure (capability gap ≠ call failure)", () => {
    // spec 251：-32601 是 server 能力缺口（该 method 没有实现），不是调用
    // 失败、更不是 spawn 失败 —— probe 据此 skip，故不得计入 FAIL。
    const sentinel = renderMethodNotFound("textDocument/references", "yaml");
    expect(isMethodNotFoundSentinel(sentinel)).toBe(true);
    expect(isLspFailureSentinel(sentinel)).toBe(false);
  });
});

describe("method-not-found sentinel (-32601 capability gap)", () => {
  it("renders method + serverId and stays a plain string (contract Y1)", () => {
    const out = renderMethodNotFound(
      "workspace/symbol",
      "json-language-server"
    );
    expect(typeof out).toBe("string");
    expect(out).toContain("json-language-server");
    expect(out).toContain("workspace/symbol");
    expect(isMethodNotFoundSentinel(out)).toBe(true);
  });

  it("omits the server id when unknown", () => {
    expect(
      isMethodNotFoundSentinel(renderMethodNotFound("workspace/symbol"))
    ).toBe(true);
  });

  it("does not match a successful payload or another sentinel family", () => {
    expect(isMethodNotFoundSentinel("[]")).toBe(false);
    expect(
      isMethodNotFoundSentinel("(LSP server pyright unavailable; hint: x)")
    ).toBe(false);
    expect(isMethodNotFoundSentinel(undefined)).toBe(false);
  });

  it("position tool returns the sentinel instead of throwing when the server lacks the method", async () => {
    // -32601 → 哨兵（不算 spawn 失败）；不是 ToolExecutionError。
    const err = Object.assign(
      new Error("Unhandled method textDocument/definition"),
      {
        code: -32601,
      }
    );
    const { client, calls } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_definition").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(typeof out).toBe("string");
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(isLspFailureSentinel(out)).toBe(false);
    expect(calls[0].method).toBe("textDocument/definition");
  });

  it("call-hierarchy tool does not forward after a prepareCallHierarchy capability gap", async () => {
    const err = Object.assign(
      new Error("Unhandled method textDocument/prepareCallHierarchy"),
      { code: -32601 }
    );
    const { client, calls } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_outgoing_calls").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    // prepare 就缺能力 → 不该再发第二个请求（缺席 ≠ 不支持，但显式缺口就此收手）。
    expect(calls.map((c) => c.method)).toEqual([
      "textDocument/prepareCallHierarchy",
    ]);
  });

  it("other RPC errors still propagate (capability gap detection is narrow)", async () => {
    // -32602（参数错）等**参数层**错误不是能力缺口：必须照旧抛，不得被哨兵吞。
    const err = Object.assign(new Error("invalid params"), { code: -32602 });
    const { client } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await expect(
      byName(tools, "lsp_definition").handler({
        file: "/work/src/a.ts",
        line: 1,
        character: 0,
      })
    ).rejects.toThrow("invalid params");
  });
});

// ── initialize 能力声明闸门（spec 251 § initialize 能力广告）─────────────────
//
// 契约（S18 / plan T4）：server 在 initialize 结果里**显式**声明 provider
// `false` → 确定没有该能力，不发 RPC，直接返回缺方法哨兵；声明**缺席**
// （undefined）或 `true` → 照发 —— typescript-language-server 实测不声明
// `callHierarchyProvider` 却实现了 call hierarchy，把缺席当不支持会误伤
// TS 的 call hierarchy（probe 10/10 保底面）。
//
// 「发没发 RPC」用 calls 长度断言（fake 记录每次 sendRequest）。

describe("initialize capability gate (explicit false → no RPC)", () => {
  it("returns the sentinel without sending RPC when the provider is explicitly false", async () => {
    const { client, calls } = makeFakeClient(
      () => {
        throw new Error(
          "RPC must not be sent for an explicitly false provider"
        );
      },
      { referencesProvider: false }
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_references").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    // 显式 false → 连 RPC 都不发（不是发了等 -32601）。
    expect(calls).toHaveLength(0);
  });

  it("still sends RPC when the provider key is absent (absence ≠ unsupported)", async () => {
    // TS call hierarchy 的回归保护：typescript-language-server 不声明
    // callHierarchyProvider 却实现了 call hierarchy。
    const { client, calls } = makeFakeClient(
      () => [{ name: "foo" }],
      {} // 能力全缺席
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_prepare_call_hierarchy").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "textDocument/prepareCallHierarchy",
    ]);
    expect(out).toContain("foo");
  });

  it("still sends RPC when the provider is explicitly true", async () => {
    const { client, calls } = makeFakeClient(() => [], {
      referencesProvider: true,
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    await byName(tools, "lsp_references").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(calls.map((c) => c.method)).toEqual(["textDocument/references"]);
  });

  it("call-hierarchy tool short-circuits prepare on an explicit false provider", async () => {
    const { client, calls } = makeFakeClient(
      () => {
        throw new Error(
          "RPC must not be sent for an explicitly false provider"
        );
      },
      { callHierarchyProvider: false }
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createLspToolSet(ctx);
    const out = await byName(tools, "lsp_incoming_calls").handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    // prepare 被闸门挡下 → 后段 incomingCalls 更不会发。
    expect(calls).toHaveLength(0);
  });
});

// ── probe 判定（scripts/lsp-probe.ts）对哨兵 = skip ─────────────────────────
//
// spec 251「initialize 能力广告 + 缺方法哨兵」：工具层把 -32601 / 显式 false
// 转成哨兵**返回**后，probe 的 safeCall 看到的是 ok + 哨兵（不再是 error
// detail）。probe 的判定核心 classifyProbeResult 必须把这条路径与逃逸的
// MethodNotFound RPC error 合流成同一 skip 语义 —— 否则哨兵被当普通非空
// 字符串误报 ✓（#265 类假阳性），能力缺口就不再被承认。

describe("probe verdict: method-not-found sentinel skips like a MethodNotFound error", () => {
  it("treats the tool-level sentinel result as a skip (not a pass, not a failure)", () => {
    const verdict = classifyProbeResult({
      kind: "ok",
      value: renderMethodNotFound("textDocument/references", "yaml"),
    });
    expect(verdict.kind).toBe("skip");
  });

  it("treats a MethodNotFound RPC error as a skip (both paths converge)", () => {
    const err = Object.assign(
      new Error("Unhandled method textDocument/references"),
      { code: -32601 }
    );
    expect(
      classifyProbeResult({ kind: "err", detail: err.message, error: err }).kind
    ).toBe("skip");
  });

  it("treats a non-Error 'Unhandled method' detail as a skip (code may be absent)", () => {
    expect(
      classifyProbeResult({
        kind: "err",
        detail: "Unhandled method workspace/symbol",
        error: "Unhandled method workspace/symbol",
      }).kind
    ).toBe("skip");
  });

  it("still fails other RPC errors (capability detection stays narrow)", () => {
    const err = Object.assign(new Error("invalid params"), { code: -32602 });
    const verdict = classifyProbeResult({
      kind: "err",
      detail: err.message,
      error: err,
    });
    expect(verdict.kind).toBe("fail");
    if (verdict.kind === "fail")
      expect(verdict.detail).toContain("invalid params");
  });

  it("passes a plain non-empty result and fails the empty / no-server ones", () => {
    expect(
      classifyProbeResult({ kind: "ok", value: '[{"uri":"a.ts"}]' }).kind
    ).toBe("pass");
    expect(classifyProbeResult({ kind: "ok", value: "" }).kind).toBe("fail");
    // 分层失败哨兵（B3）：no-server / no-root / spawn-failed 三条文案都必须
    // 判 FAIL，否则 no-server 文件被当成有结果。
    for (const value of [
      "(no LSP server configured for /work/a.yml; supported extensions: .ts, .yml)",
      "(no LSP project root found above /work/a.ts within /work; missing root marker for typescript)",
      "(LSP server pyright unavailable; hint: npm i -g pyright)",
    ]) {
      expect(classifyProbeResult({ kind: "ok", value }).kind).toBe("fail");
    }
  });

  it("fails non-string results (contract Y1 would be broken)", () => {
    expect(classifyProbeResult({ kind: "ok", value: 42 }).kind).toBe("fail");
    expect(classifyProbeResult({ kind: "ok", value: undefined }).kind).toBe(
      "fail"
    );
  });
});

// ── 符号族走同一道门控入口（spec 251 § initialize 能力广告 + 缺方法哨兵）─────
//
// 背景（review M1）：符号解析层（symbol-resolver.ts）曾直连
// `client.sendRequest("textDocument/documentSymbol")`，绕过 lsp.ts 的能力
// 闸门与 -32601 哨兵 —— server 显式声明 `documentSymbolProvider: false` 时
// 照发 RPC，回 -32601 则抛错被 executor 记 `execution_failed`，而 spec 251
// 要求两条路径都收敛到同一哨兵、**不算** spawn 失败。documentSymbol 是
// 所有 symbol-* 工具（含 symbol-mutate）的入口，故影响面是整个符号族。
//
// 下面每条都以「符号工具 handler 的真实输出」为断言面（而非 resolver 内部
// 函数），锁的是契约：显式 false 零 RPC + 哨兵串；-32601 → 哨兵串不抛；
// 其余 RPC 错误仍上抛（门控是窄的）。

/** symbol 工具的统一调用面：handler 入参 `{ file, symbol_path }`。 */
const SYMBOL_INPUT = { file: "/work/src/a.ts", symbol_path: "Foo/bar" };

function createSymbolQueryToolSetForTest(): ReadonlyArray<AciToolDef> {
  return createSymbolQueryToolSet(ctx);
}

function createSymbolMutateToolSetForTest(): ReadonlyArray<AciToolDef> {
  return createSymbolMutateToolSet({ ctx });
}

/** 改工具各有特化必填字段；本组测试只关心「是否发 RPC / 是否返哨兵」。 */
function mutateInput(name: string): Record<string, unknown> {
  switch (name) {
    case "rename_symbol":
      return { ...SYMBOL_INPUT, new_name: "baz" };
    case "replace_symbol_body":
      return { ...SYMBOL_INPUT, new_body: "function bar() {}" };
    case "insert_before_symbol":
    case "insert_after_symbol":
      return { ...SYMBOL_INPUT, code: "// note" };
    default:
      return SYMBOL_INPUT;
  }
}

/**
 * 走 `resolveSymbolPosition`（= 经 resolver 发 documentSymbol 解析符号树）的
 * 符号工具 —— M1 的失守面正在这条链路上。
 */
const SYMBOL_RESOLVER_TOOL_NAMES = [
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_hover",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
] as const;

/** 不走 resolver 的三个符号查询工具，排除理由必须逐条可查（不能整体略过）。 */
const SYMBOL_NON_RESOLVER_TOOL_NAMES = [
  { name: "find_symbol", why: "workspace/symbol 直接提问，不解析符号身份" },
  {
    name: "get_symbols_overview",
    why: "自己经门控入口发 documentSymbol（下方单列其闸门断言）",
  },
  {
    name: "get_diagnostics_for_file",
    why: "按文件读诊断，与符号身份无关",
  },
] as const;

const SAMPLE_SYMBOL_TREE = [
  {
    name: "Foo",
    kind: 5,
    range: { start: { line: 0, character: 0 } },
    selectionRange: { start: { line: 0, character: 6 } },
    children: [
      {
        name: "bar",
        kind: 6,
        range: { start: { line: 2, character: 2 } },
        selectionRange: { start: { line: 2, character: 8 } },
      },
    ],
  },
];

/** resolver 与 get_symbols_overview 都只认这一条 method 作为符号树来源。 */
const DOCUMENT_SYMBOL = "textDocument/documentSymbol";

function methodNotFoundError(method: string): Error {
  return Object.assign(new Error(`Unhandled method ${method}`), {
    code: -32601,
  });
}

/**
 * 符号树响应 + 一次业务请求响应的复合 responder。
 * 业务 method 一律回空数组（工具只要走通即可，断言点在哨兵/RPC 面上）。
 */
function symbolResponder(
  tree: unknown = SAMPLE_SYMBOL_TREE
): (method: string, params: unknown) => unknown {
  return (method: string) => (method === DOCUMENT_SYMBOL ? tree : []);
}

describe("symbol tools share the initialize capability gate (explicit false → no RPC)", () => {
  it("classifies every symbol query tool as resolver or non-resolver (no silent gaps)", () => {
    // SSOT：新符号工具若既不进 resolver 组也不进排除组，本断言先红 —— 否则
    // 新增工具会悄悄漏出「能力闸门」覆盖，正是 M1 的失守形态。
    const classified = [
      ...SYMBOL_RESOLVER_TOOL_NAMES,
      ...SYMBOL_NON_RESOLVER_TOOL_NAMES.map((e) => e.name),
    ];
    expect([...classified].sort()).toEqual([...SYMBOL_QUERY_TOOL_NAMES].sort());
  });

  it("every symbol query tool returns the sentinel without sending documentSymbol RPC", async () => {
    for (const name of SYMBOL_RESOLVER_TOOL_NAMES) {
      const { client, calls } = makeFakeClient(
        () => {
          throw new Error(
            "RPC must not be sent for an explicitly false documentSymbolProvider"
          );
        },
        { documentSymbolProvider: false }
      );
      mockGetClient.mockResolvedValue(client);
      const tools = createSymbolQueryToolSetForTest();
      const out = (await byName(tools, name).handler(SYMBOL_INPUT)) as string;
      expect(isMethodNotFoundSentinel(out), `${name} sentinel`).toBe(true);
      expect(calls, `${name} RPC count`).toHaveLength(0);
    }
  });

  it("every symbol mutate tool returns the sentinel without sending documentSymbol RPC", async () => {
    for (const name of SYMBOL_MUTATE_TOOL_NAMES) {
      const { client, calls } = makeFakeClient(
        () => {
          throw new Error(
            "RPC must not be sent for an explicitly false documentSymbolProvider"
          );
        },
        { documentSymbolProvider: false }
      );
      mockGetClient.mockResolvedValue(client);
      const tools = createSymbolMutateToolSetForTest();
      const out = (await byName(tools, name).handler(
        mutateInput(name)
      )) as string;
      expect(isMethodNotFoundSentinel(out), `${name} sentinel`).toBe(true);
      expect(calls, `${name} RPC count`).toHaveLength(0);
    }
  });

  it("get_symbols_overview returns the sentinel without sending documentSymbol RPC", async () => {
    const { client, calls } = makeFakeClient(
      () => {
        throw new Error(
          "RPC must not be sent for an explicitly false documentSymbolProvider"
        );
      },
      { documentSymbolProvider: false }
    );
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "get_symbols_overview").handler({
      file: "/work/src/a.ts",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("still sends the RPC when documentSymbolProvider is absent (absence ≠ unsupported)", async () => {
    // TS 实测不声明部分 provider 却实现了对应能力：缺席必须照发。
    const { client, calls } = makeFakeClient(symbolResponder(), {});
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_declaration").handler(
      SYMBOL_INPUT
    )) as string;
    expect(calls.map((c) => c.method)).toEqual([
      DOCUMENT_SYMBOL,
      "textDocument/definition",
    ]);
    expect(isMethodNotFoundSentinel(out)).toBe(false);
  });
});

describe("symbol tools convert -32601 into the sentinel (no ToolExecutionError)", () => {
  it("find_declaration returns the sentinel when documentSymbol is unimplemented", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_declaration").handler(
      SYMBOL_INPUT
    )) as string;
    expect(typeof out).toBe("string");
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(isLspFailureSentinel(out)).toBe(false);
    expect(out).toContain(DOCUMENT_SYMBOL);
    // 解析就缺能力 → 业务请求不再发（fail-fast，不再撞第二个缺口）。
    expect(calls.map((c) => c.method)).toEqual([DOCUMENT_SYMBOL]);
  });

  it("get_symbols_overview returns the sentinel when documentSymbol is unimplemented", async () => {
    const { client } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "get_symbols_overview").handler({
      file: "/work/src/a.ts",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
  });

  it("rename_symbol returns the sentinel instead of throwing", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSetForTest();
    const out = (await byName(tools, "rename_symbol").handler({
      ...SYMBOL_INPUT,
      new_name: "baz",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([DOCUMENT_SYMBOL]);
  });

  it("safe_delete_symbol does not enter the delete path on a capability gap", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw methodNotFoundError(DOCUMENT_SYMBOL);
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSetForTest();
    const out = (await byName(tools, "safe_delete_symbol").handler(
      SYMBOL_INPUT
    )) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([DOCUMENT_SYMBOL]);
  });

  it("keeps other RPC errors propagating (gate is narrow)", async () => {
    // -32602（参数错）不是能力缺口：不得被哨兵吞成"成功"。
    const err = Object.assign(new Error("invalid params"), { code: -32602 });
    const { client } = makeFakeClient(() => {
      throw err;
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_declaration").handler(SYMBOL_INPUT)
    ).rejects.toThrow("invalid params");
  });

  it("keeps transport errors propagating on the uncached path", async () => {
    const { client } = makeFakeClient(() => {
      throw new Error("initialize handshake failed");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_declaration").handler({
        file: "/work/src/transport.ts",
        symbol_path: "Foo/bar",
      })
    ).rejects.toThrow("initialize handshake failed");
  });
});

// ── 符号树快照缓存键 = 内容指纹（review L5）──────────────────────────────────
//
// fetchDocumentSymbols 的缓存键从 getOpenVersion 改为
// getDocumentFingerprint（请求级打开下 version 每次从 1 起重来，无法区分
// 「同一文件的两次打开」）。下面两条锁住语义：内容变 → 重取；内容不变 →
// 同一个 client 上只发一次 documentSymbol。

describe("symbol snapshot cache keyed by document fingerprint", () => {
  it("re-fetches documentSymbol when the content fingerprint changes", async () => {
    const { client, calls } = makeFakeClient(symbolResponder());
    let fingerprint = "fp-1";
    (
      client as unknown as {
        getDocumentFingerprint: (uri: string) => string | undefined;
      }
    ).getDocumentFingerprint = () => fingerprint;
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();

    await byName(tools, "find_declaration").handler(SYMBOL_INPUT);
    expect(calls.filter((c) => c.method === DOCUMENT_SYMBOL)).toHaveLength(1);

    // 盘外改写：解析窗口外文件内容变了 → 指纹变 → 必须重取符号树。
    fingerprint = "fp-2";
    await byName(tools, "find_declaration").handler(SYMBOL_INPUT);
    expect(calls.filter((c) => c.method === DOCUMENT_SYMBOL)).toHaveLength(2);
  });

  it("serves the cached snapshot without a second RPC when the fingerprint is unchanged", async () => {
    const { client, calls } = makeFakeClient(symbolResponder());
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();

    await byName(tools, "find_declaration").handler(SYMBOL_INPUT);
    await byName(tools, "get_hover").handler(SYMBOL_INPUT);

    // 两次解析、同一份文本 → documentSymbol 只发一次；业务请求各发一次。
    expect(calls.filter((c) => c.method === DOCUMENT_SYMBOL)).toHaveLength(1);
    expect(calls.map((c) => c.method)).toEqual([
      DOCUMENT_SYMBOL,
      "textDocument/definition",
      "textDocument/hover",
    ]);
  });
});

// ── find_symbol 无 `file`：无 project 锚点返分层哨兵（plan T3）─────────────────
//
// 根因（实测，docs/guides/lsp-client-analysis.md §8）：`workspace/symbol` 的搜索
// 集合由 server 当前 project graph 决定，graph 又由它最后触碰的那个文件决定
// ——锚点落在 tsconfig `include` 外时 tsserver 只建 inferred project（该文件 +
// import closure）。无 `file` 的调用方拿不到锚点（生产形状实测 40s 全程 `[]`，
// 同查询带 `file` 锚点 ~7s 出 4 命中），于是 `[]` 同时表示「真没这个符号」与
// 「查询链路没有 project 上下文」——正是本 plan 要杀的那一类静默退化。
//
// 契约：`[]` 只表示「查到了、真没这个符号」；无锚点的可观测形态
// （tsserver 抛 `No Project.` / 无 project 上下文下返空数组）收敛到同一条哨兵。
// 哨兵**不**进 `isLspFailureSentinel` 三前缀家族（§8.7 决定）：那三条的语义是
// 「这次调用没打成」，本条调用打成了（RPC 有响应），把它记成 probe FAIL 是
// 错误分类，且 probe 从不进这条分岔（§7.1）。消费者是模型，它需要的是
// 「结论不可信，换条路」，不是「LSP 坏了」。

/** §8.7 定稿文案 1 —— 无 project 锚点（`ctx.directory` 按家族惯例插值）。 */
const NO_ANCHOR_SENTINEL =
  "(LSP workspace/symbol has no project anchor under /work; an empty result from this path is not trustworthy — pass file=<a file inside the project to search> or use get_symbols_overview on a known file)";

/** tsserver 的 `No Project.` 抛出形态（typescript.js ThrowNoProject，实测）。 */
function noProjectError(): Error {
  return Object.assign(
    new Error(
      "<syntax> TypeScript Server Error (5.9.3)\nNo Project.\nError: No Project.\n    at Object.ThrowNoProject (typescript.js:186170:11)"
    ),
    { code: 1 }
  );
}

describe("find_symbol without `file`: no project anchor returns the layered sentinel (T3)", () => {
  it("converts the tsserver `No Project.` throw into the sentinel instead of propagating", async () => {
    const { client, calls } = makeFakeClient(() => {
      throw noProjectError();
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    })) as string;

    expect(out).toBe(NO_ANCHOR_SENTINEL);
    expect(calls.map((c) => c.method)).toEqual(["workspace/symbol"]);
  });

  it("converts an empty no-anchor result into the sentinel (`[]` no longer means two things)", async () => {
    const { client } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    });
    expect(out).toBe(NO_ANCHOR_SENTINEL);
  });

  it("classifies the sentinel as neither failure nor method-not-found (probe verdict = pass)", async () => {
    // §8.7 决定：家族不加第四条前缀分支。三条失败前缀的语义是「调用没打成」，
    // 本条调用打成了 —— 记 FAIL 是错误分类；probe 也从不进这条分岔（§7.1）。
    const { client } = makeFakeClient(() => {
      throw noProjectError();
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    })) as string;

    expect(isLspFailureSentinel(out)).toBe(false);
    expect(isMethodNotFoundSentinel(out)).toBe(false);
    expect(classifyProbeResult({ kind: "ok", value: out }).kind).toBe("pass");
  });

  it("keeps a non-empty no-anchor result as data (coverage caveat lives in the description, not the result)", async () => {
    const hits = [{ name: "createAciRegistry", kind: 12 }];
    const { client } = makeFakeClient(() => hits);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "createAciRegistry",
    });
    expect(out).toBe(JSON.stringify(hits, null, 2));
    expect(isLspFailureSentinel(out)).toBe(false);
  });

  it("names the coverage caveat in the tool description (the always-on model-visible surface)", () => {
    const tools = createSymbolQueryToolSetForTest();
    const desc = byName(tools, "find_symbol").description;
    // description 是模型可见装配面（黄金集名册 tool description 行）：无 `file`
    // 的搜索只覆盖 server 已加载的 project，`file` 才是锚点 —— 该警示常驻
    // description（在选择工具之前就送达），否则模型会把部分结果当全量结果。
    expect(desc).toContain("without `file`");
    expect(desc).toContain(
      "only covers the project the server has already loaded"
    );
    expect(desc).toContain("pass `file` to anchor the search");
  });
});

// ── find_symbol 无 `file`：锚点有效时 `[]` 仍是「真没这个符号」（plan T3）──────
//
// 本组是上组的对照面：哨兵不得吞掉健康路径。`[]` 的新契约 = searched-and-absent；
// 带 `file` 的路径（含 `file` 在场时的 `[]`）逐字节不变。

describe("find_symbol: `[]` means searched-and-absent once an anchor is in play (T3)", () => {
  it("keeps the empty array when `file` is present and the symbol is genuinely absent", async () => {
    const { client, calls, opened } = makeFakeClient(() => []);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "zzzNoSuchSymbolZzz",
      file: "/work/src/a.ts",
    });
    expect(out).toBe("[]");
    expect(calls[0].method).toBe("workspace/symbol");
    // file 在场 → 请求级打开窗口罩住整次请求（行为不变）。
    expect(opened).toEqual(["/work/src/a.ts"]);
  });

  it("keeps non-empty `file`-anchored results byte-identical", async () => {
    const hits = [{ name: "Foo", kind: 5, location: { uri: "file:///a.ts" } }];
    const { client } = makeFakeClient(() => hits);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = await byName(tools, "find_symbol").handler({
      query: "Foo",
      file: "/work/src/a.ts",
    });
    expect(out).toBe(JSON.stringify(hits, null, 2));
  });

  it("still surfaces method-not-found when the workspace dispatch lands on a server without workspace/symbol", async () => {
    // 缺方法不是无锚点：server 明确说「我不实现」时透传缺方法哨兵
    // （能力缺口是 server 的固有特性，模型据此改用别的工具）。
    const { client } = makeFakeClient(() => {
      throw methodNotFoundError("workspace/symbol");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "anything",
    })) as string;
    expect(isMethodNotFoundSentinel(out)).toBe(true);
  });

  it("keeps the no-server sentinel when the workspace dispatch finds no client", async () => {
    // 无 server ≠ 无锚点：一条都探不到时仍是失败哨兵（probe 记 FAIL），
    // 不得被降级成「结论不可信」的软提示。
    mockGetClient.mockResolvedValue(undefined);
    const tools = createSymbolQueryToolSetForTest();
    const out = (await byName(tools, "find_symbol").handler({
      query: "Foo",
    })) as string;
    expect(out.startsWith("(no LSP server configured")).toBe(true);
    expect(isLspFailureSentinel(out)).toBe(true);
  });

  it("still propagates unrelated RPC errors (the no-anchor rescue is narrow)", async () => {
    const { client } = makeFakeClient(() => {
      throw Object.assign(new Error("invalid params"), { code: -32602 });
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_symbol").handler({ query: "Foo" })
    ).rejects.toThrow("invalid params");
  });

  it("escalates a deadline hit to the timeout error instead of rescuing it", async () => {
    const { client } = makeFakeClient(() => undefined);
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
    const ctxCustom = { ...ctx, requestTimeoutMs: 1_000 };
    const tools = createSymbolQueryToolSet(ctxCustom);

    vi.useFakeTimers();
    try {
      const p = byName(tools, "find_symbol").handler({ query: "Foo" });
      const expectation = expect(p).rejects.toThrow(
        "[find_symbol] LSP request workspace/symbol timed out after 1s (cancelled)"
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not swallow a cancellation-flavoured error when no deadline fired", async () => {
    // 无超时 → RequestCancelled（executor abort 等）照旧上抛，不被救成哨兵。
    const { client } = makeFakeClient(() => {
      throw new Error("Request cancelled");
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSetForTest();
    await expect(
      byName(tools, "find_symbol").handler({ query: "Foo" })
    ).rejects.toThrow("Request cancelled");
  });
});
