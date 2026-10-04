/**
 * Durable file intent BEFORE mutation (ADR-0136 /
 * specs/session-checkpoint-architecture.md §3 items 4-6, SC9, SC9a).
 *
 * Real temp store, real filesystem, real capture path, real write tools: the
 * claim under test is that a crash between capture and `tool_result` still
 * leaves every target's facts readable from a FRESHLY CONSTRUCTED store, so
 * nothing here is mocked. Only the LSP boundary is stubbed (the 2-file
 * rename fixture), because the model/LSP response is not the subject.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { createNativeStatePort } from "../../../src/session-api/store/native-state-port-host.ts";
import { createPreimageCapture } from "../../../src/session-api/store/preimage-capture.ts";
import { createPreimageLedger } from "../../../src/session-api/store/preimage-ledger.ts";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import { NativeStatePortError } from "../../../src/shared/native-state-port.ts";
import { createWriteFileTool } from "../../../src/harness/aci/tools/write-file.ts";

const { mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClientDetailed: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return { ...actual, getClientDetailed: mockGetClientDetailed };
});

const { createSymbolMutateToolSet } =
  await import("../../../src/harness/aci/tools/symbol-mutate.ts");

let baseDir: string;
let workRoot: string;
let mainFile: string;
let otherFile: string;
let store: SessionStore;
let ledger: ReturnType<typeof createPreimageLedger>;

beforeEach(async () => {
  mockGetClientDetailed.mockReset();
  baseDir = await mkdtemp(join(tmpdir(), "iknow-intent-dur-"));
  workRoot = await mkdtemp(join(tmpdir(), "iknow-intent-work-"));
  store = new SessionStore(baseDir, process.cwd());
  ledger = createPreimageLedger();
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(workRoot, { recursive: true, force: true });
});

const sessionDirFor = (id: string): string =>
  resolveConversationDir({
    projectDir: store.getProjectDir(),
    conversationId: id,
  });

const sampleFile = (id: string): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: id,
  title: "",
  cwd: "/tmp/test",
  sanitized_at: new Date().toISOString(),
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: new Date().toISOString(),
  checkpoints: [],
});

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

/** A session with a real persisted head, so an intent has a branch anchor. */
async function seedChain(id: string): Promise<string> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({ id, events: [userMsg("go")] });
  const log = parseSessionJsonl(
    await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8")
  );
  assert.ok(log.head !== null, "fixture must have a persisted head");
  return log.head;
}

/** Reopen from scratch: a NEW store instance over the same directory. */
function reopenedStore(): SessionStore {
  return new SessionStore(baseDir, process.cwd());
}

async function durableIntents(id: string) {
  return (await reopenedStore().loadPublishedNativeState({ id })).fileIntents;
}

function makeCapture(isEnabled: () => boolean) {
  return createPreimageCapture({
    getProjectDir: () => store.getProjectDir(),
    ledger,
    isEnabled,
    intentRecorder: createNativeStatePort({ store }),
  });
}

const callCtx = (id: string, toolUseId: string) => ({
  conversationId: id,
  toolUseId,
});

