/**
 * 符号改写 ACI 工具集单测 — spec `symbol-primary-aci` T4。
 *
 * 与 `tests/harness/aci/tools/symbol-query.test.ts` 同形（`vi.mock` +
 * `vi.hoisted` 捕获），但断言 **改盘链路**：符号身份 → 解析 → LSP 计算
 * workspace/TextEdit → 本地落盘 → onEdit 回调。
 *
 * 覆盖矩阵（spec SC3 + SC6 + T4 acceptance）：
 *   - **shape**：5 件工具全部入工厂，顺序与 SYMBOL_MUTATE_TOOL_NAMES 一致；
 *     aci 元数据（category="write" / non-concurrent / cancel / default tier）。
 *   - **schema**：5 件主身 `{ file, symbol_path }` + 各自特化字段；
 *     rename 加 new_name（minLength:1）；replace 加 new_body；insert 加 code；
 *     safe_delete 不带额外字段。additionalProperties:false 守住（无
 *     line/character 漂移）。
 *   - **ajv**：空 / 缺参 / 非法字段（line/character）→ ToolExecutionError。
 *   - **no-client path**：所有 5 件返分层哨兵字符串（renderNoServer）。
 *   - **happy path**：
 *       - rename_symbol 走 `textDocument/rename` 拿 WorkspaceEdit，落盘
 *         多文件 → onEdit 触发多次，writtenFiles 包含命中文件；
 *       - replace_symbol_body 单文件 TextEdit，range = node.range（含 end）；
 *       - insert_before / insert_after 锚定到 range.start / range.end；
 *       - safe_delete_symbol 无引用 → 删除成功，onEdit 触发；
 *       - safe_delete_symbol 仍有引用 → typed 失败串 `deleted:false`，
 *         写入函数从未触发（references 路径上根本不调落盘）。
 *   - **rename 冲突**：tsserver 返 `null` → ToolExecutionError，**不空
 *     catch**，文案明示「existing declarations would conflict」。
 *   - **oversized**：replace_symbol_body / insert_before/after 超过
 *     48 KiB → ToolExecutionError（拒绝而非截断写入；spec §5 边界）。
 *   - **无效 symbol_path**：not_found / ambiguous / no_position 哨兵。
 *
 * **mock 路径**：与 query 测试一致 — `vi.mock("../../../../src/harness/lsp/client.js")`
 * 捕获 getClient/getClientDetailed；fake client 用 recordable handler 模拟
 * `textDocument/rename` / `textDocument/references` / `textDocument/documentSymbol`。
 * 落盘用真 fs（mkdtemp + rm 隔离），所以 onEdit 能被真实触达。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ToolExecutionError } from "../../../../src/harness/errors.js";
import {
  createSymbolMutateToolSet,
  SYMBOL_MUTATE_TOOL_NAMES,
} from "../../../../src/harness/aci/tools/symbol-mutate.js";
import type { AciToolDef } from "../../../../src/harness/aci/types.js";
import type { LspClient } from "../../../../src/harness/lsp/client.js";

const { mockGetClient, mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClient: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockGetClientDetailed: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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

const ctx = { directory: "/work" };

function byName(tools: ReadonlyArray<AciToolDef>, name: string): AciToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

interface FakeClientOpts {
  /** 响应器 — 可针对 method 返回不同 payload。timeout 路径下可读 token
   *  决定是否抛错（vscode-jsonrpc 在 cancel 时会让 pending request reject）。 */
  responder?: (
    method: string,
    params: unknown,
    token?: import("vscode-jsonrpc/node").CancellationToken
  ) => unknown;
  documentSymbol?: unknown[];
}

