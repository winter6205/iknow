/**
 * SessionStore typed-IO contract tests (022 T2 + 120 T3).
 * Covers all 6 SessionStoreError kinds + atomic write + list ordering +
 * project namespacing (spec #120 SC 1).
 * Uses an isolated temp dir so the repo's data/ tree is never touched.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  resolveProjectSessionDir,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import type { SessionStoreError } from "../../../src/session-api/store/index.ts";

let store: SessionStore;
let baseDir: string;
// Namespaced session dir used for direct file manipulation (raw writes, stat
// asserts, mkdir before raw writes). Matches the store's default cwd.
let sessionDir: string;

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
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// -- resolveProjectSessionDir (pure function contract) -----------------------

describe("resolveProjectSessionDir", () => {
  it("produces <base>/sessions/<basename>-<sha1(cwd)[:12]>", () => {
    const dir = resolveProjectSessionDir("/base", "/work/myproj");
    const digest = createHash("sha1")
      .update("/work/myproj")
      .digest("hex")
      .slice(0, 12);
    assert.equal(dir, join("/base", "sessions", `myproj-${digest}`));
    assert.match(basename(dir), /^myproj-[0-9a-f]{12}$/);
  });

  it("digest suffix is exactly 12 lowercase hex chars", () => {
    const dir = resolveProjectSessionDir("/base", "/work/anything-here");
    assert.match(basename(dir), /-[0-9a-f]{12}$/);
  });

  it("is stable for the same cwd", () => {
    assert.equal(
      resolveProjectSessionDir("/base", "/work/p"),
      resolveProjectSessionDir("/base", "/work/p")
    );
  });

  it("same basename at different paths does not collide", () => {
    const a = resolveProjectSessionDir("/base", "/a/proj");
    const b = resolveProjectSessionDir("/base", "/b/proj");
    assert.notEqual(a, b);
    assert.match(basename(a), /^proj-[0-9a-f]{12}$/);
    assert.match(basename(b), /^proj-[0-9a-f]{12}$/);
    assert.notEqual(basename(a), basename(b));
  });

  it("different cwds always produce different dirs", () => {
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
  it("two stores with same baseDir but different cwd are isolated", async () => {
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
        "different cwd must see no sessions from alpha"
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

  it("same baseDir + same cwd sees the same file", async () => {
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
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, "conv-v1.json");
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
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "conv-badmsg.json"),
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
    const path = join(sessionDir, "conv-corrupt.json");
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
    const path = join(sessionDir, "conv-badver.json");
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
    const path = join(sessionDir, "conv-badfield.json");
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
  it("writes the file to <namespace>/<id>.json", async () => {
    const file = sampleFile({ id: "conv-save-ok" });
    await store.save({ id: "conv-save-ok", file });
    const s = await stat(join(sessionDir, "conv-save-ok.json"));
    assert.ok(s.isFile());
  });

  it("atomic write leaves no .tmp residue on success", async () => {
    const file = sampleFile({ id: "conv-atomic" });
    await store.save({ id: "conv-atomic", file });
    // The .tmp file must have been renamed, not left behind.
    await assert.rejects(stat(join(sessionDir, "conv-atomic.json.tmp")));
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
    const s = new SessionStore(empty);
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
    // Empty messages array → bootstrap ghost, nothing to show in the sidebar.
    await store.save({
      id: "list-empty",
      file: sampleFile({ id: "list-empty" }),
    });
    // Assistant message whose text is only whitespace → also treated as empty.
    await store.save({
      id: "list-blank",
      file: sampleFile({
        id: "list-blank",
        overrides: {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "q" }],
            },
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "   " }],
            },
          ],
        },
      }),
    });
    // Assistant message with only a tool_use block (no text) → interrupted
    // mid-tool-use, nothing to show → also treated as empty.
    await store.save({
      id: "list-toolonly",
      file: sampleFile({
        id: "list-toolonly",
        overrides: {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "q" }],
            },
            {
              role: "assistant" as const,
              content: [
                {
                  type: "tool_use" as const,
                  id: "t1",
                  name: "noop",
                  input: {},
                },
              ],
            },
          ],
        },
      }),
    });
    const entries = await store.list();
    assert.ok(
      !entries.some((e) => e.conversation_id === "list-empty"),
      "empty session must not be listed"
    );
    assert.ok(
      !entries.some((e) => e.conversation_id === "list-blank"),
      "whitespace-only session must not be listed"
    );
    assert.ok(
      !entries.some((e) => e.conversation_id === "list-toolonly"),
      "tool_use-only session must not be listed"
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
      file: sampleFile({ id: "list-text", overrides: { messages } }),
    });
    const entries = await store.list();
    const e = entries.find((x) => x.conversation_id === "list-text");
    assert.equal(e?.lastFinalText, "second answer continued");
  });

  it("silently skips corrupt files in list()", async () => {
    await writeFile(join(sessionDir, "list-corrupt.json"), "{garbage", "utf8");
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
    const bad = new SessionStore(blockerPath);
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
    await writeFile(join(blocker, "sessions"), "x", "utf8");
    const bad = new SessionStore(blocker);
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
    await mkdir(sessionDir, { recursive: true });
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
    const path = join(sessionDir, `${id}.jsonl`);
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
  const path = join(sessionDir, `${id}.jsonl`);
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}
