/**
 * ADR-0136 §3 item 2 / §4 on the persistent CLI chat path.
 *
 * Two things are proved here against a real `SessionStore` over a real temp
 * tree and a real filesystem — never a mocked store:
 *
 *   1. the accepted-input boundary publishes a complete native state BEFORE
 *      the dependent model request, and a publication failure blocks that
 *      request (SC2);
 *   2. session entry runs recovery, restores the SAVED native context, and
 *      distinguishes all five outcomes (SC1a, SC23, SC27).
 *
 * The model is the only stub: a scripted stub adapter behind a call counter,
 * so "no request was issued" is an observation, not an inference. Failures
 * are injected on the real filesystem (a regular file where the body pool
 * directory must be, a deleted body blob), never by mocking persistence.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  ChatRecoveryBlockedError,
  createChatSessionCommitHook,
  createChatSessionPersistence,
  persistChatSessionCheckpoint,
  processChatLine,
  recoverChatSessionEntry,
} from "../../src/cli/chat-session.ts";
import {
  NATIVE_STATE_FORMAT_VERSION,
  parseSessionJsonl,
  RECOVERY_IN_PROGRESS_LABEL,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  SESSION_JSONL_EXT,
  type SessionFileV1,
  type SessionNativeStateRecord,
} from "../../src/session-api/store/index.ts";
import { mainCheckoutOf } from "../../src/harness/isolation/worktree-gate.ts";
import {
  createLiveGraphLedgerHost,
  type LiveGraphLedgerHost,
} from "../../src/harness/graph/ledger.ts";
import type {
  AssistantTurnResult,
  RunResult,
} from "../../src/harness/index.ts";
import { assistantResult, makeCtx, makeDeps } from "./_fixtures.ts";

/** The scripted stub model behind a call counter — the only stub here. */
function countingDeps(responses: AssistantTurnResult[]): {
  readonly deps: ReturnType<typeof makeDeps>;
  readonly modelCalls: () => number;
} {
  const base = makeDeps(responses);
  let calls = 0;
  const step = base.adapter.step.bind(base.adapter);
  return {
    deps: {
      ...base,
      adapter: {
        ...base.adapter,
        step: (...args: Parameters<typeof step>) => {
          calls += 1;
          return step(...args);
        },
      },
    },
    modelCalls: () => calls,
  };
}

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-recovery-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-chat-recovery-root-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(baseDir, taskRoot);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const conversationDir = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string =>
  join(conversationDir(id), `${id}${SESSION_JSONL_EXT}`);

const nativeStateRecords = async (
  id: string
): Promise<ReadonlyArray<SessionNativeStateRecord>> => {
  const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
  return log.records.filter(
    (r): r is SessionNativeStateRecord => r.type === "native_state"
  );
};

/** Every byte under the session folder, for the SC27 before/after compare. */
async function treeBytes(root: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(relative(root, full), await readFile(full, "utf8"));
    }
  };
  await walk(root);
  return out;
}

const text = (t: string) => ({ type: "text" as const, text: t });

const userMsg = (t: string) => ({ role: "user" as const, content: [text(t)] });
const assistantMsg = (t: string) => ({
  role: "assistant" as const,
  content: [text(t)],
});

/** Minimal RunResult builder for the direct persist-helper cases. */
function buildResult(opts: {
  readonly stopReason: RunResult["stopReason"];
  readonly messages: RunResult["messages"];
  readonly turnCount?: number;
}): RunResult {
  return {
    finalText: null,
    messages: opts.messages,
    turnCount: opts.turnCount ?? 1,
    stopReason: opts.stopReason,
    lastUsage: null,
  };
}

/** Strip the marker so the fixture is old-format — the only way to be one,
 *  because `save` deliberately never stamps it. */
async function asOldFormat(id: string): Promise<SessionFileV1> {
  const file = await store.load(id);
  delete (file as { nativeStateFormat?: number }).nativeStateFormat;
  await store.save({ id, file });
  return file;
}

// -- R1: the new-format marker is stamped at creation only --------------------

