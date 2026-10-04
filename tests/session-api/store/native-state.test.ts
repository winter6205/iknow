/**
 * Published native state: off-chain record, pure chain-derived selection,
 * immutable body pool, store publication ordering, and positive new-format
 * identification.
 *
 * Every case runs the production `SessionStore` / pool against a real
 * temporary directory; the repo's `data/` tree is never touched. Fault
 * injection is real filesystem shape, not a mock.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  isNewFormatSession,
  NATIVE_STATE_FORMAT_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  resolvePublishedNativeState,
  sanitizeSessionFile,
  SessionStore,
  validateSessionFile,
} from "../../../src/session-api/store/index.ts";
import {
  isNativeStateSha,
  nativeStateBlobsDir,
  nativeStateBodySha,
  parseNativeStateBody,
  readNativeStateBody,
  writeNativeStateBody,
} from "../../../src/session-api/store/native-state-store.ts";
import {
  isNativeStatePortError,
  NativeStatePortError,
} from "../../../src/shared/native-state-port.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import type { SessionStoreError } from "../../../src/session-api/store/index.ts";

let baseDir: string;
let projectDir: string;
let store: SessionStore;
const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-native-state-"));
  projectDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
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
const assistantMsg = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});

const snapshotOf = (
  text: string,
  overrides: Partial<NativeStateSnapshot> = {}
): NativeStateSnapshot => ({
  boundary: "input",
  messages: [userMsg(text), assistantMsg(`echo:${text}`)],
  ...overrides,
});

/** Save one session and append a two-event chain, returning the event ids. */
async function seedChain(id: string): Promise<{ e0: string; e1: string }> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({ id, events: [userMsg("q"), assistantMsg("a")] });
  return { e0: "e0", e1: "e1" };
}

