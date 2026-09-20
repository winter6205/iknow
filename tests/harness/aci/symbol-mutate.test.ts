/**
 * symbol-mutate applier — typed rejection of WorkspaceEdit fragments that
 * this tool set cannot apply.
 *
 * **Locked invariant**: whenever a language server's `WorkspaceEdit`
 * contains anything **unappliable** here (file operation / an entry that
 * cannot be normalized into a `TextDocumentEdit` / malformed `TextEdit`),
 * `rename_symbol` must fail typed and name which kind it is — **never
 * partially apply**. A half-applied rename on disk is worse than a total
 * failure: the workspace is left "half renamed, half not", invisible to
 * both model and human.
 *
 * Four same-shaped silent drops, enumerated point by point by the
 * error-handling-enforcer review and fixed in one batch:
 *   - `normalizeWorkspaceEdit`'s `continue` over `CreateFile` /
 *     `RenameFile` / `DeleteFile` (file operations treated as "absent");
 *   - two `flatMap`s silently dropping entries rejected by `normalizeTextEdit`;
 *   - `normalizeTextEdit`'s bare `return []` (the real swallowing point);
 *   - the length-0 `continue` collapsed "server sent N edits, all dropped"
 *     with "server says there is nothing to change" — the former is a
 *     corrupted response, the latter a legal LSP response (an empty
 *     `changes` is allowed); they must be separated.
 *
 * **Regression boundary**: the pure text-edit path is byte-for-byte
 * unchanged (see the happy path and the "empty edits are not a failure"
 * group). This file tests both the normalization function and the handler
 * surface directly: the handler surface proves failures really do not write
 * to disk; the function surface proves each kind stays distinguishable.
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

// Mock only getClientDetailed (no real tsserver / vscode-jsonrpc runs);
// every other lsp/client.js export keeps its real implementation.
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

/** Symbol tree for `Foo/bar`: the rename target is the `foo` at line 0, character 6. */
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

/** A valid TextEdit that changes only the `foo` on line 0. */
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

/** Same fake-client shape as `lsp.test.ts` (fake transport under the real tool chain). */
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
  // Real temp dir: failure paths assert "nothing written on disk", not
  // "the function was not called".
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

// ── Regression boundary: the text-only edit path is unchanged byte for byte ─

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
    // LSP allows the server to return empty edits ("nothing to change");
    // the model must learn the rename effectively did not happen, but this
    // is not a corrupted response — still a successful no-op receipt.
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

// ── Failure paths: unappliable fragments must be rejected wholesale, nothing on disk ─

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
          // The same response also carries one **legal** text edit — the
          // temptation source for partial application.
          { textDocument: { uri: uriOf(mainFile) }, edits: [FOO_EDIT] },
        ],
      });

      expect(outcome, op.kind).toBe("rejected");
      expect(value, op.kind).toBeInstanceOf(WorkspaceEditUnsupportedError);
      expect((value as WorkspaceEditUnsupportedError).kind, op.kind).toBe(
        "file-operation"
      );
      expect((value as Error).message, op.kind).toContain(op.kind);
      // Partial application = half a rename; even the legal edit must not reach disk.
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
    // Empty array = legal no-op (pinned by the previous group); non-empty
    // yet every edit un-normalizable = corrupted response.
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
    // Normalization passes but the path cannot be resolved before writing:
    // still unappliable → typed failure, never a silent drop.
    const { outcome, value } = await runRename({
      documentChanges: [
        {
          textDocument: { uri: "https://example.com/a.ts" },
          edits: [FOO_EDIT],
        },
      ],
    });
    expect(outcome).toBe("rejected");
    // Attribution is "the uri cannot become a file path", not "the payload
    // is broken": the entry shape itself is legal, and the two kinds give
    // the model different action hints, so they get distinct kinds.
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
    // Regression boundary: branches before normalization are unaffected by
    // this change (the sentinel stays a sentinel, not a typed failure).
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-server" },
    });
    const tools = createSymbolMutateToolSet({ ctx: { directory: workDir } });
    const out = await byName(tools, "rename_symbol").handler(renameInput());
    expect(typeof out).toBe("string");
    expect(out).toContain("(no LSP server configured");
  });
});

// ── Normalization function surface: each kind stays distinguishable (no disk writes) ─

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
    // A null from the server = the rename was refused; the handler already
    // translates it upstream into a typed same-scope-conflict failure
    // (makeRenameSymbolTool's result === null branch). Normalization only
    // needs to not throw on these "legally absent" shapes. Same for `{}`:
    // neither shape field present = zero entries.
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
    // An unreadable envelope = this response is unusable, a different thing
    // from "the server says nothing to change": the latter is a legal no-op,
    // the former must be a typed failure — otherwise the handler would
    // report `renamed: true, editCount: 0` as success.
    for (const raw of ["nope", 42, [goodEdit]]) {
      const thrown = captureThrow(() =>
        normalizeWorkspaceEdit(raw)
      ) as WorkspaceEditUnsupportedError;
      expect(thrown).toBeInstanceOf(WorkspaceEditUnsupportedError);
      expect(thrown.kind).toBe("malformed-entry");
    }
  });

  it("rejects a present-but-wrong-shaped changes / documentChanges", () => {
    // Both shape fields are "present" yet yield no readable entries: must
    // not be silently passed as "zero entries".
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
    // Normalization checks shape only and never resolves uris — resolution
    // lives in applyWorkspaceEdit's groupEditsByPath, which is where
    // "cannot become a file path" is detected and unresolvable-uri is
    // thrown (see the runRename disk-path case above).
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [
          { textDocument: { uri: "untitled:foo" }, edits: [goodEdit] },
        ],
      })
    ).toEqual([{ textDocument: { uri: "untitled:foo" }, edits: [goodEdit] }]);
  });
});

/** Run and capture a throw; undefined if none (lets each case assert its kind individually, unlike expect(...).toThrow). */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}