describe("new-format marker (R1, SC23)", () => {
  it("stamps a session the chat path creates itself", async () => {
    await persistChatSessionCheckpoint({
      store,
      conversationId: "created-here",
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [userMsg("q"), assistantMsg("a")],
      }),
      priorMessages: [],
      workspaceRoot: projectDir,
      newFormat: true,
    });
    assert.equal(
      (await store.load("created-here")).nativeStateFormat,
      NATIVE_STATE_FORMAT_VERSION
    );
  });

  it("leaves a resumed session unstamped, so unsupported_format stays honest", async () => {
    await persistChatSessionCheckpoint({
      store,
      conversationId: "resumed",
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [userMsg("q"), assistantMsg("a")],
      }),
      priorMessages: [],
      workspaceRoot: projectDir,
    });
    assert.equal((await store.load("resumed")).nativeStateFormat, undefined);
  });

  it("never relabels an old-format session that receives a new turn", async () => {
    await persistChatSessionCheckpoint({
      store,
      conversationId: "old-format",
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [userMsg("first"), assistantMsg("a")],
      }),
      priorMessages: [],
      workspaceRoot: projectDir,
      newFormat: true,
    });
    const before = await asOldFormat("old-format");

    await persistChatSessionCheckpoint({
      store,
      conversationId: "old-format",
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [
          userMsg("first"),
          assistantMsg("a"),
          userMsg("second"),
          assistantMsg("b"),
        ],
      }),
      priorMessages: [userMsg("first"), assistantMsg("a")],
      workspaceRoot: projectDir,
    });

    assert.equal((await store.load("old-format")).nativeStateFormat, undefined);
    assert.equal(
      before.messages.length,
      2,
      "the fixture really was an old-format session with history"
    );
  });

  it("stamps the file the in-turn commit hook bootstraps", async () => {
    const hook = createChatSessionCommitHook({
      store,
      conversationId: "bootstrapped",
      jsonMode: false,
      getPriors: () => [],
      workspaceRoot: projectDir,
      newFormat: true,
    });
    await hook([assistantMsg("first commit")]);
    assert.equal(
      (await store.load("bootstrapped")).nativeStateFormat,
      NATIVE_STATE_FORMAT_VERSION
    );
  });
});

// -- R2: the accepted-input boundary ------------------------------------------

/** A chat turn wired exactly as runChatSession wires it: the same persistence
 *  pair over the real store, on a real session id. Only the model is stubbed.
 *  `onModelCall` observes each request at dispatch time, so "published before
 *  the request" is a measurement rather than a reading of the final state. */
async function runTurn(opts: {
  readonly conversationId: string;
  readonly responses: AssistantTurnResult[];
  readonly newFormat?: boolean;
  readonly line?: string;
  readonly onModelCall?: (
    messages: ReadonlyArray<{ role: string; content: unknown }>
  ) => void;
}): Promise<{
  readonly stderr: string | undefined;
  readonly modelCalls: () => number;
}> {
  const base = makeDeps(opts.responses);
  let calls = 0;
  const step = base.adapter.step.bind(base.adapter);
  let ctx: ReturnType<typeof makeCtx>;
  const persistence = createChatSessionPersistence({
    store,
    conversationId: opts.conversationId,
    newFormat: opts.newFormat !== false,
    jsonMode: false,
    getPriors: () => ctx.state.messages,
    workspaceRoot: projectDir,
    deps: base,
  });
  // Production order: the commit hook becomes the engine's `commitMessages`,
  // the session-bound persistence sink becomes the engine's
  // `runtimePersistence`, and the accepted-input commit reuses the same hook
  // as its append authority.
  const deps: typeof base = {
    ...base,
    commitMessages: persistence.commit,
    ...(persistence.runtimePersistence !== undefined
      ? { runtimePersistence: persistence.runtimePersistence }
      : {}),
    adapter: {
      ...base.adapter,
      step: (...args: Parameters<typeof step>) => {
        calls += 1;
        // Synchronous read of the real log at dispatch time, so the ordering
        // observation cannot be satisfied by a later write.
        opts.onModelCall?.(args[0].messages);
        return step(...args);
      },
    },
  };
  ctx = makeCtx({
    responses: opts.responses,
    checkpointStore: store,
    workspaceRoot: projectDir,
    stateOverrides: { conversationId: opts.conversationId },
  });
  const result = await processChatLine({
    line: opts.line ?? "remember this",
    ctx: {
      ...ctx,
      deps,
      newFormatSession: opts.newFormat !== false,
      commitAcceptedInput: persistence.commitAcceptedInput,
    },
  });
  return { stderr: result.stderr, modelCalls: () => calls };
}

