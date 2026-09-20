/**
 * load/resume backfills unpaired tool_use (process closeout).
 *
 * When the on-disk JSONL head chain contains an assistant event with tool_use
 * block(s) not followed by matching tool_result(s) — the crash shape of a
 * process dying mid-turn — the load projection backfills synthetic
 * tool_result(s) via the existing `encodeToolResults` adapter encoder
 * (`execution_failed`), so no consumer (hub/chat/serve) ever sends an orphan
 * tool_use to the adapter.
 *
 * Locked here (spec Testing Decisions negative class):
 *   - Backfill is a pure load-time projection: zero extra IO — on-disk bytes
 *     are unchanged by load; every load re-derives the same synthetic results.
 *   - Synthetic results are `execution_failed` with `process` reason
 *     semantics: the text must NOT contain `Interrupted by user.` (that system
 *     sentence belongs to the harness `cancelled` path, not this one).
 *   - Mutating tools (bash / edit_file / write_file — spec-named set) carry
 *     the check-before-rerun instruction (`先检查副作用是否已生效,未生效再重跑`
 *     — "first check whether the side effect already landed; rerun only if not");
 *     read-only tools (grep, read_file, glob, …) must NOT contain it.
 *   - Multiple orphan tool_uses in one assistant event each get a paired
 *     result; a partially-answered turn (T3's per-tool commit shape) only
 *     backfills the missing ones, after the committed results.
 *   - Orphans are only possible at the tail of the head chain (append-only
 *     invariant); mid-chain/general shapes are locked defensively anyway.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeoutOrphanToolUses,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../src/harness/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";

let store: SessionStore;
let baseDir: string;
let sessionDir: string;

const userMsg = (text: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistantMsg = (text: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const toolUseMsg = (
  calls: ReadonlyArray<{ readonly id: string; readonly name: string }>
): AnthropicNativeMessage => ({
  role: "assistant",
  content: calls.map((c) => ({
    type: "tool_use" as const,
    id: c.id,
    name: c.name,
    input: {},
  })),
});

const toolResultMsg = (
  toolUseId: string,
  text: string
): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
});

const sampleFile = (opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 => ({
  schemaVersion: 5,
  conversation_id: opts.id,
  title: "",
  cwd: "/tmp/test",
  sanitized_at: "2026-01-01T00:00:00.000Z",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  checkpoints: [],
  ...opts.overrides,
});

const conversationDir = (id: string): string =>
  resolveConversationDir({ projectDir: sessionDir, conversationId: id });
const jsonlPath = (id: string): string =>
  join(conversationDir(id), `${id}${SESSION_JSONL_EXT}`);

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<AnthropicContentBlock, { type: "tool_result" }>;

const toolUseBlocksOf = (msg: AnthropicNativeMessage): ToolUseBlock[] =>
  msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

const toolResultBlocksOf = (msg: AnthropicNativeMessage): ToolResultBlock[] =>
  msg.content.filter((b): b is ToolResultBlock => b.type === "tool_result");

/** The mutating-tool check-before-rerun instruction (spec D6). */
const CHECK_BEFORE_RERUN =
  "check whether the intended change already took effect";

/**
 * API-legality assertion: every tool_use in an assistant message must be
 * answered by tool_result block(s) in the immediately following consecutive
 * tool_result-only user message(s) — before any other content or role.
 */
function assertApiLegal(messages: ReadonlyArray<AnthropicNativeMessage>): void {
  for (let i = 0; i < messages.length; i++) {
    const ids = toolUseBlocksOf(messages[i]!).map((b) => b.id);
    if (ids.length === 0) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j]!;
      if (next.role !== "user") break;
      if (
        next.content.length === 0 ||
        !next.content.every((b) => b.type === "tool_result")
      ) {
        break;
      }
      for (const b of toolResultBlocksOf(next)) answered.add(b.tool_use_id);
      j++;
    }
    for (const id of ids) {
      assert.ok(
        answered.has(id),
        `tool_use ${id} (message ${i}) lacks a tool_result immediately after`
      );
    }
  }
}

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-closeout-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// -- pure projection (closeoutOrphanToolUses) --------------------------------

