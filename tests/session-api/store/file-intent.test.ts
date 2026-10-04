/**
 * Durable file write intent: the pre-mutation record that carries EVERY
 * target of a multi-file call (the in-memory preimage ledger is last-write-wins
 * per tool_use_id) and anchors at the persisted head.
 *
 * Real temporary store, real filesystem: the repo's `data/` tree is never
 * touched.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  resolvePublishedNativeState,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { FileIntentTarget } from "../../../src/session-api/store/jsonl.ts";
import type {
  SessionFileV1,
  SessionStoreError,
} from "../../../src/session-api/store/index.ts";

let baseDir: string;
let projectDir: string;
let store: SessionStore;
const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-file-intent-"));
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

const target = (over: Partial<FileIntentTarget> = {}): FileIntentTarget => ({
  relPath: "src/a.ts",
  rootIdentity: "/root/identity",
  absentBefore: false,
  preimageSha: "a".repeat(64),
  postimageSha: "b".repeat(64),
  ...over,
});

/** Save one session with a persisted chain, returning the head event id. */
async function seedChain(id: string): Promise<string> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({ id, events: [userMsg("q"), userMsg("q2")] });
  return "e1";
}

async function readIntentRecords(
  id: string
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.type === "file_intent");
}

async function readLog(id: string) {
  return parseSessionJsonl(
    await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8")
  );
}

describe("SessionStore.appendFileIntent", () => {
  it("(a) anchors the record at the CURRENT persisted head and leaves head untouched", async () => {
    const id = "anchor";
    const head = await seedChain(id);
    const before = await readLog(id);
    const res = await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [target()],
    });
    assert.equal(res.record.anchorEventId, head);
    const after = await readLog(id);
    assert.equal(after.head, before.head);
    assert.equal(after.maxEventIndex, before.maxEventIndex);
    const [rec] = await readIntentRecords(id);
    assert.equal(rec?.["toolUseId"], "tu-1");
    assert.equal(rec?.["captured"], true);
    assert.equal(typeof rec?.["createdAt"], "string");
  });

  it("(b) a multi-file call keeps EVERY target (no last-write-wins)", async () => {
    const id = "multi";
    await seedChain(id);
    await store.appendFileIntent({
      id,
      toolUseId: "tu-multi",
      captured: true,
      targets: [
        target({ relPath: "src/a.ts" }),
        target({
          relPath: "src/b.ts",
          absentBefore: true,
          preimageSha: "c".repeat(64),
        }),
        target({ relPath: "docs/c.md", postimageSha: undefined }),
      ],
    });
    const [rec] = await readIntentRecords(id);
    const targets = rec?.["targets"] as Array<Record<string, unknown>>;
    assert.equal(targets.length, 3);
    assert.deepEqual(
      targets.map((t) => t["relPath"]),
      ["src/a.ts", "src/b.ts", "docs/c.md"]
    );
    assert.equal(targets[1]?.["absentBefore"], true);
    // absent postimage is a legal key-absent shape, never `undefined` on disk
    assert.ok(!("postimageSha" in targets[2]!));
  });

  it("(c) captured:false records the suppression and carries no preimage", async () => {
    const id = "uncaptured";
    await seedChain(id);
    await store.appendFileIntent({
      id,
      toolUseId: "tu-off",
      captured: false,
      targets: [target({ preimageSha: undefined })],
    });
    const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
    const line = raw.split("\n").filter((l) => l.includes('"file_intent"'))[0]!;
    assert.ok(!line.includes("preimageSha"), "no captured evidence is claimed");
    const [rec] = await readIntentRecords(id);
    const targets = rec?.["targets"] as Array<Record<string, unknown>>;
    assert.ok(!("preimageSha" in targets[0]!));
    assert.equal(rec?.["captured"], false);
  });

  it("(d) the record survives a later save()", async () => {
    const id = "survives";
    await seedChain(id);
    await store.appendFileIntent({
      id,
      toolUseId: "tu-s",
      captured: true,
      targets: [target()],
    });
    await store.save({
      id,
      file: {
        ...sampleFile(id),
        messages: [userMsg("q"), userMsg("q2")],
      } as SessionFileV1,
    });
    assert.equal((await readIntentRecords(id)).length, 1);
    assert.equal(
      resolvePublishedNativeState(await readLog(id)).fileIntents.length,
      1
    );
  });

  it("(e) repeated appends are additive and each keeps its own chain position", async () => {
    const id = "repeat";
    await seedChain(id);
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [target({ relPath: "a.ts" })],
    });
    await store.appendEvents({ id, events: [userMsg("q3")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-2",
      captured: true,
      targets: [target({ relPath: "b.ts" })],
    });
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.deepEqual(
      sel.fileIntents.map((p) => [p.record.toolUseId, p.anchorIndex]),
      [
        ["tu-1", 1],
        ["tu-2", 2],
      ]
    );
  });

  it("(f) an intent anchored off the selected chain is excluded from selection", async () => {
    const id = "rewound";
    await seedChain(id);
    await store.appendFileIntent({
      id,
      toolUseId: "tu-fork",
      captured: true,
      targets: [target()],
    });
    await store.rewindToHead({ id, head: "e0" });
    const sel = resolvePublishedNativeState(await readLog(id));
    assert.deepEqual(sel.fileIntents, []);
    // the record is still on disk (append-only, never dropped)
    assert.equal((await readIntentRecords(id)).length, 1);
  });
});

