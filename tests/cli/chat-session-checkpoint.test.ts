/**
 * Chat REPL checkpoint persistence on interrupt/exit, plus Ctrl+C wiring.
 *
 * Paths covered:
 *   1. empty-messages: turn-0 cancel (no messages) writes no file;
 *   2. MaxTurnsExceeded-at-turn-0 (delta=0) is a no-op, writes no file;
 *   3. resumed-then-cancelled: continuing under the same conversationId then
 *      cancelling accumulates turnCount (checkpoint sequence stays contiguous,
 *      mirroring the hub.ts convention);
 *   4. signal-then-save: abort → run resolves "cancelled" → checkpoint lands on
 *      disk with interruptReason="cancelled";
 *   + happy path: completed persists full messages;
 *   + failure path: write_failed warns and continues, never rethrows;
 *   + boundary: the prior==state.messages reference survives host replacement
 *     after run, so the delta is correct;
 *   + empty/invalid: conversationId=null skips persistence;
 *   + concurrency: repeated commits under one conversationId accumulate in
 *     order;
 *   + close-save visibility: the concurrent_write refusal — the one failure
 *     mode keepHead created — prints a stderr notice even when no opts.warn
 *     is passed; every other kind keeps the pre-existing optional-warn
 *     silence.
 *
 * Reuses the established pattern: processChatLine over a pipe, stub deps, and a
 * SessionStore in an isolated temp dir (never the real ~/.iknow).
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistChatSessionCheckpoint,
  processChatLine,
} from "../../src/cli/chat-session.ts";
import type { ChatLineContext } from "../../src/cli/chat-session.ts";
import {
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import { captureStderrOf } from "../_helpers/capture-stderr.ts";
import type {
  AnthropicNativeMessage,
  LoopEngineDeps,
  RunResult,
} from "../../src/harness/index.ts";
import { SUBAGENT_DRAIN_PREFIX } from "../../src/harness/subagent/host-drain.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";

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

/** Isolated temp-dir store per test; all dirs removed after the suite. */
const tempDirs: string[] = [];
async function storeFor(): Promise<SessionStore> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-cp-"));
  tempDirs.push(tmp);
  return new SessionStore(tmp, process.cwd());
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Minimal RunResult builder (mirrors tests/session-api/store/checkpoint.test.ts). */
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

