/**
 * ADR-0119 T3: a parent rewind whose abandoned segment contains a worker's
 * `spawn_subagent` restores that worker's files under the same drift rule.
 *
 * Join key locked here: the worker's
 * `subagents/<taskId>/agent-<taskId>.meta.json` `toolUseId` field equals the
 * parent transcript's spawn tool_use id; the preimage refs live on the
 * worker transcript (`subagents/<taskId>/<taskId>.jsonl`) and its blobs in
 * the PARENT session folder. Postures (real store + fresh ids, temp workspace):
 *   - abandoned-spawn worker edits restore together with parent refs in one
 *     plan/report;
 *   - worker-file drift is a reported skip (bytes preserved, head moves);
 *   - an unreadable worker blob or a corrupt meta ABORTS: zero writes, head
 *     stays where it was (unreadable link ≠ absent link);
 *   - legacy shapes (no meta / no transcript / spawn kept) are skipped.
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
  resolveSubagentTraceDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { PreimageRef } from "../../src/session-api/store/jsonl.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import {
  workerMetaPath,
  workerTranscriptPath,
} from "../../src/harness/sandbox/fence-tmp.ts";
import { makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let sessionDir: string;
let store: SessionStore;
let taskRoot: string;

const text = (t: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: t }],
});
const spawn = (id: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "spawn_subagent", input: {} }],
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

const convDir = (id: string) =>
  resolveConversationDir({ projectDir: sessionDir, conversationId: id });

/** Seed the parent transcript: header (workspaceRoot = taskRoot) + given
 *  events + head. Stamped events carry `codePreimage`; blobs land in the
 *  parent session folder. */
async function seedParent(
  id: string,
  events: ReadonlyArray<{
    id: string;
    parent: string | null;
    message: AnthropicNativeMessage;
    pre?: { relPath: string; pre: string; post: string; capturePre?: boolean };
  }>,
  head: string | null
): Promise<void> {
  const dir = convDir(id);
  await mkdir(dir, { recursive: true });
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
  for (const e of events) {
    let codePreimage: PreimageRef | undefined;
    if (e.pre !== undefined) {
      const postSha = await captureCodeSnapshot(dir, e.pre.post);
      const preSha =
        e.pre.capturePre === false
          ? codeSnapshotSha(`UNCAPTURED-${e.pre.pre}`)
          : await captureCodeSnapshot(dir, e.pre.pre);
      codePreimage = ref(e.pre.relPath, preSha, postSha, taskRoot);
    }
    lines.push(
      JSON.stringify({
        type: "message",
        id: e.id,
        parent: e.parent,
        message: e.message,
        ...(codePreimage !== undefined ? { codePreimage } : {}),
      })
    );
  }
  lines.push(JSON.stringify({ type: "head", id: head }));
  await writeFile(
    join(dir, `${id}${SESSION_JSONL_EXT}`),
    `${lines.join("\n")}\n`,
    "utf8"
  );
}

/** Seed one worker record under the parent folder: the trace file (enumeration
 *  handle), optionally meta.json (spawn join) and transcript (stamped events +
 *  blobs in the PARENT folder, where the worker host's capture writes). */
async function seedWorker(opts: {
  parent: string;
  taskId: string;
  toolUseId?: string;
  metaBroken?: boolean;
  transcript?: boolean;
  pre?: {
    relPath: string;
    pre: string;
    post: string;
    capturePre?: boolean;
    root?: string;
  };
}): Promise<void> {
  const subagentsDir = resolveSubagentTraceDir({
    projectDir: sessionDir,
    conversationId: opts.parent,
  });
  const taskDir = join(subagentsDir, opts.taskId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, `agent-${opts.taskId}.jsonl`), "", "utf8");
  if (opts.metaBroken === true) {
    await writeFile(workerMetaPath(subagentsDir, opts.taskId), "{nope", "utf8");
  } else if (opts.toolUseId !== undefined) {
    await writeFile(
      workerMetaPath(subagentsDir, opts.taskId),
      JSON.stringify({ taskId: opts.taskId, toolUseId: opts.toolUseId }),
      "utf8"
    );
  }
  if (opts.transcript === false || opts.pre === undefined) return;
  const dir = convDir(opts.parent);
  const postSha = await captureCodeSnapshot(dir, opts.pre.post);
  const preSha =
    opts.pre.capturePre === false
      ? codeSnapshotSha(`UNCAPTURED-${opts.pre.pre}`)
      : await captureCodeSnapshot(dir, opts.pre.pre);
  const codePreimage = ref(
    opts.pre.relPath,
    preSha,
    postSha,
    opts.pre.root ?? taskRoot
  );
  const header = {
    type: "session",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.taskId,
    title: "w",
    cwd: "/tmp",
    sanitized_at: "2026-01-01T00:00:00.000Z",
    jsonMode: false,
    turnCount: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const lines = [
    JSON.stringify(header),
    JSON.stringify({
      type: "message",
      id: "e0",
      parent: null,
      message: text("worker task"),
    }),
    JSON.stringify({
      type: "message",
      id: "e1",
      parent: "e0",
      message: text("worker wrote"),
      codePreimage,
    }),
    JSON.stringify({ type: "head", id: "e1" }),
  ];
  await writeFile(
    workerTranscriptPath(subagentsDir, opts.taskId),
    `${lines.join("\n")}\n`,
    "utf8"
  );
}

const parentChain = (
  spawnEvent: "e2" | "e0",
  withParentPre: boolean
): Array<{
  id: string;
  parent: string | null;
  message: AnthropicNativeMessage;
  pre?: { relPath: string; pre: string; post: string };
}> => [
  {
    id: "e0",
    parent: null,
    message: spawnEvent === "e0" ? spawn("tu-spawn") : text("e0"),
  },
  {
    id: "e1",
    parent: "e0",
    message: text("e1"),
    ...(withParentPre ? { pre: { relPath: "a.ts", pre: "A", post: "B" } } : {}),
  },
  {
    id: "e2",
    parent: "e1",
    message: spawnEvent === "e2" ? spawn("tu-spawn") : text("e2"),
  },
  { id: "e3", parent: "e2", message: text("e3") },
];

