/**
 * symbol-mutate applier — WorkspaceEdit 不可应用片段的 typed 拒绝
 * （plan `lsp-silent-degradation` T4）。
 *
 * **钉住的不变式**：语言服务器给出的 `WorkspaceEdit` 只要含本工具集**应用
 * 不了**的东西（file operation / 无法归一成 `TextDocumentEdit` 的条目 /
 * 形状非法的 `TextEdit`），`rename_symbol` 必须 typed 失败并点名是哪一种，
 * **不得部分应用** —— 半套 rename 落盘比整体失败更坏：workspace 留在
 * 「一半改了、一半没改」的状态，模型与人都看不出来。
 *
 * **四处同形静默丢弃**（ACR error-handling-enforcer 逐点列出，同一批修）：
 *   - `normalizeWorkspaceEdit` 对 `CreateFile` / `RenameFile` / `DeleteFile`
 *     的 `continue`（file operation 被当成「不存在」）；
 *   - 两个 `flatMap` 静默丢掉 `normalizeTextEdit` 拒绝的条目；
 *   - `normalizeTextEdit` 的裸 `return []`（真正的吞点是它）；
 *   - length-0 `continue` 把「server 送回 N 条、全被丢弃」与「server 说没有
 *     可改的地方」压成同一种结果 —— 前者是响应损坏，后者是 LSP 合法响应
 *     （server 允许返回空 `changes`），必须分开。
 *
 * **回归边界**：纯文本编辑路径逐字节不变（见 happy path 与「空 edits 不是
 * 失败」两组）。本文件同时直测归一化函数与 handler 面：handler 面证明失败
 * 真的不落盘，函数面证明各种 kind 各自可判。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AciToolDef } from "../../../src/harness/aci/types.ts";

const { mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClientDetailed: vi.fn<() => Promise<unknown>>(),
}));

// 只替换 getClientDetailed（真实 tsserver / vscode-jsonrpc 不落地）；
// 其余 lsp/client.js 导出保留真实实现。
vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClientDetailed: mockGetClientDetailed,
  };
});

import {
  WorkspaceEditUnsupportedError,
  createSymbolMutateToolSet,
  normalizeWorkspaceEdit,
} from "../../../src/harness/aci/tools/symbol-mutate.ts";

const DOCUMENT_SYMBOL = "textDocument/documentSymbol";

/** `Foo/bar` 的符号树：改名目标 = 第 0 行第 6 列的 `foo`。 */
const SAMPLE_SYMBOL_TREE = [
  {
    name: "Foo",
    kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
    selectionRange: { start: { line: 0, character: 6 } },
    children: [
      {
        name: "bar",
        kind: 6,
        range: {
          start: { line: 2, character: 2 },
          end: { line: 2, character: 16 },
        },
        selectionRange: { start: { line: 2, character: 8 } },
      },
    ],
  },
];

const FILE_BODY = [
  "const foo = 1;",
  "function bar() {",
  "  return foo;",
  "}",
].join("\n");

/** 只改第 0 行 `foo` 的合法 TextEdit。 */
const FOO_EDIT = {
  range: {
    start: { line: 0, character: 6 },
    end: { line: 0, character: 9 },
  },
  newText: "baz",
};

interface FakeClient {
  readonly calls: Array<{ method: string; params: unknown }>;
  readonly client: unknown;
}

/** 与 `lsp.test.ts` 同一套 fake 客户端形态（真实工具链路的假传输层）。 */
function makeFakeClient(renameResult: unknown): FakeClient {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    client: {
      connection: {} as never,
      process: {} as never,
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(_file: string, fn: () => Promise<T>) => fn(),
      sendRequest: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return method === DOCUMENT_SYMBOL ? SAMPLE_SYMBOL_TREE : renameResult;
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      getDocumentFingerprint: () => "fp-1",
      dispose: () => undefined,
    },
  };
}

function byName(tools: ReadonlyArray<AciToolDef>, name: string): AciToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

let workDir: string;
let mainFile: string;
let otherFile: string;

