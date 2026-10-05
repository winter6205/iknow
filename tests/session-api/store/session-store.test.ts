/**
 * SessionStore typed-IO contract tests (022 T2 + 120 T3).
 * Covers all 6 SessionStoreError kinds + atomic write + list ordering +
 * project namespacing (spec #120 SC 1).
 * Uses an isolated temp dir so the repo's data/ tree is never touched.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  rm,
  stat,
  readFile,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import type { SessionStoreError } from "../../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";

let store: SessionStore;
let baseDir: string;
// Per-conversation session folder under the project dir; the store keeps its
// files inside `<projectDir>/<id>/` after T1 (session-folder-consolidation).
// Tests use this for direct file manipulation (raw writes, stat asserts,
// mkdir before raw writes).
let sessionDir: string;
const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir: sessionDir, conversationId: id });

const sampleFile = (opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 => {
  const { id, overrides = {} } = opts;
  return {
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
    ...overrides,
  };
};

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-store-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function withIsolatedSessionStores<T>(
  projectRoot: string,
  run: (writer: SessionStore, reopenReader: () => SessionStore) => Promise<T>
): Promise<T> {
  const isolatedBaseDir = await mkdtemp(join(tmpdir(), "iknow-list-store-"));
  try {
    return await run(
      new SessionStore(isolatedBaseDir, projectRoot),
      () => new SessionStore(isolatedBaseDir, projectRoot)
    );
  } finally {
    await rm(isolatedBaseDir, { recursive: true, force: true });
  }
}

// -- resolveProjectSessionDir (pure function contract) -----------------------

describe("resolveProjectSessionDir", () => {
  it("produces <base>/projects/<basename>-<sha1(root)[:12]> keyed by projectIdentityRoot (T1)", () => {
    const dir = resolveProjectSessionDir("/base", "/work/myproj");
    const digest = createHash("sha1")
      .update("/work/myproj")
      .digest("hex")
      .slice(0, 12);
    assert.equal(dir, join("/base", "projects", `myproj-${digest}`));
    assert.match(basename(dir), /^myproj-[0-9a-f]{12}$/);
  });

  it("digest suffix is exactly 12 lowercase hex chars", () => {
    const dir = resolveProjectSessionDir("/base", "/work/anything-here");
    assert.match(basename(dir), /-[0-9a-f]{12}$/);
  });

  it("is stable for the same projectIdentityRoot", () => {
    assert.equal(
      resolveProjectSessionDir("/base", "/work/p"),
      resolveProjectSessionDir("/base", "/work/p")
    );
  });

  it("same basename at different projectIdentityRoot paths does not collide", () => {
    const a = resolveProjectSessionDir("/base", "/a/proj");
    const b = resolveProjectSessionDir("/base", "/b/proj");
    assert.notEqual(a, b);
    assert.match(basename(a), /^proj-[0-9a-f]{12}$/);
    assert.match(basename(b), /^proj-[0-9a-f]{12}$/);
    assert.notEqual(basename(a), basename(b));
  });

  it("different projectIdentityRoots always produce different dirs", () => {
    const a = resolveProjectSessionDir("/base", "/x/alpha");
    const b = resolveProjectSessionDir("/base", "/y/beta");
    const c = resolveProjectSessionDir("/base", "/z/gamma");
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
  });
});

// -- SessionStore project namespace (spec #120 SC 1) -------------------------

describe("SessionStore project namespace", () => {
  it("two stores with same baseDir but different projectIdentityRoot are isolated", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-ns-iso-"));
    try {
      const storeA = new SessionStore(tmp, "/proj/alpha");
      const storeB = new SessionStore(tmp, "/proj/beta");
      await storeA.save({
        id: "ns-iso-1",
        file: sampleFile({
          id: "ns-iso-1",
          overrides: {
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: "hi" }],
              },
              {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "reply" }],
              },
            ],
          },
        }),
      });
      // storeB cannot see alpha's session
      assert.deepEqual(
        await storeB.list(),
        [],
        "different projectIdentityRoot must see no sessions from alpha"
      );
      await assert.rejects(
        () => storeB.load("ns-iso-1"),
        (err: unknown) =>
          (err as SessionStoreError).kind === "not_found" &&
          (err as SessionStoreError).conversation_id === "ns-iso-1"
      );
      // storeA still sees its own file
      const loaded = await storeA.load("ns-iso-1");
      assert.equal(loaded.conversation_id, "ns-iso-1");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("same baseDir + same projectIdentityRoot sees the same file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-ns-shared-"));
    try {
      const storeA = new SessionStore(tmp, "/proj/shared");
      const storeB = new SessionStore(tmp, "/proj/shared");
      await storeA.save({
        id: "ns-shared-1",
        file: sampleFile({
          id: "ns-shared-1",
          overrides: {
            title: "hello",
            // list() skips sessions without assistant text (issue #96);
            // include an assistant reply so the cross-store list assertion
            // proves the namespace is shared.
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: "hello" }],
              },
              {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "reply" }],
              },
            ],
          },
        }),
      });
      const loaded = await storeB.load("ns-shared-1");
      assert.equal(loaded.conversation_id, "ns-shared-1");
      assert.equal(loaded.title, "hello");
      // list() from the sibling store sees the same file under the same
      // baseDir + cwd namespace.
      const listB = await storeB.list();
      assert.equal(listB.length, 1);
      assert.equal(listB[0]?.conversation_id, "ns-shared-1");
      assert.equal(listB[0]?.title, "hello");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// -- existing tests (paths updated to the namespaced layout) -----------------

describe("SessionStore.load", () => {
  it("sanitizes v1 in memory without writing", async () => {
    await mkdir(sessionDirFor("conv-v1"), { recursive: true });
    const path = join(sessionDirFor("conv-v1"), "conv-v1.json");
    const raw = {
      schemaVersion: 1,
      conversation_id: "conv-v1",
      messages: [
        { role: "user", content: [{ type: "text", text: " hello " }] },
      ],
      jsonMode: false,
      turnCount: 0,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await writeFile(path, JSON.stringify(raw), "utf8");
    const before = await readFile(path, "utf8");
    const loaded = await store.load("conv-v1");
    const after = await readFile(path, "utf8");
    assert.equal(loaded.title, "hello");
    assert.equal(loaded.cwd, "");
    assert.equal(loaded.sanitized_at, raw.updatedAt);
    assert.equal(loaded.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(loaded.checkpoints, []);
    assert.equal(loaded.workspaceRoot, undefined);
    assert.equal("workspaceRoot" in loaded, false);
    assert.equal(after, before);
  });

  it("rejects malformed message elements with complete error", async () => {
    await mkdir(sessionDirFor("conv-badmsg"), { recursive: true });
    await writeFile(
      join(sessionDirFor("conv-badmsg"), "conv-badmsg.json"),
      JSON.stringify({
        schemaVersion: 1,
        conversation_id: "conv-badmsg",
        messages: [{ role: "nope", content: [] }],
        jsonMode: false,
        turnCount: 0,
        updatedAt: "x",
      }),
      "utf8"
    );
    await assert.rejects(
      () => store.load("conv-badmsg"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "schema_invalid" &&
          e.conversation_id === "conv-badmsg" &&
          e.field === "messages"
        );
      }
    );
  });

  it("returns the saved file when valid", async () => {
    const file = sampleFile({ id: "conv-load-ok" });
    await store.save({ id: file.conversation_id, file });
    const loaded = await store.load("conv-load-ok");
    assert.equal(loaded.conversation_id, "conv-load-ok");
    assert.equal(loaded.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("round-trips a complete v4 file", async () => {
    const file = sampleFile({
      id: "conv-v4",
      overrides: {
        title: "saved",
        cwd: "/work",
        sanitized_at: "2026-01-01T00:00:00Z",
      },
    });
    await store.save({ id: file.conversation_id, file });
    assert.deepEqual(await store.load(file.conversation_id), file);
  });

  it("throws not_found for missing file", async () => {
    try {
      await store.load("does-not-exist");
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as SessionStoreError).kind, "not_found");
      assert.equal(
        (err as SessionStoreError).conversation_id,
        "does-not-exist"
      );
    }
  });

  it("throws parse_failed (not bare Error) for corrupt JSON", async () => {
    // Write a file directly with garbage so JSON.parse fails.
    await mkdir(sessionDirFor("conv-corrupt"), { recursive: true });
    const path = join(sessionDirFor("conv-corrupt"), "conv-corrupt.json");
    await writeFile(path, "{not-json", "utf8");
    try {
      await store.load("conv-corrupt");
      assert.fail("should have thrown");
    } catch (err) {
      const e = err as SessionStoreError;
      assert.equal(e.kind, "parse_failed");
      assert.equal(e.conversation_id, "conv-corrupt");
      assert.ok(
        typeof e.reason === "string" && e.reason.length > 0,
        "reason must be non-empty"
      );
      assert.ok(
        !(err instanceof Error) || err.constructor.name !== "Error",
        "must not be a bare Error"
      );
    }
  });

  it("throws schema_invalid when schemaVersion is above CURRENT (#120 range check)", async () => {
    // Under #120 T1, the range check accepts v1 and v2 (≤ CURRENT) and only
    // rejects future versions. schemaVersion 99 exercises the reject branch.
    await mkdir(sessionDirFor("conv-badver"), { recursive: true });
    const path = join(sessionDirFor("conv-badver"), "conv-badver.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 99 }), "utf8");
    try {
      await store.load("conv-badver");
      assert.fail("should have thrown");
    } catch (err) {
      const e = err as SessionStoreError;
      assert.equal(e.kind, "schema_invalid");
      assert.equal(e.conversation_id, "conv-badver");
      assert.equal(e.field, "schemaVersion");
    }
  });

  it("throws schema_invalid when a required field has the wrong type", async () => {
    await mkdir(sessionDirFor("conv-badfield"), { recursive: true });
    const path = join(sessionDirFor("conv-badfield"), "conv-badfield.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        conversation_id: "conv-badfield",
        messages: "not-an-array",
        jsonMode: false,
        turnCount: 0,
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      "utf8"
    );
    try {
      await store.load("conv-badfield");
      assert.fail("should have thrown");
    } catch (err) {
      const e = err as SessionStoreError;
      assert.equal(e.kind, "schema_invalid");
      assert.equal(e.field, "messages");
    }
  });
});

describe("SessionStore.save", () => {
  it("writes the JSONL authority to <namespace>/<id>/<id>.jsonl (#629)", async () => {
    const file = sampleFile({ id: "conv-save-ok" });
    await store.save({ id: "conv-save-ok", file });
    const s = await stat(
      join(sessionDirFor("conv-save-ok"), "conv-save-ok.jsonl")
    );
    assert.ok(s.isFile());
    // save no longer writes a `.json` mirror.
    await assert.rejects(
      stat(join(sessionDirFor("conv-save-ok"), "conv-save-ok.json"))
    );
  });

  it("atomic write leaves no .tmp residue on success", async () => {
    const file = sampleFile({ id: "conv-atomic" });
    await store.save({ id: "conv-atomic", file });
    // The .tmp file must have been renamed, not left behind.
    await assert.rejects(
      stat(join(sessionDirFor("conv-atomic"), "conv-atomic.json.tmp"))
    );
  });

  it("overwrites an existing file", async () => {
    await store.save({
      id: "conv-overwrite",
      file: sampleFile({ id: "conv-overwrite", overrides: { turnCount: 1 } }),
    });
    await store.save({
      id: "conv-overwrite",
      file: sampleFile({ id: "conv-overwrite", overrides: { turnCount: 5 } }),
    });
    const loaded = await store.load("conv-overwrite");
    assert.equal(loaded.turnCount, 5);
  });
});

describe("SessionStore.list", () => {
  it("returns [] when no sessions exist", async () => {
    // Use a fresh temp dir to ensure emptiness.
    const empty = await mkdtemp(join(tmpdir(), "iknow-store-empty-"));
    const s = new SessionStore(empty, "/proj/empty");
    assert.deepEqual(await s.list(), []);
    await rm(empty, { recursive: true, force: true });
  });

  it("returns entries sorted by updatedAt descending", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-02-01T00:00:00.000Z";
    const t3 = "2026-03-01T00:00:00.000Z";
    // Each session needs assistant text or list() skips it (issue #96).
    const withReply = (id: string, updatedAt: string) =>
      sampleFile({
        id,
        overrides: {
          updatedAt,
          title: "list reply",
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "q" }],
            },
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "reply" }],
            },
          ],
        },
      });
    await store.save({ id: "list-a", file: withReply("list-a", t1) });
    await store.save({ id: "list-b", file: withReply("list-b", t3) });
    await store.save({ id: "list-c", file: withReply("list-c", t2) });

    const entries = await store.list();
    // Filter to just our three to insulate from other tests.
    const ours = entries.filter((e) =>
      ["list-a", "list-b", "list-c"].includes(e.conversation_id)
    );
    assert.deepEqual(
      ours.map((e) => e.conversation_id),
      ["list-b", "list-c", "list-a"]
    );
    for (const e of ours) {
      assert.equal(typeof e.updatedAt, "string");
      assert.equal(typeof e.lastFinalText, "string");
      assert.equal(typeof e.title, "string");
      assert.ok(!("messages" in e), "list entries must not contain messages");
    }
  });

  it("skips sessions with no assistant text (issue #96)", async () => {
    const prefix = `list-filter-${randomUUID()}`;
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly id: string;
      readonly messages: SessionFileV1["messages"];
    }> = [
      { label: "bootstrap", id: `${prefix}-empty`, messages: [] },
      {
        label: "user-only",
        id: `${prefix}-user-only`,
        messages: [userMsgShape("question")],
      },
      {
        label: "whitespace-only",
        id: `${prefix}-blank`,
        messages: [userMsgShape("question"), assistantMsgShape("  \t\n")],
      },
      {
        label: "tool-only",
        id: `${prefix}-tool-only`,
        messages: [
          userMsgShape("question"),
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `${prefix}-tool`,
                name: "noop",
                input: {},
              },
            ],
          },
        ],
      },
      {
        label: "thinking-only",
        id: `${prefix}-thinking-only`,
        messages: [
          userMsgShape("question"),
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "analysis", signature: "sig" },
            ],
          },
        ],
      },
    ];

    await withIsolatedSessionStores(
      `/proj/${prefix}`,
      async (writer, reopenReader) => {
        for (const { id, messages } of cases) {
          await writer.save({
            id,
            file: sampleFile({ id, overrides: { messages } }),
          });
        }
        const entries = await reopenReader().list();
        for (const { id, label } of cases) {
          assert.ok(
            !entries.some((entry) => entry.conversation_id === id),
            `${label} session must not be listed`
          );
        }
      }
    );
  });

  it("omits blank-title sessions from list() (issue #1197)", async () => {
    const prefix = `list-title-filter-${randomUUID()}`;
    const missingRoot = join(tmpdir(), `${prefix}-no-such-dir`);
    type Case = {
      readonly label: string;
      readonly id: string;
      readonly title: string;
      readonly messages: SessionFileV1["messages"];
      readonly workspaceRoot?: string;
      readonly visible: boolean;
    };
    const cases: Case[] = [
      {
        label: "blank title with assistant text",
        id: `${prefix}-blank`,
        title: "",
        messages: [userMsgShape("q"), assistantMsgShape("answer")],
        visible: false,
      },
      {
        label: "whitespace-only title with assistant text",
        id: `${prefix}-whitespace`,
        title: "  \t ",
        messages: [userMsgShape("q"), assistantMsgShape("answer")],
        visible: false,
      },
      {
        label: "titled session with assistant text",
        id: `${prefix}-titled`,
        title: "Real title",
        messages: [userMsgShape("Real title"), assistantMsgShape("answer")],
        visible: true,
      },
      {
        // Titled but with no assistant reply: proves the issue #96
        // lastFinalText filter still fires independently of the title guard.
        label: "titled session with no assistant text",
        id: `${prefix}-no-assistant`,
        title: "Has a title",
        messages: [userMsgShape("Has a title")],
        visible: false,
      },
      {
        // Blank title but an invalid workspace binding must stay listed so the
        // picker can still offer rebind/recreate (recovery invariant).
        label: "blank-title session with an invalid binding",
        id: `${prefix}-invalid-root`,
        title: "",
        messages: [userMsgShape("q"), assistantMsgShape("answer")],
        workspaceRoot: missingRoot,
        visible: true,
      },
    ];

    await withIsolatedSessionStores(
      `/proj/${prefix}`,
      async (writer, reopenReader) => {
        for (const c of cases) {
          await writer.save({
            id: c.id,
            file: sampleFile({
              id: c.id,
              overrides: {
                title: c.title,
                messages: c.messages,
                ...(c.workspaceRoot !== undefined
                  ? { workspaceRoot: c.workspaceRoot }
                  : {}),
              },
            }),
          });
        }
        const listed = new Set(
          (await reopenReader().list()).map((e) => e.conversation_id)
        );
        for (const c of cases) {
          if (c.visible) {
            assert.ok(listed.has(c.id), `${c.label} must be listed`);
          } else {
            assert.ok(!listed.has(c.id), `${c.label} must not be listed`);
          }
        }
      }
    );
  });

  it("listWorkspaceClaims() keeps a blank-title bound claim that list() hides (#1197 occupancy decouple)", async () => {
    const prefix = `list-claims-${randomUUID()}`;
    // A real, existing directory so classifyWorkspaceRoot yields "bound".
    const claimRoot = await mkdtemp(join(tmpdir(), "iknow-claim-root-"));
    try {
      await withIsolatedSessionStores(
        `/proj/${prefix}`,
        async (writer, reopenReader) => {
          await writer.save({
            id: `${prefix}-claim`,
            file: sampleFile({
              id: `${prefix}-claim`,
              overrides: {
                title: "",
                messages: [userMsgShape("q"), assistantMsgShape("answer")],
                workspaceRoot: claimRoot,
              },
            }),
          });
          await writer.save({
            id: `${prefix}-no-assistant`,
            file: sampleFile({
              id: `${prefix}-no-assistant`,
              overrides: {
                title: "",
                messages: [userMsgShape("q")],
                workspaceRoot: claimRoot,
              },
            }),
          });
          await writer.save({
            id: `${prefix}-titled`,
            file: sampleFile({
              id: `${prefix}-titled`,
              overrides: {
                title: "Real title",
                messages: [userMsgShape("q"), assistantMsgShape("ans")],
                workspaceRoot: claimRoot,
              },
            }),
          });

          const reader = reopenReader();
          const listed = new Set(
            (await reader.list()).map((e) => e.conversation_id)
          );
          const claims = await reader.listWorkspaceClaims();
          const claimIds = new Set(claims.map((e) => e.conversation_id));

          // Picker hides the blank-title bound claim; occupancy sees it,
          // preserving its binding so assertNotClaimed can resolve the tree.
          assert.ok(
            !listed.has(`${prefix}-claim`),
            "list() must hide a blank-title bound session"
          );
          const claim = claims.find(
            (e) => e.conversation_id === `${prefix}-claim`
          );
          assert.ok(claim, "listWorkspaceClaims() must see the blank claim");
          assert.equal(claim.workspaceRoot, claimRoot);
          assert.equal(claim.bindingStatus, "bound");

          // Documented residual: the #96 no-assistant filter still applies to
          // occupancy, so a bootstrap claim with no assistant reply stays out.
          assert.ok(
            !claimIds.has(`${prefix}-no-assistant`),
            "listWorkspaceClaims() must still honour the #96 assistant filter"
          );

          // A titled bound claim is a claim for both consumers.
          assert.ok(listed.has(`${prefix}-titled`));
          assert.ok(claimIds.has(`${prefix}-titled`));
        }
      );
    } finally {
      await rm(claimRoot, { recursive: true, force: true });
    }
  });

  it("keeps a prior answer visible when the latest assistant event only calls a tool", async () => {
    const id = `list-tool-head-${randomUUID()}`;
    const toolId = `${id}-tool`;
    const latestMessage: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: "noop", input: {} }],
    };

    await withIsolatedSessionStores(
      `/proj/${id}`,
      async (writer, reopenReader) => {
        await writer.save({
          id,
          file: sampleFile({
            id,
            overrides: {
              title: "saved answer",
              messages: [
                userMsgShape("question"),
                assistantMsgShape("saved answer"),
              ],
            },
          }),
        });
        await writer.appendEvents({ id, events: [latestMessage] });

        const reader = reopenReader();
        const loaded = await reader.load(id);
        assert.ok(
          loaded.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) => block.type === "tool_use" && block.id === toolId
              )
          ),
          "reopened transcript must include the persisted head tool call"
        );
        assert.ok(
          loaded.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) =>
                  block.type === "text" && block.text === "saved answer"
              )
          ),
          "reopened transcript must retain the earlier assistant answer"
        );

        const entry = (await reader.list()).find(
          (item) => item.conversation_id === id
        );
        assert.ok(
          entry,
          "session with an earlier answer must remain discoverable"
        );
        assert.equal(entry.lastFinalText, "saved answer");
      }
    );
  });

  const latestNonDisplayableMessages: ReadonlyArray<{
    readonly label: string;
    readonly message: AnthropicNativeMessage;
  }> = [
    {
      label: "thinking-only",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "analysis", signature: "sig" }],
      },
    },
    {
      label: "whitespace-only",
      message: {
        role: "assistant",
        content: [{ type: "text", text: " \t\n" }],
      },
    },
  ];

  it.each(latestNonDisplayableMessages)(
    "keeps the earlier preview when the latest assistant message is $label",
    async ({ message }) => {
      const id = `list-preview-${randomUUID()}`;
      await withIsolatedSessionStores(
        `/proj/${id}`,
        async (writer, reopenReader) => {
          await writer.save({
            id,
            file: sampleFile({
              id,
              overrides: {
                title: "earlier answer",
                messages: [
                  userMsgShape("question"),
                  assistantMsgShape("earlier answer"),
                ],
              },
            }),
          });
          await writer.appendEvents({ id, events: [message] });

          const entry = (await reopenReader().list()).find(
            (item) => item.conversation_id === id
          );
          assert.ok(
            entry,
            "earlier non-empty assistant text keeps the session visible"
          );
          assert.equal(entry.lastFinalText, "earlier answer");
        }
      );
    }
  );

  it("uses the latest non-empty assistant text as the preview", async () => {
    const id = `list-latest-answer-${randomUUID()}`;
    await withIsolatedSessionStores(
      `/proj/${id}`,
      async (writer, reopenReader) => {
        await writer.save({
          id,
          file: sampleFile({
            id,
            overrides: {
              title: "earlier answer",
              messages: [
                userMsgShape("question"),
                assistantMsgShape("earlier answer"),
              ],
            },
          }),
        });
        await writer.appendEvents({
          id,
          events: [
            userMsgShape("follow-up"),
            assistantMsgShape("latest answer"),
          ],
        });

        const entry = (await reopenReader().list()).find(
          (item) => item.conversation_id === id
        );
        assert.ok(entry);
        assert.equal(entry.lastFinalText, "latest answer");
      }
    );
  });

  it("hides a rewound session when its current head has no assistant text", async () => {
    const id = `list-rewound-user-only-${randomUUID()}`;
    await withIsolatedSessionStores(
      `/proj/${id}`,
      async (writer, reopenReader) => {
        await writer.save({
          id,
          file: sampleFile({
            id,
            overrides: {
              messages: [
                userMsgShape("question"),
                assistantMsgShape("older answer"),
              ],
            },
          }),
        });
        await writer.rewindToHead({ id, head: "e0" });

        const jsonlPath = join(
          resolveConversationDir({
            projectDir: writer.getProjectDir(),
            conversationId: id,
          }),
          `${id}.jsonl`
        );
        const rawJsonl = await readFile(jsonlPath, "utf8");
        assert.ok(
          rawJsonl.includes('"text":"older answer"'),
          "rewind must retain the abandoned assistant event in JSONL"
        );

        const reader = reopenReader();
        assert.deepEqual((await reader.load(id)).messages, [
          userMsgShape("question"),
        ]);
        assert.ok(
          !(await reader.list()).some((entry) => entry.conversation_id === id),
          "a hidden historical answer must not make a user-only head visible"
        );
      }
    );
  });

  it("extracts text from the most recent assistant message as lastFinalText", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "first answer" }],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "follow up" }],
      },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "second answer" },
          { type: "text" as const, text: "continued" },
        ],
      },
    ];
    await store.save({
      id: "list-text",
      file: sampleFile({
        id: "list-text",
        overrides: { title: "hi", messages },
      }),
    });
    const entries = await store.list();
    const e = entries.find((x) => x.conversation_id === "list-text");
    assert.equal(e?.lastFinalText, "second answer continued");
  });

  it("silently skips corrupt files in list()", async () => {
    await mkdir(sessionDirFor("list-corrupt"), { recursive: true });
    await writeFile(
      join(sessionDirFor("list-corrupt"), "list-corrupt.json"),
      "{garbage",
      "utf8"
    );
    const entries = await store.list();
    assert.ok(!entries.some((e) => e.conversation_id === "list-corrupt"));
  });
});

describe("SessionStore.delete", () => {
  it("removes the file and then load() throws not_found", async () => {
    await store.save({ id: "conv-del", file: sampleFile({ id: "conv-del" }) });
    await store.delete("conv-del");
    try {
      await store.load("conv-del");
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as SessionStoreError).kind, "not_found");
    }
  });

  it("throws not_found when deleting a missing file", async () => {
    try {
      await store.delete("never-existed");
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as SessionStoreError).kind, "not_found");
    }
  });
});

describe("SessionStoreError kinds (full coverage)", () => {
  it("not_found (load missing) — covered above; assert kind contract", () => {
    // Compile-time: discriminated union requires .kind string literal.
    const e: SessionStoreError = { kind: "not_found", conversation_id: "x" };
    assert.equal(e.kind, "not_found");
  });

  it("parse_failed — covered above; assert kind contract", () => {
    const e: SessionStoreError = {
      kind: "parse_failed",
      conversation_id: "x",
      reason: "r",
    };
    assert.equal(e.kind, "parse_failed");
  });

  it("schema_invalid — covered above; assert kind contract", () => {
    const e: SessionStoreError = {
      kind: "schema_invalid",
      conversation_id: "x",
      field: "f",
    };
    assert.equal(e.kind, "schema_invalid");
  });

  it("write_failed — surfaced by write to an invalid base dir (path is a file)", async () => {
    const blocker = await mkdtemp(join(tmpdir(), "iknow-store-block-"));
    // Force save() to fail by making the base path traverse through a regular file.
    const blockerPath = join(blocker, "blocker");
    await writeFile(blockerPath, "x", "utf8");
    const bad = new SessionStore(blockerPath, "/proj/block");
    try {
      await bad.save({ id: "x", file: sampleFile({ id: "x" }) });
      assert.fail("should have thrown");
    } catch (err) {
      const e = err as SessionStoreError;
      assert.equal(e.kind, "write_failed");
      assert.equal(e.conversation_id, "x");
      assert.ok(typeof e.cause === "string" && e.cause.length > 0);
    }
    await rm(blocker, { recursive: true, force: true });
  });

  it("io_error — surfaced by readdir failure on a path that is a file (not a dir)", async () => {
    const blocker = await mkdtemp(join(tmpdir(), "iknow-store-err-"));
    // T1 (session-folder-consolidation): the project dir under the base
    // is `<base>/projects/<basename>-<sha1[:12]>/`. Make `projects` a
    // regular file so readdir() on the resolved projectDir surfaces
    // ENOTDIR → typed io_error.
    await writeFile(join(blocker, "projects"), "x", "utf8");
    const bad = new SessionStore(blocker, "/proj/ioerr");
    try {
      await bad.list();
      assert.fail("should have thrown");
    } catch (err) {
      const e = err as SessionStoreError;
      assert.equal(e.kind, "io_error");
      assert.ok(typeof e.cause === "string" && e.cause.length > 0);
    }
    await rm(blocker, { recursive: true, force: true });
  });

  it("concurrent_write — reserved kind for hub-side serialization (T4), contract smoke test", () => {
    // Hub will throw this; store does not produce it (caller responsibility per spec).
    // Compile-time assertion that the discriminant exists with the expected shape.
    const e: SessionStoreError = {
      kind: "concurrent_write",
      conversation_id: "x",
    };
    assert.equal(e.kind, "concurrent_write");
  });
});

// -- appendEvents createdAt stamping (rewind prompt timestamps) --------------

describe("SessionStore.appendEvents createdAt stamping", () => {
  it("stamps an ISO createdAt on every appended event record", async () => {
    const id = "ts-append-stamp";
    const file = sampleFile({
      id,
      overrides: { messages: [userMsgShape("q")] },
    });
    await store.save({ id, file });
    await store.appendEvents({
      id,
      events: [assistantMsgShape("a")],
    });
    const lines = await readJsonlLinesById(id);
    const eventRecords = lines.filter(
      (l): l is Record<string, unknown> =>
        (l as { type?: string }).type === "message"
    );
    // Save() wrote e0 without createdAt (fullRewritePlan → sessionFileToJsonl
    // doesn't stamp; bootstrap path), appendEvents wrote e1 with createdAt.
    const e1 = eventRecords[1] as {
      createdAt?: unknown;
      id: string;
      parent: string;
    };
    assert.equal(e1.id, "e1");
    assert.equal(e1.parent, "e0");
    assert.equal(typeof e1.createdAt, "string");
    const stamped = new Date(e1.createdAt as string);
    assert.ok(
      !Number.isNaN(stamped.getTime()),
      `createdAt must parse as a valid ISO date (got ${e1.createdAt})`
    );
    // Within a 60s window around now (CI clock skew margin).
    const drift = Math.abs(stamped.getTime() - Date.now());
    assert.ok(drift < 60_000, `createdAt drift > 60s: ${drift}ms`);
  });

  it("stamps each event in a multi-event append with a distinct ISO timestamp", async () => {
    const id = "ts-append-multi";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: [userMsgShape("q")] },
      }),
    });
    await store.appendEvents({
      id,
      events: [
        assistantMsgShape("a1"),
        assistantMsgShape("a2"),
        assistantMsgShape("a3"),
      ],
    });
    const lines = await readJsonlLinesById(id);
    const stamps = lines
      .filter(
        (l): l is { type: string; createdAt?: unknown } =>
          (l as { type: string }).type === "message" &&
          "createdAt" in (l as Record<string, unknown>)
      )
      .map((l) => l.createdAt as string);
    // e0 was written by save() (unstamped), e1..e3 stamped by appendEvents.
    assert.equal(stamps.length, 3);
    for (const s of stamps) {
      assert.ok(!Number.isNaN(new Date(s).getTime()), `bad ISO: ${s}`);
    }
    // Strict non-decreasing — same-millisecond is allowed.
    for (let i = 1; i < stamps.length; i++) {
      assert.ok(
        new Date(stamps[i]!).getTime() >= new Date(stamps[i - 1]!).getTime()
      );
    }
  });

  it("load projects messageCreatedAt aligned with messages on a mixed chain", async () => {
    // save() writes via sessionFileToJsonl which doesn't stamp (legacy /
    // bootstrap path); appendEvents stamps each event it writes. Mixed
    // chain: e0/e1 unstamped (undefined), e2 stamped (ISO).
    const id = "ts-load-mixed";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          messages: [userMsgShape("q"), assistantMsgShape("a")],
        },
      }),
    });
    await store.appendEvents({
      id,
      events: [userMsgShape("q2")],
    });
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 3);
    assert.equal(loaded.messageCreatedAt?.[0], null);
    assert.equal(loaded.messageCreatedAt?.[1], null);
    assert.equal(typeof loaded.messageCreatedAt?.[2], "string");
    assert.ok(
      !Number.isNaN(new Date(loaded.messageCreatedAt?.[2] as string).getTime())
    );
  });

  it("legacy JSONL (handwritten without createdAt) loads with no messageCreatedAt key", async () => {
    // Hand-craft a JSONL where every event omits createdAt — mirrors a file
    // written before the stamping change. Load must succeed and the
    // projection must omit the messageCreatedAt key (spread-discipline,
    // conditional emit). Picker fallback reads undefined → "".
    await mkdir(sessionDirFor("ts-load-legacy"), { recursive: true });
    const id = "ts-load-legacy";
    const raw = [
      JSON.stringify({
        type: "session",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "legacy",
        cwd: "/tmp/test",
        sanitized_at: "2026-08-20T00:00:00.000Z",
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-08-20T00:00:00.000Z",
        checkpoints: [],
      }),
      JSON.stringify({
        type: "message",
        id: "e0",
        parent: null,
        message: userMsgShape("q"),
      }),
      JSON.stringify({
        type: "message",
        id: "e1",
        parent: "e0",
        message: assistantMsgShape("a"),
      }),
      JSON.stringify({ type: "head", id: "e1" }),
    ].join("\n");
    const path = join(sessionDirFor(id), `${id}.jsonl`);
    await writeFile(path, `${raw}\n`, "utf8");
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(
      "messageCreatedAt" in loaded,
      false,
      "legacy chain must not grow messageCreatedAt key (spread-discipline)"
    );
    assert.equal(loaded.messageCreatedAt?.[0], undefined);
  });

  it("save() preserves stamped event createdAt verbatim through the header-refresh path", async () => {
    // plan Open Q #2 contract: save() must not re-stamp existing event records
    // — appendEvents is the only writer that sets `createdAt`, and its writes
    // pass through `serializeSessionLog(meta, records)` in the identical-
    // projection branch with no JSON re-encoding. A regression that called
    // `createdAt: new Date().toISOString()` inside the save event builder
    // would mutate the picker-visible timestamps on every subsequent save
    // and silently break the rewind prompt-timestamp invariant.
    const id = "ts-save-keep-stamps";
    // Bootstrap a 2-message transcript via fullRewritePlan (e0/e1 unstamped).
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: [userMsgShape("q"), assistantMsgShape("a")] },
      }),
    });
    // appendEvents stamps e2 with the only createdAt on disk.
    await store.appendEvents({ id, events: [userMsgShape("q2")] });
    const findEvent = (
      lines: ReadonlyArray<unknown>,
      eventId: string
    ): { id: string; createdAt?: unknown } => {
      const ev = lines.find(
        (l) =>
          (l as { type?: string; id?: string }).type === "message" &&
          (l as { id?: string }).id === eventId
      ) as { id: string; createdAt?: unknown } | undefined;
      assert.ok(ev, `event ${eventId} must exist on disk before save()`);
      return ev;
    };
    const before = await readJsonlLinesById(id);
    const e2Before = findEvent(before, "e2");
    assert.equal(
      typeof e2Before.createdAt,
      "string",
      "appendEvents must have stamped e2 with a createdAt string"
    );
    // Re-save with the same projection → identical-branch header-refresh.
    // (load() round-trips the same messages; no rewind happens here.)
    const loaded = await store.load(id);
    await store.save({ id, file: loaded });
    const after = await readJsonlLinesById(id);
    const e2After = findEvent(after, "e2");
    assert.equal(
      e2After.createdAt,
      e2Before.createdAt,
      "save() header-refresh must preserve stamped event createdAt verbatim"
    );
  });
});

// -- D2 (tui-display-consistency): thinkingMs appendEvents stamping ---------

describe("SessionStore.appendEvents thinkingMs stamping", () => {
  it("stamps thinkingMs on assistant events when provided in the batch", async () => {
    const id = "tm-append-stamp";
    // Bootstrap with a user message via save() so e0 exists; appendEvents
    // then writes e1 (assistant) which carries thinkingMs.
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: [userMsgShape("q")] },
      }),
    });
    await store.appendEvents({
      id,
      events: [assistantMsgShape("a")],
      thinkingMs: 1500,
    });
    const lines = await readJsonlLinesById(id);
    const eventRecords = lines.filter(
      (l): l is Record<string, unknown> =>
        (l as { type?: string }).type === "message"
    );
    // e0 written by save() (no thinkingMs), e1 written by appendEvents
    // (with thinkingMs).
    const e1 = eventRecords[1] as {
      thinkingMs?: unknown;
      id: string;
      message: { role: string };
    };
    assert.equal(e1.id, "e1");
    assert.equal(e1.message.role, "assistant");
    assert.equal(e1.thinkingMs, 1500);
  });

  it("does NOT stamp thinkingMs on user / tool_result events in the batch", async () => {
    const id = "tm-append-skip-user";
    // Bootstrap with a user message via save() so e0 exists; appendEvents
    // writes e1 which is also a user event (must skip thinkingMs).
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: [userMsgShape("q")] },
      }),
    });
    await store.appendEvents({
      id,
      events: [userMsgShape("q2")],
      // Even if caller passes thinkingMs by mistake, user events skip it.
      thinkingMs: 9999,
    });
    const lines = await readJsonlLinesById(id);
    const e1 = lines[1] as Record<string, unknown>;
    assert.equal(
      "thinkingMs" in e1,
      false,
      "user events must not carry thinkingMs even when caller provides it"
    );
  });

  it("does NOT stamp thinkingMs when value is non-positive / non-finite (defensive boundary)", async () => {
    const id = "tm-append-boundary";
    await store.save({ id, file: sampleFile({ id }) });
    const boundaries: unknown[] = [0, -1, NaN, Infinity, -Infinity];
    for (let i = 0; i < boundaries.length; i++) {
      const value = boundaries[i];
      const seqId = `${id}-${i}`;
      await store.save({ id: seqId, file: sampleFile({ id: seqId }) });
      await store.appendEvents({
        id: seqId,
        events: [assistantMsgShape(`a-${i}`)],
        // ts-expect-error -- probe defensive behavior on illegal values
        thinkingMs: value as number,
      });
      const lines = await readJsonlLinesById(seqId);
      const e1 = lines[1] as Record<string, unknown>;
      assert.equal(
        "thinkingMs" in e1,
        false,
        `illegal thinkingMs ${String(value)} must not be stamped on event record`
      );
    }
  });

  it("omits thinkingMs when not provided in batch (back-compat with existing callers)", async () => {
    const id = "tm-append-undefined";
    // Bootstrap with a user message so e0 exists; appendEvents writes e1
    // (assistant) without thinkingMs in the batch.
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: [userMsgShape("q")] },
      }),
    });
    await store.appendEvents({
      id,
      events: [assistantMsgShape("a")],
      // thinkingMs explicitly undefined — mirrors legacy callers' zero-touch
    });
    const lines = await readJsonlLinesById(id);
    const e1 = lines[1] as Record<string, unknown>;
    assert.equal(
      "thinkingMs" in e1,
      false,
      "absent thinkingMs must not introduce the key on event record"
    );
  });

  it("load projects thinkingMs aligned with messages on a mixed chain", async () => {
    // save() writes via sessionFileToJsonl which doesn't stamp thinkingMs
    // (legacy / bootstrap path); appendEvents stamps each event it writes.
    // Mixed chain: e0/e1 unstamped (no thinkingMs), e2 assistant with
    // thinkingMs. Projection yields parallel array aligned root→head.
    const id = "tm-load-mixed";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          messages: [userMsgShape("q"), assistantMsgShape("a")],
        },
      }),
    });
    await store.appendEvents({
      id,
      events: [assistantMsgShape("a2")],
      thinkingMs: 2300,
    });
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 3);
    // e0 user (null), e1 assistant bootstrap (null), e2 assistant stamped.
    assert.deepEqual(loaded.thinkingMs, [null, null, 2300]);
  });

  it("legacy JSONL (handwritten without thinkingMs) loads with no thinkingMs key", async () => {
    // Hand-craft a JSONL where no event carries thinkingMs — mirrors a file
    // written before the D2 change. Load must succeed and the projection
    // must omit the thinkingMs key (spread-discipline, conditional emit).
    await mkdir(sessionDirFor("tm-load-legacy"), { recursive: true });
    const id = "tm-load-legacy";
    const raw = [
      JSON.stringify({
        type: "session",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        title: "legacy",
        cwd: "/tmp/test",
        sanitized_at: "2026-08-20T00:00:00.000Z",
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-08-20T00:00:00.000Z",
        checkpoints: [],
      }),
      JSON.stringify({
        type: "message",
        id: "e0",
        parent: null,
        message: userMsgShape("q"),
      }),
      JSON.stringify({
        type: "message",
        id: "e1",
        parent: "e0",
        message: assistantMsgShape("a"),
      }),
      JSON.stringify({ type: "head", id: "e1" }),
    ].join("\n");
    const path = join(sessionDirFor(id), `${id}.jsonl`);
    await writeFile(path, `${raw}\n`, "utf8");
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(
      "thinkingMs" in loaded,
      false,
      "legacy chain must not grow thinkingMs key (spread-discipline)"
    );
    assert.equal(loaded.thinkingMs?.[0], undefined);
  });
});

// -- shared helpers for the describe above (locally scoped to avoid polluting
// -- the file's top-level imports / sampleFile closure) -----------------------

function userMsgShape(text: string): {
  readonly role: "user";
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
} {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsgShape(text: string): {
  readonly role: "assistant";
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
} {
  return { role: "assistant", content: [{ type: "text", text }] };
}

async function readJsonlLinesById(id: string): Promise<ReadonlyArray<unknown>> {
  const path = join(sessionDirFor(id), `${id}.jsonl`);
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

// -- appendTitle (session-list-title T3 / ADR-0113) ---------------------------

describe("SessionStore.appendTitle (标题事件权威, header title 缓存)", () => {
  it("appendTitle 后 load().title = 事件正文; messages 不含事件", async () => {
    const id = "t3-append-basic";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { title: "占位", messages: [userMsgShape("q")] },
      }),
    });
    await store.appendTitle({ id, text: "事件标题" });
    const loaded = await store.load(id);
    assert.equal(loaded.title, "事件标题");
    assert.equal(loaded.messages.length, 1);
    assert.ok(
      !JSON.stringify(loaded.messages).includes("事件标题"),
      "title 事件不得进入 messages 投影"
    );
    // On disk exactly one title record is appended; event/head records unchanged.
    const lines = await readJsonlLinesById(id);
    assert.equal(lines.length, 4); // header + e0 + head + title
    assert.deepEqual(lines[3], { type: "title", text: "事件标题" });
  });

  it("appendTitle 后 list().title 立即反映事件正文", async () => {
    const id = "t3-append-list";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          title: "占位",
          messages: [userMsgShape("q"), assistantMsgShape("a")],
        },
      }),
    });
    const before = await store.list();
    assert.equal(before.find((e) => e.conversation_id === id)?.title, "占位");
    await store.appendTitle({ id, text: "列表标题" });
    const after = await store.list();
    assert.equal(
      after.find((e) => e.conversation_id === id)?.title,
      "列表标题"
    );
  });

  it("回盖闸: 有事件后 save 携带 extractTitle 重算值, header 缓存仍为事件正文", async () => {
    const id = "t3-save-gate";
    const messages = [userMsgShape("真正的问题"), assistantMsgShape("a")];
    await store.save({
      id,
      file: sampleFile({ id, overrides: { title: "真正的问题", messages } }),
    });
    await store.appendTitle({ id, text: "lite 生成标题" });
    // Mimic hub conditionalSave: each turn recomputes via extractTitle and passes it into save.
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          title: extractTitle([
            { role: "user", content: [{ type: "text", text: "真正的问题" }] },
          ]),
          messages: [...messages, userMsgShape("q2")],
        },
      }),
    });
    const header = (await readJsonlLinesById(id))[0] as { title: string };
    assert.equal(header.title, "lite 生成标题");
    assert.equal((await store.load(id)).title, "lite 生成标题");
  });

  it("回盖闸: rewind 不用 extractTitle 覆写 header", async () => {
    const id = "t3-rewind-gate";
    const messages = [
      userMsgShape("q1"),
      assistantMsgShape("a1"),
      userMsgShape("q2"),
      assistantMsgShape("a2"),
    ];
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { title: "q1", messages, turnCount: 2 },
      }),
    });
    await store.appendTitle({ id, text: "事件标题" });
    const { file } = await store.rewindToAnchor({ id, keepTurns: 1 });
    assert.equal(file.title, "事件标题");
    const header = (await readJsonlLinesById(id))[0] as { title: string };
    assert.equal(header.title, "事件标题");
    // The title record survives across rewind rewrites.
    assert.equal((await store.load(id)).title, "事件标题");
  });

  it("多条 title 事件取最新; 再 append 更新缓存语义", async () => {
    const id = "t3-multi";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { title: "占位", messages: [userMsgShape("q")] },
      }),
    });
    await store.appendTitle({ id, text: "第一版" });
    assert.equal((await store.load(id)).title, "第一版");
    await store.appendTitle({ id, text: "第二版" });
    assert.equal((await store.load(id)).title, "第二版");
  });

  it("空/纯空白 text → typed schema_invalid field title（不落盘）", async () => {
    const id = "t3-empty";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { title: "占位", messages: [userMsgShape("q")] },
      }),
    });
    for (const text of ["", "   ", "\t\n"]) {
      await assert.rejects(
        () => store.appendTitle({ id, text }),
        (err: unknown) => {
          const e = err as SessionStoreError;
          return (
            e.kind === "schema_invalid" &&
            "field" in e &&
            e.field === "title" &&
            "conversation_id" in e &&
            e.conversation_id === id
          );
        }
      );
    }
    assert.equal((await store.load(id)).title, "占位");
  });

  it("未知 id → not_found", async () => {
    await assert.rejects(
      () => store.appendTitle({ id: "t3-missing", text: "标题" }),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });

  it("legacy .json-only → write_failed（迁移信号，同 appendEvents）", async () => {
    const id = "t3-legacy";
    await mkdir(sessionDirFor(id), { recursive: true });
    await writeFile(
      join(sessionDirFor(id), `${id}.json`),
      JSON.stringify(sampleFile({ id })),
      "utf8"
    );
    await assert.rejects(
      () => store.appendTitle({ id, text: "标题" }),
      (err: unknown) => (err as SessionStoreError).kind === "write_failed"
    );
  });

  it("回归: 无 title 事件的旧文件 save/rewind 行为与今日一致 (extractTitle)", async () => {
    const id = "t3-noevent";
    const messages = [
      userMsgShape("首条问题"),
      assistantMsgShape("a1"),
      userMsgShape("q2"),
      assistantMsgShape("a2"),
    ];
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { title: "首条问题", messages, turnCount: 2 },
      }),
    });
    // save with no title record → header carries the caller's title verbatim (extractTitle semantics).
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { title: "重算值", messages, turnCount: 2 },
      }),
    });
    let header = (await readJsonlLinesById(id))[0] as { title: string };
    assert.equal(header.title, "重算值");
    // rewind with no title record → title = extractTitle(kept).
    const { file } = await store.rewindToAnchor({ id, keepTurns: 0 });
    assert.equal(file.title, "");
    header = (await readJsonlLinesById(id))[0] as { title: string };
    assert.equal(header.title, "");
  });
});

// -- hasTitleEvent (ADR-0113 pre-trigger disk gate) ----------------------------

describe("SessionStore.hasTitleEvent", () => {
  it("无标题事件 → false; appendTitle 后 → true（多条仍 true）", async () => {
    const id = "t4-hastitle";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { title: "占位", messages: [userMsgShape("q")] },
      }),
    });
    assert.equal(await store.hasTitleEvent(id), false);
    await store.appendTitle({ id, text: "事件标题" });
    assert.equal(await store.hasTitleEvent(id), true);
    await store.appendTitle({ id, text: "第二版" });
    assert.equal(await store.hasTitleEvent(id), true);
  });

  it("未知 id → typed not_found（调用方 log-and-continue，不静默生成）", async () => {
    await assert.rejects(
      () => store.hasTitleEvent("t4-hastitle-missing"),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });

  it("legacy .json-only → typed not_found（无 JSONL log 即无标题事件可查，readHead 同形态）", async () => {
    const id = "t4-hastitle-legacy";
    await mkdir(sessionDirFor(id), { recursive: true });
    await writeFile(
      join(sessionDirFor(id), `${id}.json`),
      JSON.stringify(sampleFile({ id })),
      "utf8"
    );
    await assert.rejects(
      () => store.hasTitleEvent(id),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });
});