const warnCollector = (): { warn: (line: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return {
    warn: (line) => lines.push(line),
    lines,
  };
};

// -- persistChatSessionCheckpoint (pure IO helper, tested directly) ----------

describe("persistChatSessionCheckpoint", () => {
  it("cancelled 空 messages(turn-0)→ shouldPersist false → 不写文件", async () => {
    const s = await storeFor();
    const id = "empty-cancelled";
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "cancelled",
        messages: [],
        turnCount: 0,
      }),
      priorMessages: [],
    });
    await assert.rejects(
      () => s.load(id),
      (err: unknown) => (err as { kind?: string }).kind === "not_found"
    );
  });

  it("cancelled 有增量 → 落盘 checkpoint(interruptReason=cancelled, 累计 turnCount)", async () => {
    const s = await storeFor();
    const id = "cancelled-progress";
    const workspaceRoot = process.cwd();
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      // prior=[] and the run yields [user, assistant] (delta>0)
      result: buildResult({
        stopReason: "cancelled",
        messages: [userMsg("q"), assistantMsg("partial")],
        turnCount: 1,
      }),
      priorMessages: [],
      ...({ workspaceRoot } as { readonly workspaceRoot: string }),
    });
    const file = await s.load(id);
    assert.equal(file.turnCount, 1);
    assert.equal(file.checkpoints?.length, 1);
    assert.equal(file.checkpoints?.[0]?.interruptReason, "cancelled");
    assert.equal(file.checkpoints?.[0]?.turnIndex, 1);
    assert.equal(file.checkpoints?.[0]?.messagesCount, 2);
    assert.equal(file.workspaceRoot, workspaceRoot);
    assert.equal(file.cwd, workspaceRoot);
  });

  it("protocolError(delta=user)→ 只落 user 消息;失败的 assistant 不进历史 (spec invariant 8)", async () => {
    // chat and hub share decideCheckpointPersist's partial_user_only branch:
    // after protocolError the user's sentence stays on disk, the failed
    // assistant turn never enters history.
    const s = await storeFor();
    const id = "protocol-partial";
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      // The engine had already encoded the user query before failing (last
      // entry is a dangling user, no assistant).
      result: buildResult({
        stopReason: "protocolError",
        messages: [userMsg("keep my sentence")],
        turnCount: 0,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    const file = await s.load(id);
    assert.equal(file.messages.length, 1);
    assert.equal(file.messages[0]?.role, "user");
    assert.equal(
      file.messages[0]?.content[0]?.type === "text"
        ? file.messages[0].content[0].text
        : "",
      "keep my sentence"
    );
    assert.ok(
      !file.messages.some((m) => m.role === "assistant"),
      "failed assistant turn must not reach disk"
    );
    assert.equal(file.turnCount, 0);
    // The user message is a rewind anchor (the rewind picker consumes
    // checkpoints' interruptedAt; toInterruptReason labels protocolError, so
    // the record is appended).
    assert.deepEqual(
      file.checkpoints?.map((c) => c.interruptReason),
      ["protocolError"]
    );
    assert.equal(file.checkpoints?.[0]?.messagesCount, 1);
  });

  it("protocolError(仅 tool_result delta)→ 不写文件(orphan 不进盘)", async () => {
    // A tool_result-only user message is a continuation, not a query (isTurnQuery
    // SSOT); persisting it alone would leave an orphan with no paired assistant
    // tool_use.
    const s = await storeFor();
    const id = "protocol-tool-result-only";
    const prior = [userMsg("q"), assistantMsg("a")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "protocolError",
        messages: [
          ...prior,
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
            ],
          },
        ],
        turnCount: 0,
      }),
      priorMessages: prior,
      workspaceRoot: process.cwd(),
    });
    await assert.rejects(
      () => s.load(id),
      (err: unknown) => (err as { kind?: string }).kind === "not_found",
      "零 user query 增量 → 不得落盘"
    );
  });

  it("protocolError(delta 混合 query + tool_result-only)→ 只落 query,不落 tool_result 孤儿", async () => {
    // protocolError mid-tool-loop: the delta holds a real user query, the
    // assistant tool_use it triggered, and a tool_result-only continuation.
    // tool_result is a continuation, not a query (isTurnQuery SSOT), and its
    // paired assistant tool_use is dropped on the partial path — persisting it
    // would leave a malformed orphan. A bare role === "user" check would write
    // both; this case pins the divergence.
    const s = await storeFor();
    const id = "protocol-mixed-delta";
    const prior = [userMsg("earlier turn"), assistantMsg("earlier answer")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: prior,
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "protocolError",
        messages: [
          ...prior,
          userMsg("keep my sentence"),
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
            ],
          },
        ],
        turnCount: 0,
      }),
      priorMessages: prior,
    });
    const file = await s.load(id);
    assert.equal(file.messages.length, 3, "prior 2 条 + 本轮 query 1 条");
    assert.equal(file.messages[2]?.role, "user");
    assert.equal(
      file.messages[2]?.content[0]?.type === "text"
        ? file.messages[2].content[0].text
        : "",
      "keep my sentence"
    );
    assert.ok(
      !file.messages.some(
        (m) =>
          m.role === "assistant" && m.content.some((b) => b.type === "tool_use")
      ),
      "本轮失败的 assistant tool_use 不进历史"
    );
    assert.ok(
      !file.messages.some((m) =>
        m.content.some((b) => b.type === "tool_result")
      ),
      "tool_result-only 续跑消息不得作为孤儿进盘"
    );
  });

  it("protocolError(delta 末尾是 drain 摘要)→ 无 query 增量 → 不写文件", async () => {
    // The subagent drain summary is also an SSOT-excluded user message (host
    // injected, not a user query). When it is the whole delta there is no query
    // increment, so nothing is written.
    const s = await storeFor();
    const id = "protocol-drain-only";
    const prior = [userMsg("q"), assistantMsg("a")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "protocolError",
        messages: [
          ...prior,
          userMsg(`${SUBAGENT_DRAIN_PREFIX}worker-1\n\ndone`),
        ],
        turnCount: 0,
      }),
      priorMessages: prior,
    });
    await assert.rejects(
      () => s.load(id),
      (err: unknown) => (err as { kind?: string }).kind === "not_found",
      "drain 摘要不是 query,不得触发落盘"
    );
  });

  it("partial 落盘保留盘上既有历史(不与 delta 拼接丢失)", async () => {
    const s = await storeFor();
    const id = "protocol-partial-append";
    const first = [userMsg("q1"), assistantMsg("a1")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: first,
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "emptyFinalResponse",
        messages: [...first, userMsg("q2")],
        turnCount: 0,
      }),
      priorMessages: first,
    });
    const file = await s.load(id);
    assert.equal(file.messages.length, 3);
    assert.equal(file.messages[2]?.role, "user");
    assert.equal(file.turnCount, 1, "失败回合不增 turnCount");
  });

  it("completed → 落盘但无 checkpoint 记录(interruptReason=null 不 append)", async () => {
    const s = await storeFor();
    const id = "completed-plain";
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: true,
      result: buildResult({
        stopReason: "completed",
        messages: [userMsg("q"), assistantMsg("a")],
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    const file = await s.load(id);
    assert.equal(file.jsonMode, true);
    assert.equal(file.turnCount, 1);
    assert.deepEqual(file.checkpoints, []);
  });

  it("fresh completed without workspaceRoot → refuse bootstrap and warn", async () => {
    const s = await storeFor();
    const collector = warnCollector();
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: "rootless-completed",
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [userMsg("q"), assistantMsg("a")],
        turnCount: 1,
      }),
      priorMessages: [],
      warn: collector.warn,
    });
    assert.deepEqual(await s.list(), []);
    assert.equal(collector.lines.length, 1);
    assert.match(collector.lines[0]!, /workspace root is required/);
  });

  it("resumed-then-cancelled: 同 conversationId 二次写 → turnIndex 从既有累计(镜像 hub 约定)", async () => {
    const s = await storeFor();
    const id = "resumed-cancelled";
    // Round 1 completed: on disk turnCount=1, messages=[user q1, assistant a1].
    const first = [userMsg("q1"), assistantMsg("a1")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: first,
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    let file = await s.load(id);
    assert.equal(file.turnCount, 1);

    // Round 2 cancelled: prior=first, the run appends [user q2] (delta>0) → a
    // checkpoint is written.
    const second = [...first, userMsg("q2")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "cancelled",
        messages: second,
        turnCount: 0,
      }),
      priorMessages: first,
    });
    file = await s.load(id);
    assert.equal(file.turnCount, 1, "cancelled 不完成回合,不增 turnCount");
    assert.equal(file.messages.length, 3);
    // Cumulative turnIndex = session.turnCount(1) + result.turnCount(0) = 1.
    assert.equal(file.checkpoints?.length, 1);
    assert.equal(file.checkpoints?.[0]?.interruptReason, "cancelled");
    assert.equal(file.checkpoints?.[0]?.turnIndex, 1);
    assert.equal(file.checkpoints?.[0]?.messagesCount, 3);
  });

  it("重复提交(同 conversationId 两轮 completed)→ turnCount 顺序累计", async () => {
    const s = await storeFor();
    const id = "repeat-commit";
    const t1 = [userMsg("q1"), assistantMsg("a1")];
    const t2 = [...t1, userMsg("q2"), assistantMsg("a2")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: t1,
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: t2,
        turnCount: 1,
      }),
      priorMessages: t1,
    });
    const file = await s.load(id);
    assert.equal(file.turnCount, 2);
    assert.equal(file.messages.length, 4);
  });

  it("write_failed → warn+continue,绝不重抛(REPL 不 crash)", async () => {
    // The store's baseDir is "a file", so save's mkdir must fail → write_failed.
    const blocker = await mkdtemp(join(tmpdir(), "iknow-chat-cp-block-"));
    tempDirs.push(blocker);
    const blockerPath = join(blocker, "blocker");
    await writeFile(blockerPath, "x", "utf8");
    const bad = new SessionStore(blockerPath, process.cwd());
    const collector = warnCollector();
    await persistChatSessionCheckpoint({
      store: bad,
      conversationId: "write-fail",
      jsonMode: false,
      result: buildResult({
        stopReason: "cancelled",
        messages: [userMsg("q"), assistantMsg("partial")],
        turnCount: 1,
      }),
      priorMessages: [],
      warn: collector.warn,
      workspaceRoot: process.cwd(),
    });
    assert.equal(collector.lines.length, 1, "必须 emit 一条 warn");
    assert.match(collector.lines[0]!, /write_failed/);
  });

  it("既有文件损坏(parse_failed)→ 静默重建为新 v3 文件,本次 turn 仍可落盘", async () => {
    // An unreadable file must not block this turn's write (it is not a
    // user-caught error, and warning would make it noisy on every turn) — the
    // reconstruct → save path succeeds silently.
    const tmp = await mkdtemp(join(tmpdir(), "iknow-chat-cp-corrupt-"));
    tempDirs.push(tmp);
    const s = new SessionStore(tmp, process.cwd());
    const id = "corrupt-existing";
    const dir = resolveProjectSessionDir(tmp, process.cwd());
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), "{garbage", "utf8");
    const collector = warnCollector();
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [userMsg("q"), assistantMsg("a")],
        turnCount: 1,
      }),
      priorMessages: [],
      warn: collector.warn,
      workspaceRoot: process.cwd(),
    });
    assert.equal(collector.lines.length, 0, "load 错误走静默重建,不发 warn");
    // This turn overwrote the file successfully.
    const file = await s.load(id);
    assert.equal(file.turnCount, 1);
    assert.equal(file.messages.length, 2);
    assert.deepEqual(file.checkpoints, []);
  });
});

