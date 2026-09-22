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
