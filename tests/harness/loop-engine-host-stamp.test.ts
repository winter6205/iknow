/**
 * ADR-0112 T2 — 宿主注入 commit 盖戳。
 *
 * 本套件钉住的不变式（SSOT: specs/instruction-authority-projection.md
 * invariant 2 + ADR-0112 Decision 1）：
 *   - loop-engine 全部宿主注入 commit 缝（agent_status 栏 / graph 切换与
 *     现势 / MCP 重连 / skill 索引增量 / LOOP_DETECTED envelope / compact
 *     请求 / 收尾摘要 prompt）写进 LoopState 的 user 消息携带非模型可见的
 *     `hostInjected` 出处戳；
 *   - 操作员首轮文本与 assistant 回合不盖戳（operator 通道 out of scope，
 *     无戳 user 文本由出站投影按 invariant 3 转译）；
 *   - 权威历史不落转译：戳只是出处标记，消息正文原样（盘上可脏）；
 *   - 戳随 pendingInjected → commitMessages → store JSONL 链存活
 *     （resume 后同一历史仍出同一 wire 前缀，KV 稳定）；
 *   - `agentStatusFromMessages` 读盘上原文解析照常（转译只发生在 wire）。
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/harness/loop-engine.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import {
  COMPACT_SUMMARY_INJECTION_PREFIX,
  isHostInjectedUserText,
} from "../../src/harness/agent-status-instruction.ts";
import { agentStatusFromMessages } from "../../src/harness/agent-status.ts";
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.ts";
import { buildCompactPrompt } from "../../src/harness/compress/full-compact.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { createGraphAssembly } from "../../src/harness/graph/assembly.ts";
import type { GraphModeContext } from "../../src/harness/graph/mode.ts";
import { makeTodoDir } from "./_agent-status-fixtures.ts";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- helpers -------------------------------------------------------------------

function userText(m: AnthropicNativeMessage): string {
  return m.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** 文本回合 stub adapter，记录每次 step 收到的 state.messages。 */
function recordingTextAdapter(responses: string[]) {
  const steps: Array<ReadonlyArray<AnthropicNativeMessage>> = [];
  let call = 0;
  const adapter = {
    steps,
    encodeUserText: (text: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text }],
    }),
    encodeToolResults: () => [],
    step: async (state: LoopState): Promise<AssistantTurnResult> => {
      steps.push(state.messages);
      const text = responses[Math.min(call, responses.length - 1)] ?? "done";
      call += 1;
      const native: AnthropicNativeMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
      };
      return {
        nativeMessage: native,
        projection: { nativeMessage: native, texts: [text], toolCalls: [] },
        supplierStop: "success",
        needsTools: false,
        isEmptyFinalResponse: false,
      };
    },
  };
  return adapter;
}

const emptyExecutor = Object.freeze({ executeAll: async () => [] });
const emptyRegistry = Object.freeze({
  list: () => [],
  get: () => undefined,
});

function makeGraphAssembly(enabled: boolean) {
  const ctx = { get: () => ({ enabled }) } as unknown as GraphModeContext;
  const assembly = createGraphAssembly(ctx);
  assembly.beginRound();
  return assembly;
}

/** 找出含给定标记文本的 user 消息（返回消息对象以便断言戳）。 */
function findUserMessage(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  marker: string
): AnthropicNativeMessage | undefined {
  return messages.find(
    (m) => m.role === "user" && userText(m).includes(marker)
  );
}

// -- 1. 各宿主注入缝盖戳 ----------------------------------------------------------

