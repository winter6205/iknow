/**
 * Chat REPL `--resume <id>` continuation —— the `seedResumeMessages` helper plus
 * the resume wiring.
 *
 * Coverage across the six boundary classes:
 *   1. empty: no resumeId → zero IO, empty messages, behaviour identical to the
 *      plain new-session path;
 *   2. negative: not_found / parse_failed / schema_invalid / io_error, all typed
 *      → guard returns empty messages and fires the warn callback while
 *      **keeping the conversationId anchor**, so later checkpoints write back to
 *      the same `<id>.jsonl`;
 *   3. overflow / concurrent: repeated completed turns under one conversationId
 *      accumulate turnCount to prior+N and messages; a cancelled turn with
 *      turnCount=1 appends its checkpoint after the existing index;
 *   4. exception: an unknown (non-typed) throw is rethrown as-is, never silently
 *      swallowed;
 *   + success: load hit → state.messages == file.messages; a first resumed turn
 *     through processChatLine → file.turnCount = prior + 1, messages accumulate,
 *     checkpoints keep order.
 *
 * Design: `runChatSession` is itself a TTY/pipe entry point (integration-heavy,
 * not unit-testable), but its core IO (`store.load` once + write to state) is
 * extracted into the pure helper `seedResumeMessages`. The resume wiring
 * (state.messages = seed result) is verified indirectly through
 * processChatLine —— agreement on the prior view is sufficient proof.
 */
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistChatSessionCheckpoint,
  processChatLine,
  seedResumeMessages,
} from "../../src/cli/chat-session.ts";
import {
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type {
  AnthropicNativeMessage,
  RunResult,
} from "../../src/harness/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";

// -- fixtures ----------------------------------------------------------------

const text = (t: string) => ({ type: "text" as const, text: t });
const userMsg = (t: string): AnthropicNativeMessage => ({
  role: "user",
  content: [text(t)],
});
const assistantMsg = (t: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [text(t)],
});

const tempDirs: string[] = [];
async function storeFor(): Promise<SessionStore> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-"));
  tempDirs.push(tmp);
  return new SessionStore(tmp, process.cwd());
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

type InterruptReasonLit =
  "cancelled" | "maxTurns" | "process" | "protocolError" | "timeout";

/** Build a v3 session file matching schema (CURRENT_SCHEMA_VERSION=3). */
function seededFile(opts: {
  readonly id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount: number;
  readonly checkpoints?: ReadonlyArray<{
    readonly turnIndex: number;
    readonly messagesCount: number;
    readonly interruptedAt: string;
    readonly interruptReason: InterruptReasonLit;
  }>;
}): Parameters<SessionStore["save"]>[0]["file"] {
  return {
    schemaVersion: 3,
    conversation_id: opts.id,
    messages: opts.messages,
    jsonMode: false,
    turnCount: opts.turnCount,
    updatedAt: "2026-08-11T00:00:00.000Z",
    title: "",
    cwd: process.cwd(),
    sanitized_at: "2026-08-11T00:00:00.000Z",
    checkpoints: opts.checkpoints ?? [],
  };
}

