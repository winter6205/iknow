/**
 * ADR-0121: `SessionHub.rewindSession(conversationId, head, restoreCode)`.
 *
 * Locked here (real store + fresh conversationId, workspace on temp disk):
 *   - restoreCode=true writes the abandoned files back to their preimages,
 *     moves the head, and reports the restored paths.
 *   - restoreCode=false / omitted moves the head and leaves bytes untouched,
 *     with NO codeRestore field on the response.
 *   - drift and root-identity mismatch are reported skips; the head still moves.
 *   - an unreadable preimage blob aborts: workspace untouched AND the head
 *     stays where it was (the transcript never advances past code we failed to
 *     restore).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  captureCodeSnapshot,
  codeSnapshotSha,
} from "../../src/session-api/store/code-snapshot-store.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { PreimageRef } from "../../src/session-api/store/jsonl.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import { makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let sessionDir: string;
let store: SessionStore;
let taskRoot: string;

const text = (t: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

function ref(
  relPath: string,
  preSha: string,
  postSha: string,
  root: string
): PreimageRef {
  return {
    relPath,
    rootIdentity: root,
    preimageSha: preSha,
    postimageSha: postSha,
  };
}

/** Seed a 4-event chain e0..e3 (head e3). `preimages` stamp codePreimage refs
 *  onto the named events; every readable blob is captured into the session
 *  folder so the restore pass can find it. */
async function seed(
  id: string,
  preimages: ReadonlyArray<{
    event: string;
    relPath: string;
    pre: string;
    post: string;
    root?: string;
    capturePre?: boolean;
  }>
): Promise<void> {
  const dir = resolveConversationDir({
    projectDir: sessionDir,
    conversationId: id,
  });
  await mkdir(dir, { recursive: true });
  const refByEvent = new Map<string, PreimageRef>();
  for (const p of preimages) {
    const root = p.root ?? taskRoot;
    const postSha = await captureCodeSnapshot(dir, p.post);
    const preSha =
      p.capturePre === false
        ? codeSnapshotSha(`UNCAPTURED-${p.pre}`)
        : await captureCodeSnapshot(dir, p.pre);
    refByEvent.set(p.event, ref(p.relPath, preSha, postSha, root));
  }
  const parentByEvent: Record<string, string | null> = {
    e0: null,
    e1: "e0",
    e2: "e1",
    e3: "e2",
  };
  const header = {
    type: "session",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "q1",
    cwd: "/tmp",
    sanitized_at: "2026-01-01T00:00:00.000Z",
    jsonMode: false,
    turnCount: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspaceRoot: taskRoot,
  };
  const lines = [JSON.stringify(header)];
  for (const eid of ["e0", "e1", "e2", "e3"]) {
    const r = refByEvent.get(eid);
    lines.push(
      JSON.stringify({
        type: "message",
        id: eid,
        parent: parentByEvent[eid],
        message: text(eid),
        ...(r ? { codePreimage: r } : {}),
      })
    );
  }
  lines.push(JSON.stringify({ type: "head", id: "e3" }));
  await writeFile(
    join(dir, `${id}${SESSION_JSONL_EXT}`),
    `${lines.join("\n")}\n`,
    "utf8"
  );
}

function hub(): SessionHub {
  return new SessionHub({ store, deps: makeDeps([]), workspaceRoot: taskRoot });
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-restore-store-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-hub-restore-root-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

describe("rewindSession restoreCode", () => {
  it("true: writes the preimage back, moves the head, reports the path", async () => {
    await writeFile(join(taskRoot, "a.ts"), "C");
    await seed("hc-restore", [
      { event: "e1", relPath: "a.ts", pre: "A", post: "B" },
      { event: "e3", relPath: "a.ts", pre: "B", post: "C" },
    ]);
    const res = await hub().rewindSession("hc-restore", "e0", true);
    assert.equal(res.head, "e0");
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "A");
    assert.deepEqual(res.codeRestore?.restored, ["a.ts"]);
    assert.deepEqual(res.codeRestore?.skipped, []);
  });

  it("false: head moves, bytes untouched, no codeRestore field", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    await seed("hc-noc", [
      { event: "e1", relPath: "a.ts", pre: "A", post: "B" },
    ]);
    const res = await hub().rewindSession("hc-noc", "e0", false);
    assert.equal(res.head, "e0");
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "B");
    assert.equal(res.codeRestore, undefined);
  });

  it("omitted arg defaults to false", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    await seed("hc-omit", [
      { event: "e1", relPath: "a.ts", pre: "A", post: "B" },
    ]);
    const res = await hub().rewindSession("hc-omit", "e0");
    assert.equal(res.codeRestore, undefined);
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "B");
  });

  it("drift: reported skip, bytes preserved, head still moves", async () => {
    await writeFile(join(taskRoot, "a.ts"), "edited externally");
    await seed("hc-drift", [
      { event: "e1", relPath: "a.ts", pre: "A", post: "B" },
    ]);
    const res = await hub().rewindSession("hc-drift", "e0", true);
    assert.equal(res.head, "e0");
    assert.equal(
      await readFile(join(taskRoot, "a.ts"), "utf8"),
      "edited externally"
    );
    assert.deepEqual(res.codeRestore?.restored, []);
    assert.deepEqual(res.codeRestore?.skipped, [
      { relPath: "a.ts", reason: "drift" },
    ]);
  });

  it("root-identity mismatch: no write, reported skip, head still moves", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    await seed("hc-identity", [
      {
        event: "e1",
        relPath: "a.ts",
        pre: "A",
        post: "B",
        root: "/some-other-root",
      },
    ]);
    const res = await hub().rewindSession("hc-identity", "e0", true);
    assert.equal(res.head, "e0");
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "B");
    assert.deepEqual(res.codeRestore?.skipped, [
      { relPath: "a.ts", reason: "root_identity" },
    ]);
  });

  it("unreadable blob aborts: head unchanged, workspace untouched", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    await seed("hc-blob", [
      { event: "e1", relPath: "a.ts", pre: "A", post: "B", capturePre: false },
    ]);
    await assert.rejects(
      () => hub().rewindSession("hc-blob", "e0", true),
      (err: unknown) =>
        (err as { kind: string }).kind === "code_snapshot_missing"
    );
    assert.equal(await store.readHead("hc-blob"), "e3", "head never moved");
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "B");
  });
});
