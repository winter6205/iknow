/**
 * SC23 — existing-session transition and retention.
 *
 * The criterion has three observable halves. The old-format half (opening an
 * old fixture rewrites nothing and claims nothing) is already covered in
 * `recovery.test.ts:205`; the two halves with NO coverage anywhere in the
 * suite live here:
 *
 *   SC23a — a new-format session does not expire by age or quota.
 *   SC23b — explicit deletion removes only that session's records/content.
 *
 * SC23a asserts the ABSENCE of an expiry path, not a retention policy: the
 * session store defines no retention window and no quota, so the contract under
 * test is "nothing ages out and nothing is reclaimed", demonstrated by
 * back-dating every timestamp the store persists and by publishing more content
 * than any plausible cap would allow. `SessionStore` is the only seam that
 * could do this; there is no background sweeper in the store surface.
 *
 * SC23b runs the real store over two sibling sessions in one project
 * directory, each with its own log, its own published records, and its own
 * session-local `blobs/native/<sha256>` bodies.
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
  type AppendOperationFactInput,
  type SessionFileV1,
  type SessionStoreError,
} from "../../../src/session-api/store/index.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";

/** Well beyond any plausible retention window, so an age rule — if one existed
 *  — would have to fire. */
const ANCIENT = new Date("2000-01-01T00:00:00.000Z");
/** Every timestamp field the store writes into the log. */
const TIME_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "sanitized_at",
  "messageCreatedAt",
]);

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string => join(sessionDirFor(id), `${id}.jsonl`);
const bodyDirFor = (id: string): string =>
  join(sessionDirFor(id), "blobs", "native");

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-sc23-retention-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-sc23-taskroot-"));
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
    // Non-blank title so list() keeps these sessions visible; the age/quota
    // checks must key on retention, not on the blank-title filter.
    title: id,
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
const toolResultMsg = (text: string) => ({
  role: "user" as const,
  content: [
    { type: "tool_result" as const, tool_use_id: "tu-1", content: text },
  ],
});

const snapshotOf = (
  messages: NativeStateSnapshot["messages"],
  overrides: Partial<NativeStateSnapshot> = {}
): NativeStateSnapshot => ({ boundary: "input", messages, ...overrides });

const recover = (id: string) =>
  recoverSession({
    store,
    conversationId: id,
    taskRoot,
    liveRootIdentity: "/live/sc23-checkout",
  });

const toolFact = (factId: string): Omit<AppendOperationFactInput, "id"> => ({
  factId,
  fact: {
    kind: "tool_result",
    toolUseId: "tu-1",
    batchPosition: 0,
    batchSize: 1,
    resultMessage: toolResultMsg("settled result"),
  },
  turnId: "t-1",
});

/** Every file under a session folder, as folder-relative path → content. */
async function sessionTreeBytes(id: string): Promise<Record<string, string>> {
  const root = sessionDirFor(id);
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      out[full.slice(root.length + 1)] = await readFile(full, "utf8");
    }
  };
  await walk(root);
  return out;
}

/** Every file under the whole project directory, as project-relative path. */
async function projectTreePaths(): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      out.push(full.slice(projectDir.length + 1));
    }
  };
  await walk(projectDir);
  return out.sort();
}

async function nativeBodyShas(id: string): Promise<ReadonlyArray<string>> {
  return (await readdir(bodyDirFor(id))).sort();
}

/** Stable identity of every record, for "nothing was pruned" checks that must
 *  survive a deliberate timestamp rewrite: timestamp fields collapse to a
 *  constant, so only record identity and payload remain. */
async function recordIdentities(id: string): Promise<ReadonlyArray<string>> {
  return parseSessionJsonl(await readFile(jsonlFor(id), "utf8")).records.map(
    (r) => JSON.stringify(r, (key, value) => (key.endsWith("At") ? 0 : value))
  );
}

/** Hand-written bytes on purpose: no production writer emits a chosen past
 *  timestamp, and the age claim needs the whole log to look ancient. Returns the
 *  number of timestamp fields rewritten so a fixture that recorded none cannot
 *  pass silently. */
async function backDateEveryTimestamp(id: string): Promise<number> {
  const raw = await readFile(jsonlFor(id), "utf8");
  let rewritten = 0;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (TIME_KEYS.has(key)) {
        rewritten += 1;
        out[key] = ANCIENT.toISOString();
        continue;
      }
      out[key] = rewrite(nested);
    }
    return out;
  };
  const lines = raw
    .split("\n")
    .map((line) =>
      line.trim().length === 0
        ? line
        : JSON.stringify(rewrite(JSON.parse(line)))
    );
  await writeFile(jsonlFor(id), lines.join("\n"), "utf8");
  return rewritten;
}

async function backDateEveryFile(id: string): Promise<ReadonlyArray<string>> {
  const paths = Object.keys(await sessionTreeBytes(id)).map((rel) =>
    join(sessionDirFor(id), rel)
  );
  for (const path of paths) await utimes(path, ANCIENT, ANCIENT);
  return paths;
}

/** New-format session: one committed turn, then `states` complete published
 *  native states anchored along that turn. Returns the published body shas in
 *  publication order. */