async function readRecords(
  id: string
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function readLog(id: string) {
  return parseSessionJsonl(
    await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8")
  );
}

// -- body pool ----------------------------------------------------------------

describe("native state body pool", () => {
  // A real folder under the temp base: the pool creates its own dirs, so the
  // fixture must not sit at an unwritable absolute path.
  const pool = (): string => join(baseDir, "pool-session");

  it("(a) nativeStateBlobsDir nests under blobs/native/, not the trace-addressable flat blobs/", () => {
    assert.equal(nativeStateBlobsDir("/base/sess"), "/base/sess/blobs/native");
    assert.notEqual(
      nativeStateBlobsDir("/base/sess"),
      "/base/sess/blobs",
      "a flat blobs/ name is what a trace reference resolves"
    );
  });

  it("(b) writeNativeStateBody stores the exact bytes under the sha name and returns the sha", async () => {
    const bytes = JSON.stringify(snapshotOf("hello"));
    const sha = await writeNativeStateBody(pool(), bytes);
    assert.equal(sha, nativeStateBodySha(bytes));
    assert.equal(isNativeStateSha(sha), true);
    // path derivation is pure; the write above created its own dir tree
    assert.equal(
      nativeStateBodySha(bytes),
      nativeStateBodySha(Buffer.from(bytes))
    );
  });

  it("(c) identical bytes written twice dedup to ONE body (same sha, no rewrite)", async () => {
    const dir = nativeStateBlobsDir(pool());
    const payload = Buffer.from('{"boundary":"input","messages":[]}', "utf8");
    const sha1 = await writeNativeStateBody(pool(), payload);
    const sha2 = await writeNativeStateBody(pool(), payload);
    assert.equal(sha1, sha2);
    assert.deepEqual(await readdir(dir), [sha1]);
  });

  it("(d) readNativeStateBody round-trips bytes; empty body is a legal body", async () => {
    const bytes = Buffer.from("round trip ünïcodé\n", "utf8");
    const sha = await writeNativeStateBody(pool(), bytes);
    assert.deepEqual(await readNativeStateBody(pool(), sha), bytes);
    const emptySha = await writeNativeStateBody(pool(), Buffer.alloc(0));
    assert.equal((await readNativeStateBody(pool(), emptySha)).length, 0);
  });

  it("(e) missing body throws the typed native_state_body_missing (not a bare ENOENT)", async () => {
    await assert.rejects(
      () => readNativeStateBody(pool(), "0".repeat(64)),
      (err: unknown) => {
        assert.ok(!(err instanceof Error), "typed plain object, not an Error");
        assert.equal(
          (err as { kind?: string }).kind,
          "native_state_body_missing"
        );
        return true;
      }
    );
  });

  it("(f) a non-sha name (traversal) is refused before any filesystem access", async () => {
    await mkdir(pool(), { recursive: true });
    await assert.rejects(
      () => readNativeStateBody(pool(), "../secret.txt"),
      (err: unknown) => {
        assert.equal(
          (err as { kind?: string }).kind,
          "native_state_body_invalid_sha"
        );
        return true;
      }
    );
  });

  it("(g) parseNativeStateBody separates corrupt bytes from schema-invalid content", async () => {
    assert.throws(
      () => parseNativeStateBody(Buffer.from("{not json", "utf8")),
      (err: unknown) => {
        assert.equal(
          (err as { kind?: string }).kind,
          "native_state_body_corrupt"
        );
        return true;
      }
    );
    assert.throws(
      () =>
        parseNativeStateBody(Buffer.from('{"boundary":"nope","messages":[]}')),
      (err: unknown) => {
        assert.equal(
          (err as { kind?: string }).kind,
          "native_state_body_schema_invalid"
        );
        assert.equal((err as { field?: string }).field, "boundary");
        return true;
      }
    );
  });

  it("(h) empty / wrong-shaped bodies never validate", () => {
    assert.throws(
      () => parseNativeStateBody(Buffer.alloc(0)),
      (err: unknown) =>
        (err as { kind?: string }).kind === "native_state_body_corrupt"
    );
    assert.throws(
      () => parseNativeStateBody(Buffer.from('{"messages":[]}', "utf8")),
      (err: unknown) =>
        (err as { kind?: string }).kind === "native_state_body_schema_invalid"
    );
  });

  it("(i) a valid snapshot with runtimeFacts round-trips through the pool", async () => {
    const snapshot = snapshotOf("rt", {
      turnId: "e1",
      runtimeFacts: { loopPosition: "awaiting_model", graph: { done: ["n1"] } },
    });
    const sha = await writeNativeStateBody(pool(), JSON.stringify(snapshot));
    assert.deepEqual(
      parseNativeStateBody(await readNativeStateBody(pool(), sha)),
      snapshot
    );
  });
});

// -- record guards + pure selection -------------------------------------------

describe("native_state record guard and chain-derived selection", () => {
  it('(a) parse accepts a native_state record and an unknown type still throws schema_invalid "type"', async () => {
    const id = "guard";
    const { e1 } = await seedChain(id);
    await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot: snapshotOf("g"),
    });
    const log = await readLog(id);
    assert.equal(
      log.records.filter((r) => r.type === "native_state").length,
      1
    );
    assert.throws(
      () => parseSessionJsonl('{"type":"session"}\n{"type":"bogus"}\n'),
      (err: unknown) => {
        assert.equal((err as { kind?: string }).kind, "schema_invalid");
        assert.equal((err as { field?: string }).field, "type");
        return true;
      }
    );
  });

  it("(b) an off-chain record never moves head or maxEventIndex", async () => {
    const id = "offchain";
    const { e1 } = await seedChain(id);
    const before = await readLog(id);
    await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "tool_batch",
      snapshot: snapshotOf("o", { boundary: "tool_batch" }),
    });
    const after = await readLog(id);
    assert.equal(after.head, before.head);
    assert.equal(after.maxEventIndex, before.maxEventIndex);
    assert.equal(after.events.length, before.events.length);
  });

  it("(c) selection is the LAST on-chain native_state in file order", async () => {
    const id = "select-last";
    const { e0, e1 } = await seedChain(id);
    await store.appendNativeState({
      id,
      anchorEventId: e0,
      boundary: "input",
      snapshot: snapshotOf("first"),
    });
    await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "terminal",
      snapshot: snapshotOf("second", { boundary: "terminal" }),
    });
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.equal(
      sel.selected?.bodySha,
      nativeStateBodySha(
        JSON.stringify(snapshotOf("second", { boundary: "terminal" }))
      )
    );
    assert.equal(sel.selected?.boundary, "terminal");
    assert.equal(sel.anchorIndex, 1);
    assert.deepEqual(sel.messageEventIds, ["e0", "e1"]);
  });

  it("(d) a state anchored off the selected chain is not selectable", async () => {
    const id = "off-branch";
    const { e0, e1 } = await seedChain(id);
    // fork: save a divergent projection parented at e0, giving e2 off the
    // original chain, then rewind the head back to the original tip.
    await store.save({
      id,
      file: {
        ...sampleFile(id),
        messages: [userMsg("q"), assistantMsg("a"), userMsg("forked")],
      } as SessionFileV1,
    });
    await store.appendNativeState({
      id,
      anchorEventId: "e2",
      boundary: "compaction",
      snapshot: snapshotOf("fork-only", { boundary: "compaction" }),
    });
    await store.rewindToHead({ id, head: e1 });
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.equal(sel.selected, null);
    assert.equal(sel.anchorIndex, -1);
    // the fork's events are still on disk
    assert.equal((await readLog(id)).events.length, 3);
    assert.equal(e0, "e0");
  });

  it("(e) no published state → selected null, anchorIndex -1, empty fileIntents", async () => {
    const id = "empty-sel";
    await seedChain(id);
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.equal(sel.selected, null);
    assert.equal(sel.anchorIndex, -1);
    assert.deepEqual(sel.fileIntents, []);
  });

  it("(f) a torn trailing line is still dropped and the published state survives", async () => {
    const id = "torn";
    const { e1 } = await seedChain(id);
    await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot: snapshotOf("t"),
    });
    const path = join(sessionDirFor(id), `${id}.jsonl`);
    await writeFile(
      path,
      `${await readFile(path, "utf8")}{"type":"nativ`,
      "utf8"
    );
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.equal(sel.selected?.boundary, "input");
  });
});

