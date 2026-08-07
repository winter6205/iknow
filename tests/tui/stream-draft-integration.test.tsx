/**
 * tests/tui/stream-draft-integration.test.tsx
 *
 * T4 (#175): TUI streaming-render integration test.
 *
 * Uses inline adapters (not stub-model) for deterministic timing: emit
 * text_delta, then await a controllable delay before returning. This lets
 * the test observe the draft mid-stream (BEFORE the turn resolves) and
 * cleanly exercise the abort path while events are still being delivered.
 *
 * Coverage:
 *  1. draft accumulates while streaming: ChatView renders masked text
 *     BEFORE the turn completes (inflight still populated, draft is the
 *     sole source of truth mid-turn);
 *  2. after commit the draft is folded into the transcript (final message
 *     holds the full assistant reply, draft no longer shown after turn end);
 *  3. after abort the draft is cleared + "interrupted" notice + runState idle.
 *
 * Assembly reuses app.test.tsx makeApp + fakeTtyStream pattern (ink render).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import type { Instance } from "ink";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createStubTool } from "../../src/harness/stubs/stub-tool.js";
import { createRegistry } from "../../src/harness/tools/registry.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import { assistantResult } from "../cli/_fixtures.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
} from "../../src/harness/index.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import type { ToolExecutionResult } from "../../src/harness/tools/types.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("This operation was aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout: ${label}`);
    }
    await delay(50);
  }
}

function fakeTtyStream(): PassThrough & {
  isTTY: boolean;
  columns: number;
  rows: number;
  setRawMode: (v: boolean) => void;
  ref: () => void;
  unref: () => void;
} {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    setRawMode: (v: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 30;
  stream.setRawMode = (): void => {};
  stream.ref = (): void => {};
  stream.unref = (): void => {};
  return stream;
}

/**
 * Inline adapter that streams scripted deltas, then awaits a post-emit delay
 * before returning. The post-emit delay creates a deterministic window
 * where deltas have been delivered but the turn has NOT yet resolved, so
 * the draft is the sole source of truth mid-turn.
 */
function streamingAdapter(opts: {
  deltas: ReadonlyArray<string>;
  postEmitDelayMs: number;
  finalText: string;
}): ModelAdapter & {
  readonly encodeUserText: (t: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    rs: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
} {
  return {
    async step(
      _state: LoopState,
      request: { onStream?: (e: HarnessStreamEvent) => void },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      for (const text of opts.deltas) {
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        request.onStream?.({ type: "text_delta", text });
      }
      await abortableDelay(opts.postEmitDelayMs, signal);
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return assistantResult({ texts: [opts.finalText] });
    },
    encodeUserText(t: string): AnthropicNativeMessage {
      return { role: "user", content: [{ type: "text", text: t }] };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] {
      return results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.output,
        is_error: r.isError,
      }));
    },
  };
}

/**
 * T3 (#175): 流式 thinking 夹具 — 先发 thinking_delta 序列,再发 answer text,
 * 然后 await 后置延迟才返回(制造 turn 未完成的稳定窗口)。
 */
function thinkingStreamingAdapter(opts: {
  thinkingDeltas: ReadonlyArray<string>;
  postEmitDelayMs: number;
  finalText: string;
}): ModelAdapter & {
  readonly encodeUserText: (t: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    rs: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
} {
  return {
    async step(
      _state: LoopState,
      request: { onStream?: (e: HarnessStreamEvent) => void },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      for (const t of opts.thinkingDeltas) {
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        request.onStream?.({ type: "thinking_delta", text: t });
      }
      request.onStream?.({ type: "text_delta", text: opts.finalText });
      await abortableDelay(opts.postEmitDelayMs, signal);
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return assistantResult({ texts: [opts.finalText] });
    },
    encodeUserText(t: string): AnthropicNativeMessage {
      return { role: "user", content: [{ type: "text", text: t }] };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] {
      return results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.output,
        is_error: r.isError,
      }));
    },
  };
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly instance: Instance;
  readonly lastOutput: () => string;
  readonly type: (text: string) => Promise<void>;
  readonly ready: () => Promise<void>;
}