async function seedSession(
  id: string,
  states: ReadonlyArray<NativeStateSnapshot>
): Promise<ReadonlyArray<string>> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [userMsg(`question in ${id}`), assistantMsg(`answer in ${id}`)],
  });
  const shas: string[] = [];
  for (const snapshot of states) {
    const published = await store.appendNativeState({
      id,
      anchorEventId: "e1",
      boundary: snapshot.boundary,
      snapshot,
    });
    shas.push(published.bodySha);
  }
  return shas;
}

describe("SC23a — a new-format session does not expire by age", () => {
  it("(a) with every persisted timestamp and file mtime back-dated, recovery still selects the published state and nothing is pruned", async () => {
    const id = "ancient-session";
    const [firstSha, selectedSha] = await seedSession(id, [
      snapshotOf([userMsg("first published state")]),
      snapshotOf([userMsg("latest published state")], {
        boundary: "terminal",
      }),
    ]);
    await store.appendOperationFact({ ...toolFact("f-settled"), id });
    const identitiesBefore = await recordIdentities(id);

    const rewritten = await backDateEveryTimestamp(id);
    assert.ok(
      rewritten >= 4,
      `the log really carried persisted timestamps (saw ${rewritten})`
    );
    const backDated = await backDateEveryFile(id);
    assert.ok(backDated.length >= 3, "log plus both bodies were back-dated");
    for (const path of backDated) {
      assert.equal(
        Math.round((await stat(path)).mtimeMs / 86_400_000),
        Math.round(ANCIENT.getTime() / 86_400_000),
        `${path} really carries the ancient mtime`
      );
    }
    const treeBeforeOpen = await sessionTreeBytes(id);

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.deepEqual(report.messages, [userMsg("latest published state")]);
    assert.equal(report.savedMessageCount, 1);

    // Nothing aged out: the same records and the same bodies, and the reopen
    // itself wrote nothing — every byte of the folder is what it was once the
    // timestamps were back-dated.
    assert.deepEqual(await recordIdentities(id), identitiesBefore);
    const after = await sessionTreeBytes(id);
    assert.deepEqual(after, treeBeforeOpen);
    assert.ok(
      after[join("blobs", "native", firstSha)] !== undefined,
      "the superseded state's body was not reclaimed either"
    );
    const oldest = await store.readPublishedNativeStateBody({
      id,
      bodySha: firstSha,
    });
    assert.deepEqual(oldest.messages, [userMsg("first published state")]);
    assert.equal(
      (await store.loadPublishedNativeState({ id })).selected?.bodySha,
      selectedSha
    );
    assert.deepEqual(
      (await store.list()).map((e) => e.conversation_id),
      [id],
      "an age rule would have dropped the session from listing"
    );
  });

  it("(b) the store exposes no expiry, pruning, or quota-reclamation path", () => {
    // Structural counterpart to (a): with no such method on the store's own
    // surface, an age/quota rule cannot be running in this seam.
    const surface = Object.getOwnPropertyNames(SessionStore.prototype).filter(
      (name) => name !== "constructor"
    );
    for (const name of surface) {
      assert.ok(
        !/expire|prune|gc$|collect|sweep|evict|reclaim|retention|compact_?old|rotate/i.test(
          name
        ),
        `SessionStore.${name} looks like a retention path`
      );
    }
    assert.ok(
      surface.includes("delete"),
      "deletion is the explicit removal path"
    );
  });
});

describe("SC23a — a new-format session does not expire by quota", () => {
  it("(c) a session far past any plausible content cap keeps every state, every body, and the oldest body is still readable", async () => {
    const id = "oversized-session";
    // 12 distinct states of ~32 KB each: no plausible per-session cap, and the
    // store records no byte budget to exceed — the claim under test is that
    // nothing is reclaimed as content accumulates.
    const bulky = "x".repeat(32 * 1024);
    const states = Array.from({ length: 12 }, (_, i) =>
      snapshotOf([userMsg(`state-${i} ${bulky}`)], {
        boundary: i === 11 ? "terminal" : "input",
      })
    );
    const shas = await seedSession(id, states);
    assert.equal(new Set(shas).size, shas.length, "12 distinct bodies");
    const totalBodyBytes = (
      await Promise.all(shas.map((sha) => stat(join(bodyDirFor(id), sha))))
    ).reduce((sum, s) => sum + s.size, 0);
    assert.ok(
      totalBodyBytes > 300 * 1024,
      `the session really holds a large pool (${totalBodyBytes} bytes)`
    );

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.equal(report.savedMessageCount, 1);
    assert.ok(
      report.messages[0]?.content[0]?.type === "text" &&
        report.messages[0].content[0].text.startsWith("state-11")
    );

    assert.deepEqual(await nativeBodyShas(id), [...shas].sort());
    assert.equal(
      parseSessionJsonl(await readFile(jsonlFor(id), "utf8")).records.filter(
        (r) => r.type === "native_state"
      ).length,
      12
    );
    // The oldest published state is still addressable by its own reference.
    const oldest = await store.readPublishedNativeStateBody({
      id,
      bodySha: shas[0]!,
    });
    assert.ok(
      oldest.messages[0]?.content[0]?.type === "text" &&
        oldest.messages[0].content[0].text.startsWith("state-0")
    );
  });
});