describe("accepted-input checkpoint (SC2, R2)", () => {
  it("publishes the input state anchored at the accepted input's own event, before the model request", async () => {
    const id = "sc2-publish";
    // At each model dispatch, read the real log: how many native_state records
    // existed at that instant is the ordering proof.
    const publishedAtModelCall: number[] = [];
    const { modelCalls } = await runTurn({
      conversationId: id,
      responses: [assistantResult({ texts: ["answered"] })],
      onModelCall: () => {
        publishedAtModelCall.push(
          parseSessionJsonl(readFileSync(jsonlFor(id), "utf8")).records.filter(
            (r) => r.type === "native_state"
          ).length
        );
      },
    });
    assert.equal(modelCalls(), 1);
    assert.deepEqual(
      publishedAtModelCall,
      [1],
      "the input state was already published when the model was called"
    );

    const records = await nativeStateRecords(id);
    // The turn also publishes the settled terminal state, so the input
    // boundary is counted per boundary — one input publication per accepted
    // input, never two.
    const inputRecords = records.filter((r) => r.boundary === "input");
    assert.equal(
      inputRecords.length,
      1,
      "exactly one input state for one turn"
    );
    const record = inputRecords[0]!;
    assert.equal(record.boundary, "input");

    // The anchor is the accepted input's OWN event, and it is on the head
    // chain — the only authority checkpoint selection consults.
    const fresh = new SessionStore(baseDir, taskRoot);
    const selection = await fresh.loadPublishedNativeState({ id });
    assert.ok(selection.selected, "the published state is selectable");
    assert.ok(
      selection.messageEventIds.includes(record.anchorEventId),
      "the input anchor is on the head chain"
    );
    const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    const anchorEvent = log.events.find((e) => e.id === record.anchorEventId);
    assert.equal(anchorEvent?.message.role, "user");
    assert.equal(
      anchorEvent?.message.content[0]?.type === "text"
        ? anchorEvent.message.content[0].text
        : "",
      "remember this"
    );

    // The body is the exact native sequence at that boundary.
    const body = await fresh.readPublishedNativeStateBody({
      id,
      bodySha: record.bodySha,
    });
    assert.equal(body.boundary, "input");
    assert.equal(body.messages.length, record.messageCount);
    const upToAnchor = log.events.slice(
      0,
      log.events.findIndex((e) => e.id === record.anchorEventId) + 1
    );
    assert.deepEqual(
      body.messages,
      upToAnchor.map((e) => e.message)
    );
    // No turn identity is synthesized at a boundary that has none, and no
    // runtime facts are fabricated.
    assert.equal(body.turnId, undefined);
    assert.equal(body.runtimeFacts, undefined);
  });

  it("issues no model request when publication fails (dependent call blocked)", async () => {
    const id = "sc2-publish-fails";
    // Real FS fault: a regular file where the body pool directory must be, so
    // the required body write cannot complete.
    await store.save({
      id,
      file: {
        schemaVersion: 3,
        conversation_id: id,
        messages: [userMsg("prior turn"), assistantMsg("prior answer")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: taskRoot,
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
        workspaceRoot: taskRoot,
        nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
      },
    });
    await writeFile(
      join(conversationDir(id), "blobs"),
      "not a directory",
      "utf8"
    );

    const { stderr, modelCalls } = await runTurn({
      conversationId: id,
      responses: [assistantResult({ texts: ["must not run"] })],
      line: "persist me",
    });

    assert.equal(
      modelCalls(),
      0,
      "no model request after a failed publication"
    );
    assert.equal(
      (await nativeStateRecords(id)).length,
      0,
      "nothing is published when the body write fails"
    );
    assert.ok(
      stderr !== undefined && stderr.includes("PERSIST_FAILED"),
      `the persistence failure surfaced to the operator, got: ${stderr}`
    );
    // The accepted input itself is durable: it is kept, never resent.
    const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    assert.ok(
      log.events.some((e) =>
        e.message.content.some(
          (b) => b.type === "text" && b.text === "persist me"
        )
      ),
      "the accepted input is committed to the session log"
    );
  });

  it("does not publish into a session the host did not create (SC23)", async () => {
    const id = "sc2-old-format";
    await store.save({
      id,
      file: {
        schemaVersion: 3,
        conversation_id: id,
        messages: [userMsg("old q"), assistantMsg("old a")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: projectDir,
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
        workspaceRoot: projectDir,
      },
    });
    const before = await treeBytes(conversationDir(id));

    const { modelCalls } = await runTurn({
      conversationId: id,
      responses: [assistantResult({ texts: ["ok"] })],
      newFormat: false,
      line: "old format turn",
    });

    assert.equal(modelCalls(), 1, "the turn itself still runs");
    assert.equal(
      (await nativeStateRecords(id)).length,
      0,
      "an old-format session is never published into"
    );
    assert.equal(
      (await store.load(id)).nativeStateFormat,
      undefined,
      "and never relabelled"
    );
    const after = await treeBytes(conversationDir(id));
    // The turn's own transcript growth is expected; the published-state
    // directory must not appear and the marker must not either.
    assert.ok(
      !after.has("blobs/"),
      "no native state body pool is created for an old-format session"
    );
    assert.ok(before.size > 0);
  });

  it("publishes once per accepted input across repeated turns", async () => {
    const id = "sc2-repeated";
    const scripted = [
      assistantResult({ texts: ["first answer"] }),
      assistantResult({ texts: ["second answer"] }),
    ];
    const base = makeDeps(scripted);
    const ctx = makeCtx({
      responses: scripted,
      checkpointStore: store,
      workspaceRoot: projectDir,
      stateOverrides: { conversationId: id },
    });
    const persistence = createChatSessionPersistence({
      store,
      conversationId: id,
      newFormat: true,
      jsonMode: false,
      getPriors: () => ctx.state.messages,
      workspaceRoot: projectDir,
      deps: base,
    });
    const wired = {
      ...ctx,
      deps: {
        ...base,
        commitMessages: persistence.commit,
        ...(persistence.runtimePersistence !== undefined
          ? { runtimePersistence: persistence.runtimePersistence }
          : {}),
      },
      newFormatSession: true,
      commitAcceptedInput: persistence.commitAcceptedInput,
    };
    await processChatLine({ line: "first question", ctx: wired });
    await processChatLine({ line: "second question", ctx: wired });

    // One INPUT state per accepted input. The settled terminal boundary also
    // publishes per turn, so the count is read per boundary rather than over
    // every record the turn wrote.
    const records = (await nativeStateRecords(id)).filter(
      (r) => r.boundary === "input"
    );
    assert.equal(records.length, 2, "one input state per accepted input");
    const fresh = new SessionStore(baseDir, taskRoot);
    const bodies = await Promise.all(
      records.map((r) =>
        fresh.readPublishedNativeStateBody({ id, bodySha: r.bodySha })
      )
    );
    assert.deepEqual(
      bodies.map((b) => b.messages.length),
      [1, 3],
      "the second state carries the first turn plus the new input"
    );
    // Selection stays deterministic from the head chain, not a clock. Each
    // turn's LAST publication is its settled terminal state, so the selected
    // anchor is that one — and both input anchors are on its chain.
    const selection = await fresh.loadPublishedNativeState({ id });
    const lastInputAnchor = records[1]?.anchorEventId;
    assert.ok(lastInputAnchor !== undefined);
    assert.notEqual(selection.selected?.anchorEventId, lastInputAnchor);
    for (const r of records) {
      assert.ok(
        selection.messageEventIds.includes(r.anchorEventId),
        `input anchor ${r.anchorEventId} is on the selected chain`
      );
    }
  });

  it("publishes nothing for an empty or rejected line", async () => {
    const id = "sc2-empty";
    const scripted = [assistantResult({ texts: ["ok"] })];
    const base = makeDeps(scripted);
    const ctx = makeCtx({
      responses: scripted,
      checkpointStore: store,
      workspaceRoot: projectDir,
      stateOverrides: { conversationId: id },
    });
    const persistence = createChatSessionPersistence({
      store,
      conversationId: id,
      newFormat: true,
      jsonMode: false,
      getPriors: () => ctx.state.messages,
      workspaceRoot: projectDir,
      deps: base,
    });
    const wired = {
      ...ctx,
      deps: {
        ...base,
        commitMessages: persistence.commit,
        ...(persistence.runtimePersistence !== undefined
          ? { runtimePersistence: persistence.runtimePersistence }
          : {}),
      },
      newFormatSession: true,
      commitAcceptedInput: persistence.commitAcceptedInput,
    };
    for (const line of ["", "   "]) {
      const r = await processChatLine({ line, ctx: wired });
      assert.notEqual(
        r.ranQuery,
        true,
        `no turn ran for ${JSON.stringify(line)}`
      );
    }
    // An over-cap line is rejected before any turn starts, so it is not an
    // accepted input and must not be published either.
    const overCap = await processChatLine({
      line: "x".repeat(8001),
      ctx: wired,
    });
    assert.match(overCap.stderr ?? "", /exceeds max length/);
    await assert.rejects(
      () => readFile(jsonlFor(id), "utf8"),
      (err: unknown) => (err as { code?: string }).code === "ENOENT",
      "an empty or rejected line writes nothing at all, so there is nothing to publish"
    );
  });

  it("keeps the operator recovery copy out of the model's request", async () => {
    // The recovery status line is operator UI (SC26): it must never reach a
    // model prompt, a tool description, or a system instruction. Asserted on
    // the real request the adapter was handed.
    const seen: string[] = [];
    await runTurn({
      conversationId: "sc2-no-operator-copy",
      responses: [assistantResult({ texts: ["ok"] })],
      onModelCall: (messages) => {
        for (const m of messages) seen.push(JSON.stringify(m.content));
      },
    });
    assert.ok(seen.length > 0, "the model was called");
    for (const blob of seen) {
      assert.ok(
        !blob.includes("recovery in progress"),
        "the recovery transient never enters a model request"
      );
    }
  });
});

// -- R3: session-entry recovery ----------------------------------------------

/** A new-format session with one published input state, plus whatever the
 *  caller appends after it. The chain is real; only the model is stubbed. */
async function seedPublishedSession(
  id: string,
  opts: { readonly oldFormat?: boolean } = {}
): Promise<{ readonly seed: ReadonlyArray<unknown> }> {
  await store.save({
    id,
    file: {
      schemaVersion: 3,
      conversation_id: id,
      messages: [userMsg("accepted input"), assistantMsg("acknowledged")],
      jsonMode: false,
      turnCount: 1,
      updatedAt: new Date().toISOString(),
      title: "",
      cwd: taskRoot,
      sanitized_at: new Date().toISOString(),
      checkpoints: [],
      workspaceRoot: taskRoot,
      // Old format is the ABSENT marker, and `save` never stamps one — so the
      // fixture omits it rather than setting a second value.
      ...(opts.oldFormat === true
        ? {}
        : { nativeStateFormat: NATIVE_STATE_FORMAT_VERSION }),
    },
  });
  // The published state is anchored at the accepted input, so the saved context
  // is one message and the transcript holds two — the difference SC2's restore
  // requirement is about.
  await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "input",
    snapshot: { boundary: "input", messages: [userMsg("accepted input")] },
  });
  return { seed: [userMsg("accepted input"), assistantMsg("acknowledged")] };
}

