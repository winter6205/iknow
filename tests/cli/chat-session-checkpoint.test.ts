/**
 * T2: chat REPL 会话中断/退出 checkpoint 落盘 + Ctrl+C 信号接线。
 *
 * 覆盖(ACR 要求 4 条 + #222 六类路径):
 *   1. empty-messages:turn-0 cancelled(空 messages)→ 不写文件;
 *   2. MaxTurnsExceeded-at-turn-0(delta=0)→ no-op,不写文件;
 *   3. resumed-then-cancelled:同 conversationId 续跑再 cancelled → 累计
 *      turnCount 断言(checkpoint 序列可连续,镜像 hub.ts:739 约定);
 *   4. signal-then-save:abort → run resolve "cancelled" → checkpoint 落盘,
 *      文件含 interruptReason="cancelled";
 *   + 正常路径:completed 落盘含完整 messages;
 *   + 失败路径:write_failed → warn+continue 不重抛;
 *   + 边界:prior==state.messages 引用不受 run 后 host 替换影响(delta 正确);
 *   + 空/非法:conversationId=null → 跳过持久化;
 *   + 并发/重复:重复 commit(同 conversationId 两轮 completed)→ 顺序累计。
 *
 * 复用既有测试模式:processChatLine(pipe 模拟)+ stub deps + 隔离 temp dir
 * SessionStore(绝不写真实 ~/.iknow)。
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

// -- persistChatSessionCheckpoint (纯 IO helper, 直测) -----------------------

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
      // prior=[] run 产生 [user, assistant] (delta>0)
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
    // chat 与 hub 共用 decideCheckpointPersist 的 partial_user_only 分支:
    // protocolError 后用户那句话留在盘上,失败的 assistant 不进历史。
    const s = await storeFor();
    const id = "protocol-partial";
    await persistChatSessionCheckpoint({
      store: s,
      conversationId: id,
      jsonMode: false,
      // 引擎在失败前已编码 user query(末条是 dangling user,无 assistant)。
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
    // 该 user 消息是可回退锚点(rewind picker 消费 checkpoints 的 interruptedAt;
    // toInterruptReason 对 protocolError 有 label,故记录被 append)。
    assert.deepEqual(
      file.checkpoints?.map((c) => c.interruptReason),
      ["protocolError"]
    );
    assert.equal(file.checkpoints?.[0]?.messagesCount, 1);
  });

  it("protocolError(仅 tool_result delta)→ 不写文件(orphan 不进盘)", async () => {
    // tool_result-only user 消息是续跑不是 query(isTurnQuery SSOT);单独落盘
    // 会留下无 assistant tool_use 配对的孤儿。
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
    // mid-tool-loop 的 protocolError:delta 同时含真 user query、它触发的
    // assistant tool_use、以及只带 tool_result 的续跑 user 消息。tool_result
    // 是 continuation 不是 query(isTurnQuery SSOT),其配对的 assistant
    // tool_use 在 partial 路径被丢弃 —— 落盘它会留下畸形孤儿。role === "user"
    // 裸判会把它一起写盘,本用例钉住两者分歧。
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
    // subagent drain 摘要也是 SSOT 排除的 user 消息(host 注入,不是用户
    // query)。整个 delta 只有它 → 零 query 增量 → 不落盘。
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
    // 第一轮 completed:盘上 turnCount=1, messages=[user q1, assistant a1]。
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

    // 第二轮 cancelled:prior=first,run 追加 [user q2](delta>0)→ 落 checkpoint。
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
    // 累计 turnIndex = session.turnCount(1) + result.turnCount(0) = 1。
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
    // store 的 baseDir 是「一个文件」→ save 的 mkdir 必然失败 → write_failed。
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
    // 不可用文件不应阻断本次 turn 落盘(非用户主动错误,即便 warn 也会让后续
    // 每次 turn 都触发噪声)—— 走 reconstruct → save 路径,无声成功。
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
    // 文件已被本 turn 成功覆盖。
    const file = await s.load(id);
    assert.equal(file.turnCount, 1);
    assert.equal(file.messages.length, 2);
    assert.deepEqual(file.checkpoints, []);
  });
});

// -- processChatLine 集成:conversationId=null 跳过 + completed 落盘 ----------

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
    // delayMs 保证 model in-flight 时 abort 生效(S12 语义)。
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
    // cancelled 不 append assistant(整回合不进历史)→ messages 含 seed user +
    // #392 T4 system 中断消息 transcript 追加。
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
    // maxTurns=1 + 第一轮 tool-call:第 2 轮 step 入口 throw MaxTurnsExceeded,
    // run() 不 resolve → 不产生 turnCount/messages → catch 分支不落盘。
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