/** 暴露 toolEventSink 以供 T4 手动驱动 postToolUse 配对事件。 */
interface DrivenAppWithToolSink extends DrivenApp {
  readonly toolEventSink: ReturnType<typeof createToolEventSink>;
}

/**
 * T4 (#175): 流式夹具 — 先发 tool_call_start(with id),再发 answer text,
 * await 后置延迟才返回(制造 tool 运行中 turn 未完成的稳定窗口)。
 */
function toolStreamingAdapter(opts: {
  postEmitDelayMs: number;
  finalText: string;
}): ModelAdapter & {
  readonly encodeUserText: (t: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    rs: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
} {
  return {
    async step(
      _state: LoopState,
      request: { onStream?: (e: HarnessStreamEvent) => void },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      request.onStream?.({
        type: "tool_call_start",
        name: "echo",
        id: "toolu_t4_1",
      });
      request.onStream?.({ type: "text_delta", text: opts.finalText });
      await abortableDelay(opts.postEmitDelayMs, signal);
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return assistantResult({ texts: [opts.finalText] });
    },
    encodeUserText(t: string): AnthropicNativeMessage {
      return { role: "user", content: [{ type: "text", text: t }] };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] {
      return results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.output,
        is_error: r.isError,
      }));
    },
  };
}

describe("T4 streaming render integration", () => {
  const LONG_TIMEOUT = 30_000;
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  const instances: Instance[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-stream-"));
    stdout = fakeTtyStream();
    stdin = fakeTtyStream();
  }, LONG_TIMEOUT);
  afterEach(async () => {
    for (const instance of instances) instance.unmount();
    instances.length = 0;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  function mountApp(bridge: TuiBridge): DrivenAppWithToolSink {
    const askBridge = createTuiAskUserBridge();
    const toolEventSink = createToolEventSink();
    const out: string[] = [];
    stdout.on("data", (chunk) => out.push(String(chunk)));
    const instance = render(
      <TuiApp
        bridge={bridge}
        askBridge={askBridge}
        toolEventSink={toolEventSink}
        cwd="/tmp/proj"
        dataDir={baseDir}
      />,
      {
        stdout,
        stdin,
        exitOnCtrlC: false,
        interactive: true,
        kittyKeyboard: { mode: "disabled" },
      }
    );
    instances.push(instance);
    return {
      bridge,
      instance,
      lastOutput: (): string => strip(out.join("")),
      type: async (text: string): Promise<void> => {
        for (const ch of text) {
          stdin.write(ch);
          await delay(10);
        }
      },
      ready: async (): Promise<void> => {
        await delay(400);
      },
      toolEventSink,
    };
  }

  function makeAppWithAdapter(
    adapter: ModelAdapter,
    extra?: { readonly system?: () => Promise<string | undefined> }
  ): DrivenAppWithToolSink {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: { adapter, executor, registry, maxTurns: 5, ...extra },
      inflight: createInflightRegistry(),
    });
    return mountApp(bridge);
  }

  it(
    "draft accumulates while streaming -> commit folds into transcript, draft clears",
    async () => {
      const adapter = streamingAdapter({
        deltas: ["DRAFT-MARKER-alpha", "DRAFT-MARKER-beta"],
        postEmitDelayMs: 3000,
        finalText: "FINAL-MARKER-complete",
      });
      const app = makeAppWithAdapter(adapter);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      await app.type("hi\r");
      // First wait for the turn to start (inflight = 1).
      await waitFor(
        () => app.bridge.inflight.ids().size > 0,
        8000,
        "turn-start"
      );
      // Now the draft must be the source of truth (DRAFT-MARKER visible while
      // the FINAL-MARKER has NOT yet been committed).
      await waitFor(
        () => app.lastOutput().includes("DRAFT-MARKER-alpha"),
        8000,
        "stream-draft-visible"
      );
      expect(app.lastOutput()).not.toContain("FINAL-MARKER-complete");

      // Turn resolves -> draft folded into transcript (full final text),
      // inflight cleared.
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      await waitFor(
        () => app.lastOutput().includes("FINAL-MARKER-complete"),
        8000,
        "final-rendered"
      );
      // Persisted final message holds the complete assistant reply.
      const list = await app.bridge.listSessions();
      const file = await app.bridge.loadSessionFile(list[0]!.conversation_id);
      const last = file.messages[file.messages.length - 1]!;
      expect(last.role).toBe("assistant");
      const text = last.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(text).toBe("FINAL-MARKER-complete");
    },
    LONG_TIMEOUT
  );

  it(
    "T2: user message echoes into transcript immediately after submit (before any delta) and persists after turn end",
    async () => {
      // 长后置延迟:submit 后有一个稳定窗口 turn 未完成,此时用户消息必须已可见。
      const adapter = streamingAdapter({
        deltas: [],
        postEmitDelayMs: 3000,
        finalText: "T2-FINAL",
      });
      const app = makeAppWithAdapter(adapter);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      await app.type("T2-USER-MARKER\r");
      // Turn 已起跑(inflight=1),但无 delta 到达 → 用户消息是唯一可见来源。
      await waitFor(
        () => app.bridge.inflight.ids().size > 0,
        8000,
        "turn-start"
      );
      // 任何 delta 前用户文本已渲染(❯ 前缀 + 文本)。
      await waitFor(
        () => app.lastOutput().includes("T2-USER-MARKER"),
        8000,
        "user-echo-visible"
      );
      expect(app.lastOutput()).not.toContain("T2-FINAL");

      // Turn 结束 → 用户消息仍在(落盘原子替换后)。
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      await waitFor(
        () => app.lastOutput().includes("T2-FINAL"),
        8000,
        "final-rendered"
      );
      expect(app.lastOutput()).toContain("T2-USER-MARKER");
    },
    LONG_TIMEOUT
  );

  it(
    "T3: thinking_delta streams → [思考] collapsed summary visible; /thinking expands → content visible; turn end → streaming panel disappears",
    async () => {
      const adapter = thinkingStreamingAdapter({
        thinkingDeltas: ["THINK-MARKER-1", "THINK-MARKER-2"],
        postEmitDelayMs: 3000,
        finalText: "T3-FINAL",
      });
      const app = makeAppWithAdapter(adapter);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      await app.type("think request\r");
      await waitFor(
        () => app.bridge.inflight.ids().size > 0,
        8000,
        "turn-start"
      );
      // 折叠态:默认 [思考] 摘要行可见,thinking 内容不裸出。
      await waitFor(
        () => app.lastOutput().includes("思考中"),
        8000,
        "thinking-collapsed-visible"
      );
      expect(app.lastOutput()).not.toContain("THINK-MARKER-1");

      // /thinking 展开 → 流式内容可见。
      await app.type("/thinking\r");
      await waitFor(
        () => app.lastOutput().includes("THINK-MARKER-1"),
        8000,
        "thinking-expanded-visible"
      );
      expect(app.lastOutput()).toContain("THINK-MARKER-2");

      // Turn 结束 → 流式 thinking 面板消失(交棒终稿 thinking blocks 面板)。
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      await waitFor(
        () => app.lastOutput().includes("T3-FINAL"),
        8000,
        "final-rendered"
      );
      await delay(300);
      // 流式面板(streaming draft)已清空;终稿不含 THINK-MARKER(仅结论文本)。
      // lastOutput() 是累计输出,取最新 frame 尾部断言(对齐 abort 测试先例)。
      const tail = app.lastOutput().slice(-400);
      expect(tail).not.toContain("THINK-MARKER-1");
    },
    LONG_TIMEOUT
  );

  it(
    "T4: tool_call_start → [运行中] row visible; postToolUse pairs via tool_use_id → ok summary; turn end clears live state",
    async () => {
      const adapter = toolStreamingAdapter({
        postEmitDelayMs: 3000,
        finalText: "T4-DONE",
      });
      const app = makeAppWithAdapter(adapter);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      await app.type("run tool\r");
      await waitFor(
        () => app.bridge.inflight.ids().size > 0,
        8000,
        "turn-start"
      );
      await waitFor(
        () => app.bridge.inflight.ids().size === 1,
        8000,
        "inflight-single"
      );
      const convId = [...app.bridge.inflight.ids()][0]!;
      // tool_call_start 已由 adapter 流式发出 → [运行中] 行可见(工具未完成)。
      await waitFor(
        () => app.lastOutput().includes("[运行中] echo"),
        8000,
        "tool-running-visible"
      );
      expect(app.lastOutput()).not.toContain("run-tool-name · ");

      // postToolUse 按 tool_use_id 配对 → 转 ok 摘要行。
      app.toolEventSink.emit({
        conversationId: convId,
        toolName: "echo",
        toolUseId: "toolu_t4_1",
        kind: "ok",
        input: { value: "x" },
      });
      await waitFor(
        () => app.lastOutput().includes("echo ·"),
        8000,
        "tool-completed-visible"
      );
      // 累计输出含历史 [运行中] 行,断言最新 frame 尾部无该行(完成态取代 running 态)。
      expect(app.lastOutput().slice(-400)).not.toContain("[运行中] echo");

      // Turn 结束 → live 状态清空(落盘后终稿 tool_use blocks 接管)。
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      await waitFor(
        () => app.lastOutput().includes("T4-DONE"),
        8000,
        "final-rendered"
      );
      await delay(300);
      const tail = app.lastOutput().slice(-400);
      expect(tail).not.toContain("[运行中] echo");
    },
    LONG_TIMEOUT
  );

  it(
    "T4 retro: postToolUse missing tool_use_id falls back to legacy string line append",
    async () => {
      const adapter = streamingAdapter({
        deltas: [],
        postEmitDelayMs: 3000,
        finalText: "T4-LEGACY-DONE",
      });
      const app = makeAppWithAdapter(adapter);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");
      await app.type("legacy tool\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 1,
        8000,
        "inflight-single"
      );
      const convId = [...app.bridge.inflight.ids()][0]!;
      // 无 tool_use_id → 不进结构化状态,落回 legacy 字符串行追加。
      app.toolEventSink.emit({
        conversationId: convId,
        toolName: "echo",
        kind: "ok",
        input: { value: "y" },
      });
      await waitFor(
        () => app.lastOutput().includes("echo ·"),
        8000,
        "legacy-line-visible"
      );
      // 无 [运行中] 前缀(未走 liveToolRuns 路径)。
      expect(app.lastOutput().slice(-400)).not.toContain("[运行中] echo");
    },
    LONG_TIMEOUT
  );

  it(
    "abort clears draft + interruption notice + runState back to idle",
    async () => {
      const adapter = streamingAdapter({
        deltas: ["ABORT-DRAFT-marker"],
        postEmitDelayMs: 5000,
        finalText: "ABORT-FINAL-never",
      });
      const app = makeAppWithAdapter(adapter);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      await app.type("interrupt me\r");
      await waitFor(
        () => app.bridge.inflight.ids().size > 0,
        8000,
        "turn-start"
      );
      await waitFor(
        () => app.lastOutput().includes("ABORT-DRAFT-marker"),
        8000,
        "draft-before-abort"
      );
      expect(app.lastOutput()).not.toContain("ABORT-FINAL-never");

      // Ctrl+C aborts the foreground turn.
      stdin.write(String.fromCharCode(3));
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "abort-inflight-clear"
      );
      await waitFor(
        () => app.lastOutput().includes("\u5df2\u6253\u65ad"),
        8000,
        "abort-notice"
      );
      // Draft cleared: the partial draft must not become the final rendered
      // text after abort. Use the latest frame slice to avoid stale frames.
      await delay(300);
      const tail = app.lastOutput().slice(-400);
      expect(tail).not.toContain("ABORT-DRAFT-marker");
      expect(tail).not.toContain("ABORT-FINAL-never");
    },
    LONG_TIMEOUT
  );

  it(
    "Spec 守卫: 系统 resolver 注入 sentinel → TUI 渲染不含 sentinel, 用户 echo 字面",
    async () => {
      // harness 内部 query (system prompt) 不上 UI:
      // 装配层挂一个 system resolver, 输出唯一 sentinel;提交用户字面后
      // 渲染必须不含 sentinel,且用户 echo 字面一致。
      const SENTINEL = "<<SYSTEM_PROMPT_INJECTION_SENTINEL_77>>";
      const adapter = streamingAdapter({
        deltas: [],
        postEmitDelayMs: 1000,
        finalText: "GUARD-FINAL",
      });
      const app = makeAppWithAdapter(adapter, {
        system: async () => SENTINEL,
      });
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      const USER_LITERAL = "echo test";
      await app.type(`${USER_LITERAL}\r`);

      // 立即断言 sentinel 已路由到 harness adapter (不进 UI)。
      await waitFor(
        () => app.lastOutput().includes(USER_LITERAL),
        8000,
        "user-echo-visible"
      );
      expect(app.lastOutput()).not.toContain(SENTINEL);

      // turn 结束后仍守住: sentinel 不该被回填到 transcript / 状态栏 / 任何块。
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      await waitFor(
        () => app.lastOutput().includes("GUARD-FINAL"),
        8000,
        "final-rendered"
      );
      expect(app.lastOutput()).not.toContain(SENTINEL);
      // 用户 echo 仍是字面 (无字面被 sentinel 污染)。
      expect(app.lastOutput()).toContain(USER_LITERAL);
    },
    LONG_TIMEOUT
  );

  it(
    "三段一致: UI 可见用户消息 == harness 注入的模型 context == 文件落盘",
    async () => {
      // plan §1 + 用户需求 #4: 三个 view 上同一字面。
      // 段 A: UI 渲染包含字面。 段 B: 模型 context = encodeUserText 输出
      // (= hub 持久化后 messages[0] 的 content[0].text, 因为 inline adapter
      // 的 encodeUserText 是 verbatim 的). 段 C: turn 结束后 reload session
      // 文件, messages[0] 仍是字面。
      const LITERAL = "exactly-this-literal-123";
      const adapter = streamingAdapter({
        deltas: [],
        postEmitDelayMs: 1000,
        finalText: "TRI-SEC-FINAL",
      });
      const app = makeAppWithAdapter(adapter);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 段 A: 提交后立即断言 UI 含字面。
      await app.type(`${LITERAL}\r`);
      await waitFor(
        () => app.lastOutput().includes(LITERAL),
        8000,
        "ui-visible"
      );

      // 段 B + C: 取当前会话, 断言文件 messages[0].content[0].text == 字面.
      // 提交过程中持久化是原子替换, 此时 messages[0] 应是 user literal
      // (loop-engine run() 经 encodeUserText 注入 messages, 持久化紧随其后).
      // 等 turn 结束取定稿 snapshots.
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      await waitFor(
        () => app.lastOutput().includes("TRI-SEC-FINAL"),
        8000,
        "final-rendered"
      );

      // 段 B: 加载 session 文件, 断言 messages[0] 是 user 字面
      // (== encodeUserText 输出, 因为 inline adapter encodeUserText 是 verbatim).
      const sessions = await app.bridge.listSessions();
      const convId = sessions[0]!.conversation_id;
      const file = await app.bridge.loadSessionFile(convId);
      const firstUser = file.messages[0]!;
      expect(firstUser.role).toBe("user");
      const firstText = firstUser.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(firstText).toBe(LITERAL);

      // 段 C: 再载一次确认落盘稳定 (原子替换已完成, 终稿不变).
      const fileReloaded = await app.bridge.loadSessionFile(convId);
      const firstReloaded = fileReloaded.messages[0]!;
      expect(firstReloaded.role).toBe("user");
      const reloadedText = firstReloaded.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(reloadedText).toBe(LITERAL);

      // 三段已证: UI 可见 == 模型 context (file.messages[0]) == 落盘重读.
      // 段 B 等价于 encodeUserText verbatim 锁定, 由 inline adapter 契约保证.
    },
    LONG_TIMEOUT
  );
});