describe("host commit stamping: every injected seam carries hostInjected", () => {
  it("agent_status 栏盖戳；操作员 query 与 assistant 回合不盖戳；正文不被改写", async () => {
    const todoDir = await makeTodoDir("- [ ] [t1] planted\n");
    const adapter = recordingTextAdapter(["a1", "a2"]);
    const { result } = await run("go", {
      adapter,
      executor: emptyExecutor as never,
      registry: emptyRegistry as never,
      maxTurns: 5,
      agentStatus: { todoDir },
    });
    const bar = findUserMessage(result.messages, "<agent_status>");
    assert.ok(bar, "栏消息存在");
    assert.equal(bar.hostInjected, true);
    // 正文原样：权威历史不预转译（转译只发生在 wire）。
    assert.ok(userText(bar).startsWith("<agent_status>"));
    // 首条 = 操作员 query：不盖戳。
    const query = result.messages[0]!;
    assert.equal(query.role, "user");
    assert.equal(query.hostInjected, undefined);
    // assistant 回合无戳。
    for (const m of result.messages.filter((x) => x.role === "assistant")) {
      assert.equal(m.hostInjected, undefined);
    }
  });

  it("MCP 重连通知盖戳", async () => {
    const adapter = recordingTextAdapter(["a1"]);
    const { result } = await run("go", {
      adapter,
      executor: emptyExecutor as never,
      registry: emptyRegistry as never,
      maxTurns: 5,
      mcpReconnect: {
        takePending: () => [{ server: "github", tools: ["create_pr"] }],
      },
    });
    const msg = findUserMessage(result.messages, "MCP server 'github'");
    assert.ok(msg);
    assert.equal(msg.hostInjected, true);
  });

  it("graph 切换提示与短现势盖戳", async () => {
    const adapter = recordingTextAdapter(["a1"]);
    const lastSeenEnabled: { value: boolean | undefined } = { value: false };
    const { result } = await run("go", {
      adapter,
      executor: emptyExecutor as never,
      registry: emptyRegistry as never,
      maxTurns: 5,
      graphModeChange: {
        assembly: makeGraphAssembly(true),
        lastSeenEnabled,
      },
    });
    const msg = findUserMessage(result.messages, "<graph_mode>");
    assert.ok(msg, "翻转 on 应追加切换提示");
    assert.equal(msg.hostInjected, true);

    const adapter2 = recordingTextAdapter(["a1"]);
    const assembly2 = makeGraphAssembly(true);
    const { result: r2 } = await run("go", {
      adapter: adapter2,
      executor: emptyExecutor as never,
      registry: emptyRegistry as never,
      maxTurns: 5,
      graphModeChange: {
        assembly: assembly2,
        lastSeenEnabled: { value: true },
      },
      graphModePresence: {
        assembly: assembly2,
        appendedThisRun: { value: false },
      },
    });
    const presence = findUserMessage(r2.messages, "<graph_mode>");
    assert.ok(presence, "presence 短现势应追加");
    assert.equal(presence.hostInjected, true);
  });

  it("skill 索引增量盖戳", async () => {
    const adapter = recordingTextAdapter(["a1"]);
    const { result } = await run("go", {
      adapter,
      executor: emptyExecutor as never,
      registry: emptyRegistry as never,
      maxTurns: 5,
      skillIndexDelta: {
        delta: async () => ({
          added: ["new-skill"],
          text: "<available_skills>\n- new-skill: demo\n</available_skills>",
        }),
      },
    });
    const msg = findUserMessage(result.messages, "<available_skills>");
    assert.ok(msg);
    assert.equal(msg.hostInjected, true);
  });

  it("LOOP_DETECTED envelope 盖戳（fused 停因）", async () => {
    const boom = createStubTool({
      name: "boom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      next: () => {
        throw new Error("same boom");
      },
    });
    const registry = createRegistry([boom]);
    const responses: AssistantTurnResult[] = [];
    for (let i = 0; i < 8; i += 1) {
      responses.push(
        assistantResult({
          texts: [],
          toolCalls: [{ id: `c${i}`, name: "boom", input: { n: 1 } }],
        })
      );
    }
    const { result } = await run("go", {
      adapter: createStubModel({ responses }),
      executor: createExecutor(registry),
      registry,
      maxTurns: 20,
    });
    assert.equal(result.stopReason, "fused");
    const msg = findUserMessage(result.messages, "LOOP_DETECTED:");
    assert.ok(msg);
    assert.equal(msg.hostInjected, true);
    assert.equal(userText(msg), LOOP_DETECTED_TEXT);
  });

  it("compact 请求（reactive PromptTooLong → runFullCompact）盖戳", async () => {
    const adapter = recordingTextAdapter(["after compact"]);
    let firstCall = true;
    const flakyAdapter = {
      ...adapter,
      step: async (
        state: LoopState,
        _request: { readonly tools?: unknown },
        _signal?: AbortSignal
      ): Promise<AssistantTurnResult> => {
        adapter.steps.push(state.messages);
        if (firstCall) {
          firstCall = false;
          const { PromptTooLongError } =
            await import("../../src/harness/errors.ts");
          throw new PromptTooLongError("synthetic 400 prompt-too-long");
        }
        const text = "after compact";
        const native: AnthropicNativeMessage = {
          role: "assistant",
          content: [{ type: "text", text }],
        };
        return {
          nativeMessage: native,
          projection: { nativeMessage: native, texts: [text], toolCalls: [] },
          supplierStop: "success",
          needsTools: false,
          isEmptyFinalResponse: false,
        };
      },
    };
    const longPrior: AnthropicNativeMessage[] = Array.from(
      { length: 12 },
      (_, i) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `prior-${i}` }],
      })
    );
    const { result } = await run(
      "Q",
      {
        adapter: flakyAdapter as never,
        executor: emptyExecutor as never,
        registry: emptyRegistry as never,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // runFullCompact 摘要步（request.tools 缺席的那次 step）的 state 末条 =
    // compact 请求 prompt，带戳。
    const compactStep = adapter.steps.find(
      (msgs) =>
        userText(msgs[msgs.length - 1] ?? { role: "assistant", content: [] })
          .length > 0 &&
        msgs.some((m) =>
          userText(m).startsWith(buildCompactPrompt().slice(0, 20))
        )
    );
    assert.ok(compactStep, "应观察到携带 compact 请求 prompt 的摘要步");
    const promptMsg = compactStep[compactStep.length - 1]!;
    assert.equal(userText(promptMsg), buildCompactPrompt());
    assert.equal(promptMsg.hostInjected, true);
    // spec Does #1 / invariant 2:compact 续传摘要同样落盘为宿主 commit，
    // 必须带戳（否则出站时 COMPACT_SUMMARY 官方前缀被自家转译剥掉）。
    const summary = findUserMessage(
      result.messages,
      COMPACT_SUMMARY_INJECTION_PREFIX
    );
    assert.ok(summary, "summarized 分支应 commit 续传摘要 user 消息");
    assert.equal(summary.hostInjected, true);
  });

  it("收尾摘要 SUMMARY_PROMPT 盖戳（protocolError epilogue）", async () => {
    const adapter = recordingTextAdapter([]);
    let calls = 0;
    const deps: LoopEngineDeps = {
      adapter: {
        ...adapter,
        step: async (state: LoopState): Promise<AssistantTurnResult> => {
          adapter.steps.push(state.messages);
          calls += 1;
          if (calls === 1) {
            const { ProtocolError } =
              await import("../../src/harness/errors.ts");
            throw new ProtocolError("synthetic protocol break");
          }
          const text = "epilogue summary";
          const native: AnthropicNativeMessage = {
            role: "assistant",
            content: [{ type: "text", text }],
          };
          return {
            nativeMessage: native,
            projection: { nativeMessage: native, texts: [text], toolCalls: [] },
            supplierStop: "success",
            needsTools: false,
            isEmptyFinalResponse: false,
          };
        },
      } as never,
      executor: emptyExecutor as never,
      registry: emptyRegistry as never,
      maxTurns: 5,
    };
    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "protocolError");
    const summaryStep = adapter.steps.find(
      (msgs) =>
        msgs.length > 0 &&
        userText(msgs[msgs.length - 1]!).startsWith(
          "Briefly summarize in a few sentences"
        )
    );
    assert.ok(summaryStep, "应观察到收尾摘要步");
    assert.equal(
      summaryStep[summaryStep.length - 1]!.hostInjected,
      true,
      "SUMMARY_PROMPT 是宿主注入，必须盖戳"
    );
  });
});