describe("appendFileIntent typed failures", () => {
  it("(a) no persisted head yet is a typed failure, never a silent null anchor", async () => {
    const id = "no-head";
    await store.save({ id, file: sampleFile(id) });
    const log = await readLog(id);
    assert.equal(log.head, null);
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id,
          toolUseId: "tu",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "anchorEventId");
        return true;
      }
    );
    assert.equal((await readIntentRecords(id)).length, 0);
  });

  it("(b) a missing session is not_found and a legacy-only .json is the migration signal", async () => {
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id: "absent",
          toolUseId: "tu",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
    const legacyId = "legacy";
    const dir = sessionDirFor(legacyId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${legacyId}.json`),
      JSON.stringify(sampleFile(legacyId)),
      "utf8"
    );
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id: legacyId,
          toolUseId: "tu",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) => (err as SessionStoreError).kind === "write_failed"
    );
  });

  it("(c) empty targets are refused — a zero-target record claims no verifiable effect", async () => {
    const id = "empty-targets";
    await seedChain(id);
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id,
          toolUseId: "tu",
          captured: true,
          targets: [],
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "targets");
        return true;
      }
    );
  });

  it("(d) an empty toolUseId is refused", async () => {
    const id = "empty-tool";
    await seedChain(id);
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id,
          toolUseId: "",
          captured: true,
          targets: [target()],
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "toolUseId");
        return true;
      }
    );
  });

  it("(e) a non-sha preimage reference is refused (the sha is transcript-supplied)", async () => {
    const id = "bad-sha";
    await seedChain(id);
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id,
          toolUseId: "tu",
          captured: true,
          targets: [target({ preimageSha: "../../etc/passwd" })],
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "schema_invalid");
        assert.equal(e.field, "targets");
        return true;
      }
    );
  });

  it("(f) captured:true without a preimage reference is refused", async () => {
    const id = "no-preimage";
    await seedChain(id);
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id,
          toolUseId: "tu",
          captured: true,
          targets: [target({ preimageSha: undefined })],
        }),
      (err: unknown) => (err as SessionStoreError).kind === "schema_invalid"
    );
  });

  it("(g) captured:false carrying a preimage reference is refused", async () => {
    const id = "false-with-preimage";
    await seedChain(id);
    await assert.rejects(
      () =>
        store.appendFileIntent({
          id,
          toolUseId: "tu",
          captured: false,
          targets: [target()],
        }),
      (err: unknown) => (err as SessionStoreError).kind === "schema_invalid"
    );
  });

  it("(h) an empty relPath / non-boolean absentBefore is refused", async () => {
    const id = "bad-target";
    await seedChain(id);
    for (const bad of [
      target({ relPath: "" }),
      target({ absentBefore: "yes" as unknown as boolean }),
      target({ rootIdentity: "" }),
    ]) {
      await assert.rejects(
        () =>
          store.appendFileIntent({
            id,
            toolUseId: "tu",
            captured: true,
            targets: [bad],
          }),
        (err: unknown) => {
          const e = err as SessionStoreError;
          assert.equal(e.kind, "schema_invalid");
          assert.equal(e.field, "targets");
          return true;
        }
      );
    }
    assert.equal((await readIntentRecords(id)).length, 0);
  });
});

describe("file_intent record guard", () => {
  it('(a) a malformed persisted file_intent is rejected with schema_invalid "type"', async () => {
    const raw =
      '{"type":"session","schemaVersion":5,"conversation_id":"g","title":"","cwd":"","sanitized_at":"","jsonMode":false,"turnCount":0,"updatedAt":""}\n' +
      '{"type":"file_intent","toolUseId":"tu","anchorEventId":"e0","targets":[{"relPath":"","rootIdentity":"r","absentBefore":false}],"captured":true,"createdAt":"2026-01-01T00:00:00.000Z"}\n';
    assert.throws(
      () => parseSessionJsonl(raw),
      (err: unknown) => {
        assert.equal((err as { kind?: string }).kind, "schema_invalid");
        assert.equal((err as { field?: string }).field, "type");
        return true;
      }
    );
  });

  it("(b) a well-formed file_intent parses and stays out of the head chain", async () => {
    const raw =
      '{"type":"session","schemaVersion":5,"conversation_id":"g","title":"","cwd":"","sanitized_at":"","jsonMode":false,"turnCount":0,"updatedAt":""}\n' +
      '{"type":"message","id":"e0","parent":null,"message":{"role":"user","content":[{"type":"text","text":"q"}]}}\n' +
      '{"type":"file_intent","toolUseId":"tu","anchorEventId":"e0","targets":[{"relPath":"a.ts","rootIdentity":"r","absentBefore":true,"preimageSha":"' +
      "a".repeat(64) +
      '"}],"captured":true,"createdAt":"2026-01-01T00:00:00.000Z"}\n' +
      '{"type":"head","id":"e0"}\n';
    const log = parseSessionJsonl(raw);
    assert.equal(log.head, "e0");
    assert.equal(log.maxEventIndex, 0);
    const sel = resolvePublishedNativeState(log);
    assert.equal(sel.fileIntents.length, 1);
    assert.equal(sel.fileIntents[0]?.anchorIndex, 0);
    assert.equal(sel.fileIntents[0]?.record.captured, true);
  });
});