// -- processChatLine integration: conversationId=null skips, completed writes --

describe("processChatLine checkpoint 落盘接线", () => {
  it("conversationId=null(缺省)→ 不写文件(零变化路径)", async () => {
    const s = await storeFor();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["a"] })],
      checkpointStore: s,
      stateOverrides: { conversationId: null },
    });
    await processChatLine({ line: "q", ctx });
    assert.equal(ctx.state.messages.length, 2);
    assert.deepEqual(
      await s.list(),
      [],
      "conversationId=null 时不得写任何会话文件"
    );
  });

  it("completed 经 processChatLine → 文件落盘,checkpoints 为空", async () => {
    const s = await storeFor();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["answer"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: { conversationId: "pcl-completed" },
    });
    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.ranQuery, true);
    const file = await s.load("pcl-completed");
    assert.equal(file.turnCount, 1);
    assert.equal(file.messages.length, 2);
    assert.deepEqual(file.checkpoints, []);
  });

  it("cancelled(delta>0)→ checkpoint 落盘 interruptReason=cancelled", async () => {
    const s = await storeFor();
    // delayMs ensures the abort lands while the model is still in flight.
    const controller = new AbortController();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["never"] })],
      checkpointStore: s,
      abortController: controller,
      workspaceRoot: process.cwd(),
      delayMs: 100,
      stateOverrides: { conversationId: "pcl-cancelled" },
    });
    const pending = processChatLine({ line: "q", ctx });
    controller.abort();
    const r = await pending;
    assert.equal(r.ranQuery, true);
    // cancelled does not append the assistant turn (the whole round stays out of
    // history) → messages hold the seed user plus the transcript-appended system
    // interruption message.
    assert.equal(ctx.state.messages.length, 2);
    assert.equal(ctx.state.messages[1]!.role, "system");
    const file = await s.load("pcl-cancelled");
    assert.equal(file.turnCount, 0);
    assert.equal(file.checkpoints?.length, 1);
    assert.equal(file.checkpoints?.[0]?.interruptReason, "cancelled");
    assert.equal(file.checkpoints?.[0]?.messagesCount, 2);
  });

  it("MaxTurnsExceeded-at-turn-0 → delta=0 → 不写文件(#120 裁决 + ACR)", async () => {
    const s = await storeFor();
    // maxTurns=1 with a tool-call in round 1: the round-2 step entry throws
    // MaxTurnsExceeded, run() never resolves → no turnCount/messages → the catch
    // branch writes nothing.
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
        }),
        assistantResult({ texts: ["收尾摘要"] }),
      ],
    });
    const deps: LoopEngineDeps = { adapter, executor, registry, maxTurns: 1 };
    const ctx = {
      deps,
      state: {
        messages: Object.freeze([]) as ReadonlyArray<AnthropicNativeMessage>,
        jsonMode: false,
        session: {},
        conversationId: "pcl-max-turns",
      },
      checkpointStore: s,
    };
    const r = await processChatLine({ line: "do it", ctx });
    assert.equal(r.ranQuery, true);
    assert.match(r.stderr ?? "", /已达 maxTurns=1 轮上限/);
    await assert.rejects(
      () => s.load("pcl-max-turns"),
      (err: unknown) => (err as { kind?: string }).kind === "not_found",
      "MaxTurnsExceeded 抛出路径不得写空文件"
    );
  });
});

