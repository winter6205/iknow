/**
 * ADR-0121: a parent rewind whose abandoned segment contains a worker's
 * `spawn_subagent` restores that worker's files under the same drift rule.
 *
 * Join key locked here: the worker's
 * `subagents/<taskId>/agent-<taskId>.meta.json` `toolUseId` field equals the
 * parent transcript's spawn tool_use id; the preimage refs live on the
 * worker transcript (`subagents/<taskId>/<taskId>.jsonl`) and its blobs in the
 * PARENT session folder. Postures (real store + fresh ids, temp workspace):
 *   - abandoned-spawn worker edits restore together with parent refs in one
 *     plan/report — as long as each path belongs to exactly one transcript;
 *   - a path two transcripts wrote (parent + worker, or two workers) is a
 *     `cross_transcript` receipt skip: no byte is touched, the head still moves
 *     (ADR-0121 rejects both a parent-then-worker concatenation and a
 *     `createdAt` sort as a global order);
 *   - worker-file drift is a reported skip (bytes preserved, head moves);
 *   - an unreadable worker blob or a corrupt meta ABORTS: zero writes, head
 *     stays where it was (unreadable link ≠ absent link);
 *   - legacy shapes (no meta / no transcript / spawn kept) are skipped.
 *
 * The second describe block pins the cancellation that rides the same join:
 * a rewind that abandons a live worker's `spawn_subagent` event must stop that
 * worker, and only that worker.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import type {
  RewindSessionResponse,
  RewindTargetsResponse,
} from "../../src/session-api/contract.ts";
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
import type { SessionStoreError } from "../../src/session-api/store/index.ts";
import type { PreimageRef } from "../../src/session-api/store/jsonl.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import type {
  SubAgentManager,
  SubagentInfo,
} from "../../src/harness/subagent/manager.ts";
import {
  workerMetaPath,
  workerTranscriptPath,
} from "../../src/harness/sandbox/fence-tmp.ts";
import { makeDeps } from "../cli/_fixtures.ts";
import { captureConsoleWarnAsync } from "../_helpers/capture-console-warn.ts";
import {
  makeManagerRig,
  subagentInfo,
} from "./_helpers/subagent-manager-rig.ts";

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

/** One captured write the fixture wants stamped on a transcript event. */
type SeedPre = {
  relPath: string;
  pre: string;
  post: string;
  /** false = point at a blob that was never written (unreadable preimage). */
  capturePre?: boolean;
  /** capture-time ENOENT evidence, as the real capture stamps it. */
  absentBefore?: boolean;
  /** override the root identity the ref records. */
  root?: string;
};

function ref(
  relPath: string,
  preSha: string,
  postSha: string,
  root: string,
  absentBefore?: boolean
): PreimageRef {
  return {
    relPath,
    rootIdentity: root,
    preimageSha: preSha,
    postimageSha: postSha,
    // Conditional spread mirrors the real capture: false leaves no key.
    ...(absentBefore === true ? { absentBefore: true } : {}),
  };
}

const convDir = (id: string) =>
  resolveConversationDir({ projectDir: sessionDir, conversationId: id });

/** Stamp `pre` onto the parent session folder, returning its transcript ref. */
async function stampPre(
  dir: string,
  pre: SeedPre,
  root: string
): Promise<PreimageRef> {
  const postSha = await captureCodeSnapshot(dir, pre.post);
  const preSha =
    pre.capturePre === false
      ? codeSnapshotSha(`UNCAPTURED-${pre.pre}`)
      : await captureCodeSnapshot(dir, pre.pre);
  return ref(pre.relPath, preSha, postSha, pre.root ?? root, pre.absentBefore);
}

/** Seed the parent transcript: header (workspaceRoot = taskRoot) + given
 *  events + head. Stamped events carry `codePreimage`; blobs land in the
 *  parent session folder. */