/** The live write root identity recovery reconciles against. */
const liveRoot = (): string => mainCheckoutOf(taskRoot);

/** Entry recovery through a FRESH store instance, i.e. the next host opening
 *  the session — not the one that wrote it. */
const entryRecover = (
  id: string,
  overrides: Partial<{
    seedMessages: ReadonlyArray<never>;
    write: (line: string) => void;
    liveGraphLedger: LiveGraphLedgerHost;
  }> = {}
) =>
  recoverChatSessionEntry({
    store: new SessionStore(baseDir, taskRoot),
    conversationId: id,
    taskRoot,
    liveRootIdentity: liveRoot(),
    seedMessages: (overrides.seedMessages ?? []) as never,
    ...(overrides.write !== undefined ? { write: overrides.write } : {}),
    ...(overrides.liveGraphLedger !== undefined
      ? { liveGraphLedger: overrides.liveGraphLedger }
      : {}),
  });

describe("session-entry recovery (SC1a, SC23, SC27)", () => {
  it("reopens a turn the previous host published, with no request issued", async () => {
    // SC2 end to end across host generations: host A accepts an input and is
    // killed before answering; host B — a fresh store, nothing in memory —
    // restores that input and the exact saved context, and asks no model.
    const id = "entry-reopen-after-kill";
    const { modelCalls } = await runTurn({
      conversationId: id,
      // The stub throws ProtocolError when its script is exhausted, so the
      // turn dies at the boundary instead of answering it.
      responses: [],
      line: "remember this",
    });
    assert.ok(modelCalls() > 0, "the turn really did reach the model");
    // One INPUT state for the accepted input, and the engine's own terminal
    // state for the stopped turn — host A published no input state twice, and
    // the restored context is decided by the input state, not by the count.
    const inputRecords = (await nativeStateRecords(id)).filter(
      (r) => r.boundary === "input"
    );
    assert.equal(inputRecords.length, 1);

    const entry = await entryRecover(id, {
      seedMessages: [userMsg("remember this")] as never,
    });
    assert.equal(entry.recovery.status.status, "recovered");
    assert.deepEqual(
      entry.messages.map((m) => (m.content[0] as { text: string }).text),
      ["remember this"],
      "the accepted input is present in the restored context"
    );
    assert.equal(
      entry.messages.some((m) => m.role === "assistant"),
      false,
      "nothing is claimed that the dead host never committed"
    );
    assert.equal(entry.recovery.outcome.state, "unknown");
  });

  it("restores the SAVED context, not a projection of the transcript", async () => {
    const id = "entry-restores-saved";
    const { seed } = await seedPublishedSession(id);
    const seen: string[] = [];

    const entry = await entryRecover(id, {
      seedMessages: seed as never,
      write: (line) => seen.push(line),
    });

    assert.equal(entry.recovery.status.status, "recovered");
    assert.deepEqual(
      entry.messages.map((m) => (m.content[0] as { text: string }).text),
      ["accepted input"],
      "the restored context is the published body, not the 2-message log"
    );
    assert.equal(seed.length, 2, "the transcript really is longer");
    // The in-progress transient is shown, then the outcome.
    assert.equal(seen[0], RECOVERY_IN_PROGRESS_LABEL);
    assert.ok(seen[1]?.includes("recovered"));
  });

  it("reports a session that has published nothing as not-an-error", async () => {
    const id = "entry-no-published";
    await store.save({
      id,
      file: {
        schemaVersion: 3,
        conversation_id: id,
        messages: [userMsg("q"), assistantMsg("a")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: taskRoot,
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
        workspaceRoot: taskRoot,
        nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
      },
    });
    const seed = [userMsg("q"), assistantMsg("a")];
    const entry = await entryRecover(id, { seedMessages: seed as never });
    assert.equal(entry.recovery.status.status, "no_published_state");
    assert.deepEqual(
      entry.messages,
      seed,
      "an empty publication is not a reason to drop the session's history"
    );
  });

  it("leaves an old-format session's bytes untouched and offers the new-session path", async () => {
    const id = "entry-old-format";
    const { seed } = await seedPublishedSession(id, { oldFormat: true });
    const before = await treeBytes(conversationDir(id));
    const seen: string[] = [];

    const entry = await entryRecover(id, {
      seedMessages: seed as never,
      write: (line) => seen.push(line),
    });

    assert.equal(entry.recovery.status.status, "unsupported_format");
    assert.deepEqual(
      entry.messages,
      seed,
      "the old session still works as before"
    );
    assert.ok(
      seen.some(
        (l) => l.includes("unsupported_format") && l.includes("新会话")
      ),
      `the operator is offered the new-session path, got: ${seen.join(" | ")}`
    );
    const after = await treeBytes(conversationDir(id));
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [path, bytes] of before) {
      assert.equal(after.get(path), bytes, `${path} was rewritten`);
    }
  });

  it("fails closed on a damaged published body instead of falling back", async () => {
    const id = "entry-blocked";
    const { seed } = await seedPublishedSession(id);
    // Real damage: the body blob the selected record references is gone.
    await rm(join(conversationDir(id), "blobs"), {
      recursive: true,
      force: true,
    });

    await assert.rejects(
      () => entryRecover(id, { seedMessages: seed as never }),
      (err: unknown) => {
        assert.ok(
          err instanceof ChatRecoveryBlockedError,
          `expected ChatRecoveryBlockedError, got ${String(err)}`
        );
        const status = (err as ChatRecoveryBlockedError).report.status as {
          status: string;
          reason?: string;
        };
        assert.equal(status.status, "blocked");
        assert.equal(status.reason, "published_state_body_missing");
        // The seed is never substituted for the state that could not be read.
        assert.deepEqual((err as ChatRecoveryBlockedError).report.messages, []);
        return true;
      }
    );
  });

  it("surfaces needs handling with the affected path and still restores the saved context", async () => {
    const id = "entry-needs-handling";
    const { seed } = await seedPublishedSession(id);
    // A committed tool_use, then a file intent whose live bytes match neither
    // image — drift recovery must report, never overwrite.
    await store.appendEvents({
      id,
      events: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-1", name: "write_file", input: {} },
          ],
        },
      ],
    });
    // Live drift: the path exists at the recorded root but matches neither
    // image. Recovery reports it and leaves the bytes alone.
    await writeFile(join(taskRoot, "drifted.ts"), "SOMETHING ELSE", "utf8");
    const { captureCodeSnapshot } =
      await import("../../src/session-api/store/code-snapshot-store.ts");
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [
        {
          relPath: "drifted.ts",
          rootIdentity: liveRoot(),
          absentBefore: false,
          preimageSha: await captureCodeSnapshot(
            conversationDir(id),
            "OLD BYTES"
          ),
          postimageSha: await captureCodeSnapshot(
            conversationDir(id),
            "NEW BYTES"
          ),
        },
      ],
    });
    const seen: string[] = [];

    const entry = await entryRecover(id, {
      seedMessages: seed as never,
      write: (line) => seen.push(line),
    });

    const status = entry.recovery.status as {
      status: string;
      handling: ReadonlyArray<{ relPath: string; reason: string }>;
    };
    assert.equal(status.status, "needs handling");
    assert.deepEqual(
      status.handling.map((h) => [h.relPath, h.reason]),
      [["drifted.ts", "bytes_match_neither"]]
    );
    assert.ok(
      seen.some(
        (l) => l.includes("drifted.ts") && l.includes("needs handling")
      ),
      `the affected path is named to the operator, got: ${seen.join(" | ")}`
    );
    // A handling item does not block the restore, and the saved context is
    // still the published one.
    assert.deepEqual(
      entry.messages.map((m) => (m.content[0] as { text: string }).text),
      ["accepted input"]
    );
    // The drifted file is left exactly as it was — recovery reports, never
    // overwrites.
    assert.equal(
      await readFile(join(taskRoot, "drifted.ts"), "utf8"),
      "SOMETHING ELSE"
    );
  });

  it("seeds the live graph ledger from the restored node facts, in memory only", async () => {
    // F1's host half: the per-node view recovery computes must REACH the
    // scheduler's in-memory state, or a reopened session re-dispatches nodes
    // that already settled. The facts are real appended records; the reducer is
    // the real one; only the graph scheduler's own dispatch is out of scope here
    // (graph-reopen-dispatch.test.ts drives that).
    const id = "entry-seeds-graph";
    const { seed } = await seedPublishedSession(id);
    await store.appendOperationFact({
      id,
      factId: "graph_node:alpha:running",
      fact: { kind: "graph_node", nodeId: "alpha", status: "running" },
    });
    await store.appendOperationFact({
      id,
      factId: "graph_node:alpha:done",
      fact: {
        kind: "graph_node",
        nodeId: "alpha",
        status: "done",
        output: "ALPHA",
      },
    });
    await store.appendOperationFact({
      id,
      factId: "graph_node:beta:running",
      fact: { kind: "graph_node", nodeId: "beta", status: "running" },
    });
    const ledger = createLiveGraphLedgerHost();

    await entryRecover(id, {
      seedMessages: seed as never,
      liveGraphLedger: ledger,
    });

    const graph = ledger.ledgerFor(id);
    assert.equal(graph.statusOf("alpha"), "done");
    assert.equal(graph.outputOf("alpha"), "ALPHA");
    assert.equal(
      graph.isFrozen("beta"),
      false,
      "an interrupted dispatch is not settled and not failed"
    );
    // Seeding is in memory only: the log carries no new record.
    assert.equal((await nativeStateRecords(id)).length, 1);
  });

  it("is idempotent: a second open adds no record and changes no byte (SC27)", async () => {
    const id = "entry-twice";
    const { seed } = await seedPublishedSession(id);

    const first = await entryRecover(id, { seedMessages: seed as never });
    const before = await treeBytes(conversationDir(id));
    const second = await entryRecover(id, { seedMessages: seed as never });
    const after = await treeBytes(conversationDir(id));

    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
    assert.equal((await nativeStateRecords(id)).length, 1, "no re-publication");
    assert.deepEqual(
      second.recovery.status,
      first.recovery.status,
      "the same session classifies the same way twice"
    );
    assert.deepEqual(second.messages, first.messages);
  });

  it("keeps a needs-handling status across a repeated open (SC27)", async () => {
    const id = "entry-twice-handling";
    const { seed } = await seedPublishedSession(id);
    await store.appendEvents({
      id,
      events: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-2", name: "write_file", input: {} },
          ],
        },
      ],
    });
    const { captureCodeSnapshot } =
      await import("../../src/session-api/store/code-snapshot-store.ts");
    await store.appendFileIntent({
      id,
      toolUseId: "tu-2",
      captured: true,
      targets: [
        {
          relPath: "drifted.ts",
          rootIdentity: liveRoot(),
          absentBefore: false,
          preimageSha: await captureCodeSnapshot(conversationDir(id), "OLD"),
          postimageSha: await captureCodeSnapshot(conversationDir(id), "NEW"),
        },
      ],
    });

    const before = await treeBytes(conversationDir(id));
    const first = await entryRecover(id, { seedMessages: seed as never });
    const second = await entryRecover(id, { seedMessages: seed as never });
    const after = await treeBytes(conversationDir(id));

    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
    assert.deepEqual(
      (second.recovery.status as { status: string }).status,
      "needs handling",
      "an unresolved handling item is preserved until an operator acts"
    );
    assert.deepEqual(
      (second.recovery.status as { handling: unknown }).handling,
      (first.recovery.status as { handling: unknown }).handling
    );
  });

  it("never resends the saved user input or issues a request on recovery", async () => {
    const id = "entry-no-replay";
    const { seed } = await seedPublishedSession(id);
    // A model counter wired into the SAME deps the host would run turns with;
    // recovery is handed no deps at all, which is the structural guarantee.
    const { deps, modelCalls } = countingDeps([
      assistantResult({ texts: ["must not run"] }),
    ]);
    const entry = await entryRecover(id, { seedMessages: seed as never });
    assert.equal(modelCalls(), 0);
    assert.equal(entry.recovery.savedMessageCount, 1);
    // Recovery took no deps parameter — the type is the proof that it cannot
    // reach a model, a tool, or a worker.
    assert.equal(typeof deps.adapter.step, "function");
  });
});