describe("SC23b — explicit deletion removes only that session", () => {
  it("(d) deleting one of two sibling sessions removes its log and its bodies and leaves the sibling byte-identical and recoverable", async () => {
    const keepId = "keep-session";
    const dropId = "drop-session";
    const keepShas = await seedSession(keepId, [
      snapshotOf([userMsg("keep first")]),
      snapshotOf([userMsg("keep latest")], { boundary: "terminal" }),
    ]);
    const dropShas = await seedSession(dropId, [
      snapshotOf([userMsg("drop first")]),
      snapshotOf([userMsg("drop latest")], { boundary: "terminal" }),
    ]);
    const before = await projectTreePaths();
    const keepBytesBefore = await sessionTreeBytes(keepId);
    assert.equal(keepShas.length, 2);
    assert.equal(dropShas.length, 2);

    await store.delete(dropId);

    // Only the deleted session's own artifacts went away — not one sibling
    // path, and nothing outside its folder.
    const after = await projectTreePaths();
    assert.deepEqual(
      after,
      before.filter((p) => !p.startsWith(`${dropId}/`))
    );
    await assert.rejects(stat(sessionDirFor(dropId)), /ENOENT/);
    for (const sha of dropShas) {
      await assert.rejects(
        stat(join(bodyDirFor(dropId), sha)),
        /ENOENT/,
        "the deleted session's own bodies are gone with it"
      );
    }
    await assert.rejects(stat(jsonlFor(dropId)), /ENOENT/);

    // The sibling's log, records, and bodies are all still present, unchanged,
    // and it still recovers to the same saved state.
    assert.deepEqual(await sessionTreeBytes(keepId), keepBytesBefore);
    assert.deepEqual(await nativeBodyShas(keepId), [...keepShas].sort());
    assert.equal(
      (await store.loadPublishedNativeState({ id: keepId })).selected?.bodySha,
      keepShas[1]
    );
    const keepReport = await recover(keepId);
    assert.equal(keepReport.status.status, "recovered");
    assert.deepEqual(keepReport.messages, [userMsg("keep latest")]);

    // Existing deletion contract still holds, on the deleted side.
    await assert.rejects(store.load(dropId), (err: unknown) => {
      assert.equal((err as SessionStoreError).kind, "not_found");
      return true;
    });
    await assert.rejects(recover(dropId), (err: unknown) => {
      assert.equal((err as SessionStoreError).kind, "not_found");
      return true;
    });
    assert.deepEqual(
      (await store.list()).map((e) => e.conversation_id),
      [keepId]
    );
  });

  it("(e) identical published content in two sessions yields one sha in two session-local bodies, and deleting one leaves the other intact", async () => {
    // The question this settles: does deleting session X reclaim a body that
    // session Y also references? The pool is session-local
    // (`<sessionFolder>/blobs/native/`), so identical content is one content
    // address with one physical copy per session — no cross-session sharing to
    // break, and the sibling keeps its own copy.
    const keepId = "twin-keep";
    const dropId = "twin-drop";
    const shared = snapshotOf([userMsg("identical published state")]);
    const keepShas = await seedSession(keepId, [shared]);
    const dropShas = await seedSession(dropId, [shared]);
    assert.deepEqual(keepShas, dropShas, "one content address for one content");
    assert.notEqual(bodyDirFor(keepId), bodyDirFor(dropId));
    const keepBodyBytes = await readFile(
      join(bodyDirFor(keepId), keepShas[0]!),
      "utf8"
    );
    assert.equal(
      await readFile(join(bodyDirFor(dropId), dropShas[0]!), "utf8"),
      keepBodyBytes
    );

    await store.delete(dropId);

    assert.deepEqual(await nativeBodyShas(keepId), [keepShas[0]]);
    assert.equal(
      await readFile(join(bodyDirFor(keepId), keepShas[0]!), "utf8"),
      keepBodyBytes
    );
    const report = await recover(keepId);
    assert.equal(report.status.status, "recovered");
    assert.deepEqual(report.messages, shared.messages);
  });

  it("(f) a failed re-delete of the same session reports not_found and touches nothing of the sibling", async () => {
    const keepId = "survivor";
    const dropId = "already-gone";
    await seedSession(keepId, [
      snapshotOf([userMsg("survivor state")], { boundary: "terminal" }),
    ]);
    await seedSession(dropId, [
      snapshotOf([userMsg("gone state")], { boundary: "terminal" }),
    ]);
    await store.delete(dropId);
    const keepBytesBefore = await sessionTreeBytes(keepId);

    await assert.rejects(store.delete(dropId), (err: unknown) => {
      assert.equal((err as SessionStoreError).kind, "not_found");
      assert.equal((err as SessionStoreError).conversation_id, dropId);
      return true;
    });

    assert.deepEqual(await sessionTreeBytes(keepId), keepBytesBefore);
    assert.equal((await recover(keepId)).status.status, "recovered");
  });
});
