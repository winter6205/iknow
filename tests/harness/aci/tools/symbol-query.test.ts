/**
 * 符号查询 ACI 工具集单测 — spec `symbol-primary-aci` T2。
 *
 * 与 `tests/harness/aci/lsp.test.ts` 同形（模块级 `vi.mock` + `vi.hoisted`
 * 捕获），但断言 **符号身份入参 + 文件路径** 的契约：模型只给
 * `{ file, symbol_path }`，行列译码封在 `symbol-resolver.ts` 内部。
 *
 * 覆盖矩阵（spec SC3 + SC6）：
 *   - **shape**：10 件工具全部入注册表 + ACI 元数据（read-only / cancel /
 *     default tier / non-concurrent）。
 *   - **schema**：symbol tools 拒 `line`/`character`（additionalProperties:false）；
 *     `find_symbol` 必填 query 且非空；`get_symbols_overview` 仅 file；
 *     `get_diagnostics_for_file` file/files 互斥。
 *   - **SC3（spec §77）**：符号身份 + 文件路径 → 命中或显式 no-server
 *     失败字符串（**不允许** 因缺行列而抛）。
 *   - **SC6（spec §80）五边界**：
 *       - empty → ajv 拒缺参 / 空 string
 *       - illegal path-or-identity → not_found / ambiguous 渲染（含候选提示）
 *       - oversized → stringifyResult 触发 MAX_RESULT_BYTES 截断
 *       - concurrency-inflight → 同一 uri 并发 resolveSymbolPosition 共享一次 documentSymbol
 *       - language server absent / throwing → renderNoServer / 原样抛
 *   - **operation params mapping**：find_declaration 用 0-based position；
 *     find_referencing_symbols 加 includeDeclaration；call hierarchy 两步。
 *
 * 不验证：documentSymbol 树走 `symbol-resolver.ts` 自身，单元测试在
 * `tests/harness/aci/tools/symbol-resolver.test.ts`。本文件只验证工具层
 * 把身份 → 位置 → LSP 请求 → 字符串 的链路。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.js";
import { MAX_RESULT_BYTES } from "../../../../src/harness/aci/tools/lsp.js";

const { mockGetClient, mockGetClientDetailed, mockGetClientForWorkspace } =
  vi.hoisted(() => ({
    mockGetClient: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    mockGetClientDetailed: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    mockGetClientForWorkspace:
      vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  }));

vi.mock("../../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/harness/lsp/client.js")
    >();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
    getClientDetailed: (...args: unknown[]) => mockGetClientDetailed(...args),
  };
});

// 走 importOriginal 不替换的工具：stringifyResult / renderNoServer / compileValidator /
// createRequestCancellation / DEFAULT_LSP_REQUEST_TIMEOUT_MS / LSP_ACI_META 全部为真。
// 但 `getClientForWorkspaceDetailed` 在 lsp.ts 内部导出 — 需在同一模块 mock 下被替换。
vi.mock("../../../../src/harness/aci/tools/lsp.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/harness/aci/tools/lsp.js")
    >();
  return {
    ...actual,
    getClientForWorkspaceDetailed: (...args: unknown[]) =>
      mockGetClientForWorkspace(...args),
  };
});

import {
  createSymbolQueryToolSet,
  SYMBOL_QUERY_TOOL_NAMES,
} from "../../../../src/harness/aci/tools/symbol.js";
import type { AciToolDef } from "../../../../src/harness/aci/types.js";
import type { LspClient } from "../../../../src/harness/lsp/client.js";

const ctx = { directory: "/work" };

function byName(tools: ReadonlyArray<AciToolDef>, name: string): AciToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

/** 造假 client：documentSymbol 返声明树，业务请求由 responder 决定。 */
function makeFakeClient(opts: {
  documentSymbol?: unknown[];
  responder?: (method: string, params: unknown) => unknown;
  openVersion?: number;
}): {
  client: LspClient;
  calls: Array<{ method: string; params: unknown }>;
  opened: string[];
} {
  const symTree = opts.documentSymbol ?? [];
  const responder =
    opts.responder ??
    ((method) => (method === "textDocument/documentSymbol" ? symTree : []));
  const opened: string[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: LspClient = {
    connection: {} as never,
    process: {} as never,
    sendRequest: async (method, params) => {
      calls.push({ method, params });
      return responder(method, params);
    },
    sendNotification: async () => undefined,
    ensureOpen: async (file: string) => {
      opened.push(file);
    },
    notifyChange: async () => undefined,
    getDiagnostics: () => undefined,
    getDiagnosticsEntry: () => undefined,
    getOpenVersion: () => opts.openVersion ?? 1,
    dispose: () => undefined,
  };
  return { client, calls, opened };
}

beforeEach(() => {
  mockGetClient.mockReset();
  mockGetClientDetailed.mockReset();
  mockGetClientForWorkspace.mockReset();
  mockGetClientDetailed.mockImplementation(async (..._args: unknown[]) => {
    const client = (await mockGetClient(..._args)) as unknown;
    return client ? { client } : { failure: { reason: "no-server" as const } };
  });
});

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

describe("createSymbolQueryToolSet — shape", () => {
  it("exports 10 tools in SYMBOL_QUERY_TOOL_NAMES order", () => {
    const tools = createSymbolQueryToolSet(ctx);
    expect(tools).toHaveLength(10);
    expect(tools.map((t) => t.name)).toEqual([...SYMBOL_QUERY_TOOL_NAMES]);
  });

  it("every tool def is frozen", () => {
    for (const tool of createSymbolQueryToolSet(ctx)) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });

  it("sets aci metadata (read-only / non-concurrent / cancel / default tier)", () => {
    for (const tool of createSymbolQueryToolSet(ctx)) {
      expect(tool.aci.category).toBe("read-only");
      expect(tool.aci.isConcurrencySafe).toBe(false);
      expect(tool.aci.interruptBehavior).toBe("cancel");
      expect(tool.aci.timeoutTier).toBe("default");
    }
  });

  it("every tool description mentions symbol identity (no coordinate phrasing)", () => {
    for (const tool of createSymbolQueryToolSet(ctx)) {
      // 唯一例外：get_diagnostics_for_file 是文件级工具，spec 列表里它
      // 就是文件级（不要求 symbol 措辞）。
      if (tool.name === "get_diagnostics_for_file") continue;
      expect(
        /symbol|symbol_path/i.test(tool.description),
        `${tool.name} description missing identity phrasing`
      ).toBe(true);
      expect(
        /\bline\b|\bcharacter\b|0-based|1-based/i.test(tool.description),
        `${tool.name} description has coordinate phrasing`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// schema (additionalProperties: false ⇒ no line/character sneaking in)
// ---------------------------------------------------------------------------

describe("inputSchema", () => {
  it("symbol tools require file + symbol_path only (no line/character)", () => {
    const tools = createSymbolQueryToolSet(ctx);
    const symbolTools = SYMBOL_QUERY_TOOL_NAMES.filter(
      (n) =>
        n !== "find_symbol" &&
        n !== "get_symbols_overview" &&
        n !== "get_diagnostics_for_file"
    );
    for (const name of symbolTools) {
      const schema = byName(tools, name).inputSchema as {
        required: string[];
        properties: Record<string, unknown>;
      };
      expect(schema.required).toEqual(["file", "symbol_path"]);
      expect(schema.properties).not.toHaveProperty("line");
      expect(schema.properties).not.toHaveProperty("character");
      expect(schema.properties).not.toHaveProperty("query");
    }
  });

  it("find_symbol requires query (no empty query)", () => {
    const tools = createSymbolQueryToolSet(ctx);
    const schema = byName(tools, "find_symbol").inputSchema as {
      required: string[];
      properties: Record<{ minLength?: number }, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.file).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("get_symbols_overview requires only file", () => {
    const tools = createSymbolQueryToolSet(ctx);
    const schema = byName(tools, "get_symbols_overview").inputSchema as {
      required: string[];
    };
    expect(schema.required).toEqual(["file"]);
  });

  it("get_diagnostics_for_file: file / files mutually exclusive, no required", () => {
    const tools = createSymbolQueryToolSet(ctx);
    const schema = byName(tools, "get_diagnostics_for_file").inputSchema as {
      required?: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["file", "files"]);
  });
});

// ---------------------------------------------------------------------------
// ajv validation — SC6 empty / illegal path-or-identity
// ---------------------------------------------------------------------------

describe("ajv validation", () => {
  beforeEach(() => {
    mockGetClient.mockResolvedValue(undefined);
  });

  it("rejects empty symbol_path (minLength: 1)", async () => {
    const tools = createSymbolQueryToolSet(ctx);
    await expect(
      byName(tools, "find_declaration").handler({
        file: "/work/src/a.ts",
        symbol_path: "",
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects missing file", async () => {
    const tools = createSymbolQueryToolSet(ctx);
    await expect(
      byName(tools, "find_declaration").handler({ symbol_path: "Class/m" })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects additional `line` / `character` keys (additionalProperties: false)", async () => {
    // 即使模型「顺手」传 line/character — schema 直接拒（spec: 不允许把
    // 行列当作主入参；schema 闸门兜底而非只靠文档）。
    const tools = createSymbolQueryToolSet(ctx);
    await expect(
      byName(tools, "find_declaration").handler({
        file: "/work/src/a.ts",
        symbol_path: "Class/m",
        line: 1,
        character: 0,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects empty query for find_symbol", async () => {
    const tools = createSymbolQueryToolSet(ctx);
    await expect(
      byName(tools, "find_symbol").handler({ query: "" })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

// ---------------------------------------------------------------------------
// no-client path (server absent) — SC3 + SC6
// ---------------------------------------------------------------------------

describe("no LSP server (getClientDetailed → failure)", () => {
  beforeEach(() => {
    mockGetClient.mockResolvedValue(undefined);
  });

  it("SC3: find_declaration with only file + symbol_path → tiered no-server sentinel", async () => {
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "find_declaration").handler({
      file: "/work/src/a.ts",
      symbol_path: "Class/m",
    })) as string;
    expect(out).toMatch(
      /^\(no LSP server configured for .*a\.ts; supported extensions: /
    );
  });

  it("all 8 single-step symbol tools return the no-server sentinel (identity-first contract)", async () => {
    const tools = createSymbolQueryToolSet(ctx);
    // 7 件走 SYMBOL_SCHEMA (file + symbol_path),get_symbols_overview 走
    // FILE_SCHEMA（只有 file —— 大纲入口不需要 symbol_path）。
    const sevenSymbolPathTools = [
      "find_declaration",
      "find_referencing_symbols",
      "find_implementations",
      "get_hover",
      "prepare_call_hierarchy",
      "list_incoming_calls",
      "list_outgoing_calls",
    ];
    for (const name of sevenSymbolPathTools) {
      const out = (await byName(tools, name).handler({
        file: "/work/src/a.ts",
        symbol_path: "Class/m",
      })) as string;
      expect(
        out,
        `${name} should yield a no-server sentinel, not throw or ask for line/character`
      ).toMatch(/^\(no LSP server configured for /);
    }
    // get_symbols_overview(file-only schema)同样返 no-server
    const overview = (await byName(tools, "get_symbols_overview").handler({
      file: "/work/src/a.ts",
    })) as string;
    expect(overview).toMatch(/^\(no LSP server configured for /);
  });

  it("find_symbol with file → no-server sentinel", async () => {
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "find_symbol").handler({
      query: "alpha",
      file: "/work/src/a.ts",
    })) as string;
    expect(out).toMatch(/^\(no LSP server configured for /);
  });

  it("find_symbol without file → dispatches workspace-level probe", async () => {
    mockGetClient.mockReset();
    mockGetClientForWorkspace.mockResolvedValue({
      failure: { reason: "no-server" as const },
    });
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "find_symbol").handler({
      query: "alpha",
    })) as string;
    // 工作区级查询无 file 锚点 → workspace-level 哨兵形态（无 `for <file>` 子串）
    expect(out).toMatch(/^\(no LSP server configured/);
    expect(mockGetClientForWorkspace).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// happy path — server resolves symbol via documentSymbol tree
// ---------------------------------------------------------------------------

function fixtureFoo() {
  return {
    documentSymbol: [
      {
        name: "Alpha",
        kind: 5,
        selectionRange: { start: { line: 1, character: 0 } },
        range: { start: { line: 1, character: 0 } },
        children: [
          {
            name: "alphaMethod",
            kind: 6,
            selectionRange: { start: { line: 5, character: 2 } },
            range: { start: { line: 5, character: 2 } },
          },
        ],
      },
    ],
  };
}

describe("happy path — server returns documentSymbol tree", () => {
  it("SC3: find_declaration resolves rooted symbol identity → 0-based position used in textDocument/definition", async () => {
    const { client, calls } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureFoo().documentSymbol
          : [
              {
                uri: "file:///work/src/a.ts",
                range: { start: { line: 5, character: 2 } },
              },
            ],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);

    const out = await byName(tools, "find_declaration").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    });
    expect(typeof out).toBe("string");
    // 第一发 documentSymbol（行 5、列 2 → 已 0-based，无换算）
    expect(calls[0].method).toBe("textDocument/documentSymbol");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
    });
    // 第二发 textDocument/definition（用解析出来的 position）
    expect(calls[1].method).toBe("textDocument/definition");
    expect(calls[1].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
      position: { line: 5, character: 2 },
    });
    // JSON 字符串里能解析回原结构（契约 Y1）
    expect(JSON.parse(out as string)).toEqual([
      {
        uri: "file:///work/src/a.ts",
        range: { start: { line: 5, character: 2 } },
      },
    ]);
  });

  it("find_referencing_symbols includes includeDeclaration", async () => {
    const { client, calls } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureFoo().documentSymbol
          : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    await byName(tools, "find_referencing_symbols").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    });
    expect(calls[1].method).toBe("textDocument/references");
    expect((calls[1].params as { context?: unknown }).context).toEqual({
      includeDeclaration: true,
    });
  });

  it("get_symbols_overview calls textDocument/documentSymbol without position", async () => {
    const { client, calls } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureFoo().documentSymbol
          : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    const out = await byName(tools, "get_symbols_overview").handler({
      file: "/work/src/a.ts",
    });
    expect(out).toContain("Alpha");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("textDocument/documentSymbol");
    expect(calls[0].params).toEqual({
      textDocument: { uri: "file:///work/src/a.ts" },
    });
  });

  it("find_symbol → workspace/symbol with the user query (no empty query)", async () => {
    const { client, calls } = makeFakeClient({
      responder: () => [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    await byName(tools, "find_symbol").handler({
      query: "alpha",
      file: "/work/src/a.ts",
    });
    expect(calls[0].method).toBe("workspace/symbol");
    expect(calls[0].params).toEqual({ query: "alpha" });
  });
});

// ---------------------------------------------------------------------------
// symbol resolution failures — SC6 illegal identity branch
// ---------------------------------------------------------------------------

describe("symbol resolution failures — not_found / ambiguous / no_position", () => {
  function withTree(tree: unknown[]) {
    return makeFakeClient({
      documentSymbol: tree,
      responder: (method) =>
        method === "textDocument/documentSymbol" ? tree : [],
    });
  }

  it("not_found: returns a string with file + candidate list (does not throw)", async () => {
    const { client } = withTree([
      {
        name: "Alpha",
        selectionRange: { start: { line: 1, character: 0 } },
        range: { start: { line: 1, character: 0 } },
        children: [
          {
            name: "alphaMethod",
            selectionRange: { start: { line: 5, character: 2 } },
            range: { start: { line: 5, character: 2 } },
          },
        ],
      },
    ]);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "find_declaration").handler({
      file: "/work/src/a.ts",
      symbol_path: "Nope/missing",
    })) as string;
    expect(out).toMatch(/not found in \/work\/src\/a\.ts/);
    expect(out).toContain("Alpha/alphaMethod");
    expect(out).toContain("get_symbols_overview");
  });

  it("ambiguous: two same-named siblings → renders candidate paths", async () => {
    const { client } = withTree([
      {
        name: "Dup",
        selectionRange: { start: { line: 1, character: 0 } },
        range: { start: { line: 1, character: 0 } },
      },
      {
        name: "Dup",
        selectionRange: { start: { line: 10, character: 0 } },
        range: { start: { line: 10, character: 0 } },
      },
    ]);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "find_declaration").handler({
      file: "/work/src/a.ts",
      symbol_path: "Dup",
    })) as string;
    expect(out).toMatch(/matches 2 symbols/);
    // 两个候选路径都被列出
    expect((out.match(/Dup/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("no_position: server returned a node without any range/selectionRange/location", async () => {
    const { client } = withTree([{ name: "Headless" }]);
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "find_declaration").handler({
      file: "/work/src/a.ts",
      symbol_path: "Headless",
    })) as string;
    expect(out).toMatch(/no source range/);
  });
});

// ---------------------------------------------------------------------------
// call hierarchy multi-step
// ---------------------------------------------------------------------------

describe("call hierarchy multi-step", () => {
  it("list_incoming_calls prepares then forwards callHierarchy/incomingCalls", async () => {
    const item = {
      name: "alphaMethod",
      uri: "file:///work/src/a.ts",
      range: { start: { line: 5, character: 2 } },
    };
    const { client, calls } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) => {
        if (method === "textDocument/documentSymbol")
          return fixtureFoo().documentSymbol;
        if (method === "textDocument/prepareCallHierarchy") return [item];
        return [];
      },
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    await byName(tools, "list_incoming_calls").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    });
    expect(calls[0].method).toBe("textDocument/documentSymbol");
    expect(calls[1].method).toBe("textDocument/prepareCallHierarchy");
    expect(calls[1].params).toMatchObject({
      textDocument: { uri: "file:///work/src/a.ts" },
      position: { line: 5, character: 2 },
    });
    expect(calls[2].method).toBe("callHierarchy/incomingCalls");
    expect(calls[2].params).toEqual({ item });
  });

  it("list_outgoing_calls → callHierarchy/outgoingCalls", async () => {
    const item = {
      name: "alphaMethod",
      uri: "file:///work/src/a.ts",
      range: { start: { line: 5, character: 2 } },
    };
    const { client, calls } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) => {
        if (method === "textDocument/documentSymbol")
          return fixtureFoo().documentSymbol;
        if (method === "textDocument/prepareCallHierarchy") return [item];
        return [];
      },
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    await byName(tools, "list_outgoing_calls").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    });
    expect(calls[2].method).toBe("callHierarchy/outgoingCalls");
  });

  it("prepareCallHierarchy returns no items → stringifyResult([]) (does not throw)", async () => {
    const { client } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureFoo().documentSymbol
          : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "list_incoming_calls").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    })) as string;
    expect(out).toBe("[]");
  });
});

// ---------------------------------------------------------------------------
// SC6 — oversized result → capResult 截断
// ---------------------------------------------------------------------------

describe("SC6: oversized result → truncate at MAX_RESULT_BYTES", () => {
  it("stringifyResult caps output and appends truncation footer (48KiB ceiling)", async () => {
    // 业务响应是巨大字符串（documentSymbol 走真树，避免触发 not_found）
    const big = "x".repeat(MAX_RESULT_BYTES + 4096);
    const { client } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureFoo().documentSymbol
          : { payload: big },
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    const out = (await byName(tools, "find_declaration").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    })) as string;
    // capResult 在 MAX_RESULT_BYTES 处截断,再附 `(truncated, X of Y bytes shown)`。
    // UTF-8 安全回退 + 截断 footer 可能让最终字符串略超 MAX_RESULT_BYTES;
    // 只要包含 footer 且总长在合理范围内（≤ MAX_RESULT_BYTES + footer 余量）即可。
    expect(out).toMatch(/\.\.\.\[truncated, [0-9]+ of [0-9]+ bytes shown\]/);
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_BYTES + 128);
  });
});

// ---------------------------------------------------------------------------
// SC6 — concurrency: 同 uri 并发共享一次 documentSymbol（inflight 去重）
// ---------------------------------------------------------------------------

describe("SC6: concurrency — same-uri concurrent calls share one documentSymbol", () => {
  it("two parallel find_declaration calls on same file → sendRequest('textDocument/documentSymbol') fires once", async () => {
    let release!: () => void;
    const arrived = new Promise<void>((r) => (release = r));
    let docSymCalls = 0;
    const { client } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) => {
        if (method === "textDocument/documentSymbol") {
          docSymCalls += 1;
          // 故意挂起:确保两个 promise 在第一个未完成时都已进入 fetcher
          return arrived.then(() => fixtureFoo().documentSymbol);
        }
        return [];
      },
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    const p1 = byName(tools, "find_declaration").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    });
    const p2 = byName(tools, "find_referencing_symbols").handler({
      file: "/work/src/a.ts",
      symbol_path: "Alpha/alphaMethod",
    });
    release();
    await Promise.all([p1, p2]);
    expect(docSymCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SC6 — server throws during sendRequest → propagates as ToolExecutionError
// ---------------------------------------------------------------------------

describe("SC6: language server throws during sendRequest", () => {
  it("find_declaration propagates the underlying error (does not silently render a sentinel)", async () => {
    const { client } = makeFakeClient({
      ...fixtureFoo(),
      responder: (method) => {
        if (method === "textDocument/documentSymbol")
          return fixtureFoo().documentSymbol;
        throw new Error("boom: tsserver crashed");
      },
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolQueryToolSet(ctx);
    await expect(
      byName(tools, "find_declaration").handler({
        file: "/work/src/a.ts",
        symbol_path: "Alpha/alphaMethod",
      })
    ).rejects.toThrow(/boom: tsserver crashed/);
  });
});