beforeEach(async () => {
  mockGetClientDetailed.mockReset();
  // 真实临时目录：失败路径的断言面是「盘上没被写」，不是「函数没被调用」。
  workDir = await mkdtemp(path.join(os.tmpdir(), "symbol-mutate-"));
  await mkdir(path.join(workDir, "src"), { recursive: true });
  mainFile = path.join(workDir, "src", "a.ts");
  otherFile = path.join(workDir, "src", "b.ts");
  await writeFile(mainFile, FILE_BODY, "utf8");
  await writeFile(otherFile, "foo();\n", "utf8");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function uriOf(file: string): string {
  return pathToFileURL(file).href;
}

function renameInput(): Record<string, unknown> {
  return { file: mainFile, symbol_path: "Foo/bar", new_name: "baz" };
}

async function runRename(
  renameResult: unknown
): Promise<{ outcome: "resolved" | "rejected"; value: unknown }> {
  const { client } = makeFakeClient(renameResult);
  mockGetClientDetailed.mockResolvedValue({ client });
  const tools = createSymbolMutateToolSet({ ctx: { directory: workDir } });
  try {
    const value = await byName(tools, "rename_symbol").handler(renameInput());
    return { outcome: "resolved", value };
  } catch (err) {
    return { outcome: "rejected", value: err };
  }
}

// ── 回归边界：纯文本编辑路径逐字节不变 ──────────────────────────────────────

describe("text-only WorkspaceEdit path is unchanged", () => {
  it("applies cross-file text edits to disk and reports files + edit count", async () => {
    const { outcome, value } = await runRename({
      documentChanges: [
        { textDocument: { uri: uriOf(mainFile) }, edits: [FOO_EDIT] },
        {
          textDocument: { uri: uriOf(otherFile) },
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 3 },
              },
              newText: "baz",
            },
          ],
        },
      ],
    });

    expect(outcome).toBe("resolved");
    const parsed = JSON.parse(value as string) as Record<string, unknown>;
    expect(parsed.renamed).toBe(true);
    expect(parsed.editCount).toBe(2);
    expect(parsed.files).toEqual([mainFile, otherFile]);
    expect(await readFile(mainFile, "utf8")).toBe(
      FILE_BODY.replace("const foo", "const baz")
    );
    expect(await readFile(otherFile, "utf8")).toBe("baz();\n");
  });

  it("accepts the legacy `changes` form (uri → TextEdit[])", async () => {
    const { outcome, value } = await runRename({
      changes: { [uriOf(mainFile)]: [FOO_EDIT] },
    });

    expect(outcome).toBe("resolved");
    expect((JSON.parse(value as string) as { renamed?: boolean }).renamed).toBe(
      true
    );
    expect(await readFile(mainFile, "utf8")).toBe(
      FILE_BODY.replace("const foo", "const baz")
    );
  });

  it("keeps a legitimately empty WorkspaceEdit a no-op, not a failure", async () => {
    // LSP 允许 server 返回空 edits（「没有可改的地方」）；模型需要知道改名
    // 实际没发生，但这不是响应损坏 —— 仍是成功的 no-op 回执。
    for (const empty of [
      { changes: {} },
      { documentChanges: [] },
      {
        documentChanges: [
          { textDocument: { uri: uriOf(mainFile) }, edits: [] },
        ],
      },
    ]) {
      const { outcome, value } = await runRename(empty);
      expect(outcome, JSON.stringify(empty)).toBe("resolved");
      const parsed = JSON.parse(value as string) as Record<string, unknown>;
      expect(parsed.renamed).toBe(true);
      expect(parsed.editCount).toBe(0);
      expect(parsed.files).toEqual([]);
      expect(parsed.message).toMatch(/no edits/);
    }
    expect(await readFile(mainFile, "utf8")).toBe(FILE_BODY);
  });
});

// ── 失败路径：不可应用的片段必须整体拒绝，且不落盘 ──────────────────────────