// -- F9: one writer, one order on the chat path ------------------------------

/**
 * A store that records the interval of every call it serves, so the ORDER of
 * two in-flight writes to the one session file is an observation rather than an
 * inference. The underlying store is the real one on the real temp tree; the
 * proxy only traces, and one named call can be held open so an ordering claim
 * is decided while the other write is still mid-flight.
 */
function tracedStore(
  inner: SessionStore,
  trace: string[]
): {
  readonly store: SessionStore;
  /**
   * Hold `name` open so an ordering claim is decided while the other write is
   * still mid-flight. `otherEntered` resolves as soon as a DIFFERENT store call
   * is served — i.e. the moment the other write got in — so a writer that is
   * not queued is caught while the held call is still open.
   */
  readonly hold: (name: string) => {
    readonly release: () => void;
    readonly otherEntered: Promise<void>;
  };
} {
  const gates = new Map<string, { promise: Promise<void>; open: () => void }>();
  // Sticky, so a caller that registers interest after the call already landed
  // is still told — the ordering claim must not depend on which write happened
  // to be issued first.
  const seen = new Set<string>();
  const others: Array<{ name: string; resolve: () => void }> = [];
  const notify = (name: string): void => {
    seen.add(name);
    for (const waiter of others) {
      if (waiter.name !== name) waiter.resolve();
    }
  };
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const name = String(prop);
        trace.push(`enter:${name}`);
        notify(name);
        const gate = gates.get(name);
        if (gate !== undefined) await gate.promise;
        try {
          return await value.apply(target, args);
        } finally {
          trace.push(`exit:${name}`);
        }
      };
    },
  }) as SessionStore;
  return {
    store: proxy,
    hold: (name) => {
      let open!: () => void;
      const promise = new Promise<void>((r) => {
        open = r;
      });
      gates.set(name, { promise, open });
      const otherEntered = new Promise<void>((resolve) => {
        if ([...seen].some((seenName) => seenName !== name)) {
          resolve();
          return;
        }
        others.push({ name, resolve });
      });
      return { release: open, otherEntered };
    },
  };
}