function makeFakeClient(opts: FakeClientOpts = {}): {
  client: LspClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const symTree = opts.documentSymbol ?? [];
  const responder =
    opts.responder ??
    ((method) => (method === "textDocument/documentSymbol" ? symTree : []));
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: LspClient = {
    connection: {} as never,
    process: {} as never,
    sendRequest: async (method, params, token) => {
      calls.push({ method, params });
      return responder(method, params, token);
    },
    sendNotification: async () => undefined,
    ensureOpen: async () => undefined,
    notifyChange: async () => undefined,
    getDiagnostics: () => undefined,
    getDiagnosticsEntry: () => undefined,
    getOpenVersion: () => 1,
    dispose: () => undefined,
  };
  return { client, calls };
}

/** fixture 符号树：Alpha / Alpha.alphaMethod 嵌套两层，含完整 range 字段。 */
function fixtureAlpha() {
  return {
    documentSymbol: [
      {
        name: "Alpha",
        kind: 5,
        selectionRange: { start: { line: 1, character: 0 } },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 8, character: 1 },
        },
        children: [
          {
            name: "alphaMethod",
            kind: 6,
            selectionRange: { start: { line: 3, character: 2 } },
            range: {
              start: { line: 3, character: 0 },
              end: { line: 7, character: 1 },
            },
          },
        ],
      },
    ],
  };
}

