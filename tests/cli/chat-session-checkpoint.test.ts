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
 *     order.
 *
 * Reuses the established pattern: processChatLine over a pipe, stub deps, and a
 * SessionStore in an isolated temp dir (never the real ~/.iknow).
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistChatSessionCheckpoint,
  processChatLine,
} from "../../src/cli/chat-session.ts";
import {
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
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