async function seedParent(
  id: string,
  events: ReadonlyArray<{
    id: string;
    parent: string | null;
    message: AnthropicNativeMessage;
    pre?: SeedPre;
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
      codePreimage = await stampPre(dir, e.pre, taskRoot);
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
  pres?: ReadonlyArray<SeedPre>;
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
  const pres = opts.pres ?? [];
  if (opts.transcript === false || pres.length === 0) return;
  const dir = convDir(opts.parent);
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
  ];
  let parent = "e0";
  let last = "e0";
  for (const [i, pre] of pres.entries()) {
    // Transcript event ids must match `e<digits>` (jsonl.ts EVENT_ID_RE).
    const id = `e${i + 1}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parent,
        message: text("worker wrote"),
        codePreimage: await stampPre(dir, pre, taskRoot),
      })
    );
    parent = id;
    last = id;
  }
  lines.push(JSON.stringify({ type: "head", id: last }));
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
  pre?: SeedPre;
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

function hub(subagentManager?: SubAgentManager): SessionHub {
  return new SessionHub({
    store,
    deps: makeDeps([]),
    workspaceRoot: taskRoot,
    subagentManager,
  });
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
      pres: [{ relPath: "b.ts", pre: "orig", post: "W" }],
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
      pres: [{ relPath: "b.ts", pre: "orig", post: "W" }],
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
      pres: [{ relPath: "b.ts", pre: "orig", post: "W", capturePre: false }],
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
      pres: [{ relPath: "b.ts", pre: "orig", post: "W" }],
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
      pres: [{ relPath: "b.ts", pre: "orig", post: "W" }],
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
      pres: [{ relPath: "b.ts", pre: "orig", post: "W" }],
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
        pres: [{ relPath: "b.ts", pre: "orig", post: "W", root: other }],
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

describe("rewindSession restoreCode: paths owned by more than one transcript", () => {
  /** Parent writes shared.ts A→B and spawns tk1, which writes shared.ts B→C
   *  plus its own own.ts. Live bytes sit exactly where the parent chain left
   *  them, so only transcript ownership can refuse the write. */
  async function seedSharedWithParent(id: string): Promise<void> {
    await writeFile(join(taskRoot, "shared.ts"), "B");
    await writeFile(join(taskRoot, "own.ts"), "W");
    await seedParent(
      id,
      [
        { id: "e0", parent: null, message: text("e0") },
        {
          id: "e1",
          parent: "e0",
          message: text("e1"),
          pre: { relPath: "shared.ts", pre: "A", post: "B" },
        },
        { id: "e2", parent: "e1", message: spawn("tu-spawn") },
        { id: "e3", parent: "e2", message: text("e3") },
      ],
      "e3"
    );
    await seedWorker({
      parent: id,
      taskId: "tk1",
      toolUseId: "tu-spawn",
      pres: [
        { relPath: "shared.ts", pre: "B", post: "C" },
        { relPath: "own.ts", pre: "orig", post: "W" },
      ],
    });
  }

  it("parent + worker on one path: byte untouched, listed on the receipt, head still moves", async () => {
    await seedSharedWithParent("hr-parent");
    const res = await hub().rewindSession("hr-parent", "e0", true);
    assert.equal(res.head, "e0", "the rewind itself still happens");
    assert.equal(
      await readFile(join(taskRoot, "shared.ts"), "utf8"),
      "B",
      "no restore, no clobber — the bytes are exactly what they were"
    );
    assert.equal(await readFile(join(taskRoot, "own.ts"), "utf8"), "orig");
    assert.deepEqual(res.codeRestore?.restored, ["own.ts"]);
    assert.deepEqual(res.codeRestore?.skipped, [
      { relPath: "shared.ts", reason: "cross_transcript" },
    ]);
  });

  it("a path created by the parent and then written by a worker is NOT deleted", async () => {
    // Ownership is decided before the guard, so the delete directive on the
    // earliest (absentBefore) ref can never fire across transcripts.
    await writeFile(join(taskRoot, "made.ts"), "W");
    await seedParent(
      "hr-absent",
      [
        { id: "e0", parent: null, message: text("e0") },
        {
          id: "e1",
          parent: "e0",
          message: text("e1"),
          pre: { relPath: "made.ts", pre: "", post: "A", absentBefore: true },
        },
        { id: "e2", parent: "e1", message: spawn("tu-spawn") },
        { id: "e3", parent: "e2", message: text("e3") },
      ],
      "e3"
    );
    await seedWorker({
      parent: "hr-absent",
      taskId: "tk1",
      toolUseId: "tu-spawn",
      pres: [{ relPath: "made.ts", pre: "A", post: "W" }],
    });
    const res = await hub().rewindSession("hr-absent", "e0", true);
    assert.equal(res.head, "e0");
    assert.equal(await readFile(join(taskRoot, "made.ts"), "utf8"), "W");
    assert.deepEqual(res.codeRestore?.restored, []);
    assert.deepEqual(res.codeRestore?.skipped, [
      { relPath: "made.ts", reason: "cross_transcript" },
    ]);
  });

  it("two workers on one path: same verdict, each worker's own paths still restore", async () => {
    await writeFile(join(taskRoot, "both.ts"), "W2");
    await writeFile(join(taskRoot, "t1-only.ts"), "O1");
    await seedParent(
      "hr-two-workers",
      [
        { id: "e0", parent: null, message: text("e0") },
        { id: "e1", parent: "e0", message: spawn("tu-a") },
        { id: "e2", parent: "e1", message: spawn("tu-b") },
        { id: "e3", parent: "e2", message: text("e3") },
      ],
      "e3"
    );
    await seedWorker({
      parent: "hr-two-workers",
      taskId: "tkA",
      toolUseId: "tu-a",
      pres: [
        { relPath: "both.ts", pre: "X", post: "W1" },
        { relPath: "t1-only.ts", pre: "n1", post: "O1" },
      ],
    });
    await seedWorker({
      parent: "hr-two-workers",
      taskId: "tkB",
      toolUseId: "tu-b",
      pres: [{ relPath: "both.ts", pre: "W1", post: "W2" }],
    });
    const res = await hub().rewindSession("hr-two-workers", "e0", true);
    assert.equal(res.head, "e0");
    assert.equal(await readFile(join(taskRoot, "both.ts"), "utf8"), "W2");
    assert.equal(await readFile(join(taskRoot, "t1-only.ts"), "utf8"), "n1");
    assert.deepEqual(res.codeRestore?.restored, ["t1-only.ts"]);
    assert.deepEqual(res.codeRestore?.skipped, [
      { relPath: "both.ts", reason: "cross_transcript" },
    ]);
  });

  it("the same relPath under two roots is two files, so no false cross-transcript skip", async () => {
    // Parent edited shared.ts in the live root; a worker edited a same-named
    // file in its own worktree. The worker op is refused on root identity, but
    // the parent's restore must not be punished for the collision.
    await writeFile(join(taskRoot, "a.ts"), "B");
    const other = await mkdtemp(join(tmpdir(), "iknow-hr-other-"));
    try {
      await seedParent("hr-two-roots", parentChain("e2", true), "e3");
      await writeFile(join(other, "a.ts"), "W");
      await seedWorker({
        parent: "hr-two-roots",
        taskId: "tk1",
        toolUseId: "tu-spawn",
        pres: [{ relPath: "a.ts", pre: "orig", post: "W", root: other }],
      });
      const res = await hub().rewindSession("hr-two-roots", "e0", true);
      assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "A");
      assert.deepEqual(res.codeRestore?.restored, ["a.ts"]);
      assert.deepEqual(res.codeRestore?.skipped, [
        { relPath: "a.ts", reason: "root_identity" },
      ]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

/**
 * Rewind worker cancellation (the same abandoned segment, the cancel side).
 *
 * Join key pinned by the resume case: the worker meta's ORIGINAL
 * `spawn_subagent` tool_use id, never `SubagentInfo.toolUseId` — a resume
 * re-attaches the newest (`subagent_continue`) id to that in-memory field, so
 * joining there would leave the abandoned worker running and kill a kept one.
 * Scope: only `abandonedEvents` decides, so a spawn on the kept ancestor chain
 * or on a sibling fork off the current chain is untouched. Failure posture:
 * cancellation keys on the durable head COMMIT, not on whether this method
 * returned — an accepted rewind whose response assembly then throws still
 * cancels, a rewind that never committed cancels nothing, and an accepted one
 * never turns into a failure because of an unreadable meta (fail-soft sweep).
 * Slot posture: the sweep runs outside this conversation's writer slot, so a
 * worker's synchronous wake cannot rewrite the head / turns the response
 * reports. Guard: a session with no live subagents runs zero extra IO — no
 * abandoned-events read, no worker-meta enumeration.
 */
describe("rewindSession: cancel the workers the new head abandoned", () => {
  type ChainEvent = {
    id: string;
    parent: string | null;
    message: AnthropicNativeMessage;
    pre?: SeedPre;
  };

  const running = (
    taskId: string,
    conversationId: string,
    inMemoryToolUseId?: string
  ): SubagentInfo =>
    subagentInfo(taskId, {
      state: "running",
      conversationId,
      ...(inMemoryToolUseId !== undefined
        ? { toolUseId: inMemoryToolUseId }
        : {}),
    });

  /** Head = e3. A rewind to e1 abandons [e2, e3]: `tu-ab` only. `tu-kept` sits
   *  on the kept ancestor chain, `tu-sibling` on a fork branch that was never
   *  part of the current chain. */
  function forkChain(): ChainEvent[] {
    return [
      { id: "e0", parent: null, message: spawn("tu-kept") },
      { id: "e1", parent: "e0", message: text("e1") },
      { id: "e2", parent: "e1", message: spawn("tu-ab") },
      { id: "e3", parent: "e2", message: text("e3") },
      { id: "e4", parent: "e1", message: spawn("tu-sibling") },
      { id: "e5", parent: "e4", message: text("e5") },
    ];
  }

  it("aborts the live worker whose spawn sits in the abandoned segment", async () => {
    await seedParent("rc-abandon", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "rc-abandon",
      taskId: "tk-ab",
      toolUseId: "tu-spawn",
    });
    const rig = makeManagerRig([running("tk-ab", "rc-abandon")]);
    // Counting the segment read here is what makes the idle case's
    // "zero abandoned-events IO" assertion mean something.
    const abandoned = vi.spyOn(store, "abandonedEvents");
    const res = await hub(rig.manager).rewindSession("rc-abandon", "e1", false);
    const reads = abandoned.mock.calls.length;
    abandoned.mockRestore();
    assert.equal(res.head, "e1");
    assert.deepEqual(rig.abortCalls, ["tk-ab"]);
    assert.equal(reads, 1, "captured once, pre-move");
    assert.deepEqual(
      Object.keys(res).sort(),
      ["head", "session", "turns"],
      "cancellation adds no field to the response"
    );
  });

  it("never aborts a live worker spawned on the kept chain", async () => {
    await seedParent("rc-kept", parentChain("e0", false), "e3");
    await seedWorker({
      parent: "rc-kept",
      taskId: "tk-kept",
      toolUseId: "tu-spawn",
    });
    const rig = makeManagerRig([running("tk-kept", "rc-kept")]);
    const res = await hub(rig.manager).rewindSession("rc-kept", "e1", false);
    assert.equal(res.head, "e1");
    assert.deepEqual(rig.abortCalls, []);
  });

  it("abandoned segment only: kept ancestor and sibling fork stay alone", async () => {
    await seedParent("rc-fork", forkChain(), "e3");
    for (const [taskId, toolUseId] of [
      ["tk-kept", "tu-kept"],
      ["tk-ab", "tu-ab"],
      ["tk-sibling", "tu-sibling"],
    ]) {
      await seedWorker({ parent: "rc-fork", taskId, toolUseId });
    }
    const rig = makeManagerRig([
      running("tk-kept", "rc-fork"),
      running("tk-ab", "rc-fork"),
      running("tk-sibling", "rc-fork"),
    ]);
    const res = await hub(rig.manager).rewindSession("rc-fork", "e1", false);
    assert.equal(res.head, "e1");
    assert.deepEqual(rig.abortCalls, ["tk-ab"]);
  });

  it("a rejected rewind cancels nothing", async () => {
    await seedParent("rc-reject", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "rc-reject",
      taskId: "tk-ab",
      toolUseId: "tu-spawn",
    });
    const rig = makeManagerRig([running("tk-ab", "rc-reject")]);
    await assert.rejects(
      () => hub(rig.manager).rewindSession("rc-reject", "e9", false),
      (err: unknown) => (err as { kind: string }).kind === "schema_invalid"
    );
    assert.equal(await store.readHead("rc-reject"), "e3", "head never moved");
    assert.deepEqual(rig.abortCalls, []);
  });

  it("a rewind that fails after the capture cancels nothing", async () => {
    // The capture already holds the abandoned id here: the failure lands
    // between phase 1 and phase 2, so a sweep wired to a finally block would
    // kill a worker whose rewind never happened.
    await writeFile(join(taskRoot, "b.ts"), "W");
    await seedParent("rc-late", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "rc-late",
      taskId: "tk-ab",
      toolUseId: "tu-spawn",
      pres: [{ relPath: "b.ts", pre: "orig", post: "W", capturePre: false }],
    });
    const rig = makeManagerRig([running("tk-ab", "rc-late")]);
    await assert.rejects(
      () => hub(rig.manager).rewindSession("rc-late", "e1", true),
      (err: unknown) =>
        (err as { kind: string }).kind === "code_snapshot_missing"
    );
    assert.equal(await store.readHead("rc-late"), "e3", "head never moved");
    assert.deepEqual(rig.abortCalls, []);
    assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "W");
  });

  it("a resumed worker joins on its meta spawn id, not the in-memory one", async () => {
    await seedParent("rc-resume", forkChain(), "e3");
    // Meta = original spawn (abandoned); the live row carries the continue id
    // resumeDefinition re-attached.
    await seedWorker({
      parent: "rc-resume",
      taskId: "tk-resume",
      toolUseId: "tu-ab",
    });
    // The reverse pairing: meta points at a kept spawn while the live row
    // happens to carry the abandoned id.
    await seedWorker({
      parent: "rc-resume",
      taskId: "tk-decoy",
      toolUseId: "tu-kept",
    });
    const rig = makeManagerRig([
      running("tk-resume", "rc-resume", "tu-continue"),
      running("tk-decoy", "rc-resume", "tu-ab"),
    ]);
    const res = await hub(rig.manager).rewindSession("rc-resume", "e1", false);
    assert.equal(res.head, "e1");
    assert.deepEqual(rig.abortCalls, ["tk-resume"]);
  });

  it("no live subagents: no abort, no abandoned-events read, no meta sweep", async () => {
    // Cost-regression guard, NOT cancellation coverage: it passes on a rewind
    // that cancels nothing at all. Its value is the two read counters — an idle
    // session must not pay for an abandoned-events read or a worker-meta
    // enumeration — so a refactor that hoists either read out of the live-worker
    // guard shows up here.
    await seedParent("rc-idle", parentChain("e2", false), "e3");
    // A meta no sweep is allowed to read: a corrupt one throws typed, and the
    // fail-soft sweep would report it.
    await seedWorker({
      parent: "rc-idle",
      taskId: "tk-broken",
      metaBroken: true,
    });
    const rig = makeManagerRig([]);
    const abandoned = vi.spyOn(store, "abandonedEvents");
    const captured = await captureConsoleWarnAsync(async () => {
      const res = await hub(rig.manager).rewindSession("rc-idle", "e1", false);
      return {
        head: res.head,
        aborts: [...rig.abortCalls],
        reads: abandoned.mock.calls.length,
      };
    }).finally(() => abandoned.mockRestore());
    assert.equal(captured.result.head, "e1");
    assert.deepEqual(captured.result.aborts, []);
    assert.equal(captured.result.reads, 0, "capture guard never fired");
    assert.deepEqual(
      captured.messages.filter((line) => line.includes("abandoned")),
      [],
      "no meta sweep ran, so nothing could fail"
    );
  });

  it("an accepted rewind degrades to a diagnostic when the meta it must join is unreadable", async () => {
    // The mirror of the pre-move case ("corrupt meta.json aborts too"): there
    // the same fault stops the rewind, here the head commit is already durable,
    // so it must not un-accept the rewind. The orphan stays running because the
    // join never resolved, and the caller still gets its response.
    await seedParent("rc-failsoft", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "rc-failsoft",
      taskId: "tk-ab",
      metaBroken: true,
    });
    const rig = makeManagerRig([running("tk-ab", "rc-failsoft")]);
    const captured = await captureConsoleWarnAsync(async () => {
      const res = await hub(rig.manager).rewindSession(
        "rc-failsoft",
        "e0",
        false
      );
      return { head: res.head, aborts: [...rig.abortCalls] };
    });
    assert.equal(captured.result.head, "e0");
    assert.deepEqual(captured.result.aborts, []);
    const diagnostics = captured.messages.filter((line) =>
      line.includes("rewind abandoned-worker cancel skipped")
    );
    assert.equal(
      diagnostics.length,
      1,
      `expected one diagnostic, got ${JSON.stringify(captured.messages)}`
    );
  });

  it("an accepted restoreCode rewind keeps its report while aborting", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    await seedParent("rc-shape", parentChain("e2", true), "e3");
    await seedWorker({
      parent: "rc-shape",
      taskId: "tk-ab",
      toolUseId: "tu-spawn",
    });
    const rig = makeManagerRig([running("tk-ab", "rc-shape")]);
    const res = await hub(rig.manager).rewindSession("rc-shape", "e0", true);
    assert.deepEqual(Object.keys(res).sort(), [
      "codeRestore",
      "head",
      "session",
      "turns",
    ]);
    assert.equal(res.head, "e0");
    assert.deepEqual(res.codeRestore?.restored, ["a.ts"]);
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "A");
    assert.deepEqual(rig.abortCalls, ["tk-ab"]);
  });

  it("an accepted rewind still cancels when the response assembly throws", async () => {
    // Acceptance is the durable head commit, not "the method returned without
    // throwing". The commit lands, then a post-commit read faults typed: the
    // caller must still see the failure, the head must still have moved, and
    // the worker the accepted rewind orphaned must still stop.
    await seedParent("rc-post-commit", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "rc-post-commit",
      taskId: "tk-ab",
      toolUseId: "tu-spawn",
    });
    const rig = makeManagerRig([running("tk-ab", "rc-post-commit")]);
    const outcomes = vi
      .spyOn(store, "projectTurnOutcomes")
      .mockImplementation(async () => {
        throw {
          kind: "io_error",
          conversation_id: "rc-post-commit",
          cause: "injected post-commit read fault",
        } satisfies SessionStoreError;
      });
    let rejected: unknown;
    try {
      await hub(rig.manager).rewindSession("rc-post-commit", "e1", false);
    } catch (err) {
      rejected = err;
    } finally {
      outcomes.mockRestore();
    }
    assert.equal(
      (rejected as SessionStoreError).kind,
      "io_error",
      "the faulted assembly still rejects the caller"
    );
    assert.equal(
      await store.readHead("rc-post-commit"),
      "e1",
      "the rewind was accepted before the throw"
    );
    assert.deepEqual(rig.abortCalls, ["tk-ab"]);
  });

  it("a rewind that never committed cancels nothing, same faulted read", async () => {
    // The pair of the case above: the identical faulted post-commit read, but
    // the head commit never lands — an unknown `head` is rejected pre-move, so
    // the method throws without acceptance. Acceptance arms the sweep, not the
    // throw.
    await seedParent("rc-unaccepted", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "rc-unaccepted",
      taskId: "tk-ab",
      toolUseId: "tu-spawn",
    });
    const rig = makeManagerRig([running("tk-ab", "rc-unaccepted")]);
    const abandoned = vi.spyOn(store, "abandonedEvents");
    const outcomes = vi
      .spyOn(store, "projectTurnOutcomes")
      .mockImplementation(async () => {
        throw {
          kind: "io_error",
          conversation_id: "rc-unaccepted",
          cause: "injected post-commit read fault",
        } satisfies SessionStoreError;
      });
    try {
      await assert.rejects(
        () => hub(rig.manager).rewindSession("rc-unaccepted", "e9", false),
        (err: unknown) => (err as SessionStoreError).kind === "schema_invalid"
      );
      assert.equal(
        abandoned.mock.calls.length,
        1,
        "capture ran, then rejected"
      );
      assert.equal(await store.readHead("rc-unaccepted"), "e3");
      assert.deepEqual(rig.abortCalls, []);
    } finally {
      abandoned.mockRestore();
      outcomes.mockRestore();
    }
  });

  it("cancels outside the writer slot, so a same-conversation read queues", async () => {
    // `serialize` runs a same-conversation work fn SYNCHRONOUSLY while that
    // conversation's slot is held, and queues it behind the chain once the slot
    // released. A nested read from inside `abortTask` therefore exposes where
    // the sweep sits: started inline = the abort ran inside the rewind's slot,
    // where its synchronous wake could rewrite the head and turns the response
    // reports; started only afterwards = the slot was free.
    await seedParent("rc-slot", parentChain("e2", false), "e3");
    await seedWorker({
      parent: "rc-slot",
      taskId: "tk-ab",
      toolUseId: "tu-spawn",
    });
    const rig = makeManagerRig([running("tk-ab", "rc-slot")]);
    const sessionHub = hub(rig.manager);
    const readTargets = vi.spyOn(store, "listRewindTargets");
    // The rig's own recording `abortTask`, kept alive through the spy so this
    // case can assert the sweep reached the manager, not just that it ran.
    const recordAbort = rig.manager.abortTask;
    let startedInline = false;
    let nested: Promise<RewindTargetsResponse> | undefined;
    const abort = vi
      .spyOn(rig.manager, "abortTask")
      .mockImplementation((taskId: string) => {
        const before = readTargets.mock.calls.length;
        nested = sessionHub.listRewindTargets("rc-slot");
        startedInline = readTargets.mock.calls.length > before;
        return recordAbort(taskId);
      });
    let res: RewindSessionResponse;
    try {
      res = await sessionHub.rewindSession("rc-slot", "e1", false);
      assert.equal(res.head, "e1");
      assert.equal(
        startedInline,
        false,
        "the sweep re-entered this conversation's slot"
      );
      assert.deepEqual(rig.abortCalls, ["tk-ab"]);
    } finally {
      abort.mockRestore();
      readTargets.mockRestore();
    }
    // Awaiting proves the queued call was not lost: it ran once the slot freed.
    assert.notEqual(await nested, undefined, "the queued read completed");
  });
});
