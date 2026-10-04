/**
 * `NativeStatePort` host adapter (ADR-0136) — the ONE place the store's typed
 * `SessionStoreError` union is mapped onto the port's `NativeStatePortError`
 * vocabulary, so no second error dialect exists downstream.
 *
 * Real temporary store, real filesystem; durability is re-read through a
 * NEWLY CONSTRUCTED store.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { createNativeStatePort } from "../../../src/session-api/store/native-state-port-host.ts";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import {
  isNativeStatePortError,
  type NativeStateSnapshot,
} from "../../../src/shared/native-state-port.ts";

let baseDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-nsp-host-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
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

async function seedChain(id: string): Promise<string> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({ id, events: [userMsg("go")] });
  const log = parseSessionJsonl(
    await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8")
  );
  assert.ok(log.head !== null, "fixture must have a persisted head");
  return log.head;
}

const target = (over: Record<string, unknown> = {}) => ({
  relPath: "a.ts",
  rootIdentity: "/root",
  absentBefore: false,
  preimageSha: "a".repeat(64),
  postimageSha: "b".repeat(64),
  ...over,
});

const snapshot = (): NativeStateSnapshot => ({
  boundary: "input",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
});

describe("createNativeStatePort — recordFileIntent", () => {
  it("(a) a valid request lands durably and re-reads from a fresh store", async () => {
    const id = "ok";
    await seedChain(id);
    const port = createNativeStatePort({ store });

    await port.recordFileIntent({
      conversationId: id,
      toolUseId: "tu-1",
      captured: true,
      targets: [target()],
    });

    const reopened = new SessionStore(baseDir, process.cwd());
    const { fileIntents } = await reopened.loadPublishedNativeState({ id });
    assert.equal(fileIntents.length, 1);
    assert.equal(fileIntents[0]!.record.toolUseId, "tu-1");
    assert.equal(fileIntents[0]!.record.targets[0]!.relPath, "a.ts");
  });

  it("(b) an EMPTY target list is a pre-write rejection (VALIDATION) and writes nothing", async () => {
    const id = "empty";
    await seedChain(id);
    const before = await readFile(
      join(sessionDirFor(id), `${id}.jsonl`),
      "utf8"
    );
    const port = createNativeStatePort({ store });

    await assert.rejects(
      () =>
        port.recordFileIntent({
          conversationId: id,
          toolUseId: "tu-empty",
          captured: true,
          targets: [],
        }),
      (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION"
    );
    assert.equal(
      await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8"),
      before,
      "a rejected request appends nothing"
    );
  });

  it("(c) an empty toolUseId is VALIDATION", async () => {
    const id = "empty-id";
    await seedChain(id);
    const port = createNativeStatePort({ store });
    await assert.rejects(
      () =>
        port.recordFileIntent({
          conversationId: id,
          toolUseId: "",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION"
    );
  });

  it("(d) a legacy-only session makes the required write fail: PERSIST_FAILED", async () => {
    const id = "legacy";
    await mkdir(sessionDirFor(id), { recursive: true });
    await writeFile(
      join(sessionDirFor(id), `${id}.json`),
      JSON.stringify({ ...sampleFile(id), schemaVersion: 1 }),
      "utf8"
    );
    const port = createNativeStatePort({ store });

    await assert.rejects(
      () =>
        port.recordFileIntent({
          conversationId: id,
          toolUseId: "tu-legacy",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) =>
        isNativeStatePortError(err) && err.code === "PERSIST_FAILED"
    );
  });

  it("(e) an unknown conversation is VALIDATION (nothing was written)", async () => {
    const port = createNativeStatePort({ store });
    await assert.rejects(
      () =>
        port.recordFileIntent({
          conversationId: "no-such-session",
          toolUseId: "tu",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION"
    );
  });

  it("(f) a session with no persisted head is VALIDATION (no synthetic anchor)", async () => {
    const id = "no-head";
    await store.save({ id, file: sampleFile(id) });
    const port = createNativeStatePort({ store });
    await assert.rejects(
      () =>
        port.recordFileIntent({
          conversationId: id,
          toolUseId: "tu",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION"
    );
  });

  it("(g) captured:false with no shas is accepted (SC9a evidence absence)", async () => {
    const id = "uncaptured";
    await seedChain(id);
    const port = createNativeStatePort({ store });
    await port.recordFileIntent({
      conversationId: id,
      toolUseId: "tu-off",
      captured: false,
      targets: [{ relPath: "a.ts", rootIdentity: "/root", absentBefore: true }],
    });
    const reopened = new SessionStore(baseDir, process.cwd());
    const { fileIntents } = await reopened.loadPublishedNativeState({ id });
    assert.equal(fileIntents[0]!.record.captured, false);
    assert.ok(!("preimageSha" in fileIntents[0]!.record.targets[0]!));
  });

  it("(h) a malformed target is VALIDATION, not a persist failure", async () => {
    const id = "malformed";
    await seedChain(id);
    const port = createNativeStatePort({ store });
    await assert.rejects(
      () =>
        port.recordFileIntent({
          conversationId: id,
          toolUseId: "tu",
          captured: true,
          // Not a sha — the store's alphabet gate must reject it pre-write.
          targets: [target({ preimageSha: "not-a-sha" })],
        }),
      (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION"
    );
  });
});

describe("createNativeStatePort — publishNativeState", () => {
  it("(a) a valid state publishes and returns the body's content address", async () => {
    const id = "pub";
    const anchor = await seedChain(id);
    const port = createNativeStatePort({ store });

    const res = await port.publishNativeState({
      conversationId: id,
      anchorEventId: anchor,
      boundary: "input",
      snapshot: snapshot(),
    });

    assert.match(res.bodySha, /^[0-9a-f]{64}$/);
    assert.equal(res.messageCount, 1);
    const reopened = new SessionStore(baseDir, process.cwd());
    const selection = await reopened.loadPublishedNativeState({ id });
    assert.equal(selection.selected?.bodySha, res.bodySha);
    const body = await reopened.readPublishedNativeStateBody({
      id,
      bodySha: res.bodySha,
    });
    assert.equal(body.messages.length, 1);
  });

  it("(b) a boundary that disagrees with the snapshot is VALIDATION", async () => {
    const id = "pub-bad";
    const anchor = await seedChain(id);
    const port = createNativeStatePort({ store });
    await assert.rejects(
      () =>
        port.publishNativeState({
          conversationId: id,
          anchorEventId: anchor,
          boundary: "terminal",
          snapshot: snapshot(),
        }),
      (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION"
    );
  });

  it("(c) an anchor that is not on the log is VALIDATION and publishes nothing", async () => {
    const id = "pub-anchor";
    await seedChain(id);
    const port = createNativeStatePort({ store });
    await assert.rejects(
      () =>
        port.publishNativeState({
          conversationId: id,
          anchorEventId: "e-does-not-exist",
          boundary: "input",
          snapshot: snapshot(),
        }),
      (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION"
    );
    const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
    assert.ok(!raw.includes('"native_state"'));
  });
});