/** Overlapping calls, in the order the two writes entered the store. */
const overlappingCalls = (trace: ReadonlyArray<string>): string[] => {
  const out: string[] = [];
  const open = new Set<string>();
  for (const step of trace) {
    const name = step.split(":")[1]!;
    if (step.startsWith("enter:")) {
      if (open.size > 0) out.push(`${[...open].join("+")} → ${name}`);
      open.add(name);
    } else {
      open.delete(name);
    }
  }
  return out;
};

describe("chat writer order (F9: one writer, one order)", () => {
  it("a state publication and a concurrent commit append are ordered, not interleaved", async () => {
    const id = "sc9-order";
    await store.save({
      id,
      file: {
        schemaVersion: 3,
        conversation_id: id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: taskRoot,
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
        workspaceRoot: taskRoot,
        nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
      },
    });
    const trace: string[] = [];
    const traced = tracedStore(store, trace);
    const gate = traced.hold("appendEvents");
    const base = makeDeps([assistantResult({ texts: ["ok"] })]);
    const persistence = createChatSessionPersistence({
      store: traced.store,
      conversationId: id,
      newFormat: true,
      jsonMode: false,
      getPriors: () => [],
      workspaceRoot: projectDir,
      deps: base,
    });
    const sink = persistence.runtimePersistence;
    assert.ok(sink !== undefined, "the new-format posture publishes");

    // Both writes are in flight at once, issued without awaiting either: the
    // commit lands in its append and holds, the publication is queued behind it.
    const committing = persistence.commit([
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
    const publishing = sink.publishSavedState({
      boundary: "terminal_turn",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    });
    // Release the held append as soon as the other write manages to reach the
    // store (caught mid-flight, not after the fact); the timer is the queued
    // case, where the other write cannot get in until the hold is released.
    const released = gate.otherEntered.then(() => gate.release());
    const timer = setTimeout(() => gate.release(), 100);
    await Promise.all([committing, publishing]);
    await released;
    clearTimeout(timer);

    assert.deepEqual(
      overlappingCalls(trace),
      [],
      `the two writes must not interleave, trace: ${trace.join(" ")}`
    );
    // Observable order in the log itself: the committed message is on record
    // before the publication anchored at it.
    const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    assert.deepEqual(
      log.records
        .map((r) => r.type)
        .filter((t) => t === "message" || t === "native_state"),
      ["message", "native_state"],
      "the commit's append lands before the publication's record"
    );
  });

  it("a failed commit still blocks the dependent execution and does not poison the queue", async () => {
    const id = "sc9-failed-commit";
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          // A non-typed fault: the hook rethrows it instead of bootstrapping.
          if (String(prop) === "appendEvents") throw new Error("disk on fire");
          return value.apply(target, args);
        };
      },
    }) as SessionStore;
    const base = makeDeps([assistantResult({ texts: ["ok"] })]);
    const persistence = createChatSessionPersistence({
      store: failing,
      conversationId: id,
      newFormat: true,
      jsonMode: false,
      getPriors: () => [],
      workspaceRoot: projectDir,
      deps: base,
    });

    await assert.rejects(
      () => persistence.commitAcceptedInput({ effectiveText: "q" }),
      /disk on fire/,
      "the accepted-input seam rejects, so its dependent request is never issued"
    );

    // The failure reached its own caller only: the queue still runs, and the
    // failed commit wrote nothing at all.
    const base2 = makeDeps([assistantResult({ texts: ["ok"] })]);
    const after = createChatSessionPersistence({
      store,
      conversationId: id,
      newFormat: true,
      jsonMode: false,
      getPriors: () => [],
      workspaceRoot: projectDir,
      deps: base2,
    });
    await after.commit([
      { role: "assistant", content: [{ type: "text", text: "later" }] },
    ]);
    const log = parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));
    assert.deepEqual(
      log.records
        .map((r) => r.type)
        .filter((t) => t === "message" || t === "native_state"),
      ["message"],
      "only the successful commit's message is on record"
    );
  });
});