function buildResult(opts: {
  readonly stopReason: RunResult["stopReason"];
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
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

// -- stderr capture (spyOn) --------------------------------------------------

/**
 * `seedResumeMessages`' warn callback goes through `writeErr` →
 * `process.stderr.write`. Same vitest spyOn pattern as
 * tui/run-errors.test.ts (bun:test variant), reused across files.
 */
// Capture stderr.write spy. vi.spyOn's generic resolution with
// `process.stderr.write` overloads is brittle: TS picks an overload
// whose method-key constraint defaults to array-method keys, so the
// helper's constraint fails even though the runtime call is sound. We
// type it via the concrete return type of the actual `vi.spyOn(...)`
// assignment in `beforeEach`, then consume `mock.calls` / `mockRestore`
// without further re-derivation.
import type { MockInstance } from "vitest";
let stderrSpy: MockInstance<typeof process.stderr.write>;

function capturedStderr(): string {
  return stderrSpy.mock.calls
    .map((call) =>
      typeof call[0] === "string"
        ? call[0]
        : Buffer.from(call[0] as Uint8Array).toString("utf8")
    )
    .join("");
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write");
});
afterEach(() => {
  stderrSpy.mockRestore();
});

// -- seedResumeMessages (pure IO helper) ------------------------------------

describe("seedResumeMessages — T4 seed helper", () => {
  it("resumeId 未设 → 空 messages,无 warn (empty-class 零 IO)", async () => {
    const r = await seedResumeMessages({ store: undefined, id: undefined });
    assert.deepEqual(r.messages, []);
    assert.equal(r.warn, undefined);
  });

  it("load 命中 → messages 严格匹配文件,无 warn", async () => {
    const s = await storeFor();
    const id = "hit";
    const messages = [userMsg("q1"), assistantMsg("a1")];
    await s.save({ id, file: seededFile({ id, messages, turnCount: 1 }) });

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, messages);
    assert.equal(r.warn, undefined);
  });

  // A conversation that does not exist is REJECTED, not degraded. This case used
  // to assert the opposite — that `not_found` returns an empty seed and warns
  // "从空开始" — which is what made one `--resume` command print a promise and
  // then die in `openSessionWithRecovery`. It now asserts the rejection, and
  // strictly more: the typed kind survives, the promise is never printed, and
  // no session is created on the way out.
  it("not_found → typed error propagates; nothing is warned, nothing is created", async () => {
    const s = await storeFor();
    const id = "ghost";
    await assert.rejects(
      () => seedResumeMessages({ store: s, id }),
      (err: unknown) => {
        // A typed SessionStoreError, not a bare Error: the store contract is
        // that these carry a string `kind`, and the entry contract is that a
        // missing conversation is rejected with that typed error intact.
        assert.equal(typeof err, "object");
        assert.equal(err instanceof Error, false);
        assert.equal((err as { kind?: string }).kind, "not_found");
        return true;
      }
    );
    // The false promise must be gone: no "从空开始" line for a missing id.
    assert.equal(capturedStderr(), "");
    // And the rejection must not have written a session where there was none.
    await assert.rejects(
      () => s.load(id),
      (err: unknown) => {
        assert.equal((err as { kind?: string }).kind, "not_found");
        return true;
      }
    );
  });

  it("parse_failed → 写入垃圾 JSON 后 warn 触发 [parse_failed]", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-corrupt-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "corrupt";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(tmp, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), "{not json", "utf8");

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    const text = capturedStderr();
    assert.match(text, /\[parse_failed\]/);
    assert.match(text, new RegExp(id));
  });

  it("schema_invalid → schemaVersion=99 → warn 触发 [schema_invalid]", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-schema-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "bad-schema";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(tmp, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    // future schemaVersion → validateSessionFile returns "schemaVersion" →
    // sanitize throws → load re-throws schema_invalid.
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({ schemaVersion: 99, conversation_id: id }),
      "utf8"
    );

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    const text = capturedStderr();
    assert.match(text, /\[schema_invalid\]/);
  });

  it("io_error → project session dir 是普通文件 → readFile 走非 ENOENT 分支", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-io-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "io-err";
    const projectDir = resolveProjectSessionDir(tmp, process.cwd());
    const convDir = resolveConversationDir({
      projectDir,
      conversationId: id,
    });
    // Replace the conversation subfolder with a plain file: readFile resolving a
    // path under it gets ENOTDIR → store.readRaw maps anything other than ENOENT
    // to io_error.
    await mkdir(join(tmp, "projects"), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(convDir, "blocker", "utf8");

    const r = await seedResumeMessages({ store: s, id });
    assert.deepEqual(r.messages, []);
    assert.equal(typeof r.warn, "function");
    r.warn!();
    assert.match(capturedStderr(), /\[io_error\]/);
  });

  it("未知异常(防御性)→ 原样重抛,绝不静默吞咽", async () => {
    // Build a fake that satisfies SessionStore.load's shape but throws a bare
    // Error, simulating a fault outside the store contract. The cast to an
    // unknown SessionStore is test-only.
    const fake = {
      load: () => Promise.reject(new Error("explosion")),
    } as unknown as SessionStore;
    await assert.rejects(
      () => seedResumeMessages({ store: fake, id: "x" }),
      (err: unknown) => err instanceof Error && err.message === "explosion"
    );
  });
});