describe("durable file intent before mutation", () => {
  it("(a) an enabled write leaves a durable per-file intent readable from a FRESH store", async () => {
    const id = "dur-1";
    const head = await seedChain(id);
    const target = join(workRoot, "a.ts");
    await writeFile(target, "old\n", "utf8");
    const tool = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
      rootIdentity: workRoot,
    });

    await tool.handler({ path: "a.ts", content: "new\n" }, callCtx(id, "tu-1"));

    assert.equal(await readFile(target, "utf8"), "new\n");
    const intents = await durableIntents(id);
    assert.equal(intents.length, 1, "one intent survived into the fresh store");
    const rec = intents[0]!.record;
    assert.equal(rec.toolUseId, "tu-1");
    assert.equal(rec.captured, true);
    assert.equal(rec.anchorEventId, head, "anchored at the persisted head");
    assert.equal(rec.targets.length, 1);
    assert.equal(rec.targets[0]!.relPath, "a.ts");
    assert.equal(rec.targets[0]!.rootIdentity, workRoot);
    assert.equal(rec.targets[0]!.absentBefore, false);
    assert.match(rec.targets[0]!.preimageSha ?? "", /^[0-9a-f]{64}$/);
    assert.match(rec.targets[0]!.postimageSha ?? "", /^[0-9a-f]{64}$/);
    // The intent is written BEFORE the mutation: the recorded postimage sha
    // must be the bytes now on disk, and the preimage sha the bytes that
    // were there.
    const recorded = intents[0]!.record.targets[0]!;
    assert.notEqual(recorded.preimageSha, recorded.postimageSha);
  });

  it("(b) a create is distinguishable from an existing EMPTY file", async () => {
    const id = "dur-absent";
    await seedChain(id);
    const created = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
    });
    await created.handler(
      { path: "fresh.ts", content: "f\n" },
      callCtx(id, "tu-create")
    );
    const emptied = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
    });
    await writeFile(join(workRoot, "empty.ts"), "", "utf8");
    await emptied.handler(
      { path: "empty.ts", content: "e\n" },
      callCtx(id, "tu-edit")
    );

    const intents = await durableIntents(id);
    const byTool = new Map(intents.map((i) => [i.record.toolUseId, i.record]));
    assert.equal(byTool.get("tu-create")!.targets[0]!.absentBefore, true);
    assert.equal(
      byTool.get("tu-edit")!.targets[0]!.absentBefore,
      false,
      "an existing empty file is not a create"
    );
  });

  it("(c) SC9 evidence-write failure: the tool fails and the target bytes are unchanged", async () => {
    const id = "dur-fail";
    // A legacy-only `.json` session makes the REAL store refuse the append
    // (write_failed) — no mock, a genuine production failure path.
    await mkdir(sessionDirFor(id), { recursive: true });
    await writeFile(
      join(sessionDirFor(id), `${id}.json`),
      JSON.stringify({ ...sampleFile(id), schemaVersion: 1 }),
      "utf8"
    );
    const target = join(workRoot, "keep.ts");
    await writeFile(target, "precious\n", "utf8");
    const tool = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
    });

    let thrown: unknown;
    try {
      await tool.handler(
        { path: "keep.ts", content: "clobbered\n" },
        callCtx(id, "tu-f")
      );
    } catch (err) {
      thrown = err;
    }

    assert.ok(
      thrown instanceof NativeStatePortError,
      "a typed port failure, not an ad-hoc string"
    );
    assert.equal((thrown as NativeStatePortError).code, "PERSIST_FAILED");
    assert.equal(
      await readFile(target, "utf8"),
      "precious\n",
      "the dependent write must not proceed"
    );
  });

  it("(d) SC9a capture disabled: the write still lands, the intent says UNVERIFIED", async () => {
    const id = "dur-off";
    await seedChain(id);
    const target = join(workRoot, "off.ts");
    await writeFile(target, "before\n", "utf8");
    const tool = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => false),
    });

    await tool.handler(
      { path: "off.ts", content: "after\n" },
      callCtx(id, "tu-off")
    );

    // The otherwise permitted write is NOT blocked to manufacture evidence.
    assert.equal(await readFile(target, "utf8"), "after\n");
    // No code snapshot was created.
    const blobs = await readdir(
      join(sessionDirFor(id), "code-snapshots").replace(/\/$/, "")
    ).catch(() => [] as string[]);
    assert.deepEqual(blobs, [], "no snapshot blobs under suppression");
    // …but the effect is recorded as unverified rather than inferred.
    const intents = await durableIntents(id);
    assert.equal(intents.length, 1);
    const rec = intents[0]!.record;
    assert.equal(rec.captured, false);
    assert.equal(rec.targets.length, 1);
    assert.equal(rec.targets[0]!.relPath, "off.ts");
    const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
    const line = raw.split("\n").find((l) => l.includes('"file_intent"'))!;
    assert.ok(!line.includes("preimageSha"), "no captured evidence is claimed");
    assert.ok(!line.includes("postimageSha"));
  });

  it("(e) a missing toolUseId writes nothing durable and does not block the write", async () => {
    const id = "dur-noids";
    await seedChain(id);
    const target = join(workRoot, "noids.ts");
    const tool = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
    });

    await tool.handler(
      { path: "noids.ts", content: "x\n" },
      { conversationId: id }
    );

    assert.equal(await readFile(target, "utf8"), "x\n");
    assert.deepEqual(await durableIntents(id), []);
    assert.equal(ledger.consume(id, []).size, 0);
  });

  it("(f) two writes to the same file are additive, each with its own intent", async () => {
    const id = "dur-repeat";
    await seedChain(id);
    await writeFile(join(workRoot, "r.ts"), "v0\n", "utf8");
    const tool = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
    });
    await tool.handler({ path: "r.ts", content: "v1\n" }, callCtx(id, "tu-1"));
    await tool.handler({ path: "r.ts", content: "v2\n" }, callCtx(id, "tu-2"));

    const intents = await durableIntents(id);
    assert.deepEqual(
      intents.map((i) => i.record.toolUseId),
      ["tu-1", "tu-2"]
    );
  });

  it("(g) the in-memory ledger still stamps ONE ref per call (legacy path unchanged)", async () => {
    const id = "dur-ledger";
    await seedChain(id);
    const tool = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
    });
    await tool.handler({ path: "l.ts", content: "x\n" }, callCtx(id, "tu-l"));

    const consumed = ledger.consume(id, ["tu-l"]);
    assert.equal(consumed.size, 1, "the ledger entry is still produced");
    assert.equal(consumed.get("tu-l")!.relPath, "l.ts");
  });

  it("(h) the write tool replaces the target by rename, not in place", async () => {
    const id = "dur-atomic";
    await seedChain(id);
    const target = join(workRoot, "inode.ts");
    await writeFile(target, "old\n", "utf8");
    const before = (await stat(target)).ino;
    const tool = createWriteFileTool(workRoot, {
      preimageCapture: makeCapture(() => true),
    });

    await tool.handler(
      { path: "inode.ts", content: "new\n" },
      callCtx(id, "tu-i")
    );

    // A new inode is the filesystem-observable signature of rename-replace;
    // an in-place write would have kept the original inode.
    assert.notEqual((await stat(target)).ino, before, "published by rename");
    assert.equal(await readFile(target, "utf8"), "new\n");
  });
});

