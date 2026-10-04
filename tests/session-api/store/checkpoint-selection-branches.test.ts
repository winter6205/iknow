/**
 * SC7 — event-head authority for checkpoint selection.
 *
 * The criterion: with several session-history branches, each carrying its own
 * COMPLETE published native state, selection follows the selected reachable
 * event/head chain deterministically — not timestamp order, not an independent
 * mutable current-checkpoint pointer, not a duplicate branch registry.
 *
 * Every case runs the production `SessionStore`, the real session-local body
 * pool, and the real `recoverSession` entry against a temporary directory; the
 * repo's `data/` tree and any user session dir are never touched. The only
 * hand-written bytes are the deliberate `createdAt` back-dating and the
 * `utimes` calls that make the timestamp direction unambiguous; those say so
 * at the point of use.
 */
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  parseSessionJsonl,
  recoverSession,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type FileIntentTarget,
  type ParsedSessionLog,
  type SessionFileV1,
  type SessionNativeStateRecord,
  type SessionTailRecord,
} from "../../../src/session-api/store/index.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";

/** Epoch far outside any plausible retention window. */
const ANCIENT = new Date("2000-01-01T00:00:00.000Z");

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string => join(sessionDirFor(id), `${id}.jsonl`);
const bodyPathFor = (id: string, sha: string): string =>
  join(sessionDirFor(id), "blobs", "native", sha);

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-sc7-branches-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-sc7-taskroot-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(baseDir, taskRoot);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const sampleFile = (id: string): SessionFileV1 =>
  ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: taskRoot,
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
  }) as SessionFileV1;

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
const assistantMsg = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});

/** A complete published state — the two branches must differ in real content,
 *  so a wrong pick is visible in the restored messages and not only in a sha. */
const snapshotOf = (
  label: string,
  overrides: Partial<NativeStateSnapshot> = {}
): NativeStateSnapshot => ({
  boundary: "input",
  messages: [
    userMsg(`question on ${label}`),
    assistantMsg(`answer on ${label}`),
  ],
  ...overrides,
});

const recover = (id: string) =>
  recoverSession({
    store,
    conversationId: id,
    taskRoot,
    liveRootIdentity: "/live/sc7-checkout",
  });

async function readLog(id: string): Promise<ParsedSessionLog> {
  return parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
}

/** Every file under the session folder, as sorted folder-relative paths. */
async function sessionFilePaths(id: string): Promise<ReadonlyArray<string>> {
  const root = sessionDirFor(id);
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      out.push(full.slice(root.length + 1));
    }
  };
  await walk(root);
  return out.sort();
}

/**
 * One session, two real branches, one COMPLETE published state each.
 *
 *   e0 ── e1                     (branch A: "input" checkpoint at e1)
 *    └── e2 ── e3               (branch B: "compaction" checkpoint at e3)
 *
 * A's record is appended first and B's second, so file order and `createdAt`
 * both favour B. The head starts on B (the last append left it there) and is
 * moved onto A with the production rewind primitive.
 */
async function seedTwoBranches(id: string): Promise<{
  readonly bodyShaA: string;
  readonly bodyShaB: string;
  readonly snapshotA: NativeStateSnapshot;
  readonly snapshotB: NativeStateSnapshot;
}> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [userMsg("branch-a question"), assistantMsg("branch-a answer")],
  });
  const snapshotA = snapshotOf("branch-A");
  const a = await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "input",
    snapshot: snapshotA,
  });
  // Fork: move the head back to the shared root, then commit a divergent turn.
  await store.writeHead({ id, head: "e0" });
  await store.appendEvents({
    id,
    events: [userMsg("branch-b question"), assistantMsg("branch-b answer")],
  });
  const snapshotB = snapshotOf("branch-B", { boundary: "compaction" });
  const b = await store.appendNativeState({
    id,
    anchorEventId: "e3",
    boundary: "compaction",
    snapshot: snapshotB,
  });
  return { bodyShaA: a.bodySha, bodyShaB: b.bodySha, snapshotA, snapshotB };
}

/** Rewrite ONE record's `createdAt`, leaving every other byte of the log
 *  untouched. Hand-written bytes on purpose: no production writer can emit a
 *  chosen past timestamp, and the timestamp claim needs one. */
