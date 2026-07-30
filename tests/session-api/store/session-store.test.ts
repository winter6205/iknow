/**
 * SessionStore typed-IO contract tests (022 T2).
 * Covers all 6 SessionStoreError kinds + atomic write + list ordering.
 * Uses an isolated temp dir so the repo's data/ tree is never touched.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import type { SessionStoreError } from "../../../src/session-api/store/index.ts";

let store: SessionStore;
let baseDir: string;

const sampleFile = (
  id: string,
  overrides: Partial<SessionFileV1> = {}
): SessionFileV1 => ({
  schemaVersion: 1,
  conversation_id: id,
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: new Date().toISOString(),
  ...overrides,
});

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-store-"));
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("SessionStore.load", () => {
  it("returns the saved file when valid", async () => {
    const file = sampleFile("conv-load-ok");
    await store.save(file.conversation_id, file);
    const loaded = await store.load("conv-load-ok");
    assert.equal(loaded.conversation_id, "conv-load-ok");
    assert.equal(loaded.schemaVersion, 1);
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
    const { writeFile } = await import("node:fs/promises");
    const path = join(baseDir, "sessions", "conv-corrupt.json");
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

  it("throws schema_invalid when schemaVersion is wrong", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = join(baseDir, "sessions", "conv-badver.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 2 }), "utf8");
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
    const { writeFile } = await import("node:fs/promises");
    const path = join(baseDir, "sessions", "conv-badfield.json");
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
  it("writes the file to data/sessions/<id>.json", async () => {
    const file = sampleFile("conv-save-ok");
    await store.save("conv-save-ok", file);
    const s = await stat(join(baseDir, "sessions", "conv-save-ok.json"));
    assert.ok(s.isFile());
  });

  it("atomic write leaves no .tmp residue on success", async () => {
    const file = sampleFile("conv-atomic");
    await store.save("conv-atomic", file);
    // The .tmp file must have been renamed, not left behind.
    await assert.rejects(
      stat(join(baseDir, "sessions", "conv-atomic.json.tmp"))
    );
  });

  it("overwrites an existing file", async () => {
    await store.save(
      "conv-overwrite",
      sampleFile("conv-overwrite", { turnCount: 1 })
    );
    await store.save(
      "conv-overwrite",
      sampleFile("conv-overwrite", { turnCount: 5 })
    );
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

  it("returns entries sorted by updatedAt descending (no messages)", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-02-01T00:00:00.000Z";
    const t3 = "2026-03-01T00:00:00.000Z";
    await store.save("list-a", sampleFile("list-a", { updatedAt: t1 }));
    await store.save("list-b", sampleFile("list-b", { updatedAt: t3 }));
    await store.save("list-c", sampleFile("list-c", { updatedAt: t2 }));

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
      assert.ok(!("messages" in e), "list entries must not contain messages");
    }
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
    await store.save("list-text", sampleFile("list-text", { messages }));
    const entries = await store.list();
    const e = entries.find((x) => x.conversation_id === "list-text");
    assert.equal(e?.lastFinalText, "second answer continued");
  });

  it("silently skips corrupt files in list()", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(baseDir, "sessions", "list-corrupt.json"),
      "{garbage",
      "utf8"
    );
    const entries = await store.list();
    assert.ok(!entries.some((e) => e.conversation_id === "list-corrupt"));
  });
});

describe("SessionStore.delete", () => {
  it("removes the file and then load() throws not_found", async () => {
    await store.save("conv-del", sampleFile("conv-del"));
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
    const { writeFile } = await import("node:fs/promises");
    // Force save() to fail by making the sessions path traverse through a regular file.
    const blockerPath = join(blocker, "blocker");
    await writeFile(blockerPath, "x", "utf8");
    const bad = new SessionStore(blockerPath);
    try {
      await bad.save("x", sampleFile("x"));
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
    const { writeFile } = await import("node:fs/promises");
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