// -- full-arm close vs. the persisted head chain -----------------------------

/** One session's JSONL path, taken from the store's own resolved project root. */
const sessionJsonl = (s: SessionStore, id: string): string =>
  join(
    resolveConversationDir({
      projectDir: s.getProjectDir(),
      conversationId: id,
    }),
    `${id}${SESSION_JSONL_EXT}`
  );

describe("persistChatSessionCheckpoint full-arm close vs. the persisted head chain", () => {
  it("fresh full-arm close bootstraps the JSONL and lands the head on the projection tip", async () => {
    const s = await storeFor();
    const id = "head-full-fresh";
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: [userMsg("q1"), assistantMsg("a1")],
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    assert.equal(await s.readHead(id), "e1");
    const file = await s.load(id);
    assert.deepEqual(
      file.messages.map((m) => m.role),
      ["user", "assistant"]
    );
  });

  it("full-arm close whose projection is ahead of the chain moves the head forward", async () => {
    const s = await storeFor();
    const id = "head-full-extension";
    const first = [userMsg("q1"), assistantMsg("a1")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: first,
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    // Mid-run commit of the next turn's query, then the close carries the whole
    // history plus that turn's reply: an extension of the persisted chain.
    const second = [...first, userMsg("q2"), assistantMsg("a2")];
    await s.appendEvents({ id, events: [userMsg("q2")] });
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "cancelled",
        messages: second,
        turnCount: 0,
      }),
      priorMessages: first,
      workspaceRoot: process.cwd(),
    });
    assert.equal(await s.readHead(id), "e3");
    const file = await s.load(id);
    assert.equal(file.messages.length, 4);
    assert.equal(
      file.turnCount,
      1,
      "a cancelled turn does not complete a turn"
    );
    assert.equal(file.checkpoints?.length, 1);
  });

  it("full-arm close whose projection fell behind the chain leaves the head and the file untouched", async () => {
    const s = await storeFor();
    const id = "head-full-behind-chain";
    const first = [userMsg("q1"), assistantMsg("a1")];
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "completed",
        messages: first,
        turnCount: 1,
      }),
      priorMessages: [],
      workspaceRoot: process.cwd(),
    });
    // A second writer on this conversation id commits a full turn while the run
    // being closed here is in flight, so the chain grows past its projection.
    await s.appendEvents({
      id,
      events: [userMsg("q2"), assistantMsg("a2")],
    });
    const headBefore = await s.readHead(id);
    const bytesBefore = await readFile(sessionJsonl(s, id), "utf8");
    assert.equal(headBefore, "e3", "the other writer grew the head chain");

    // The close carries the history as of turn start (prior=[q1], result adds the
    // reply): delta > 0 so the decision is "full", and the projection it writes
    // is a strict prefix of the chain on disk.
    const collector = warnCollector();
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      result: buildResult({
        stopReason: "cancelled",
        messages: first,
        turnCount: 0,
      }),
      priorMessages: [userMsg("q1")],
      warn: collector.warn,
      workspaceRoot: process.cwd(),
    });

    assert.equal(
      await s.readHead(id),
      headBefore,
      "a closing save never moves the persisted head backward"
    );
    assert.equal(
      await readFile(sessionJsonl(s, id), "utf8"),
      bytesBefore,
      "a refused close writes no bytes"
    );
    assert.deepEqual(
      (await s.load(id)).messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"],
      "the commits the projection fell behind stay on the head chain"
    );
    assert.equal(collector.lines.length, 1);
    assert.match(collector.lines[0]!, /concurrent_write/);
  });
});