// -- 2. 戳随落盘链存活；解析面读原文 ----------------------------------------------

describe("stamp survives persistence and does not leak into parsing semantics", () => {
  it("commit → store JSONL → load：戳在盘上保留，agentStatusFromMessages 解析照常", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-host-stamp-"));
    tempDirs.push(tmp);
    const store = new SessionStore(tmp, process.cwd());
    const id = "stamp-roundtrip";
    const workspaceRoot = process.cwd();
    const emptyFile: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: new Date().toISOString(),
      title: "",
      cwd: workspaceRoot,
      sanitized_at: new Date().toISOString(),
      checkpoints: [],
      workspaceRoot,
    };
    await store.save({ id, file: emptyFile });

    const todoDir = await makeTodoDir("- [ ] [t1] planted\n");
    const adapter = recordingTextAdapter(["a1"]);
    const { result } = await run("go", {
      adapter,
      executor: emptyExecutor as never,
      registry: emptyRegistry as never,
      maxTurns: 5,
      agentStatus: { todoDir },
      commitMessages: async (messages) => {
        await store.appendEvents({ id, events: messages });
      },
    });
    await store.save({
      id,
      file: {
        ...emptyFile,
        messages: result.messages,
        turnCount: result.turnCount,
      },
    });
    const loaded = await store.load(id);
    // 盘上原文（未转译）仍被 isHostInjectedUserText 认出：
    const barOnDisk = loaded.messages.find((m) =>
      userText(m).startsWith("<agent_status>")
    );
    assert.ok(barOnDisk, "栏消息在盘上");
    assert.equal(isHostInjectedUserText(userText(barOnDisk)), true);
    // 戳随 JSONL 链存活（resume 后同一历史出同一 wire 前缀）：
    assert.equal(barOnDisk.hostInjected, true);
    // 解析面读盘上原文不受投影影响（invariant 2 的展示侧不回归）：
    const snapshot = agentStatusFromMessages(loaded.messages);
    assert.equal(snapshot?.lastTool, "idle");
    assert.deepEqual(snapshot?.openTodoLines, ["- [ ] [t1] planted"]);
    // 原始文件里确认过 JSONL 也含戳（投影只发生在 wire）：
    const raw = await (
      await import("node:fs/promises")
    ).readFile(
      join(
        resolveConversationDir({
          projectDir: resolveProjectSessionDir(tmp, workspaceRoot),
          conversationId: id,
        }),
        `${id}.jsonl`
      ),
      "utf8"
    );
    assert.ok(raw.includes("hostInjected"));
    const log = parseSessionJsonl(raw);
    assert.ok(log.events.length > 0);
  });
});