describe("unsupported WorkspaceEdit fragments are rejected, never partially applied", () => {
  it("rejects a CreateFile / RenameFile / DeleteFile documentChanges entry by kind", async () => {
    for (const op of [
      { kind: "create", uri: uriOf(path.join(workDir, "src", "new.ts")) },
      {
        kind: "rename",
        oldUri: uriOf(mainFile),
        newUri: uriOf(path.join(workDir, "src", "c.ts")),
      },
      { kind: "delete", uri: uriOf(otherFile) },
    ]) {
      const { outcome, value } = await runRename({
        documentChanges: [
          op,
          // 同一个响应里还夹着一条**合法**文本编辑 —— 部分应用的诱惑源。
          { textDocument: { uri: uriOf(mainFile) }, edits: [FOO_EDIT] },
        ],
      });

      expect(outcome, op.kind).toBe("rejected");
      expect(value, op.kind).toBeInstanceOf(WorkspaceEditUnsupportedError);
      expect((value as WorkspaceEditUnsupportedError).kind, op.kind).toBe(
        "file-operation"
      );
      expect((value as Error).message, op.kind).toContain(op.kind);
      // 部分应用 = 半套 rename；合法的那条也不许落盘。
      expect(await readFile(mainFile, "utf8"), op.kind).toBe(FILE_BODY);
      expect(await readFile(otherFile, "utf8"), op.kind).toBe("foo();\n");
    }
  });

  it("rejects a documentChanges entry that has no usable textDocument.uri", async () => {
    for (const entry of [null, "not-an-object", { edits: [FOO_EDIT] }]) {
      const { outcome, value } = await runRename({
        documentChanges: [entry],
      });
      expect(outcome, JSON.stringify(entry)).toBe("rejected");
      expect((value as WorkspaceEditUnsupportedError).kind).toBe(
        "malformed-entry"
      );
    }
    expect(await readFile(mainFile, "utf8")).toBe(FILE_BODY);
  });

  it("rejects a malformed TextEdit instead of dropping it", async () => {
    for (const badEdit of [
      null,
      "nope",
      { newText: "x" },
      { range: { start: { line: 0, character: 0 } }, newText: 42 },
    ]) {
      const { outcome, value } = await runRename({
        documentChanges: [
          { textDocument: { uri: uriOf(mainFile) }, edits: [badEdit] },
        ],
      });
      expect(outcome, JSON.stringify(badEdit)).toBe("rejected");
      expect(
        (value as WorkspaceEditUnsupportedError).kind,
        String(badEdit)
      ).toBe("malformed-edit");
    }
    expect(await readFile(mainFile, "utf8")).toBe(FILE_BODY);
  });

  it("distinguishes 'server sent zero edits' from 'every edit was malformed'", async () => {
    // 空数组 = 合法 no-op（上一组已钉）；非空、但每条都归一不了 = 响应损坏。
    const { outcome, value } = await runRename({
      changes: { [uriOf(mainFile)]: [null, "nope"] },
    });
    expect(outcome).toBe("rejected");
    expect((value as WorkspaceEditUnsupportedError).kind).toBe(
      "malformed-edit"
    );
  });

  it("rejects a non-array `changes` value instead of skipping the uri", async () => {
    const { outcome, value } = await runRename({
      changes: { [uriOf(mainFile)]: "not-an-array" },
    });
    expect(outcome).toBe("rejected");
    expect((value as WorkspaceEditUnsupportedError).kind).toBe(
      "malformed-entry"
    );
  });

  it("rejects edits whose uri is not a file URL (unresolvable target)", async () => {
    // 归一化能过、落盘前解不出路径：同样应用不了 → typed 失败，不静默丢。
    const { outcome, value } = await runRename({
      documentChanges: [
        {
          textDocument: { uri: "https://example.com/a.ts" },
          edits: [FOO_EDIT],
        },
      ],
    });
    expect(outcome).toBe("rejected");
    // 归因是「uri 落不成文件路径」而非「payload 坏了」：条目形状本身合法，
    // 两类给模型的行动提示不同，故分开记 kind。
    expect((value as WorkspaceEditUnsupportedError).kind).toBe(
      "unresolvable-uri"
    );
    expect(await readFile(mainFile, "utf8")).toBe(FILE_BODY);
  });

  it("rejects an unrecognized ResourceOp kind", async () => {
    const { outcome, value } = await runRename({
      documentChanges: [{ kind: "frobnicate", uri: uriOf(mainFile) }],
    });
    expect(outcome).toBe("rejected");
    expect((value as WorkspaceEditUnsupportedError).kind).toBe(
      "file-operation"
    );
    expect((value as Error).message).toContain("frobnicate");
  });

  it("names the offending kind in the model-facing message", async () => {
    const { value } = await runRename({
      documentChanges: [{ kind: "create", uri: uriOf(mainFile) }],
    });
    const message = (value as Error).message;
    expect(message).toContain("[symbol-mutate]");
    expect(message).toContain("file-operation");
    expect(message).toMatch(/no edits were applied/i);
  });

  it("leaves the missing-server sentinel untouched when no client is available", async () => {
    // 回归边界：归一化之前的分支不受本票影响（哨兵仍是哨兵，不是 typed 失败）。
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-server" },
    });
    const tools = createSymbolMutateToolSet({ ctx: { directory: workDir } });
    const out = await byName(tools, "rename_symbol").handler(renameInput());
    expect(typeof out).toBe("string");
    expect(out).toContain("(no LSP server configured");
  });
});

// ── 归一化函数面：各种 kind 各自可判（不落到盘） ────────────────────────────