async function backDateRecord(
  id: string,
  match: (rec: Record<string, unknown>) => boolean,
  createdAt: string
): Promise<void> {
  const raw = await readFile(jsonlFor(id), "utf8");
  const lines = raw.split("\n");
  let hits = 0;
  const rewritten = lines.map((line) => {
    if (line.trim().length === 0) return line;
    const rec = JSON.parse(line) as Record<string, unknown>;
    if (!match(rec)) return line;
    hits += 1;
    return JSON.stringify({ ...rec, createdAt });
  });
  assert.equal(hits, 1, "exactly one record matches the back-date target");
  await writeFile(jsonlFor(id), rewritten.join("\n"), "utf8");
}

describe("SC7 — selection follows the selected head chain, not record time", () => {
  it("(a) with the head on branch B, recovery restores B's state even though A was published first", async () => {
    const id = "head-on-b";
    const { bodyShaA, bodyShaB, snapshotA, snapshotB } =
      await seedTwoBranches(id);

    const sel = await store.loadPublishedNativeState({ id });
    assert.deepEqual(sel.messageEventIds, ["e0", "e2", "e3"]);
    assert.equal(sel.selected?.bodySha, bodyShaB);
    assert.equal(sel.anchorIndex, 2);

    // Reopening is deterministic: same chain, same state, every time.
    for (let open = 0; open < 3; open += 1) {
      const report = await recover(id);
      assert.equal(report.status.status, "recovered");
      assert.deepEqual(report.messages, snapshotB.messages);
      assert.equal(report.savedMessageCount, snapshotB.messages.length);
      assert.notEqual(
        JSON.stringify(report.messages),
        JSON.stringify(snapshotA.messages)
      );
    }
    // A's record is off-chain but retained: the losing branch is not deleted.
    const log = await readLog(id);
    assert.ok(
      log.records.some(
        (r) => r.type === "native_state" && r.bodySha === bodyShaA
      )
    );
    assert.ok((await stat(bodyPathFor(id, bodyShaA))).isFile());
  });

  it("(b) after rewindToHead moves the head to branch A, recovery restores A's state", async () => {
    const id = "head-move-to-a";
    const { bodyShaA, bodyShaB, snapshotA } = await seedTwoBranches(id);
    assert.equal(
      (await store.loadPublishedNativeState({ id })).selected?.bodySha,
      bodyShaB
    );

    await store.rewindToHead({ id, head: "e1" });
    assert.equal(await store.readHead(id), "e1");

    const sel = await store.loadPublishedNativeState({ id });
    assert.deepEqual(sel.messageEventIds, ["e0", "e1"]);
    assert.equal(sel.selected?.bodySha, bodyShaA);
    assert.equal(sel.anchorIndex, 1);

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.deepEqual(report.messages, snapshotA.messages);
  });

  it("(c) the losing branch is the newest by record time and the last in file order, and it still loses", async () => {
    const id = "timestamp-cannot-decide";
    const { bodyShaA, bodyShaB, snapshotA } = await seedTwoBranches(id);
    await store.rewindToHead({ id, head: "e1" });

    // Make the WINNER the oldest thing in the file: an ancient `createdAt` on
    // A's record, plus ancient mtimes on the log and on B's body. A
    // timestamp-latest or mtime-latest rule would now pick B.
    await backDateRecord(
      id,
      (rec) => rec.type === "native_state" && rec.anchorEventId === "e1",
      ANCIENT.toISOString()
    );
    for (const path of [jsonlFor(id), bodyPathFor(id, bodyShaB)]) {
      await utimes(path, ANCIENT, ANCIENT);
    }

    // Fixture claim, asserted so the test cannot pass on a broken premise:
    // the on-chain state is strictly older than the off-chain one.
    const log = await readLog(id);
    const isState =
      (bodySha: string) =>
      (r: SessionTailRecord): r is SessionNativeStateRecord =>
        r.type === "native_state" && r.bodySha === bodySha;
    const aRec = log.records.find(isState(bodyShaA));
    const bRec = log.records.find(isState(bodyShaB));
    assert.ok(aRec !== undefined && bRec !== undefined);
    assert.ok(
      Date.parse(aRec.createdAt) < Date.parse(bRec.createdAt),
      "the on-chain state's record time is older"
    );
    assert.ok(
      log.records.indexOf(aRec) < log.records.indexOf(bRec),
      "the on-chain state's record is also earlier in file order"
    );

    const sel = await store.loadPublishedNativeState({ id });
    assert.equal(sel.selected?.bodySha, bodyShaA);
    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.deepEqual(report.messages, snapshotA.messages);
  });
});

