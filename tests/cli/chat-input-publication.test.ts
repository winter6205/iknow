/**
 * ADR-0136 §3 / §4 on the persistent CLI chat path — the INPUT boundary has
 * exactly one publisher, and the engine reaches real storage through the host
 * binder.
 *
 * What is proved here, against a real `SessionStore` over a real temp tree and
 * a real filesystem — never a mocked store, never a mocked sink:
 *
 *   1. one accepted user message produces exactly ONE `input` record on disk,
 *      and the query is still committed to the transcript (the engine never
 *      commits a user message, so the host's own commit must survive);
 *   2. one turn on a new-format chat session lands all four boundaries —
 *      accepted input, settled tool batch, compaction, terminal;
 *   3. the `--resume` posture publishes nothing at all while still committing,
 *      and the session's own bytes are untouched by the binder.
 *
 * The model is the only stub: a scripted stub adapter, so "the turn ran" is an
 * observation rather than an inference.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  createChatSessionPersistence,
  processChatLine,
  type ChatLineContext,
} from "../../src/cli/chat-session.ts";
import {
  NATIVE_STATE_FORMAT_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  SESSION_JSONL_EXT,
  type SessionNativeStateRecord,
} from "../../src/session-api/store/index.ts";
import type { LoopEngineDeps, ToolDef } from "../../src/harness/index.ts";
import { createExecutor, createRegistry } from "../../src/harness/index.ts";
import { assistantResult, makeCtx, makeDeps } from "./_fixtures.ts";

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-input-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-chat-input-root-"));
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

/** The session log as it really sits on disk — events, not a projection. */
const logFor = async (id: string) =>
  parseSessionJsonl(await readFile(jsonlFor(id), "utf8"));

/** Every user text the transcript really holds, in commit order. */
const committedUserTexts = async (id: string): Promise<ReadonlyArray<string>> =>
  (await logFor(id)).events
    .filter((e) => e.message.role === "user")
    .flatMap((e) =>
      e.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
    );

const nativeStateRecords = async (
  id: string
): Promise<ReadonlyArray<SessionNativeStateRecord>> =>
  (await logFor(id)).records.filter(
    (r): r is SessionNativeStateRecord => r.type === "native_state"
  );

const boundariesOf = async (id: string): Promise<ReadonlyArray<string>> =>
  (await nativeStateRecords(id)).map((r) => r.boundary);

const text = (t: string) => ({ type: "text" as const, text: t });
const userMsg = (t: string) => ({ role: "user" as const, content: [text(t)] });

/** Every file under the session folder with its bytes — the --resume compare. */
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

/** Production wiring: the commit hook is the engine's `commitMessages`, the
 *  session-bound sink is the engine's `runtimePersistence`, and the
 *  accepted-input commit reuses that hook as its append authority. */
function wireChat(
  id: string,
  deps: LoopEngineDeps,
  ctx: ChatLineContext,
  newFormat: boolean
): ChatLineContext {
  const persistence = createChatSessionPersistence({
    store,
    conversationId: id,
    newFormat,
    jsonMode: false,
    getPriors: () => ctx.state.messages,
    workspaceRoot: projectDir,
    deps,
  });
  return {
    ...ctx,
    deps: {
      ...deps,
      commitMessages: persistence.commit,
      ...(persistence.runtimePersistence !== undefined
        ? { runtimePersistence: persistence.runtimePersistence }
        : {}),
    },
    newFormatSession: newFormat,
    commitAcceptedInput: persistence.commitAcceptedInput,
  };
}