function hub(): SessionHub {
  return new SessionHub({ store, deps: makeDeps([]), workspaceRoot: taskRoot });
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hw-restore-store-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-hw-restore-root-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

describe("rewindSession restoreCode: abandoned worker segment", () => {
  it("worker file restores side by side with the parent's own ref (one plan)", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    await writeFile(join(taskRoot, "b.ts"), "W");
    await seedParent("hw-join", parentChain("e2", true), "e3");
    await seedWorker({
      parent: "hw-join",
      taskId: "tk1",
      toolUseId: "tu-spawn",
      pre: { relPath: "b.ts", pre: "orig", post: "W" },
    });
    const res = await hub().rewindSession("hw-join", "e0", true);
    assert.equal(res.head, "e0");
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "A");
    assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "orig");
    assert.deepEqual(res.codeRestore?.restored, ["a.ts", "b.ts"]);
    assert.deepEqual(res.codeRestore?.skipped, []);
  });

  it("worker-file drift: reported skip, bytes preserved, head still moves", async () => {
    await writeFile(join(taskRoot, "b.ts"), "edited externally");
    await seedParent("hw-drift", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "hw-drift",
      taskId: "tk1",
      toolUseId: "tu-spawn",
      pre: { relPath: "b.ts", pre: "orig", post: "W" },
    });
    const res = await hub().rewindSession("hw-drift", "e1", true);
    assert.equal(res.head, "e1");
    assert.equal(
      await readFile(join(taskRoot, "b.ts"), "utf8"),
      "edited externally"
    );
    assert.deepEqual(res.codeRestore?.restored, []);
    assert.deepEqual(res.codeRestore?.skipped, [
      { relPath: "b.ts", reason: "drift" },
    ]);
  });

  it("unreadable worker blob aborts: zero writes, head unchanged", async () => {
    await writeFile(join(taskRoot, "b.ts"), "W");
    await seedParent("hw-blob", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "hw-blob",
      taskId: "tk1",
      toolUseId: "tu-spawn",
      pre: { relPath: "b.ts", pre: "orig", post: "W", capturePre: false },
    });
    await assert.rejects(
      () => hub().rewindSession("hw-blob", "e1", true),
      (err: unknown) =>
        (err as { kind: string }).kind === "code_snapshot_missing"
    );
    assert.equal(await store.readHead("hw-blob"), "e3", "head never moved");
    assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "W");
  });

  it("corrupt meta.json aborts too: an unparseable link ≠ no link", async () => {
    await writeFile(join(taskRoot, "b.ts"), "W");
    await seedParent("hw-meta", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "hw-meta",
      taskId: "tk1",
      metaBroken: true,
      pre: { relPath: "b.ts", pre: "orig", post: "W" },
    });
    await assert.rejects(
      () => hub().rewindSession("hw-meta", "e1", true),
      (err: unknown) => (err as { kind: string }).kind === "parse_failed"
    );
    assert.equal(await store.readHead("hw-meta"), "e3");
    assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "W");
  });

  it("legacy worker without meta.json is skipped (no link exists)", async () => {
    await writeFile(join(taskRoot, "b.ts"), "W");
    await seedParent("hw-nometa", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "hw-nometa",
      taskId: "tk1",
      pre: { relPath: "b.ts", pre: "orig", post: "W" },
    });
    const res = await hub().rewindSession("hw-nometa", "e1", true);
    assert.equal(res.head, "e1");
    assert.deepEqual(res.codeRestore?.restored, []);
    assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "W");
  });

  it("matched spawn but no transcript is skipped (worker exited pre-commit)", async () => {
    await writeFile(join(taskRoot, "b.ts"), "W");
    await seedParent("hw-notx", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "hw-notx",
      taskId: "tk1",
      toolUseId: "tu-spawn",
      transcript: false,
    });
    const res = await hub().rewindSession("hw-notx", "e1", true);
    assert.equal(res.head, "e1");
    assert.deepEqual(res.codeRestore?.restored, []);
  });

  it("spawn inside the KEPT chain is not restored (not abandoned history)", async () => {
    await writeFile(join(taskRoot, "b.ts"), "W");
    await seedParent("hw-kept", parentChain("e0", false), "e3");
    await seedWorker({
      parent: "hw-kept",
      taskId: "tk1",
      toolUseId: "tu-spawn",
      pre: { relPath: "b.ts", pre: "orig", post: "W" },
    });
    const res = await hub().rewindSession("hw-kept", "e1", true);
    assert.equal(res.head, "e1");
    assert.deepEqual(res.codeRestore?.restored, []);
    assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "W");
  });

  it("worker root-identity mismatch: reported skip, no write (spawn used another worktree)", async () => {
    const other = await mkdtemp(join(tmpdir(), "iknow-hw-other-"));
    try {
      await writeFile(join(taskRoot, "b.ts"), "W");
      await seedParent("hw-root", parentChain("e2", false), "e3");
      await seedWorker({
        parent: "hw-root",
        taskId: "tk1",
        toolUseId: "tu-spawn",
        pre: { relPath: "b.ts", pre: "orig", post: "W", root: other },
      });
      const res = await hub().rewindSession("hw-root", "e1", true);
      assert.equal(res.head, "e1");
      assert.deepEqual(res.codeRestore?.skipped, [
        { relPath: "b.ts", reason: "root_identity" },
      ]);
      assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "W");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