describe("SC7 — no independent current-checkpoint pointer or branch registry", () => {
  const FORBIDDEN_KEY = [
    /current_?checkpoint/i,
    /selected_?checkpoint/i,
    /latest_?checkpoint/i,
    /checkpoint_?pointer/i,
    /^parent_?checkpoint_?id$/i,
    /^branch(es)?_?(id|registry|map|index|name)$/i,
  ];
  const NATIVE_STATE_RECORD_KEYS = new Set([
    "type",
    "anchorEventId",
    "bodySha",
    "boundary",
    "messageCount",
    "createdAt",
  ]);

  const collectKeys = (value: unknown, into: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, into);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  };

  it("(d) the persisted shape carries no pointer, no parent-pointer, and no branch registry", async () => {
    const id = "no-pointer";
    const { bodyShaA, bodyShaB } = await seedTwoBranches(id);
    const log = await readLog(id);

    const keys = new Set<string>();
    collectKeys(log.header, keys);
    collectKeys(log.records, keys);
    for (const key of keys) {
      for (const forbidden of FORBIDDEN_KEY) {
        assert.ok(
          !forbidden.test(key),
          `persisted key '${key}' is a checkpoint pointer / branch registry`
        );
      }
    }
    const nativeStateKeys = log.records
      .filter((r) => r.type === "native_state")
      .map((r) => new Set(Object.keys(r)));
    assert.equal(nativeStateKeys.length, 2);
    for (const keySet of nativeStateKeys) {
      assert.deepEqual(
        [...keySet].sort(),
        [...NATIVE_STATE_RECORD_KEYS].sort()
      );
    }
    // No second file could carry such a registry either.
    assert.deepEqual(await sessionFilePaths(id), [
      join("blobs", "native", bodyShaA),
      join("blobs", "native", bodyShaB),
      `${id}.jsonl`,
    ]);
  });

  it("(e) the head record is the only input that changed between the two selections", async () => {
    const id = "head-is-the-only-delta";
    const { bodyShaA, bodyShaB, snapshotB } = await seedTwoBranches(id);
    const beforeLog = await readLog(id);
    const beforeA = await readFile(bodyPathFor(id, bodyShaA), "utf8");
    const beforeB = await readFile(bodyPathFor(id, bodyShaB), "utf8");
    assert.equal(beforeLog.head, "e3");
    assert.deepEqual((await recover(id)).messages, snapshotB.messages);

    // Moving the head rewrites the log; it must not rewrite, drop, or reorder
    // any published reference or body to change the selection.
    await store.rewindToHead({ id, head: "e1" });
    const afterLog = await readLog(id);
    const nonHead = (log: ParsedSessionLog) =>
      log.records.filter((r) => r.type !== "head");
    assert.deepEqual(nonHead(afterLog), nonHead(beforeLog));
    assert.equal(afterLog.head, "e1");
    assert.equal(await readFile(bodyPathFor(id, bodyShaA), "utf8"), beforeA);
    assert.equal(await readFile(bodyPathFor(id, bodyShaB), "utf8"), beforeB);
  });

  it("(f) facts and file intents off the selected chain are excluded from the selection", async () => {
    const id = "off-branch-records";
    const { bodyShaA } = await seedTwoBranches(id);
    const target: FileIntentTarget = {
      relPath: "a.ts",
      rootIdentity: "/live/sc7-checkout",
      absentBefore: true,
    };
    // Anchored at B's tip, i.e. off-chain once the head returns to A.
    await store.appendFileIntent({
      id,
      toolUseId: "toolu-branch-b",
      targets: [target],
      captured: false,
    });

    await store.rewindToHead({ id, head: "e1" });
    const sel = await store.loadPublishedNativeState({ id });
    assert.equal(sel.selected?.bodySha, bodyShaA);
    assert.deepEqual(sel.fileIntents, []);

    // The same intent IS selected when its branch is the reachable one.
    await store.rewindToHead({ id, head: "e3" });
    const onBranchB = await store.loadPublishedNativeState({ id });
    assert.equal(onBranchB.fileIntents.length, 1);
    assert.equal(onBranchB.fileIntents[0]?.record.toolUseId, "toolu-branch-b");
  });
});