// -- close-save failure visibility at the chat entries -----------------------

/**
 * The `keepHead` declaration gave the chat close exactly ONE new failure
 * mode: the store's `concurrent_write` refusal. Only that kind is surfaced —
 * `persistChatSessionCheckpoint` itself prints it through the module's
 * `writeErr` operator sink (the same one the resume path uses for operator
 * notices), so a refused checkpoint write cannot vanish in silence at ANY
 * entry without the entries opting a `warn` in. Every other kind keeps the
 * pre-existing optional-`opts.warn` behavior: no `warn`, no line.
 *
 * The rewind shape pinned here: a second real writer commits on the same
 * conversation id while the closing turn's model step is in flight, so the
 * wholesale projection the close carries is behind that commit. `keepHead`
 * refuses it; the head chain keeps the other writer's commits.
 */

/** One chat turn's result — the entries below also report on stderr, so their
 *  return value is captured alongside it (nothing here mocks the sink). */
type ChatTurnResult = Awaited<ReturnType<typeof processChatLine>>;

/** File bytes + head, as of one commit. */
type ChainCommit = { head: string | null; bytes: string };

/**
 * Grow the head chain from a second writer inside this turn's first model step
 * (the real window, before the close), then record the file as it stood right
 * after that commit.
 */
function commitDuringStep(opts: {
  readonly ctx: ChatLineContext;
  readonly store: SessionStore;
  readonly id: string;
  readonly events: ReadonlyArray<AnthropicNativeMessage>;
  readonly commit: ChainCommit;
}): void {
  const { ctx, store, id, commit } = opts;
  const base = ctx.deps.adapter;
  let fired = false;
  ctx.deps = {
    ...ctx.deps,
    adapter: {
      ...base,
      step: async (state, request, signal) => {
        if (!fired) {
          fired = true;
          await store.appendEvents({ id, events: [...opts.events] });
          commit.head = await store.readHead(id);
          commit.bytes = await readFile(sessionJsonl(store, id), "utf8");
        }
        return base.step(state, request, signal);
      },
    },
  };
}