describe("closeoutOrphanToolUses (pure projection)", () => {
  it("empty messages → empty; no tool_use → unchanged", () => {
    assert.deepEqual(closeoutOrphanToolUses([]), []);
    const plain = [userMsg("q"), assistantMsg("a")];
    assert.deepEqual(closeoutOrphanToolUses(plain), plain);
  });

  it("paired tool_use → unchanged (no synthetic result)", () => {
    const paired = [
      userMsg("q"),
      toolUseMsg([{ id: "tu1", name: "bash" }]),
      toolResultMsg("tu1", "ok"),
      assistantMsg("done"),
    ];
    assert.deepEqual(closeoutOrphanToolUses(paired), paired);
  });

  it("tail orphan on a read-only tool → execution_failed result WITHOUT the check-before-rerun instruction", () => {
    const out = closeoutOrphanToolUses([
      userMsg("q"),
      toolUseMsg([{ id: "tu1", name: "grep" }]),
    ]);
    assert.equal(out.length, 3);
    const synthetic = out[2]!;
    assert.equal(synthetic.role, "user");
    const results = toolResultBlocksOf(synthetic);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.tool_use_id, "tu1");
    assert.equal(results[0]!.is_error, true);
    const text = (results[0]!.content as ReadonlyArray<{ text: string }>)[0]!
      .text;
    assert.ok(text.startsWith("[execution_failed]"), text);
    assert.ok(/process/.test(text), text);
    assert.ok(!text.includes("Interrupted by user."), text);
    assert.ok(!text.includes(CHECK_BEFORE_RERUN), text);
    assert.ok(!/re-run/.test(text), text);
    assertApiLegal(out);
  });

  for (const tool of ["bash", "edit_file", "write_file"] as const) {
    it(`tail orphan on mutating tool ${tool} → text instructs check-before-rerun`, () => {
      const out = closeoutOrphanToolUses([
        userMsg("q"),
        toolUseMsg([{ id: "tu1", name: tool }]),
      ]);
      const results = toolResultBlocksOf(out[2]!);
      const text = (results[0]!.content as ReadonlyArray<{ text: string }>)[0]!
        .text;
      assert.ok(text.startsWith("[execution_failed]"), text);
      assert.ok(text.includes(CHECK_BEFORE_RERUN), text);
      assert.ok(/re-run/.test(text), text);
      assert.ok(!text.includes("Interrupted by user."), text);
      assertApiLegal(out);
    });
  }

  it("multiple orphan tool_uses in one assistant event each get a paired result", () => {
    const out = closeoutOrphanToolUses([
      userMsg("q"),
      toolUseMsg([
        { id: "tu1", name: "bash" },
        { id: "tu2", name: "grep" },
        { id: "tu3", name: "write_file" },
      ]),
    ]);
    assert.equal(out.length, 3);
    const results = toolResultBlocksOf(out[2]!);
    assert.deepEqual(
      results.map((r) => r.tool_use_id),
      ["tu1", "tu2", "tu3"]
    );
    const texts = results.map(
      (r) => (r.content as ReadonlyArray<{ text: string }>)[0]!.text
    );
    assert.ok(texts[0]!.includes(CHECK_BEFORE_RERUN)); // bash
    assert.ok(!texts[1]!.includes(CHECK_BEFORE_RERUN)); // grep
    assert.ok(texts[2]!.includes(CHECK_BEFORE_RERUN)); // write_file
    assertApiLegal(out);
  });

  it("partially-answered turn (T3 per-tool commit shape) backfills only the missing results, after the committed ones", () => {
    const out = closeoutOrphanToolUses([
      userMsg("q"),
      toolUseMsg([
        { id: "tu1", name: "bash" },
        { id: "tu2", name: "edit_file" },
      ]),
      toolResultMsg("tu1", "committed"),
    ]);
    assert.equal(out.length, 4);
    // The committed result stays untouched at index 2.
    assert.deepEqual(out[2], toolResultMsg("tu1", "committed"));
    const results = toolResultBlocksOf(out[3]!);
    assert.deepEqual(
      results.map((r) => r.tool_use_id),
      ["tu2"]
    );
    assertApiLegal(out);
  });

  it("mid-chain orphan (defensive general shape) gets the synthetic result inserted immediately after its answer window", () => {
    const out = closeoutOrphanToolUses([
      userMsg("q"),
      toolUseMsg([{ id: "tu1", name: "grep" }]),
      assistantMsg("text after"),
    ]);
    assert.equal(out.length, 4);
    assert.deepEqual(
      toolResultBlocksOf(out[2]!).map((r) => r.tool_use_id),
      ["tu1"]
    );
    assert.deepEqual(out[3], assistantMsg("text after"));
    assertApiLegal(out);
  });

  it("two orphan assistant events each get their own paired backfill", () => {
    const out = closeoutOrphanToolUses([
      toolUseMsg([{ id: "tu1", name: "bash" }]),
      toolUseMsg([{ id: "tu2", name: "read_file" }]),
    ]);
    assert.equal(out.length, 4);
    assert.deepEqual(
      toolResultBlocksOf(out[1]!).map((r) => r.tool_use_id),
      ["tu1"]
    );
    assert.deepEqual(
      toolResultBlocksOf(out[3]!).map((r) => r.tool_use_id),
      ["tu2"]
    );
    assertApiLegal(out);
  });
});

