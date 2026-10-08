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
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AciToolDef } from "../../../src/harness/aci/types.ts";
import type { PreimageCaptureInput } from "../../../src/harness/aci/preimage-port.ts";
import type { LiveTaskRoot } from "../../../src/harness/session-roots.ts";
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../../src/harness/session-roots.ts";
import { ToolExecutionError } from "../../../src/harness/errors.ts";

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

// ── Live task-root rebind: every mutation lands on the ACTIVE tree ──

describe("after a live task-root rebind, mutations follow the active tree", () => {
  /** Same body, different tail: each tree's bytes are individually provable,
   *  so "which tree was written" is decidable from the bytes alone. */
  const TREE_BODY = (marker: string): string =>
    [
      "const foo = 1;",
      "function bar() {",
      "  return foo;",
      "}",
      `// ${marker}`,
    ].join("\n");

  let oldDir: string;
  let newDir: string;
  let cell: LiveTaskRoot;
  let tools: ReadonlyArray<AciToolDef>;
  let onEditCalls: string[];
  let captured: PreimageCaptureInput[];
  let rpcUris: string[];

  beforeEach(async () => {
    oldDir = await mkdtemp(path.join(os.tmpdir(), "symbol-mutate-old-"));
    newDir = await mkdtemp(path.join(os.tmpdir(), "symbol-mutate-new-"));
    for (const dir of [oldDir, newDir]) {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(
        path.join(dir, "src", "a.ts"),
        TREE_BODY(path.basename(dir)),
        "utf8"
      );
    }
    cell = createLiveTaskRoot(oldDir);
    onEditCalls = [];
    captured = [];
    rpcUris = [];
    // The tool set is assembled BEFORE the rebind, exactly as the registry
    // does at engine build time: anything frozen to ctx.directory at factory
    // time is the stale tree here.
    tools = createSymbolMutateToolSet({
      ctx: { directory: oldDir, directoryCell: cell },
      onEdit: (file) => onEditCalls.push(file),
      preimageCapture: (input) => {
        captured.push(input);
      },
    });
  });

  afterEach(async () => {
    await rm(oldDir, { recursive: true, force: true });
    await rm(newDir, { recursive: true, force: true });
  });

  /** A client that echoes the requested document uri back into the
   *  WorkspaceEdit, so one pass proves the request URI, the applied target,
   *  and the onEdit path all name the same tree. */
  function rebindClient(): unknown {
    return {
      connection: {} as never,
      process: {} as never,
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(_file: string, fn: () => Promise<T>) => fn(),
      sendRequest: async (method: string, params: unknown) => {
        const uri = (params as { textDocument?: { uri?: string } }).textDocument
          ?.uri;
        if (uri) rpcUris.push(uri);
        if (method === DOCUMENT_SYMBOL) return SAMPLE_SYMBOL_TREE;
        if (method === "textDocument/references") return [];
        return {
          documentChanges: [{ textDocument: { uri }, edits: [FOO_EDIT] }],
        };
      },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      getDocumentFingerprint: () => "fp-1",
      dispose: () => undefined,
    };
  }

  const newTreeFile = (): string => path.join(newDir, "src", "a.ts");
  const oldTreeFile = (): string => path.join(oldDir, "src", "a.ts");
  const oldTreeBytes = (): string => TREE_BODY(path.basename(oldDir));
  const RELATIVE_INPUT = "src/a.ts";

  /** Rebind to newDir, then run one tool against the relative input. */
  async function runAfterRebind(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    mockGetClientDetailed.mockResolvedValue({ client: rebindClient() });
    writeLiveTaskRoot(cell, newDir);
    return (await byName(tools, name).handler({
      file: RELATIVE_INPUT,
      ...input,
    })) as string;
  }

  it("all five mutation tools write the ACTIVE tree and leave the old tree byte-identical", async () => {
    const cases: ReadonlyArray<
      readonly [string, Record<string, unknown>, string]
    > = [
      ["rename_symbol", { symbol_path: "Foo", new_name: "baz" }, "renamed"],
      [
        "replace_symbol_body",
        { symbol_path: "Foo", new_body: "const foo = 2;\n" },
        "replaced",
      ],
      [
        "insert_before_symbol",
        { symbol_path: "Foo", code: "// before" },
        "inserted",
      ],
      [
        "insert_after_symbol",
        { symbol_path: "Foo", code: "// after" },
        "inserted",
      ],
      ["safe_delete_symbol", { symbol_path: "Foo" }, "deleted"],
    ];

    for (const [name, input, receiptKey] of cases) {
      // Each tool gets its own fresh pair of trees so a case cannot be masked
      // by the previous case's writes.
      await resetTrees();
      onEditCalls.length = 0;
      captured.length = 0;
      rpcUris.length = 0;

      const out = await runAfterRebind(name, input);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed[receiptKey], name).toBe(true);
      // The reported files, the notifier invalidation and the preimage all
      // identify the same ACTIVE-tree absolute path.
      expect(parsed.files, name).toEqual([newTreeFile()]);
      expect(onEditCalls, name).toEqual([newTreeFile()]);
      expect(captured, name).toHaveLength(1);
      expect(
        path.join(captured[0]!.rootIdentity, captured[0]!.relPath),
        name
      ).toBe(newTreeFile());
      expect(captured[0]!.relPath, name).toBe(RELATIVE_INPUT);
      expect(captured[0]!.rootIdentity, name).toBe(newDir);
      // Bytes: the active tree changed, the old tree did not.
      expect(await readFile(newTreeFile(), "utf8"), name).not.toBe(
        TREE_BODY(path.basename(newDir))
      );
      expect(await readFile(oldTreeFile(), "utf8"), name).toBe(oldTreeBytes());
    }
  });

  /** Rewrite both trees back to their fixture bytes (fresh round per tool). */
  async function resetTrees(): Promise<void> {
    await writeFile(newTreeFile(), TREE_BODY(path.basename(newDir)), "utf8");
    await writeFile(oldTreeFile(), oldTreeBytes(), "utf8");
    writeLiveTaskRoot(cell, oldDir);
  }

  it("rename sends the request for the ACTIVE tree's absolute path", async () => {
    const out = await runAfterRebind("rename_symbol", {
      symbol_path: "Foo",
      new_name: "baz",
    });
    expect(JSON.parse(out)).toMatchObject({ renamed: true });
    // Two URI-bearing requests: the documentSymbol lookup and the rename
    // itself — both must address the ACTIVE tree.
    expect(rpcUris).toEqual([uriOf(newTreeFile()), uriOf(newTreeFile())]);
  });

  it("refuses an input that escapes the active root instead of writing outside it", async () => {
    // The escape resolves (no anchor escapes the mock's root finding), so the
    // applier's containment screen is the only thing standing between the
    // server's edit set and a file outside the active tree. Both spellings
    // name a real file: a ../ traversal and an absolute path in the OLD tree.
    for (const escaping of [
      "../outside.ts",
      path.join(oldDir, "src", "a.ts"),
    ]) {
      await resetTrees();
      onEditCalls.length = 0;
      captured.length = 0;
      mockGetClientDetailed.mockResolvedValue({
        client: {
          ...(rebindClient() as Record<string, unknown>),
          sendRequest: async (method: string, params: unknown) => {
            const uri = (params as { textDocument?: { uri?: string } })
              .textDocument?.uri;
            if (method === DOCUMENT_SYMBOL) return SAMPLE_SYMBOL_TREE;
            // A server that drags the escaped anchor into its edit set.
            return {
              documentChanges: [
                {
                  textDocument: { uri: uri ?? uriOf(newTreeFile()) },
                  edits: [FOO_EDIT],
                },
              ],
            };
          },
        },
      });
      writeLiveTaskRoot(cell, newDir);
      const out = (await byName(tools, "replace_symbol_body").handler({
        file: escaping,
        symbol_path: "Foo",
        new_body: "const foo = 3;\n",
      })) as string;

      // Typed refusal, not an empty success: the result is a sentinel string
      // naming the write denial, and nothing was written or invalidated.
      expect(typeof out, escaping).toBe("string");
      expect(out, escaping).toMatch(/\(write denied for /);
      expect(out, escaping).toContain("no edits were applied");
      expect(onEditCalls, escaping).toEqual([]);
      expect(captured, escaping).toEqual([]);
      expect(await readFile(oldTreeFile(), "utf8"), escaping).toBe(
        oldTreeBytes()
      );
      expect(await readFile(newTreeFile(), "utf8"), escaping).toBe(
        TREE_BODY(path.basename(newDir))
      );
    }
  });

  it("refuses a protected path inside the active root before any write", async () => {
    await mkdir(path.join(newDir, "src"), { recursive: true });
    const envFile = path.join(newDir, "src", ".env");
    await writeFile(envFile, "SECRET=synthetic\n", "utf8");
    mockGetClientDetailed.mockResolvedValue({ client: rebindClient() });
    writeLiveTaskRoot(cell, newDir);
    const out = (await byName(tools, "replace_symbol_body").handler({
      file: "src/.env",
      symbol_path: "Foo",
      new_body: "leaked\n",
    })) as string;

    expect(out).toMatch(/read denied for .*\.env/);
    expect(out).toContain("protected-path rule");
    expect(await readFile(envFile, "utf8")).toBe("SECRET=synthetic\n");
    expect(onEditCalls).toEqual([]);
    expect(await readFile(newTreeFile(), "utf8")).toBe(
      TREE_BODY(path.basename(newDir))
    );
  });

  it("still fails typed when the applier cannot write the resolved path", async () => {
    // The containment screen is not the only write barrier: an unremovable
    // file inside the active root must surface as the existing typed write
    // failure, never as a successful receipt.
    const target = path.join(newDir, "src", "locked.ts");
    await writeFile(target, TREE_BODY("locked"), "utf8");
    await rm(target, { force: true });
    await mkdir(target, { recursive: true }); // a directory cannot be published over
    mockGetClientDetailed.mockResolvedValue({
      client: {
        ...(rebindClient() as Record<string, unknown>),
        sendRequest: async (method: string, params: unknown) => {
          const uri = (params as { textDocument?: { uri?: string } })
            .textDocument?.uri;
          if (method === DOCUMENT_SYMBOL) return SAMPLE_SYMBOL_TREE;
          return {
            documentChanges: [{ textDocument: { uri }, edits: [FOO_EDIT] }],
          };
        },
      },
    });
    writeLiveTaskRoot(cell, newDir);
    let thrown: unknown;
    try {
      await byName(tools, "replace_symbol_body").handler({
        file: "src/locked.ts",
        symbol_path: "Foo",
        new_body: "const foo = 9;\n",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolExecutionError);
    expect((thrown as Error).message).toContain("[symbol-mutate] cannot read");
    expect(onEditCalls).toEqual([]);
  });

  // ── Write containment is judged on the CANONICAL target ──
  //
  // `isWithinRoot` is pure `path.relative` and never follows a link, so a
  // symlink INSIDE the root pointing OUTSIDE it passes a lexical screen while
  // the write (publishFile degrades to an in-place `writeFile` for a
  // non-regular-file target) follows the link and lands bytes outside the
  // active tree. These pin the canonical verdict in both directions, plus the
  // undecidable-target refusals.

  /** A client whose rename returns one fixed WorkspaceEdit uri (the server
   *  dragged some path into the change); the anchor documentSymbol still
   *  resolves so the handler reaches the applier. */
  function clientReturningEdit(editUri: string): unknown {
    return {
      ...(rebindClient() as Record<string, unknown>),
      sendRequest: async (method: string) => {
        if (method === DOCUMENT_SYMBOL) return SAMPLE_SYMBOL_TREE;
        if (method === "textDocument/references") return [];
        return {
          documentChanges: [
            { textDocument: { uri: editUri }, edits: [FOO_EDIT] },
          ],
        };
      },
    };
  }

  it("refuses a symlink inside the active root whose target escapes it, before any write", async () => {
    await resetTrees();
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "symbol-mutate-escape-")
    );
    const outsideFile = path.join(outsideDir, "stranger.ts");
    const outsideBody = "export const stranger = 1;\n";
    await writeFile(outsideFile, outsideBody, "utf8");
    const linkPath = path.join(newDir, "src", "link.ts");
    await symlink(outsideFile, linkPath);
    try {
      onEditCalls.length = 0;
      captured.length = 0;
      mockGetClientDetailed.mockResolvedValue({
        client: clientReturningEdit(uriOf(linkPath)),
      });
      writeLiveTaskRoot(cell, newDir);
      const out = (await byName(tools, "rename_symbol").handler({
        file: "src/link.ts",
        symbol_path: "Foo",
        new_name: "baz",
      })) as string;

      // Typed refusal on the same channel as every other write denial …
      expect(typeof out).toBe("string");
      expect(out).toMatch(/\(write denied for /);
      expect(out).toContain(linkPath);
      // … and the whole batch is untouched: no preimage, no invalidate.
      expect(captured).toEqual([]);
      expect(onEditCalls).toEqual([]);
      // The link's target (OUTSIDE the active root) keeps its bytes.
      expect(await readFile(outsideFile, "utf8")).toBe(outsideBody);
      // No in-root file was written either.
      expect(await readFile(newTreeFile(), "utf8")).toBe(
        TREE_BODY(path.basename(newDir))
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("permits an in-root symlink whose target is also inside the active root", async () => {
    await resetTrees();
    const target = path.join(newDir, "src", "target.ts");
    const targetBody = TREE_BODY("target");
    await writeFile(target, targetBody, "utf8");
    const linkPath = path.join(newDir, "src", "link.ts");
    await symlink(target, linkPath);
    onEditCalls.length = 0;
    captured.length = 0;
    mockGetClientDetailed.mockResolvedValue({
      client: clientReturningEdit(uriOf(linkPath)),
    });
    writeLiveTaskRoot(cell, newDir);
    const out = (await byName(tools, "rename_symbol").handler({
      file: "src/link.ts",
      symbol_path: "Foo",
      new_name: "baz",
    })) as string;

    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.renamed).toBe(true);
    expect(parsed.files).toEqual([linkPath]);
    expect(onEditCalls).toEqual([linkPath]);
    expect(captured).toHaveLength(1);
    // The write followed the link and landed on the in-root target.
    expect(await readFile(target, "utf8")).toBe(
      targetBody.replace("const foo", "const baz")
    );
  });

  it("refuses a dangling symlink write target instead of writing or throwing", async () => {
    await resetTrees();
    const linkPath = path.join(newDir, "src", "dangling.ts");
    await symlink(path.join(newDir, "src", "missing.ts"), linkPath);
    onEditCalls.length = 0;
    captured.length = 0;
    mockGetClientDetailed.mockResolvedValue({
      client: clientReturningEdit(uriOf(linkPath)),
    });
    writeLiveTaskRoot(cell, newDir);
    // Anchor on an ordinary in-root file so the ENTRY read-policy gate allows
    // the call; the server then drags the dangling link into its edit set,
    // which only the applier's containment screen can refuse.
    const out = (await byName(tools, "rename_symbol").handler({
      file: "src/a.ts",
      symbol_path: "Foo",
      new_name: "baz",
    })) as string;

    expect(typeof out).toBe("string");
    expect(out).toMatch(/\(write denied for /);
    expect(out).toContain(linkPath);
    expect(captured).toEqual([]);
    expect(onEditCalls).toEqual([]);
    expect(await readFile(newTreeFile(), "utf8")).toBe(
      TREE_BODY(path.basename(newDir))
    );
  });

  it("refuses a symlink-loop write target instead of writing or throwing", async () => {
    await resetTrees();
    const linkPath = path.join(newDir, "src", "loop.ts");
    // A relative self-target: the link resolves to itself → ELOOP.
    await symlink("loop.ts", linkPath);
    onEditCalls.length = 0;
    captured.length = 0;
    mockGetClientDetailed.mockResolvedValue({
      client: clientReturningEdit(uriOf(linkPath)),
    });
    writeLiveTaskRoot(cell, newDir);
    const out = (await byName(tools, "rename_symbol").handler({
      file: "src/a.ts",
      symbol_path: "Foo",
      new_name: "baz",
    })) as string;

    expect(typeof out).toBe("string");
    expect(out).toMatch(/\(write denied for /);
    expect(out).toContain(linkPath);
    expect(captured).toEqual([]);
    expect(onEditCalls).toEqual([]);
    expect(await readFile(newTreeFile(), "utf8")).toBe(
      TREE_BODY(path.basename(newDir))
    );
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