// -- runChatSession-equivalent wiring:seed + processChatLine -----------------

describe("resume 续跑集成(seed 步骤 + processChatLine 接线)", () => {
  it("成功:resume turnCount=3 文件 → 首轮 completed 后 turnCount=4,messages 累计,checkpoints 保序", async () => {
    const s = await storeFor();
    const id = "resume-completed";
    const seededMessages = [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"),
      assistantMsg("a3"),
    ];
    const seededCheckpoint = {
      turnIndex: 2,
      messagesCount: 4,
      interruptedAt: "2026-08-10T00:00:00.000Z",
      interruptReason: "process" as InterruptReasonLit,
    };
    await s.save({
      id,
      file: seededFile({
        id,
        messages: seededMessages,
        turnCount: 3,
        checkpoints: [seededCheckpoint],
      }),
    });

    // Seed step —— same source as inside runChatSession; state.messages must match
    // exactly.
    const seeded = await seedResumeMessages({ store: s, id });
    assert.equal(seeded.messages.length, 6);
    assert.deepEqual(
      [...seeded.messages],
      seededMessages,
      "state.messages 必须严格匹配文件 messages"
    );

    // Build a ctx with runChatSession's shape (state.messages = seed result).
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["a4"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: {
        conversationId: id,
        messages: Object.freeze([...seeded.messages]),
      },
    });
    const r = await processChatLine({ line: "q4", ctx });
    assert.equal(r.ranQuery, true);

    // Accumulation: 3 (seeded) + 1 (completed) = 4. completed appends no checkpoint.
    const file = await s.load(id);
    assert.equal(file.turnCount, 4, "completed 续跑必须累计 turnCount");
    assert.equal(file.messages.length, 8, "messages 累计到 8");
    assert.equal(file.checkpoints?.length, 1, "completed 不 append checkpoint");
    assert.deepEqual(
      file.checkpoints?.[0],
      // The checkpoint's authoritative anchor is its event id: save/load derive
      // e3, the 4th event on the chain, from messagesCount=4.
      { ...seededCheckpoint, anchorEventId: "e3" },
      "既有 checkpoints 必须保序不丢"
    );
  });

  it("成功(resume + cancelled-turn 累计 turnIndex=4):prior turnCount=3 → checkpoint 从既有序列继续", async () => {
    // End-to-end check that `session.turnCount + result.turnCount` still mirrors
    // the hub's accumulation convention in a resume context. Result
    // turnCount=1 → turnIndex=3+1=4.
    const s = await storeFor();
    const id = "resume-cancelled";
    const seeded = [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"),
      assistantMsg("a3"),
    ];
    const priorCheckpoint = {
      turnIndex: 2,
      messagesCount: 4,
      interruptedAt: "2026-08-10T00:00:00.000Z",
      interruptReason: "process" as InterruptReasonLit,
    };
    await s.save({
      id,
      file: seededFile({
        id,
        messages: seeded,
        turnCount: 3,
        checkpoints: [priorCheckpoint],
      }),
    });

    // Persist the aftermath of one cancelled round (interrupted after the model
    // produced a partial). prior = the file's existing messages.
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "cancelled",
        messages: [...seeded, userMsg("q4"), assistantMsg("partial a4")],
        turnCount: 1,
      }),
      priorMessages: seeded,
    });

    const file = await s.load(id);
    assert.equal(
      file.turnCount,
      4,
      "累计 turnCount = prior(3) + result.turnCount(1) = 4"
    );
    assert.equal(file.messages.length, 8, "messages 含 partial assistant");
    assert.equal(file.checkpoints?.length, 2, "既有 + 新增 = 2");
    const latest = file.checkpoints?.[1];
    assert.equal(latest?.turnIndex, 4, "累计 turnIndex = 3 + 1 = 4");
    assert.equal(latest?.messagesCount, 8, "messagesCount cumulative");
    assert.equal(latest?.interruptReason, "cancelled");
    // Existing checkpoints stay in order and are not lost (derived
    // anchorEventId=e3, see the note above).
    assert.deepEqual(file.checkpoints?.[0], {
      ...priorCheckpoint,
      anchorEventId: "e3",
    });
  });

  // The anchor-preservation guarantee still holds for a DAMAGED log — that is
  // the only case left that degrades to a warning (see the schema_invalid case
  // below, which asserts seed-empty + warn + id kept, and the checkpoint
  // write-back case above, which covers the anchor surviving a real save). What
  // is no longer true is that a conversation which does not exist at all
  // degrades: it is rejected, and it must not be brought into existence by the
  // command that failed to find it.
  it("not_found → 拒绝进入 processChatLine,且不会把不存在的会话建出来", async () => {
    const s = await storeFor();
    const id = "anchor-keep";
    // No file exists: the seed must REJECT rather than hand an empty context to
    // the turn path, which would have written a turn into a session the operator
    // asked to resume but that was never there.
    await assert.rejects(
      () => seedResumeMessages({ store: s, id }),
      (err: unknown) => {
        assert.equal((err as { kind?: string }).kind, "not_found");
        return true;
      }
    );
    assert.equal(capturedStderr(), "", "不存在不得再打印“从空开始”");
    await assert.rejects(
      () => s.load(id),
      (err: unknown) => {
        assert.equal((err as { kind?: string }).kind, "not_found");
        return true;
      }
    );
  });

  it("resume 文件 checkpoints=null(畸形)→ seed 空 + warn [schema_invalid] + 锚点保留", async () => {
    // Deep branch of the exception class: a v3 file with `checkpoints: null` is
    // malformed —— the production ruling is "never silently coerce" (schema.ts),
    // so it is never normalized. load throws typed schema_invalid
    // (field="checkpoints") → seed takes its typed guard: empty messages + warn
    // fired and containing `[schema_invalid]` + anchor kept (id not lost).
    // Never a bare Error, never silently swallowed.
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-resume-cpnull-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "cp-null";
    const dir = resolveConversationDir({
      projectDir: resolveProjectSessionDir(tmp, process.cwd()),
      conversationId: id,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 3,
        conversation_id: id,
        messages: [userMsg("q1"), assistantMsg("a1")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-08-11T00:00:00.000Z",
        title: "q1",
        cwd: "",
        sanitized_at: "2026-08-11T00:00:00.000Z",
        checkpoints: null,
      }),
      "utf8"
    );

    const seeded = await seedResumeMessages({ store: s, id });
    assert.deepEqual(seeded.messages, []);
    assert.equal(typeof seeded.warn, "function");
    seeded.warn!();
    const text = capturedStderr();
    assert.match(text, new RegExp(`恢复会话 ${id} 失败`));
    assert.match(text, /\[schema_invalid\]/);
    assert.match(text, new RegExp(`仍锚定 ${id}`));

    // Anchor kept: the next completed round writes back to the same
    // `<id>.jsonl`, rebuilt as a clean v5 file.
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["hello"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: {
        conversationId: id,
        messages: Object.freeze([...seeded.messages]),
      },
    });
    await processChatLine({ line: "hi", ctx });
    const file = await s.load(id);
    assert.equal(file.conversation_id, id, "写回同一 <id>.json,锚点保留");
    assert.equal(file.turnCount, 1);
    assert.deepEqual(file.checkpoints, [], "重建文件 checkpoints 归一为 []");
  });

  it("concurrent / duplicate commit:resume → 2 completed turns → turnCount = prior + 2", async () => {
    const s = await storeFor();
    const id = "repeat-after-resume";
    const seeded = [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
    ];
    const priorCheckpoint = {
      turnIndex: 2,
      messagesCount: 4,
      interruptedAt: "2026-08-10T00:00:00.000Z",
      interruptReason: "process" as InterruptReasonLit,
    };
    await s.save({
      id,
      file: seededFile({
        id,
        messages: seeded,
        turnCount: 2,
        checkpoints: [priorCheckpoint],
      }),
    });

    // Two completed turns —— same store + conversationId, simulating repeated
    // commits directly.
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [...seeded, userMsg("q3"), assistantMsg("a3")],
        turnCount: 1,
      }),
      priorMessages: seeded,
    });
    const afterFirst = await s.load(id);
    const messagesAfter1 = [...afterFirst.messages];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [...messagesAfter1, userMsg("q4"), assistantMsg("a4")],
        turnCount: 1,
      }),
      priorMessages: messagesAfter1,
    });

    const file = await s.load(id);
    assert.equal(file.turnCount, 4, "累计 turnCount = prior(2) + 2 = 4");
    assert.equal(file.messages.length, 8);
    // completed appends no checkpoint → the existing single entry is preserved
    // unchanged; growth requires a cancelled turn (the resume-cancelled case
    // covers turnIndex accumulation).
    assert.equal(
      file.checkpoints?.length,
      1,
      "completed 重复 commit 不增长 checkpoints(既有保序)"
    );
    // Derived anchorEventId=e3 (messagesCount=4 → the 4th event on the chain).
    assert.deepEqual(file.checkpoints?.[0], {
      ...priorCheckpoint,
      anchorEventId: "e3",
    });
  });
});