describe("normalizeWorkspaceEdit rejection contract", () => {
  const uri = "file:///work/src/a.ts";
  const goodEdit = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    newText: "x",
  };

  it("keeps returning normalized TextDocumentEdit[] on the happy path", () => {
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [{ textDocument: { uri }, edits: [goodEdit] }],
      })
    ).toEqual([{ textDocument: { uri }, edits: [goodEdit] }]);
    expect(normalizeWorkspaceEdit({ changes: { [uri]: [goodEdit] } })).toEqual([
      { textDocument: { uri }, edits: [goodEdit] },
    ]);
  });

  it("keeps a missing / null WorkspaceEdit an empty result (not corruption)", () => {
    // server 返 null = 拒绝了这次 rename，handler 层已前置译成同作用域冲突的
    // typed 失败（makeRenameSymbolTool 的 result === null 分支）；归一化只需
    // 对这两种「合法缺席」不抛。`{}` 同理：两个形态字段都不在场 = 零条目。
    expect(normalizeWorkspaceEdit(null)).toEqual([]);
    expect(normalizeWorkspaceEdit(undefined)).toEqual([]);
    expect(normalizeWorkspaceEdit({})).toEqual([]);
  });

  it("throws file-operation for each ResourceOp kind", () => {
    for (const op of [
      { kind: "create", uri },
      { kind: "rename", oldUri: uri, newUri: "file:///work/src/b.ts" },
      { kind: "delete", uri },
    ]) {
      const thrown = captureThrow(() =>
        normalizeWorkspaceEdit({ documentChanges: [op] })
      );
      expect(thrown, JSON.stringify(op)).toBeInstanceOf(
        WorkspaceEditUnsupportedError
      );
      expect((thrown as WorkspaceEditUnsupportedError).kind).toBe(
        "file-operation"
      );
    }
  });

  it("throws malformed-entry / malformed-edit with a distinct kind each", () => {
    const cases: ReadonlyArray<[unknown, string]> = [
      [{ documentChanges: [null] }, "malformed-entry"],
      [{ documentChanges: [{ edits: [] }] }, "malformed-entry"],
      [
        { documentChanges: [{ textDocument: { uri }, edits: "no" }] },
        "malformed-entry",
      ],
      [
        { documentChanges: [{ textDocument: { uri }, edits: [null] }] },
        "malformed-edit",
      ],
      [{ changes: { [uri]: "no" } }, "malformed-entry"],
      [{ changes: { [uri]: [null] } }, "malformed-edit"],
    ];
    for (const [raw, kind] of cases) {
      const thrown = captureThrow(() => normalizeWorkspaceEdit(raw));
      expect(thrown, JSON.stringify(raw)).toBeInstanceOf(
        WorkspaceEditUnsupportedError
      );
      expect(
        (thrown as WorkspaceEditUnsupportedError).kind,
        JSON.stringify(raw)
      ).toBe(kind);
    }
  });

  it("keeps zero-edit normalizations an empty array (no throw)", () => {
    expect(normalizeWorkspaceEdit({ documentChanges: [] })).toEqual([]);
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [{ textDocument: { uri }, edits: [] }],
      })
    ).toEqual([]);
    expect(normalizeWorkspaceEdit({ changes: { [uri]: [] } })).toEqual([]);
  });

  it("names the offending kind and the no-write guarantee in the message", () => {
    const thrown = captureThrow(() =>
      normalizeWorkspaceEdit({ documentChanges: [{ kind: "delete", uri }] })
    ) as WorkspaceEditUnsupportedError;
    expect(thrown.message).toContain("file-operation");
    expect(thrown.message).toContain("delete");
    expect(thrown.message).toMatch(/no edits were applied/i);
  });

  it("rejects an unreadable envelope instead of normalizing it to zero edits", () => {
    // 信封读不出来 = 这次响应不可用，与「server 说没有可改的地方」是两回事：
    // 后者是合法 no-op，前者必须 typed 失败，否则 handler 会把
    // `renamed: true, editCount: 0` 报成成功。
    for (const raw of ["nope", 42, [goodEdit]]) {
      const thrown = captureThrow(() =>
        normalizeWorkspaceEdit(raw)
      ) as WorkspaceEditUnsupportedError;
      expect(thrown).toBeInstanceOf(WorkspaceEditUnsupportedError);
      expect(thrown.kind).toBe("malformed-entry");
    }
  });

  it("rejects a present-but-wrong-shaped changes / documentChanges", () => {
    // 两种形态都「在场」却读不出条目：不能当作「没有条目」静默放过。
    for (const raw of [
      { documentChanges: "not-an-array" },
      { documentChanges: { textDocument: { uri }, edits: [goodEdit] } },
      { changes: [] },
      { changes: "not-an-object" },
    ]) {
      const thrown = captureThrow(() =>
        normalizeWorkspaceEdit(raw)
      ) as WorkspaceEditUnsupportedError;
      expect(thrown).toBeInstanceOf(WorkspaceEditUnsupportedError);
      expect(thrown.kind).toBe("malformed-entry");
    }
  });

  it("normalizes a non-file uri without judging it (resolution happens at apply time)", () => {
    // 归一化只认形状，不解析 uri —— 解析落在 applyWorkspaceEdit 的
    // groupEditsByPath，那里才判得出「落不成文件路径」并抛 unresolvable-uri
    // （见上方 runRename 落盘路径那条）。
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [
          { textDocument: { uri: "untitled:foo" }, edits: [goodEdit] },
        ],
      })
    ).toEqual([{ textDocument: { uri: "untitled:foo" }, edits: [goodEdit] }]);
  });
});

/** 执行并捕获 throw；不抛则返回 undefined（比 expect(...).toThrow 更能逐条判 kind）。 */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}