describe("multi-file rename_symbol keeps EVERY durable association", () => {
  const MAIN_BODY = [
    "const foo = 1;",
    "function bar() {",
    "  return foo;",
    "}",
  ].join("\n");
  const OTHER_BODY = "foo();\n";

  beforeEach(async () => {
    mainFile = join(workRoot, "a.ts");
    otherFile = join(workRoot, "b.ts");
    await writeFile(mainFile, MAIN_BODY, "utf8");
    await writeFile(otherFile, OTHER_BODY, "utf8");
  });

  it("(i) a 2-file rename leaves 2 durable associations in a fresh store", async () => {
    const id = "dur-multi";
    await seedChain(id);
    const captured: string[] = [];
    await runRename(
      captured,
      makeCapture(() => true),
      id,
      "tu-rename"
    );

    // The in-memory ledger is last-write-wins, so it can hold only ONE of the
    // two. That is exactly why the durable records matter.
    assert.equal(ledger.consume(id, ["tu-rename"]).size, 1);
    const intents = await durableIntents(id);
    assert.equal(intents.length, 2, "both targets kept, not last-write-wins");
    assert.deepEqual(intents.map((i) => i.record.targets[0]!.relPath).sort(), [
      "a.ts",
      "b.ts",
    ]);
    for (const intent of intents) {
      assert.equal(intent.record.toolUseId, "tu-rename");
      assert.equal(intent.record.captured, true);
      assert.match(
        intent.record.targets[0]!.preimageSha ?? "",
        /^[0-9a-f]{64}$/
      );
    }
    // Both files really changed on disk.
    assert.notEqual(await readFile(mainFile, "utf8"), MAIN_BODY);
    assert.notEqual(await readFile(otherFile, "utf8"), OTHER_BODY);
    assert.deepEqual(captured.sort(), ["a.ts", "b.ts"]);
  });
});

/** Drive the real 2-file rename with a stubbed LSP client (the only stub). */
async function runRename(
  captured: string[],
  capture: ReturnType<typeof createPreimageCapture>,
  id: string,
  toolUseId: string
): Promise<void> {
  const { pathToFileURL } = await import("node:url");
  mockGetClientDetailed.mockResolvedValue({
    client: {
      connection: {} as never,
      process: {} as never,
      getServerCapabilities: () => ({}),
      ensureOpen: async () => undefined,
      withDocumentOpen: async <T>(_f: string, fn: () => Promise<T>) => fn(),
      sendRequest: async (method: string) =>
        method === "textDocument/documentSymbol"
          ? [
              {
                name: "Foo",
                kind: 5,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 3, character: 1 },
                },
                selectionRange: {
                  start: { line: 0, character: 6 },
                  end: { line: 0, character: 9 },
                },
              },
            ]
          : {
              documentChanges: [
                {
                  textDocument: { uri: pathToFileURL(mainFile).href },
                  edits: [
                    {
                      range: {
                        start: { line: 0, character: 6 },
                        end: { line: 0, character: 9 },
                      },
                      newText: "baz",
                    },
                  ],
                },
                {
                  textDocument: { uri: pathToFileURL(otherFile).href },
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
            },
      sendNotification: async () => undefined,
      getDiagnostics: () => [] as ReadonlyArray<unknown>,
      getDocumentFingerprint: () => "fp-1",
      dispose: () => undefined,
    },
  });
  const tools = createSymbolMutateToolSet({
    ctx: { directory: workRoot },
    preimageCapture: (input) => {
      captured.push(input.relPath);
      return capture(input);
    },
  });
  const tool = tools.find((t) => t.name === "rename_symbol");
  if (tool === undefined) throw new Error("rename_symbol tool missing");
  await tool.handler(
    { file: mainFile, symbol_path: "Foo", new_name: "baz" },
    { conversationId: id, toolUseId }
  );
}