// ---------------------------------------------------------------------------
// ChatSessionOpts.conversationId SSOT: a conversationId explicitly injected by
// the caller (cli.ts) must reach ctx.state.conversationId. Both
// processChatLine and persistChatSessionCheckpoint inside the REPL read
// state.conversationId, so they must share one id —— resume must not split into
// "cli.ts sub-agent dir id ≠ REPL id".
//
// runChatSession is a TTY / pipe entry point (integration-heavy) and is not
// called here; instead the contract is pinned at type level and proved
// indirectly through its seeding path (seedResumeMessages): given a
// conversationId, the seed + persist loop writes the checkpoint file of that
// same id and never starts a new UUID.
// ---------------------------------------------------------------------------

describe("review-fix H2 — ChatSessionOpts.conversationId SSOT (resume 时单源)", () => {
  it("给定固定 conversationId + resumeId 同值 → seed / persist 全部落在该 id 文件", async () => {
    const s = await storeFor();
    const fixedId = "fixed-conv-id-1234";
    const seededMessages = [userMsg("q1"), assistantMsg("a1")];
    await s.save({
      id: fixedId,
      file: seededFile({ id: fixedId, messages: seededMessages, turnCount: 1 }),
    });

    // Seed step —— same source as inside runChatSession.
    const seeded = await seedResumeMessages({ store: s, id: fixedId });
    assert.equal(seeded.messages.length, 2);

    // Build a ctx with runChatSession's shape (state.conversationId comes from
    // opts, which is exactly the point of this fix):
    // `opts.conversationId ?? opts.resumeId ?? randomUUID()` → here
    // opts.conversationId === fixedId wins and no new UUID is started.
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["a2"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: {
        conversationId: fixedId,
        messages: Object.freeze([...seeded.messages]),
      },
    });
    const r = await processChatLine({ line: "q2", ctx });
    assert.equal(r.ranQuery, true);
    // Key assertion: the file is still named after fixedId, undrifted by a second
    // randomUUID inside the REPL.
    const file = await s.load(fixedId);
    assert.equal(file.conversation_id, fixedId);
    assert.equal(file.turnCount, 2);
  });

  it("type-level: ChatSessionOpts 接收可选 conversationId (compile-time 契约钉死)", () => {
    // Compile-time contract: the opts shape is writable without importing the
    // actual function body. Type assertion only.
    type Opts = Parameters<
      typeof import("../../src/cli/chat-session.ts").runChatSession
    >[0];
    const opts: Opts = {
      deps: {} as Opts["deps"],
      session: {} as Opts["session"],
      jsonMode: false,
      // Key field —— an additive seam; when absent (ask / legacy test seam) the
      // fallback stays `resumeId ?? randomUUID()`, aligned with byte-stable
      // behaviour.
      conversationId: "explicit-conv-id",
    };
    assert.equal(opts.conversationId, "explicit-conv-id");
  });
});