let scratch: string;
let onEditCalls: string[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aci-symmut-"));
  onEditCalls = [];
  mockGetClient.mockReset();
  mockGetClientDetailed.mockReset();
  mockGetClientDetailed.mockImplementation(async (..._args: unknown[]) => {
    const client = (await mockGetClient(..._args)) as unknown;
    return client ? { client } : { failure: { reason: "no-server" as const } };
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

describe("createSymbolMutateToolSet — shape", () => {
  it("exports 5 tools in SYMBOL_MUTATE_TOOL_NAMES order", () => {
    const tools = createSymbolMutateToolSet({ ctx });
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([...SYMBOL_MUTATE_TOOL_NAMES]);
    expect(SYMBOL_MUTATE_TOOL_NAMES).toEqual([
      "rename_symbol",
      "replace_symbol_body",
      "insert_before_symbol",
      "insert_after_symbol",
      "safe_delete_symbol",
    ]);
  });

  it("every tool def is frozen", () => {
    for (const tool of createSymbolMutateToolSet({ ctx })) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });

  it("sets aci metadata (write / non-concurrent / cancel / default tier)", () => {
    for (const tool of createSymbolMutateToolSet({ ctx })) {
      expect(tool.aci.category).toBe("write");
      expect(tool.aci.isConcurrencySafe).toBe(false);
      expect(tool.aci.interruptBehavior).toBe("cancel");
      expect(tool.aci.timeoutTier).toBe("default");
    }
  });

  it("every tool description mentions symbol identity (no coordinate phrasing)", () => {
    for (const tool of createSymbolMutateToolSet({ ctx })) {
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
// schema
// ---------------------------------------------------------------------------

describe("inputSchema", () => {
  it("rename_symbol requires file + symbol_path + new_name", () => {
    const tools = createSymbolMutateToolSet({ ctx });
    const schema = byName(tools, "rename_symbol").inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["file", "symbol_path", "new_name"]);
    expect(schema.properties).not.toHaveProperty("line");
    expect(schema.properties).not.toHaveProperty("character");
    expect(schema.additionalProperties).toBe(false);
  });

  it("replace_symbol_body requires file + symbol_path + new_body", () => {
    const tools = createSymbolMutateToolSet({ ctx });
    const schema = byName(tools, "replace_symbol_body").inputSchema as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["file", "symbol_path", "new_body"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("insert_before/after_symbol require file + symbol_path + code", () => {
    const tools = createSymbolMutateToolSet({ ctx });
    for (const name of ["insert_before_symbol", "insert_after_symbol"]) {
      const schema = byName(tools, name).inputSchema as {
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.required).toEqual(["file", "symbol_path", "code"]);
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("safe_delete_symbol requires file + symbol_path only", () => {
    const tools = createSymbolMutateToolSet({ ctx });
    const schema = byName(tools, "safe_delete_symbol").inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["file", "symbol_path"]);
    expect(schema.properties).not.toHaveProperty("new_name");
    expect(schema.properties).not.toHaveProperty("new_body");
    expect(schema.properties).not.toHaveProperty("code");
    expect(schema.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ajv validation — SC6 empty / illegal path-or-identity
// ---------------------------------------------------------------------------

describe("ajv validation", () => {
  beforeEach(() => {
    mockGetClient.mockResolvedValue(undefined);
  });

  it("rejects missing new_name for rename_symbol", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    await expect(
      byName(tools, "rename_symbol").handler({
        file: "/work/a.ts",
        symbol_path: "Alpha",
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects empty new_name for rename_symbol", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    await expect(
      byName(tools, "rename_symbol").handler({
        file: "/work/a.ts",
        symbol_path: "Alpha",
        new_name: "",
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects additional line/character keys (additionalProperties:false)", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    await expect(
      byName(tools, "replace_symbol_body").handler({
        file: "/work/a.ts",
        symbol_path: "Alpha",
        new_body: "x",
        line: 1,
        character: 0,
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects missing new_body for replace_symbol_body", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    await expect(
      byName(tools, "replace_symbol_body").handler({
        file: "/work/a.ts",
        symbol_path: "Alpha",
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects missing code for insert_before_symbol", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    await expect(
      byName(tools, "insert_before_symbol").handler({
        file: "/work/a.ts",
        symbol_path: "Alpha",
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

// ---------------------------------------------------------------------------
// no-client path (server absent)
// ---------------------------------------------------------------------------

describe("no LSP server (getClientDetailed → failure)", () => {
  beforeEach(() => {
    mockGetClient.mockResolvedValue(undefined);
  });

  it("all 5 mutate tools return the no-server sentinel", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "rename_symbol",
        { file: "/work/a.ts", symbol_path: "Alpha", new_name: "Beta" },
      ],
      [
        "replace_symbol_body",
        { file: "/work/a.ts", symbol_path: "Alpha", new_body: "x" },
      ],
      [
        "insert_before_symbol",
        { file: "/work/a.ts", symbol_path: "Alpha", code: "// x" },
      ],
      [
        "insert_after_symbol",
        { file: "/work/a.ts", symbol_path: "Alpha", code: "// x" },
      ],
      ["safe_delete_symbol", { file: "/work/a.ts", symbol_path: "Alpha" }],
    ];
    for (const [name, input] of cases) {
      const out = (await byName(tools, name).handler(input)) as string;
      expect(out, `${name} should yield a no-server sentinel`).toMatch(
        /^\(no LSP server configured for .*a\.ts/
      );
    }
  });
});

// ---------------------------------------------------------------------------
// happy path — single file rename → file written, onEdit fired
// ---------------------------------------------------------------------------

describe("rename_symbol — happy path", () => {
  it("rename across declaration + reference site → both files written, onEdit fired twice", async () => {
    const fileA = join(scratch, "a.ts");
    const fileB = join(scratch, "b.ts");
    await writeFile(fileA, "export const alpha = 1;\n", "utf8");
    await writeFile(fileB, "import { alpha } from './a';\n", "utf8");
    // tsserver 返 WorkspaceEdit.changes 形态：两个 uri → TextEdit[]。
    const editPayload = {
      changes: {
        [pathToFileURL(fileA).href]: [
          {
            range: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 18 },
            },
            newText: "beta",
          },
        ],
        [pathToFileURL(fileB).href]: [
          {
            range: {
              start: { line: 0, character: 9 },
              end: { line: 0, character: 14 },
            },
            newText: "beta",
          },
        ],
      },
    };
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? [
              {
                name: "alpha",
                kind: 13, // Variable / const
                selectionRange: { start: { line: 0, character: 13 } },
                range: {
                  start: { line: 0, character: 13 },
                  end: { line: 0, character: 18 },
                },
              },
            ]
          : editPayload,
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });

    const out = (await byName(tools, "rename_symbol").handler({
      file: fileA,
      symbol_path: "alpha",
      new_name: "beta",
    })) as string;
    const parsed = JSON.parse(out) as {
      renamed: boolean;
      symbol_path: string;
      new_name: string;
      files: string[];
      editCount: number;
    };
    expect(parsed.renamed).toBe(true);
    expect(parsed.new_name).toBe("beta");
    expect(parsed.editCount).toBe(2);
    expect(parsed.files.sort()).toEqual([fileA, fileB].sort());
    expect(onEditCalls.sort()).toEqual([fileA, fileB].sort());
    // 磁盘上 alpha → beta 已替换
    expect(await readFile(fileA, "utf8")).toBe("export const beta = 1;\n");
    expect(await readFile(fileB, "utf8")).toBe("import { beta } from './a';\n");
  });

  it("rename with no edits (already named) → renamed:true, zero files", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "export const alpha = 1;\n", "utf8");
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? [
              {
                name: "alpha",
                kind: 13,
                selectionRange: { start: { line: 0, character: 13 } },
                range: {
                  start: { line: 0, character: 13 },
                  end: { line: 0, character: 18 },
                },
              },
            ]
          : { changes: {} },
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    const out = (await byName(tools, "rename_symbol").handler({
      file: fileA,
      symbol_path: "alpha",
      new_name: "alpha",
    })) as string;
    const parsed = JSON.parse(out) as { files: string[]; editCount: number };
    expect(parsed.files).toEqual([]);
    expect(parsed.editCount).toBe(0);
    expect(onEditCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rename 冲突 — typed failure string, no empty catch
// ---------------------------------------------------------------------------

describe("rename_symbol — conflict path", () => {
  it("tsserver returns null (rename would conflict) → typed ToolExecutionError, file unchanged", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "export const alpha = 1;\n", "utf8");
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? [
              {
                name: "alpha",
                kind: 13,
                selectionRange: { start: { line: 0, character: 13 } },
                range: {
                  start: { line: 0, character: 13 },
                  end: { line: 0, character: 18 },
                },
              },
            ]
          : null,
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    await expect(
      byName(tools, "rename_symbol").handler({
        file: fileA,
        symbol_path: "alpha",
        new_name: "beta",
      })
    ).rejects.toThrow(/existing declarations would conflict/);
    // 文件保持原样，onEdit 未触发
    expect(await readFile(fileA, "utf8")).toBe("export const alpha = 1;\n");
    expect(onEditCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// replace_symbol_body — TextEdit range = symbol.range
// ---------------------------------------------------------------------------

describe("replace_symbol_body — happy path", () => {
  it("replaces symbol body using node.range (start..end)", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(
      fileA,
      [
        "// header",
        "class Alpha {",
        "  alphaMethod() {",
        "    return 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );
    const { client } = makeFakeClient(fixtureAlpha());
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    const out = (await byName(tools, "replace_symbol_body").handler({
      file: fileA,
      symbol_path: "Alpha/alphaMethod",
      new_body: "  alphaMethod() {\n    return 42;\n  }",
    })) as string;
    const parsed = JSON.parse(out) as {
      replaced: boolean;
      files: string[];
      editCount: number;
    };
    expect(parsed.replaced).toBe(true);
    expect(parsed.files).toEqual([fileA]);
    expect(parsed.editCount).toBe(1);
    expect(onEditCalls).toEqual([fileA]);
    // body 已被替换；其余结构（class 包装 / header）保留
    const after = await readFile(fileA, "utf8");
    expect(after).toContain("alphaMethod() {");
    expect(after).toContain("return 42;");
    expect(after).toContain("class Alpha {");
    expect(after).toContain("// header");
  });
});

// ---------------------------------------------------------------------------
// insert_before/after — anchored to range.start / range.end
// ---------------------------------------------------------------------------

describe("insert_before/after_symbol — happy path", () => {
  // 单行 fixture：Alpha 占据 file 单行 char 0..14（LSP range.end 独占，
  // = 14 字符 "class Alpha {}"），使 insert_before 落在 char 0 之前；
  // insert_after 落在 char 14（即 "}" 之后、"\n" 之前）。
  function singleLineFixture() {
    return {
      documentSymbol: [
        {
          name: "Alpha",
          kind: 5,
          selectionRange: { start: { line: 0, character: 6 } },
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 14 },
          },
        },
      ],
    };
  }

  it("insert_before_symbol anchors the splice at range.start", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient(singleLineFixture());
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    await byName(tools, "insert_before_symbol").handler({
      file: fileA,
      symbol_path: "Alpha",
      code: "// leading",
    });
    const after = await readFile(fileA, "utf8");
    // code 在 class Alpha {} 之前插入，自动补换行
    expect(after.startsWith("// leading\n")).toBe(true);
    expect(after).toContain("class Alpha {}");
    expect(onEditCalls).toEqual([fileA]);
  });

  it("insert_after_symbol anchors the splice at range.end", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient(singleLineFixture());
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    await byName(tools, "insert_after_symbol").handler({
      file: fileA,
      symbol_path: "Alpha",
      code: "// trailing",
    });
    const after = await readFile(fileA, "utf8");
    // 自动补换行 → 落在 class Alpha {} 之后独立成段（range.end = char 13,
    //  = "class Alpha {}" 末尾的 "}" 之后,插入 "\n// trailing"）。
    expect(after).toContain("class Alpha {}\n// trailing");
    expect(onEditCalls).toEqual([fileA]);
  });
});

// ---------------------------------------------------------------------------
// safe_delete_symbol — references branch
// ---------------------------------------------------------------------------

describe("safe_delete_symbol — references branch", () => {
  it("returns typed failure with references list when refs exist (no write)", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const refsPayload = [
      {
        uri: "file:///work/a.ts",
        range: { start: { line: 0, character: 6 } },
      },
      {
        uri: "file:///work/b.ts",
        range: { start: { line: 0, character: 4 } },
      },
    ];
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureAlpha().documentSymbol
          : method === "textDocument/references"
            ? refsPayload
            : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    const out = (await byName(tools, "safe_delete_symbol").handler({
      file: fileA,
      symbol_path: "Alpha",
    })) as string;
    const parsed = JSON.parse(out) as {
      deleted: boolean;
      references: Array<{ file: string; line: number; character: number }>;
      message: string;
    };
    expect(parsed.deleted).toBe(false);
    expect(parsed.references).toHaveLength(2);
    expect(parsed.references[0]?.file).toContain("a.ts");
    expect(parsed.references[0]?.line).toBe(0);
    expect(parsed.message).toMatch(/refusing to delete/);
    // 不删：onEdit 未触发，文件保持原样
    expect(onEditCalls).toEqual([]);
    expect(await readFile(fileA, "utf8")).toBe("class Alpha {}\n");
  });
});

// ---------------------------------------------------------------------------
// safe_delete_symbol — no refs branch
// ---------------------------------------------------------------------------

describe("safe_delete_symbol — no references branch", () => {
  it("deletes when references list is empty, onEdit fires once", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? [
              {
                name: "Alpha",
                kind: 5,
                selectionRange: { start: { line: 0, character: 6 } },
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 13 },
                },
              },
            ]
          : method === "textDocument/references"
            ? []
            : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    const out = (await byName(tools, "safe_delete_symbol").handler({
      file: fileA,
      symbol_path: "Alpha",
    })) as string;
    const parsed = JSON.parse(out) as {
      deleted: boolean;
      files: string[];
      editCount: number;
    };
    expect(parsed.deleted).toBe(true);
    expect(parsed.files).toEqual([fileA]);
    expect(parsed.editCount).toBe(1);
    expect(onEditCalls).toEqual([fileA]);
  });
});

// ---------------------------------------------------------------------------
// oversized body / code — SC6 边界
// ---------------------------------------------------------------------------

describe("SC6: oversized new_body / code", () => {
  beforeEach(() => {
    const { client } = makeFakeClient(fixtureAlpha());
    mockGetClient.mockResolvedValue(client);
  });

  it("replace_symbol_body rejects new_body exceeding 48 KiB", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    const huge = "x".repeat(48 * 1024 + 1);
    await expect(
      byName(tools, "replace_symbol_body").handler({
        file: "/work/a.ts",
        symbol_path: "Alpha/alphaMethod",
        new_body: huge,
      })
    ).rejects.toThrow(/exceeding 49152-byte cap/);
  });

  it("insert_before_symbol rejects code exceeding 48 KiB", async () => {
    const tools = createSymbolMutateToolSet({ ctx });
    const huge = "x".repeat(48 * 1024 + 1);
    await expect(
      byName(tools, "insert_before_symbol").handler({
        file: "/work/a.ts",
        symbol_path: "Alpha",
        code: huge,
      })
    ).rejects.toThrow(/exceeding 49152-byte cap/);
  });
});

// ---------------------------------------------------------------------------
// invalid symbol_path — not_found / ambiguous / no_position
// ---------------------------------------------------------------------------

describe("symbol resolution failures — not_found / ambiguous", () => {
  beforeEach(() => {
    mockGetClient.mockResolvedValue(undefined);
  });

  it("not_found: returns a sentinel with candidate paths, no write", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureAlpha().documentSymbol
          : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({ ctx });
    const out = (await byName(tools, "rename_symbol").handler({
      file: fileA,
      symbol_path: "Nope/missing",
      new_name: "Z",
    })) as string;
    expect(out).toMatch(/not found in/);
    expect(out).toContain("get_symbols_overview");
    // 文件不变，onEdit 未触发
    expect(await readFile(fileA, "utf8")).toBe("class Alpha {}\n");
    expect(onEditCalls).toEqual([]);
  });

  it("ambiguous: two same-named roots → ambiguous sentinel, no write", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const ambiguousTree = [
      {
        name: "Alpha",
        kind: 5,
        selectionRange: { start: { line: 1, character: 0 } },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 3, character: 1 },
        },
      },
      {
        name: "Alpha",
        kind: 5,
        selectionRange: { start: { line: 5, character: 0 } },
        range: {
          start: { line: 5, character: 0 },
          end: { line: 7, character: 1 },
        },
      },
    ];
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol" ? ambiguousTree : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({ ctx });
    const out = (await byName(tools, "replace_symbol_body").handler({
      file: fileA,
      symbol_path: "Alpha",
      new_body: "x",
    })) as string;
    expect(out).toMatch(/matches 2 symbols/);
    expect(onEditCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onEdit 缺席（undefine）— 不影响写盘主路径
// ---------------------------------------------------------------------------

describe("createSymbolMutateToolSet — onEdit optional", () => {
  it("omitting onEdit does not block writes (best-effort notifier is separate concern)", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? [
              {
                name: "Alpha",
                kind: 5,
                selectionRange: { start: { line: 0, character: 6 } },
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 13 },
                },
              },
            ]
          : method === "textDocument/references"
            ? []
            : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({ ctx }); // no onEdit
    const out = (await byName(tools, "safe_delete_symbol").handler({
      file: fileA,
      symbol_path: "Alpha",
    })) as string;
    const parsed = JSON.parse(out) as { deleted: boolean; files: string[] };
    expect(parsed.deleted).toBe(true);
    expect(parsed.files).toEqual([fileA]);
  });
});

// ---------------------------------------------------------------------------
// T4 review findings — silent fallback + copy-paste timeout labels
// ---------------------------------------------------------------------------

describe("T4 review: safe_delete_symbol refuses malformed references", () => {
  it("throws ToolExecutionError when textDocument/references returns a non-array string (no silent delete)", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureAlpha().documentSymbol
          : method === "textDocument/references"
            ? "not an array" // malformed: server returned a string, not Location[]
            : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx,
      onEdit: (f) => onEditCalls.push(f),
    });
    // spec §53 + ACR error-handling-enforcer: 不能"证明无引用"必须拒绝删除
    // 而非静默回退到"无引用"路径。typed failure 比 silent fallback 更安全。
    await expect(
      byName(tools, "safe_delete_symbol").handler({
        file: fileA,
        symbol_path: "Alpha",
      })
    ).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(
      byName(tools, "safe_delete_symbol").handler({
        file: fileA,
        symbol_path: "Alpha",
      })
    ).rejects.toThrow(/cannot prove no references/);
    // 文件不变，onEdit 未触发（typed failure 在写盘前抛）
    expect(onEditCalls).toEqual([]);
    expect(await readFile(fileA, "utf8")).toBe("class Alpha {}\n");
  });

  it("throws ToolExecutionError when textDocument/references returns null (no silent delete)", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient({
      responder: (method) =>
        method === "textDocument/documentSymbol"
          ? fixtureAlpha().documentSymbol
          : method === "textDocument/references"
            ? null // malformed: null 不是 Location[]
            : [],
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({ ctx });
    await expect(
      byName(tools, "safe_delete_symbol").handler({
        file: fileA,
        symbol_path: "Alpha",
      })
    ).rejects.toThrow(/cannot prove no references/);
    expect(onEditCalls).toEqual([]);
    expect(await readFile(fileA, "utf8")).toBe("class Alpha {}\n");
  });
});

describe("T4 review: timeout method labels — no copy-paste rename", () => {
  /** 触发超时的最简路径：requestTimeoutMs=1 + responder 故意 sleep 100ms
   *  并在醒来后检查 token：被 cancel 则抛错（与 vscode-jsonrpc 在 cancel 时
   *  让 pending request reject 的真实语义一致）。后续 `cancel.timedOut()`
   *  在 catch 中为 true → 走 timeoutError 分支。 */
  function hangingResponder(payload: unknown) {
    return async (
      _method: string,
      _params: unknown,
      token?: import("vscode-jsonrpc/node").CancellationToken
    ) => {
      await new Promise((r) => setTimeout(r, 100));
      if (token?.isCancellationRequested) {
        throw new Error("request cancelled");
      }
      return payload;
    };
  }

  it("replace_symbol_body timeout label names documentSymbol + applyWorkspaceEdit (not rename)", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient({
      responder: hangingResponder(fixtureAlpha().documentSymbol),
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx: { directory: "/work", requestTimeoutMs: 1 },
    });
    // 期望：timeoutError 方法段写"documentSymbol + applyWorkspaceEdit"，
    // 不含 "rename"（copy-paste bug 防回归）。
    let caught: unknown;
    try {
      await byName(tools, "replace_symbol_body").handler({
        file: fileA,
        symbol_path: "Alpha/alphaMethod",
        new_body: "x",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as Error).message;
    expect(message).toMatch(/documentSymbol \+ applyWorkspaceEdit/);
    expect(message).not.toMatch(/rename/);
    expect(message).toMatch(/replace_symbol_body/);
  });

  it("insert_before_symbol timeout label names documentSymbol + applyWorkspaceEdit insert (not rename)", async () => {
    const fileA = join(scratch, "a.ts");
    await writeFile(fileA, "class Alpha {}\n", "utf8");
    const { client } = makeFakeClient({
      responder: hangingResponder(fixtureAlpha().documentSymbol),
    });
    mockGetClient.mockResolvedValue(client);
    const tools = createSymbolMutateToolSet({
      ctx: { directory: "/work", requestTimeoutMs: 1 },
    });
    let caught: unknown;
    try {
      await byName(tools, "insert_before_symbol").handler({
        file: fileA,
        symbol_path: "Alpha",
        code: "// x",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as Error).message;
    expect(message).toMatch(/documentSymbol \+ applyWorkspaceEdit \(insert\)/);
    expect(message).not.toMatch(/rename/);
  });
});