// -- store publication ---------------------------------------------------------

describe("SessionStore.appendNativeState (body before reference)", () => {
  it("(a) publishes the body first, then the record, and returns both identities", async () => {
    const id = "pub";
    const { e1 } = await seedChain(id);
    const snapshot = snapshotOf("pub");
    const res = await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot,
    });
    assert.equal(res.bodySha, nativeStateBodySha(JSON.stringify(snapshot)));
    assert.equal(res.messageCount, 2);
    assert.equal(res.record.type, "native_state");
    assert.equal(res.record.anchorEventId, e1);
    const body = await readNativeStateBody(sessionDirFor(id), res.bodySha);
    assert.deepEqual(parseNativeStateBody(body), snapshot);
    const rec = (await readRecords(id)).find((r) => r.type === "native_state");
    assert.equal(rec?.["bodySha"], res.bodySha);
    assert.equal(rec?.["messageCount"], 2);
  });

  it("(b) the record survives a later save() — planSessionSave keeps every tail record", async () => {
    const id = "survives-save";
    const { e1 } = await seedChain(id);
    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot: snapshotOf("s"),
    });
    await store.save({
      id,
      file: {
        ...sampleFile(id),
        messages: [userMsg("q"), assistantMsg("a")],
      } as SessionFileV1,
    });
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.equal(sel.selected?.bodySha, bodySha);
  });

  it("(c) a body-pool failure throws typed and leaves NO selectable reference", async () => {
    const id = "body-fail";
    const { e1 } = await seedChain(id);
    // Real fault: `blobs/native` already exists as a regular file, so the
    // pool's mkdir cannot create its body dir.
    await mkdir(join(sessionDirFor(id), "blobs"), { recursive: true });
    await writeFile(
      nativeStateBlobsDir(sessionDirFor(id)),
      "not a dir",
      "utf8"
    );
    await assert.rejects(
      () =>
        store.appendNativeState({
          id,
          anchorEventId: e1,
          boundary: "input",
          snapshot: snapshotOf("never"),
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "write_failed");
        assert.equal(e.conversation_id, id);
        return true;
      }
    );
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.equal(sel.selected, null);
  });

  it("(d) an invalid snapshot never reaches the pool or the log", async () => {
    const id = "bad-snapshot";
    const { e1 } = await seedChain(id);
    await assert.rejects(
      () =>
        store.appendNativeState({
          id,
          anchorEventId: e1,
          boundary: "input",
          snapshot: {
            boundary: "input",
            messages: [{ role: "nope", content: [] }],
          } as unknown as NativeStateSnapshot,
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "messages");
        return true;
      }
    );
    assert.equal(
      (await readRecords(id)).filter((r) => r.type === "native_state").length,
      0
    );
  });

  it("(e) boundary disagreement between the record and its body is a typed schema failure", async () => {
    const id = "boundary-mismatch";
    const { e1 } = await seedChain(id);
    await assert.rejects(
      () =>
        store.appendNativeState({
          id,
          anchorEventId: e1,
          boundary: "terminal",
          snapshot: snapshotOf("x", { boundary: "input" }),
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "boundary");
        return true;
      }
    );
  });

  it("(f) an unknown anchor event id is refused (the record could never be selected)", async () => {
    const id = "bad-anchor";
    await seedChain(id);
    await assert.rejects(
      () =>
        store.appendNativeState({
          id,
          anchorEventId: "e99",
          boundary: "input",
          snapshot: snapshotOf("x"),
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "anchorEventId");
        return true;
      }
    );
  });

  it("(g) an unknown boundary member is refused", async () => {
    const id = "bad-boundary";
    const { e1 } = await seedChain(id);
    await assert.rejects(
      () =>
        store.appendNativeState({
          id,
          anchorEventId: e1,
          boundary: "whatever" as NativeStateSnapshot["boundary"],
          snapshot: snapshotOf("x"),
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "boundary");
        return true;
      }
    );
  });

  it("(h) a missing session is not_found; a legacy-only .json is the migration signal", async () => {
    await assert.rejects(
      () =>
        store.appendNativeState({
          id: "absent",
          anchorEventId: "e0",
          boundary: "input",
          snapshot: snapshotOf("x"),
        }),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
    const legacyId = "legacy-only";
    const dir = sessionDirFor(legacyId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${legacyId}.json`),
      JSON.stringify(sampleFile(legacyId)),
      "utf8"
    );
    await assert.rejects(
      () =>
        store.appendNativeState({
          id: legacyId,
          anchorEventId: "e0",
          boundary: "input",
          snapshot: snapshotOf("x"),
        }),
      (err: unknown) => (err as SessionStoreError).kind === "write_failed"
    );
  });

  it("(i) republishing the identical snapshot dedups the body and keeps selection stable", async () => {
    const id = "republish";
    const { e1 } = await seedChain(id);
    const snapshot = snapshotOf("same");
    const a = await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot,
    });
    const b = await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot,
    });
    assert.equal(a.bodySha, b.bodySha);
    assert.deepEqual(await readdir(nativeStateBlobsDir(sessionDirFor(id))), [
      a.bodySha,
    ]);
    // two records, but selection resolves to one state
    assert.equal(
      (await readRecords(id)).filter((r) => r.type === "native_state").length,
      2
    );
    assert.equal(resolvePublishedNativeState(await readLog(id)).anchorIndex, 1);
  });
});

// -- read side -----------------------------------------------------------------

describe("SessionStore.loadPublishedNativeState / body read", () => {
  it("(a) returns the selection plus the file-intent chain positions", async () => {
    const id = "read-sel";
    const { e1 } = await seedChain(id);
    const { bodySha, messageCount } = await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "tool_batch",
      snapshot: snapshotOf("r", { boundary: "tool_batch" }),
    });
    await store.appendFileIntent({
      id,
      toolUseId: "tu1",
      captured: true,
      targets: [
        {
          relPath: "src/a.ts",
          rootIdentity: "/root/identity",
          absentBefore: false,
          preimageSha: "a".repeat(64),
          postimageSha: "b".repeat(64),
        },
      ],
    });
    const sel = await store.loadPublishedNativeState({ id });
    assert.equal(sel.newFormat, false);
    assert.equal(sel.selected?.bodySha, bodySha);
    assert.equal(sel.selected?.messageCount, messageCount);
    assert.equal(sel.anchorIndex, 1);
    assert.equal(sel.fileIntents.length, 1);
    assert.equal(sel.fileIntents[0]?.record.toolUseId, "tu1");
    assert.equal(sel.fileIntents[0]?.anchorIndex, 1);
  });

  it("(b) no session → not_found; a session with no published state → selected null", async () => {
    await assert.rejects(
      () => store.loadPublishedNativeState({ id: "absent" }),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
    const id = "none";
    await seedChain(id);
    const sel = await store.loadPublishedNativeState({ id });
    assert.equal(sel.selected, null);
    assert.equal(sel.anchorIndex, -1);
  });

  it("(c) a corrupt log surfaces parse_failed, not an empty selection", async () => {
    const id = "corrupt-log";
    await seedChain(id);
    const path = join(sessionDirFor(id), `${id}.jsonl`);
    const raw = await readFile(path, "utf8");
    await writeFile(
      path,
      raw.replace('{"type":"head"', '{broken\n{"type":"head"'),
      "utf8"
    );
    await assert.rejects(
      () => store.loadPublishedNativeState({ id }),
      (err: unknown) => (err as SessionStoreError).kind === "parse_failed"
    );
  });

  it("(d) body read: valid body round-trips the exact snapshot", async () => {
    const id = "body-ok";
    const { e1 } = await seedChain(id);
    const snapshot = snapshotOf("body", { turnId: "e1" });
    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot,
    });
    assert.deepEqual(
      await store.readPublishedNativeStateBody({ id, bodySha }),
      snapshot
    );
  });

  it("(e) body read surfaces missing / corrupt / schema-invalid as DISTINCT typed outcomes", async () => {
    const id = "body-bad";
    const { e1 } = await seedChain(id);
    const { bodySha } = await store.appendNativeState({
      id,
      anchorEventId: e1,
      boundary: "input",
      snapshot: snapshotOf("b"),
    });
    const dir = nativeStateBlobsDir(sessionDirFor(id));

    await writeFile(join(dir, bodySha), "{not json", "utf8");
    await assert.rejects(
      () => store.readPublishedNativeStateBody({ id, bodySha }),
      (err: unknown) => (err as SessionStoreError).kind === "parse_failed"
    );

    await writeFile(
      join(dir, bodySha),
      '{"boundary":"input","messages":[{"role":"user","content":[{"type":"nope"}]}]}',
      "utf8"
    );
    await assert.rejects(
      () => store.readPublishedNativeStateBody({ id, bodySha }),
      (err: unknown) => (err as SessionStoreError).kind === "schema_invalid"
    );

    await rm(join(dir, bodySha));
    await assert.rejects(
      () => store.readPublishedNativeStateBody({ id, bodySha }),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });

  it("(f) a traversal body name is schema_invalid, never a file read", async () => {
    const id = "body-sha-gate";
    await seedChain(id);
    await assert.rejects(
      () =>
        store.readPublishedNativeStateBody({
          id,
          bodySha: "../../../etc/passwd",
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "bodySha");
        return true;
      }
    );
  });
});

// -- positive new-format identification ---------------------------------------

describe("new-format identification", () => {
  it("(a) a plain session file is old format; the field is absent from its bytes", async () => {
    const id = "old-format";
    await store.save({ id, file: sampleFile(id) });
    const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
    assert.ok(
      !raw.includes("nativeStateFormat"),
      "old bytes must not gain a key"
    );
    assert.equal(isNewFormatSession(await store.load(id)), false);
  });

  it("(b) a stamped file is new format and survives save/load verbatim", async () => {
    const id = "new-format";
    const file = {
      ...sampleFile(id),
      nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
    } as SessionFileV1;
    await store.save({ id, file });
    const loaded = await store.load(id);
    assert.equal(isNewFormatSession(loaded), true);
    assert.equal(loaded.nativeStateFormat, NATIVE_STATE_FORMAT_VERSION);
    await store.save({ id, file: loaded });
    const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
    assert.ok(
      raw.includes(`"nativeStateFormat":${NATIVE_STATE_FORMAT_VERSION}`)
    );
  });

  it("(c) a malformed value fails validate with field nativeStateFormat (never coerced)", () => {
    assert.equal(
      validateSessionFile({ ...sampleFile("x"), nativeStateFormat: "1" }),
      "nativeStateFormat"
    );
    assert.equal(
      validateSessionFile({ ...sampleFile("x"), nativeStateFormat: 0 }),
      "nativeStateFormat"
    );
    assert.equal(
      validateSessionFile({
        ...sampleFile("x"),
        nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
      }),
      null
    );
  });

  it("(d) loadPublishedNativeState reports the format from the header", async () => {
    const id = "fmt-read";
    await store.save({
      id,
      file: {
        ...sampleFile(id),
        nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
      } as SessionFileV1,
    });
    assert.equal(
      (await store.loadPublishedNativeState({ id })).newFormat,
      true
    );
  });

  it("(e) sanitize keeps the field and leaves a legacy file untouched", () => {
    const legacy = sanitizeSessionFile(sampleFile("legacy"));
    assert.ok(!("nativeStateFormat" in legacy));
    const stamped = sanitizeSessionFile({
      ...sampleFile("stamped"),
      nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
    });
    assert.equal(stamped.nativeStateFormat, NATIVE_STATE_FORMAT_VERSION);
  });
});

// -- port failure type ---------------------------------------------------------

describe("neutral port typed failure", () => {
  it("(a) NativeStatePortError is a real Error carrying a code, guardable by type", () => {
    const err = new NativeStatePortError(
      "PERSIST_FAILED",
      "body write failed",
      {
        conversationId: "c1",
      }
    );
    assert.ok(err instanceof Error);
    assert.equal(err.name, "NativeStatePortError");
    assert.equal(err.code, "PERSIST_FAILED");
    assert.deepEqual(err.details, { conversationId: "c1" });
    assert.equal(isNativeStatePortError(err), true);
    assert.equal(isNativeStatePortError(new Error("plain")), false);
  });
});