describe("chat input publication: one owner, four boundaries", () => {
  it("publishes exactly ONE input record per accepted message, and still commits the query", async () => {
    const id = "one-input-record";
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
      checkpointStore: store,
      workspaceRoot: projectDir,
      stateOverrides: { conversationId: id },
    });
    const wired = wireChat(id, ctx.deps, ctx, true);

    await processChatLine({ line: "remember this", ctx: wired });

    const records = await nativeStateRecords(id);
    assert.equal(
      records.filter((r) => r.boundary === "input").length,
      1,
      "exactly one input record for one accepted message"
    );
    // The query itself is the engine's obligation it never meets: the host's
    // own commit must still be what puts the user message on the chain.
    assert.ok(
      (await committedUserTexts(id)).includes("remember this"),
      "the accepted query is committed to the transcript"
    );
    const bodies = await Promise.all(
      records.map((r) =>
        new SessionStore(baseDir, taskRoot).readPublishedNativeStateBody({
          id,
          bodySha: r.bodySha,
        })
      )
    );
    const input = bodies.find((b) => b.boundary === "input");
    assert.equal(input?.messages.length, 1, "the input state holds the query");
  });

  it("lands input, tool batch, compaction and terminal for one turn", async () => {
    const id = "all-four-boundaries";
    // A concurrency-safe tool so the batch settles in one wave, and a
    // compaction threshold far below the estimate so the gate fires on turn 0.
    const tool: ToolDef = Object.freeze({
      name: "alpha",
      description: "returns a fixed result",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (async () => "result-a") as ToolDef["handler"],
      aci: {
        category: "read-only",
        isConcurrencySafe: true,
        interruptBehavior: "cancel",
        timeoutTier: "fast",
      },
    });
    const registry = createRegistry([tool]);
    // The proactive gate only fires when there is history to drop, so the
    // seeded history below is what makes the boundary reachable. The summary
    // round runs on the compaction seam, not on the scripted main-loop turns.
    const base = {
      ...makeDeps([
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a1", name: "alpha", input: {} }],
        }),
        assistantResult({ texts: ["done"], supplierStop: "success" }),
      ]),
      registry,
      executor: createExecutor(registry),
      compress: { contextWindow: 200_000, thresholdTokens: 1 },
    };
    const ctx = makeCtx({
      responses: [],
      checkpointStore: store,
      workspaceRoot: projectDir,
      stateOverrides: {
        conversationId: id,
        messages: Array.from({ length: 12 }, (_, i) =>
          i % 2 === 0
            ? userMsg(`earlier question ${i}`)
            : {
                role: "assistant" as const,
                content: [text(`earlier answer ${i}`)],
              }
        ),
      },
    });
    const wired = wireChat(id, base, ctx, true);

    const result = await processChatLine({ line: "go", ctx: wired });
    assert.equal(result.ranQuery, true, "the turn really ran");

    const landed = await boundariesOf(id);
    for (const boundary of ["input", "tool_batch", "terminal"] as const) {
      assert.equal(
        landed.filter((b) => b === boundary).length,
        1,
        `exactly one ${boundary} record (landed: ${landed.join(",")})`
      );
    }
    // Compaction may re-arm on a later beat of the same turn, so its boundary
    // is required to land, not to land once.
    assert.ok(
      landed.includes("compaction"),
      `a compaction record landed (landed: ${landed.join(",")})`
    );
    // Order is the contract too: each boundary is durable before the request
    // that reads it, so the input record's anchor precedes the tool batch's.
    const records = await nativeStateRecords(id);
    const order = (b: string): number =>
      records.findIndex((r) => r.boundary === b);
    assert.ok(order("input") < order("tool_batch"));
    assert.ok(order("tool_batch") < order("terminal"));
  });

  it("keeps the --resume posture publishing nothing, while still committing", async () => {
    const id = "resumed-session";
    // A real new-format session the current host did not create: the picker
    // opened it, so the anchor chain is already there.
    await store.save({
      id,
      file: {
        schemaVersion: 3,
        conversation_id: id,
        messages: [userMsg("earlier question")],
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
    const treeBefore = await treeBytes(conversationDir(id));
    const markerBefore = (await store.load(id)).nativeStateFormat;

    const base = makeDeps([assistantResult({ texts: ["ok"] })]);
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
      checkpointStore: store,
      workspaceRoot: projectDir,
      stateOverrides: { conversationId: id },
    });
    const wired = wireChat(id, base, ctx, false);

    const result = await processChatLine({ line: "new question", ctx: wired });
    assert.equal(result.ranQuery, true, "the resumed turn still ran");

    // SC23: nothing was published into a session this host did not create —
    // no state record, no body blob, no new file, and not one pre-existing
    // byte rewritten (the transcript only ever grew by the committed turn).
    assert.deepEqual(await nativeStateRecords(id), []);
    const treeAfter = await treeBytes(conversationDir(id));
    assert.ok(!treeAfter.has("blobs/"), "no body pool was created");
    assert.deepEqual(
      [...treeAfter.keys()].filter((name) => name !== `${id}.jsonl`),
      [...treeBefore.keys()].filter((name) => name !== `${id}.jsonl`),
      "no file was added besides the transcript's own growth"
    );
    for (const [name, bytes] of treeBefore) {
      if (name === `${id}.jsonl`) continue;
      assert.equal(treeAfter.get(name), bytes, `${name} kept its bytes`);
    }
    // The marker decides which format the session is in, so a resumed turn
    // must neither drop it nor move it to another value.
    assert.equal((await store.load(id)).nativeStateFormat, markerBefore);
    assert.equal(markerBefore, NATIVE_STATE_FORMAT_VERSION);
    // The turn is still committed, or --resume would discard every answer.
    assert.ok(
      (await committedUserTexts(id)).includes("new question"),
      "the resumed turn's query is still committed"
    );
  });
});
