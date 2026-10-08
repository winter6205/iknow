/**
 * tests/harness/aci/symbol-mutate-preimage.test.ts — ADR-0036 / ADR-0121
 * preimage seam on the multi-file mutate path.
 *
 * Invariant pinned: a cross-file rename stages **every** file's preimage
 * before it writes **any** of them. A rename is one logical change, so a
 * capture that refuses partway must leave the whole workspace as it was —
 * a half-renamed tree has no preimage the rewind could restore from, and the
 * transcript would carry a ref for bytes that were already overwritten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

const { mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClientDetailed: vi.fn<() => Promise<unknown>>(),
}));

// Only the client lookup is faked: the applier, the normalization and the real
// temp filesystem stay in play, because "nothing landed on disk" is the claim.
vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return { ...actual, getClientDetailed: mockGetClientDetailed };
});

import { createSymbolMutateToolSet } from "../../../src/harness/aci/tools/symbol-mutate.ts";

const DOCUMENT_SYMBOL = "textDocument/documentSymbol";
const SAMPLE_SYMBOL_TREE = [
  {
    name: "Foo",
    kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
    selectionRange: { start: { line: 0, character: 6 } },
  },
];
const MAIN_BODY = [
  "const foo = 1;",
  "function bar() {",
  "  return foo;",
  "}",
].join("\n");
const OTHER_BODY = "foo();\n";
const MAIN_EDIT = {
  range: {
    start: { line: 0, character: 6 },
    end: { line: 0, character: 9 },
  },
  newText: "baz",
};
const OTHER_EDIT = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 3 },
  },
  newText: "baz",
};
let workDir: string;
let mainFile: string;
let otherFile: string;

beforeEach(async () => {
  mockGetClientDetailed.mockReset();
  workDir = await mkdtemp(path.join(os.tmpdir(), "symbol-mutate-preimg-"));
  await writeFile(path.join(workDir, "a.ts"), MAIN_BODY, "utf8");
  await writeFile(path.join(workDir, "b.ts"), OTHER_BODY, "utf8");
  mainFile = path.join(workDir, "a.ts");
  otherFile = path.join(workDir, "b.ts");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function renameResult(): unknown {
  return {
    documentChanges: [
      {
        textDocument: { uri: pathToFileURL(mainFile).href },
        edits: [MAIN_EDIT],
      },
      {
        textDocument: { uri: pathToFileURL(otherFile).href },
        edits: [OTHER_EDIT],
      },
    ],
  };
}

function byName(tools: ReadonlyArray<AciToolDef>, name: string): AciToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

async function runRename(
  preimageCapture: (input: PreimageCaptureInput) => void | Promise<void>
): Promise<unknown> {
  mockGetClientDetailed.mockResolvedValue({
    client: {
      connection: {} as never,
      process: {} as never,
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(_file: string, fn: () => Promise<T>) => fn(),
      sendRequest: async (method: string) =>
        method === DOCUMENT_SYMBOL ? SAMPLE_SYMBOL_TREE : renameResult(),
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      getDocumentFingerprint: () => "fp-1",
      dispose: () => undefined,
    },
  });
  const tools = createSymbolMutateToolSet({
    ctx: { directory: workDir },
    preimageCapture,
  });
  return byName(tools, "rename_symbol").handler({
    file: mainFile,
    symbol_path: "Foo",
    new_name: "baz",
  });
}

describe("rename_symbol → preimage port stages all files first", () => {
  it("captures both preimages while neither file has been written yet", async () => {
    const seen: PreimageCaptureInput[] = [];
    const liveBytesAtCapture: string[] = [];
    await runRename((input) => {
      seen.push(input);
      // Reading the *other* file at capture time is the ordering proof: a
      // write-then-capture loop would already show its edited bytes.
      liveBytesAtCapture.push(
        `${readFileSync(mainFile, "utf8")}|${readFileSync(otherFile, "utf8")}`
      );
    });

    expect(seen.map((r) => r.relPath)).toEqual(["a.ts", "b.ts"]);
    expect(seen[0]!.preBytes.toString("utf8")).toBe(MAIN_BODY);
    expect(seen[1]!.preBytes.toString("utf8")).toBe(OTHER_BODY);
    // symbol-mutate only ever edits files it just read → no create evidence.
    expect(seen[0]!.absentBefore).toBe(false);
    expect(seen[1]!.absentBefore).toBe(false);
    expect(liveBytesAtCapture).toEqual([
      `${MAIN_BODY}|${OTHER_BODY}`,
      `${MAIN_BODY}|${OTHER_BODY}`,
    ]);
    // Both edits did land afterwards, so the staging is not a refusal to apply.
    expect(await readFile(mainFile, "utf8")).not.toBe(MAIN_BODY);
    expect(await readFile(otherFile, "utf8")).not.toBe(OTHER_BODY);
  });

  it("a capture that refuses on the second file leaves BOTH files untouched", async () => {
    let calls = 0;
    await expect(
      runRename(() => {
        calls += 1;
        if (calls === 2) throw new Error("capture refused");
      })
    ).rejects.toThrow(/capture refused/);

    expect(calls).toBe(2);
    expect(await readFile(mainFile, "utf8")).toBe(MAIN_BODY);
    expect(await readFile(otherFile, "utf8")).toBe(OTHER_BODY);
  });
});

describe("the whole-batch preimage contract survives a live task-root rebind", () => {
  /** Byte-identical bodies in both trees, so only the TREE the write landed
   *  in is decidable — the preimage root must come from the active cell. */
  let oldDir: string;
  let newDir: string;
  let cell: LiveTaskRoot;
  let outsideDir: string;
  let outsideFile: string;

  const treeBody = (marker: string): string => `${MAIN_BODY}\n// ${marker}\n`;
  const OTHER_TREE_BODY = (marker: string): string =>
    `${OTHER_BODY}// ${marker}\n`;

  beforeEach(async () => {
    oldDir = await mkdtemp(path.join(os.tmpdir(), "symbol-mutate-preimg-old-"));
    newDir = await mkdtemp(path.join(os.tmpdir(), "symbol-mutate-preimg-new-"));
    outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "symbol-mutate-preimg-out-")
    );
    for (const dir of [oldDir, newDir]) {
      await writeFile(
        path.join(dir, "a.ts"),
        treeBody(path.basename(dir)),
        "utf8"
      );
      await writeFile(
        path.join(dir, "b.ts"),
        OTHER_TREE_BODY(path.basename(dir)),
        "utf8"
      );
    }
    outsideFile = path.join(outsideDir, "stranger.ts");
    await writeFile(outsideFile, "export const stranger = 1;\n", "utf8");
    cell = createLiveTaskRoot(oldDir);
  });

  afterEach(async () => {
    for (const dir of [oldDir, newDir, outsideDir]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Assemble the tool set against the OLD tree (as the registry does before
   *  the switch), rebind, then run a rename whose input is relative. */
  async function runRenameAfterRebind(
    preimageCapture: (input: PreimageCaptureInput) => void | Promise<void>,
    editTargets: (requestedUri: string | undefined) => unknown,
    onEditCalls?: string[]
  ): Promise<unknown> {
    mockGetClientDetailed.mockResolvedValue({
      client: {
        connection: {} as never,
        process: {} as never,
        getServerCapabilities: () => ({}),
        ensureOpen: async () => undefined,
        withDocumentOpen: async <T>(_file: string, fn: () => Promise<T>) =>
          fn(),
        sendRequest: async (method: string, params: unknown) => {
          if (method === DOCUMENT_SYMBOL) return SAMPLE_SYMBOL_TREE;
          const uri = (params as { textDocument?: { uri?: string } })
            .textDocument?.uri;
          return editTargets(uri);
        },
        sendNotification: async () => undefined,
        getDiagnostics: () => [] as ReadonlyArray<unknown>,
        getDocumentFingerprint: () => "fp-1",
        dispose: () => undefined,
      },
    });
    const tools = createSymbolMutateToolSet({
      ctx: { directory: oldDir, directoryCell: cell },
      preimageCapture,
      onEdit:
        onEditCalls === undefined ? undefined : (f) => onEditCalls.push(f),
    });
    writeLiveTaskRoot(cell, newDir);
    return byName(tools, "rename_symbol").handler({
      file: "a.ts",
      symbol_path: "Foo",
      new_name: "baz",
    });
  }

  it("captures the whole batch against the ACTIVE root before any byte lands", async () => {
    const seen: PreimageCaptureInput[] = [];
    const liveBytesAtCapture: string[] = [];
    const a = path.join(newDir, "a.ts");
    const b = path.join(newDir, "b.ts");
    await runRenameAfterRebind(
      (input) => {
        seen.push(input);
        liveBytesAtCapture.push(
          `${readFileSync(a, "utf8")}|${readFileSync(b, "utf8")}`
        );
      },
      () => ({
        documentChanges: [
          {
            textDocument: {
              uri: pathToFileURL(path.join(newDir, "a.ts")).href,
            },
            edits: [MAIN_EDIT],
          },
          {
            textDocument: { uri: pathToFileURL(b).href },
            edits: [OTHER_EDIT],
          },
        ],
      })
    );

    // relPath is measured from the tree the write resolved against, not from
    // the root the tool set was assembled with.
    expect(seen.map((r) => r.rootIdentity)).toEqual([newDir, newDir]);
    expect(seen.map((r) => r.relPath)).toEqual(["a.ts", "b.ts"]);
    expect(seen[0]!.preBytes.toString("utf8")).toBe(
      treeBody(path.basename(newDir))
    );
    expect(seen[1]!.preBytes.toString("utf8")).toBe(
      OTHER_TREE_BODY(path.basename(newDir))
    );
    expect(liveBytesAtCapture).toEqual([
      `${treeBody(path.basename(newDir))}|${OTHER_TREE_BODY(
        path.basename(newDir)
      )}`,
      `${treeBody(path.basename(newDir))}|${OTHER_TREE_BODY(
        path.basename(newDir)
      )}`,
    ]);
    // Both edits landed in the ACTIVE tree only.
    expect(await readFile(a, "utf8")).not.toBe(treeBody(path.basename(newDir)));
    expect(await readFile(b, "utf8")).not.toBe(
      OTHER_TREE_BODY(path.basename(newDir))
    );
    expect(await readFile(path.join(oldDir, "a.ts"), "utf8")).toBe(
      treeBody(path.basename(oldDir))
    );
    expect(await readFile(path.join(oldDir, "b.ts"), "utf8")).toBe(
      OTHER_TREE_BODY(path.basename(oldDir))
    );
  });

  it("a server-returned target OUTSIDE the active root refuses the batch before any write", async () => {
    const seen: PreimageCaptureInput[] = [];
    const onEditCalls: string[] = [];
    const out = (await runRenameAfterRebind(
      (input) => {
        seen.push(input);
      },
      () => ({
        documentChanges: [
          {
            textDocument: {
              uri: pathToFileURL(path.join(newDir, "a.ts")).href,
            },
            edits: [MAIN_EDIT],
          },
          // The legal in-root edit comes FIRST: the screen must reject the
          // whole batch, not write this one and stop.
          {
            textDocument: { uri: pathToFileURL(outsideFile).href },
            edits: [OTHER_EDIT],
          },
        ],
      }),
      onEditCalls
    )) as string;

    expect(typeof out).toBe("string");
    expect(out).toMatch(/\(write denied for /);
    expect(out).toContain(outsideFile);
    expect(seen).toEqual([]);
    expect(onEditCalls).toEqual([]);
    expect(await readFile(path.join(newDir, "a.ts"), "utf8")).toBe(
      treeBody(path.basename(newDir))
    );
    expect(await readFile(outsideFile, "utf8")).toBe(
      "export const stranger = 1;\n"
    );
    expect(await readFile(path.join(oldDir, "a.ts"), "utf8")).toBe(
      treeBody(path.basename(oldDir))
    );
  });

  it("a server-returned PROTECTED path inside the active root refuses the batch before any write", async () => {
    // .env is inside the active root, so containment alone would allow it; the
    // read-policy screen is the only barrier and it must fire on the same
    // whole-batch, before-capture posture as the containment one.
    const envFile = path.join(newDir, ".env");
    await writeFile(envFile, "SECRET=synthetic\n", "utf8");
    const seen: PreimageCaptureInput[] = [];
    const onEditCalls: string[] = [];
    const out = (await runRenameAfterRebind(
      (input) => {
        seen.push(input);
      },
      () => ({
        documentChanges: [
          {
            textDocument: {
              uri: pathToFileURL(path.join(newDir, "a.ts")).href,
            },
            edits: [MAIN_EDIT],
          },
          {
            textDocument: { uri: pathToFileURL(envFile).href },
            edits: [OTHER_EDIT],
          },
        ],
      }),
      onEditCalls
    )) as string;

    expect(out).toMatch(/read denied for /);
    expect(out).toContain("protected-path rule");
    expect(seen).toEqual([]);
    expect(onEditCalls).toEqual([]);
    expect(await readFile(path.join(newDir, "a.ts"), "utf8")).toBe(
      treeBody(path.basename(newDir))
    );
    expect(await readFile(envFile, "utf8")).toBe("SECRET=synthetic\n");
  });
});