// -- store load projection (integration) --------------------------------------

describe("SessionStore.load — process closeout backfill", () => {
  it("on-disk orphan tool_use (crash after assistant commit) loads paired", async () => {
    await store.save({
      id: "t4-orphan",
      file: sampleFile({
        id: "t4-orphan",
        overrides: { messages: [userMsg("q")] },
      }),
    });
    // Crash shape: assistant event committed, process died before the result.
    await store.appendEvents({
      id: "t4-orphan",
      events: [toolUseMsg([{ id: "tu1", name: "bash" }])],
    });
    const loaded = await store.load("t4-orphan");
    assert.equal(loaded.messages.length, 3);
    const results = toolResultBlocksOf(loaded.messages[2]!);
    assert.equal(results[0]!.tool_use_id, "tu1");
    assert.equal(results[0]!.is_error, true);
    const text = (results[0]!.content as ReadonlyArray<{ text: string }>)[0]!
      .text;
    assert.ok(text.includes(CHECK_BEFORE_RERUN), text);
    assert.ok(!text.includes("Interrupted by user."), text);
    assertApiLegal(loaded.messages);
  });

  it("backfill is a pure projection: zero extra IO, on-disk bytes unchanged, reloads are deterministic", async () => {
    await store.save({
      id: "t4-pure",
      file: sampleFile({
        id: "t4-pure",
        overrides: { messages: [userMsg("q")] },
      }),
    });
    await store.appendEvents({
      id: "t4-pure",
      events: [toolUseMsg([{ id: "tu1", name: "grep" }])],
    });
    const before = await readFile(jsonlPath("t4-pure"), "utf8");
    const first = await store.load("t4-pure");
    const after = await readFile(jsonlPath("t4-pure"), "utf8");
    assert.equal(after, before, "load must not write to the log");
    const second = await store.load("t4-pure");
    assert.deepEqual(second.messages, first.messages);
  });

  it("a save after the backfilled load persists the pairing (self-healing); reload stays API-legal", async () => {
    await store.save({
      id: "t4-heal",
      file: sampleFile({
        id: "t4-heal",
        overrides: { messages: [userMsg("q")] },
      }),
    });
    await store.appendEvents({
      id: "t4-heal",
      events: [toolUseMsg([{ id: "tu1", name: "write_file" }])],
    });
    const loaded = await store.load("t4-heal");
    await store.save({ id: "t4-heal", file: loaded });
    const reloaded = await store.load("t4-heal");
    assert.deepEqual(reloaded.messages, loaded.messages);
    assertApiLegal(reloaded.messages);
    // The synthetic result is now a real event in the log (no re-backfill).
    const raw = await readFile(jsonlPath("t4-heal"), "utf8");
    assert.ok(raw.includes('"tool_use_id":"tu1"'));
  });

  it("fully-answered turns load unchanged (no synthetic noise)", async () => {
    const file = sampleFile({
      id: "t4-clean",
      overrides: {
        messages: [
          userMsg("q"),
          toolUseMsg([{ id: "tu1", name: "bash" }]),
          toolResultMsg("tu1", "ok"),
          assistantMsg("done"),
        ],
      },
    });
    await store.save({ id: "t4-clean", file });
    const loaded = await store.load("t4-clean");
    assert.deepEqual(loaded.messages, file.messages);
  });
});
