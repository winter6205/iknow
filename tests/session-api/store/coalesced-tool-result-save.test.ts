/**
 * Closing save must not re-parent a coalesced copy of tool results that
 * appendEvents already stored one result per message.
 *
 * Write-as-you-run commits each tool_result alone. The in-memory projection
 * then concatenates that batch into one user message. Those are the same
 * tool_use ids, not a second execution. save() used to treat the shape
 * mismatch as a fork and append a second parent chain.
 *
 * `keepHead` is the second half: a caller that declares it refuses the arm of
 * the save plan that MOVES THE HEAD BACKWARD, because the caller cannot
 * re-derive the alignment relation (only the store counts a coalesced batch as
 * the span of per-call events).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";

const TOOL_A = "read_file_0_aaa";
const TOOL_B = "bash_1_bbb";

const assistant = (): AnthropicNativeMessage => ({
  role: "assistant",
  content: [
    { type: "tool_use", id: TOOL_A, name: "read_file", input: {} },
    { type: "tool_use", id: TOOL_B, name: "bash", input: {} },
  ],
});

const toolResult = (
  toolUseId: string,
  text: string
): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
});

const coalesced = (
  a: AnthropicNativeMessage,
  b: AnthropicNativeMessage
): AnthropicNativeMessage => ({
  role: "user",
  content: [...a.content, ...b.content],
});

const interrupt = (): AnthropicNativeMessage => ({
  role: "system",
  content: [{ type: "text", text: "Interrupted by user." }],
});

let store: SessionStore;
let baseDir: string;
let sessionDir: string;

const file = (
  id: string,
  messages: ReadonlyArray<AnthropicNativeMessage>,
  messagesCount: number
): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: id,
  title: "",
  cwd: "/tmp/test",
  sanitized_at: "2026-01-01T00:00:00.000Z",
  messages: [...messages],
  jsonMode: false,
  turnCount: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  checkpoints: [
    {
      turnIndex: 1,
      messagesCount,
      interruptedAt: "2026-10-10T04:57:53.944Z",
      interruptReason: "cancelled",
    },
  ],
});

const jsonlPath = (id: string): string =>
  join(
    resolveConversationDir({ projectDir: sessionDir, conversationId: id }),
    `${id}${SESSION_JSONL_EXT}`
  );

/** Every JSONL record of one session, in write order. */
async function readRecords(
  id: string
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(jsonlPath(id), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readMessages(
  id: string
): Promise<
  Array<{ id: string; parent: string | null; message: AnthropicNativeMessage }>
> {
  return (await readRecords(id)).filter(
    (
      row
    ): row is {
      type: "message";
      id: string;
      parent: string | null;
      message: AnthropicNativeMessage;
    } => row["type"] === "message"
  );
}

/** The `head` records of one session, in write order. */
async function headRecords(
  id: string
): Promise<Array<Record<string, unknown>>> {
  return (await readRecords(id)).filter((row) => row["type"] === "head");
}

const toolUseIds = (message: AnthropicNativeMessage): string[] =>
  message.content.flatMap((block) =>
    block.type === "tool_use"
      ? [block.id]
      : block.type === "tool_result"
        ? [block.tool_use_id]
        : []
  );

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-coalesce-save-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("SessionStore.save coalesced tool-result projection", () => {
  it("does not append a second parent chain for the same tool_use ids", async () => {
    const id = "coalesce-same-ids";
    const resultA = toolResult(TOOL_A, "one");
    const resultB = toolResult(TOOL_B, "two");
    const incremental = [assistant(), resultA, resultB, interrupt()];
    const projected = [assistant(), coalesced(resultA, resultB), interrupt()];

    await store.save({ id, file: file(id, [], 0) });
    await store.appendEvents({ id, events: incremental });
    await store.save({ id, file: file(id, projected, projected.length) });

    const messages = await readMessages(id);
    const occurrences = new Map<string, string[]>();
    for (const row of messages) {
      for (const toolId of toolUseIds(row.message)) {
        const seen = occurrences.get(toolId) ?? [];
        seen.push(row.id);
        occurrences.set(toolId, seen);
      }
    }
    assert.deepEqual(occurrences.get(TOOL_A), ["e0", "e1"]);
    assert.deepEqual(occurrences.get(TOOL_B), ["e0", "e2"]);

    const children = new Map<string | null, string[]>();
    for (const row of messages) {
      const kids = children.get(row.parent) ?? [];
      kids.push(row.id);
      children.set(row.parent, kids);
    }
    assert.deepEqual(children.get("e0"), ["e1"]);
    assert.equal(messages.length, incremental.length);
    assert.equal(await store.readHead(id), "e3");

    const loaded = await store.load(id);
    assert.equal(loaded.checkpoints?.[0]?.anchorEventId, "e3");
    assert.equal(loaded.checkpoints?.[0]?.messagesCount, incremental.length);
    assert.equal(
      loaded.messages.filter(
        (message) =>
          message.role === "system" &&
          message.content.some(
            (block) =>
              block.type === "text" && block.text === "Interrupted by user."
          )
      ).length,
      1
    );
  });

  it("still forks when a coalesced tool_result body differs from the committed bytes", async () => {
    const id = "coalesce-different-bytes";
    const resultA = toolResult(TOOL_A, "one");
    const resultB = toolResult(TOOL_B, "two");
    await store.save({ id, file: file(id, [], 0) });
    await store.appendEvents({
      id,
      events: [assistant(), resultA, resultB],
    });
    const changed = toolResult(TOOL_B, "rewritten");
    await store.save({
      id,
      file: file(id, [assistant(), coalesced(resultA, changed)], 2),
    });

    const messages = await readMessages(id);
    const parentsOfB = messages
      .filter((row) =>
        row.message.content.some(
          (block) =>
            block.type === "tool_result" && block.tool_use_id === TOOL_B
        )
      )
      .map((row) => row.parent);
    assert.deepEqual(parentsOfB, ["e1", "e0"]);
  });

  it("keepHead refuses a projection that only fits by moving the head backward", async () => {
    // The fail-open shape a caller cannot detect on its own: the chain holds a
    // per-call tool_result batch AND a later committed event, while the
    // projection concatenates that batch and stops short of the tip. Elementwise
    // comparison sees a mismatch at the batch, yet the store's alignment counts
    // the span and reads the projection as a strict prefix — the reset-shaped
    // arm. `keepHead` refuses that arm instead of writing it.
    const id = "coalesce-keep-head-refuses";
    const resultA = toolResult(TOOL_A, "one");
    const resultB = toolResult(TOOL_B, "two");
    const chain = [assistant(), resultA, resultB, interrupt()];
    const projection = [assistant(), coalesced(resultA, resultB)];

    await store.save({ id, file: file(id, [], 0) });
    await store.appendEvents({ id, events: chain });
    const before = await readFile(jsonlPath(id), "utf8");

    await assert.rejects(
      () => store.save({ id, file: file(id, projection, 2), keepHead: true }),
      (err: unknown) => {
        const e = err as { kind?: string; conversation_id?: string };
        assert.equal(e.kind, "concurrent_write");
        assert.equal(e.conversation_id, id);
        return true;
      }
    );

    // Nothing written: the refused plan never reached the file.
    assert.equal(
      await readFile(jsonlPath(id), "utf8"),
      before,
      "a refused keepHead save writes no bytes"
    );
    assert.equal(await store.readHead(id), "e3", "head stays at the chain tip");
    const after = await store.load(id);
    assert.equal(
      after.messages.length,
      chain.length,
      "the committed events the projection fell behind stay on the head chain"
    );
  });

  it("compaction-shaped projection under keepHead forks instead of being refused", async () => {
    // The other half of `keepHead`: compaction re-branches the chain at its head
    // (a leading summary no chain event equals) rather than falling behind it, so
    // the alignment reads a FORK — the arm that leaves the head in place or moves
    // it forward. Refusing that arm would break compaction, so the write goes
    // through: the abandoned branch stays in the file (append-only) and the head
    // lands on the new branch tip.
    const id = "coalesce-keep-head-fork";
    const resultA = toolResult(TOOL_A, "one");
    const resultB = toolResult(TOOL_B, "two");
    const chain = [assistant(), resultA, resultB, interrupt()];
    const summary: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "Summary of the conversation so far." }],
    };
    const followUp: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Work continued after the summary." }],
    };
    const compacted = [summary, followUp];

    await store.save({ id, file: file(id, [], 0) });
    await store.appendEvents({ id, events: chain });
    const before = await readMessages(id);
    const headsBefore = (await headRecords(id)).length;

    await store.save({
      id,
      file: file(id, compacted, compacted.length),
      keepHead: true,
    });

    // Append-only: the committed chain is untouched and the new branch hangs off
    // the LCP end — no shared prefix here, so off the root.
    const messages = await readMessages(id);
    assert.deepEqual(
      messages.slice(0, chain.length),
      before,
      "the abandoned branch stays on disk byte-for-byte"
    );
    assert.equal(
      messages.length,
      chain.length + compacted.length,
      "the fork appends its own branch, no event is dropped"
    );
    assert.deepEqual(
      messages.slice(chain.length).map((row) => row.parent),
      [null, "e4"],
      "the summary opens the branch, the follow-up chains off it"
    );
    assert.equal(await store.readHead(id), "e5", "head is the new branch tip");
    const headsAfter = await headRecords(id);
    assert.equal(headsAfter.length, headsBefore + 1);
    assert.deepEqual(headsAfter[headsAfter.length - 1], {
      type: "head",
      id: "e5",
    });

    const loaded = await store.load(id);
    assert.deepEqual(
      loaded.messages,
      compacted,
      "the reload projects the compacted branch"
    );
    // The fork arm's own record shape: the checkpoint count stays the projection's
    // and re-anchors onto the branch this save wrote.
    assert.equal(loaded.checkpoints?.[0]?.messagesCount, compacted.length);
    assert.equal(loaded.checkpoints?.[0]?.anchorEventId, "e5");
  });

  it("without keepHead the same projection still takes the reset-shaped arm", async () => {
    // The contrast pins what did NOT change: resetSession / rewindSession own a
    // backward head move and ask for it without the flag.
    const id = "coalesce-no-flag-still-rewinds";
    const resultA = toolResult(TOOL_A, "one");
    const resultB = toolResult(TOOL_B, "two");
    const chain = [assistant(), resultA, resultB, interrupt()];
    const projection = [assistant(), coalesced(resultA, resultB)];

    await store.save({ id, file: file(id, [], 0) });
    await store.appendEvents({ id, events: chain });
    const headsBefore = (await headRecords(id)).length;

    await store.save({ id, file: file(id, projection, 2) });

    assert.equal(await store.readHead(id), "e2");
    const messages = await readMessages(id);
    assert.equal(
      messages.length,
      chain.length,
      "append-only: no event dropped"
    );
    const headsAfter = await headRecords(id);
    assert.equal(
      headsAfter.length,
      headsBefore + 1,
      "the rewind is one appended head record"
    );
    assert.deepEqual(headsAfter[headsAfter.length - 1], {
      type: "head",
      id: "e2",
    });
    const loaded = await store.load(id);
    assert.deepEqual(
      loaded.messages.map((m) => m.role),
      ["assistant", "user", "user"]
    );
  });
});