describe("chat close-save 失败可见性（仅并发拒绝进 stderr）", () => {
  it("/continue close 被并发拒绝 → 恰好一条点名 kind 的 stderr 提示，链表与盘一字节不动", async () => {
    const s = await storeFor();
    const id = "prod-close-concurrent";
    // An empty final response lands only the query (partial_user_only), which
    // is exactly the transcript that makes `/continue` pending.
    await processChatLine({
      line: "q1",
      ctx: makeCtx({
        responses: [assistantResult({ texts: [] })],
        checkpointStore: s,
        workspaceRoot: process.cwd(),
        stateOverrides: { conversationId: id },
      }),
    });
    assert.equal(await s.readHead(id), "e0");

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["a1"] })],
      checkpointStore: s,
      workspaceRoot: process.cwd(),
      stateOverrides: { conversationId: id },
    });
    const commit: ChainCommit = { head: null, bytes: "" };
    commitDuringStep({
      ctx,
      store: s,
      id,
      events: [assistantMsg("a1"), userMsg("q2")],
      commit,
    });
    // Disk as the refused close finds it: the other writer's commits, and the
    // turn-1 state fields the refused close must not advance.
    const before = await s.load(id);
    let r: ChatTurnResult | undefined;
    const stderr = await captureStderrOf(async () => {
      r = await processChatLine({ line: "/continue", ctx });
    });

    assert.equal(r!.ranQuery, true, "被拒绝的 close 不打断 /continue");
    assert.match(
      stderr,
      /会话检查点写入失败 \[concurrent_write\]/,
      "并发拒绝必须点名 typed kind 进 stderr"
    );
    assert.equal(
      stderr.match(/会话检查点写入失败/g)?.length,
      1,
      "一次被拒的 close 只发一条提示"
    );
    // Rendering pin: the refusal is a typed PLAIN object (never an Error) —
    // dumping it would print `[object Object]` in the operator notice.
    assert.doesNotMatch(stderr, /\[object Object\]/, "提示不得倾倒对象");
    assert.equal(commit.head, "e2", "the other writer did grow the chain");
    assert.equal(
      await s.readHead(id),
      commit.head,
      "另一个 writer 的 head 不被回退"
    );
    assert.equal(
      await readFile(sessionJsonl(s, id), "utf8"),
      commit.bytes,
      "被拒绝的 close 一个字节都不写"
    );
    const file = await s.load(id);
    assert.equal(
      file.turnCount,
      before.turnCount,
      "被拒绝的 turn 不推进盘上 turnCount"
    );
    assert.deepEqual(
      file.checkpoints,
      before.checkpoints,
      "被拒绝的 turn 的 checkpoint 不落盘"
    );
  });

  it("非 concurrent_write 的 close 失败不新增 stderr（钉住既有静默）", async () => {
    // Rootless-bootstrap ValidationError driven through the real chat entry:
    // no ctx.workspaceRoot, so the bootstrap inside the save throws before any
    // write. The chat entries pass no `warn`, so this kind must stay fully
    // silent — the shape chat-session-rebind relies on for its own turn.
    const s = await storeFor();
    const rootlessCtx = makeCtx({
      responses: [assistantResult({ texts: ["a1"] })],
      checkpointStore: s,
      stateOverrides: { conversationId: "close-silent-rootless" },
    });
    const rootlessStderr = await captureStderrOf(async () => {
      await processChatLine({ line: "q", ctx: rootlessCtx });
    });
    assert.equal(
      rootlessStderr,
      "",
      "rootless 失败不是并发拒绝：stderr 必须保持全静默"
    );
    assert.deepEqual(await s.list(), [], "bootstrap 未成功时不得落任何文件");

    // write_failed from the save itself, through the same catch with no
    // `warn`: the store's baseDir is a file, so save's mkdir must fail (the
    // blocker shape the direct-helper write_failed case already uses).
    const blocker = await mkdtemp(join(tmpdir(), "iknow-chat-cp-vis-block-"));
    tempDirs.push(blocker);
    const blockerPath = join(blocker, "blocker");
    await writeFile(blockerPath, "x", "utf8");
    const bad = new SessionStore(blockerPath, process.cwd());
    const saveStderr = await captureStderrOf(async () => {
      await persistChatSessionCheckpoint({
        store: bad,
        conversationId: "close-silent-write-failed",
        jsonMode: false,
        result: buildResult({
          stopReason: "cancelled",
          messages: [userMsg("q"), assistantMsg("partial")],
          turnCount: 1,
        }),
        priorMessages: [],
        workspaceRoot: process.cwd(),
      });
    });
    assert.equal(
      saveStderr,
      "",
      "write_failed 无 warn 时不得新增 stderr（仅并发拒绝可见）"
    );
  });
});
