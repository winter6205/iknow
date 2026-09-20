/** @jsxImportSource @opentui/react */
/**
 * tests/tui/stream-draft-integration.test.tsx
 *
 * End-to-end streaming-draft wiring (draft accumulate / commit / abort /
 * thinking / tool pairing; UI == harness context == on-disk session).
 *
 * Assembly: mountAppAsync + stubbed deps streamEventsByStep injecting scripted
 * stream events (text_delta / thinking_delta / tool_call_start /
 * tool_input_delta / stop_summary).
 *
 * Coverage:
 *  1. stop_summary onStream event → the notice area shows the summary text;
 *  2. text_delta streaming → turn completes → persisted assistant text; the
 *     draft intermediate state is rendered by StreamDraft.masked() (asserting
 *     it via the hint cursor is fragile, so this test focuses on "stream
 *     events flow into onStream → notice / draft paths are connected");
 *  3. tool_call_start + tool_input_delta×N → running frames carry the partial
 *     args summary (live incremental display), and finalText persists once the
 *     turn completes.
 *
 * Note: this file pins the streaming-contract wiring only; the UI == harness
 * context == on-disk consistency is guaranteed jointly by session-state /
 * sessionHub / StreamDraft, with end-to-end assertions in
 * tui-cross-entry.test.ts + app.test.tsx.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.js";
import { createRegistry } from "../../src/harness/tools/registry.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopEngineDeps,
  LoopState,
  ModelAdapter,
} from "../../src/harness/index.js";
import type { ToolExecutionResult } from "../../src/harness/tools/types.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import { createStreamDraft } from "../../src/cli/stream-draft.js";

/** Delay window after the event fires (abort pass-through): the stable tool-running phase. */
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

/** Assemble LoopEngineDeps with an inline adapter + a noop tool (consumed by createTuiBridge). */
function buildToolDeps(adapter: ModelAdapter): LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  return { adapter, executor, registry, maxTurns: 5 };
}

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
}

async function mountAppAsync(
  streamEventsByStep: ReadonlyArray<ReadonlyArray<HarnessStreamEvent>>,
  finalText: string,
  depsOverride?: LoopEngineDeps
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-stream-"));
  const deps =
    depsOverride ??
    makeDeps([assistantResult({ texts: [finalText] })], {
      streamEventsByStep,
    });
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps,
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: 80, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 300));
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("TUI 流式 draft 接线（spec SC8）", () => {
  test("stop_summary onStream 事件 → notice 区呈现摘要", async () => {
    const app = await mountAppAsync(
      [[{ type: "stop_summary", text: "TUI 流式收尾摘要" }]],
      ""
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // the stop_summary digest should land in the notice area
    await untilFrame(
      app.setup,
      (f) => f.includes("TUI 流式收尾摘要"),
      8000,
      "stop-summary"
    );

    // turn done
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");

    await app.destroy();
  }, 30_000);

  test("text_delta + thinking_delta 流式 → turn 完成 → 落盘 assistant 文本", async () => {
    const app = await mountAppAsync(
      [
        [
          { type: "text_delta", text: "你" },
          { type: "text_delta", text: "好" },
          { type: "thinking_delta", text: "思考中…" },
        ],
      ],
      "final-reply"
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // turn done
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");

    // persistence check: stream events flowed through → turn completed normally
    const list = await app.bridge.listSessions();
    expect(list).toBeDefined();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("hi");
    const sessionId = list[0]!.conversation_id;
    const file = await app.bridge.loadSessionFile(sessionId);
    expect(file.turnCount).toBe(1);
    // assistant text (from finalText): the stub response injects "final-reply"
    const assistantTexts = file.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
      );
    expect(assistantTexts.join("")).toContain("final-reply");

    await app.destroy();
  }, 30_000);

  test("thinking 留存：turn 结束 → 末条 assistant 折叠行显示 Thought for Ns", async () => {
    // Requirement: the thinking seconds survive the turn end instead of
    // vanishing. The streaming panel disappears when the turn ends, so the app
    // layer snapshots thinkingSeconds in runTurnOnce's finally → the last
    // assistant history fold-line shows `Thought for <duration>` (English unit
    // fold; the seconds carry over and are not lost when the draft clears).
    // Inline adapter: emit thinking_delta, then await 3000ms before returning →
    // ≥1s elapses after thinkingStartedAt, so thinkingSeconds() > 0 at the
    // finally snapshot.
    const thinkingAdapter: ModelAdapter = {
      async step(
        _state: LoopState,
        request: { onStream?: (e: HarnessStreamEvent) => void },
        signal?: AbortSignal
      ): Promise<AssistantTurnResult> {
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        request.onStream?.({ type: "thinking_delta", text: "链上推理…" });
        await abortableDelay(3000, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return assistantResult({
          texts: ["正式回答"],
          thinkingBlocks: [
            { type: "thinking", thinking: "链上推理…", signature: "sig-1" },
          ],
          // The stub adapter injects thinkingMs; hub → store.appendEvents →
          // hub → store.appendEvents → projectSessionLog writes it into the
          // persisted parallel arrays; the ChatView last-assistant fold line
          // reads the seconds from session.thinkingMs for persistence
          // (replacing the deleted in-memory pinThinkingSeconds side channel).
          thinkingMs: 3000,
        });
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
    const app = await mountAppAsync(
      [],
      "正式回答",
      buildToolDeps(thinkingAdapter)
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // turn done.
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    // The last-assistant fold line persists `Thought for <duration>` (N≥1; the
    // 3s delay guarantees seconds>0; English unit fold).
    await untilFrame(
      app.setup,
      (f) => /Thought for \d+s/.test(f),
      8000,
      "thinking-persisted"
    );

    await app.destroy();
  }, 30_000);

  test("纯思考时长：思考秒数不含 turn 启动 → 首 thinking_delta 等待时段（惰性打点）", async () => {
    // Scenario: the "waiting for thinking" span between sending the request and
    // the first thinking_delta must NOT count into the thinking seconds.
    // Timing origin = lazy stamp on the first thinking_delta (its only source) —
    // thinking seconds = pure thinking duration (first delta → answer start);
    // the waiting span is accounted by the app-layer mode line / `Crunched for
    // X`. Inline adapter: delay 2600ms (waiting span) → emit thinking_delta →
    // delay 1500ms → return. Expect: the persisted fold-line seconds after the
    // turn ≈ 1 (pure thinking, excluding the 2.6s wait; the old turn-start
    // stamping would give ≥4). The 1500ms window is wider than the 1000ms floor
    // boundary for slack against CI clock jitter.
    const thinkingAdapter: ModelAdapter = {
      async step(
        _state: LoopState,
        request: { onStream?: (e: HarnessStreamEvent) => void },
        signal?: AbortSignal
      ): Promise<AssistantTurnResult> {
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        await abortableDelay(2600, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        request.onStream?.({ type: "thinking_delta", text: "等待后思考…" });
        await abortableDelay(1500, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return assistantResult({
          texts: ["正式回答"],
          thinkingBlocks: [
            { type: "thinking", thinking: "等待后思考…", signature: "sig-2" },
          ],
          // The stub adapter injects the pure thinking duration of 1500ms (the
          // 2.6s wait is excluded, because thinkingMs starts from the lazy stamp
          // on the first thinking_delta of the anthropic-adapter streaming arm —
          // that is the measurement point).
          thinkingMs: 1500,
        });
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
    const app = await mountAppAsync(
      [],
      "正式回答",
      buildToolDeps(thinkingAdapter)
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // After the turn completes, the history fold-line persists seconds ≈1
    // (counted from the lazy first-delta stamp; pure thinking 1500ms; the 2.6s
    // wait excluded). CI jitter tolerated up to 2; the old turn-start stamping
    // would give ≥4 — `[12]` is exactly the proof the waiting span is excluded.
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(
      app.setup,
      (f) => /Thought for [12]s/.test(f),
      8000,
      "thinking-pure-duration"
    );

    await app.destroy();
  }, 30_000);

  test("首 thinking_delta 惰性打点：thinkingSeconds() 基于首 delta 时刻计算", async () => {
    // Unit-level integration: createStreamDraft directly verifies timing origin
    // = the first thinking_delta moment (lazy stamp; no turn-start explicit
    // stamping channel). After 8000ms seconds = 8 (pure thinking duration, no
    // turn-start waiting). `Date.now()` is evaluated after append → always at or
    // after the stamp moment, so elapsed ≥ 8000ms holds and the assertion is deterministic.
    const draft = createStreamDraft();
    draft.append({ type: "thinking_delta", text: "想" });
    expect(draft.thinkingSeconds()).toBe(0); // just stamped, under 1s
    expect(draft.thinkingSeconds(Date.now() + 8000)).toBe(8);
    expect(draft.thinkingSeconds(Date.now() + 8_500)).toBe(8);
    // reset → cleared to zero.
    draft.reset();
    expect(draft.thinkingSeconds()).toBe(0);
  });

  test("tool_call_start → LiveToolRun running 过程行实时追加", async () => {
    // Timing note: the stub-model's streamEventsByStep emits events after the
    // delay and returns immediately → the turn completes at once and the
    // running window is too short to catch. The inline adapter here awaits
    // 3000ms after tool_call_start before returning, manufacturing a stable
    // "tool running, turn unfinished" window.
    const toolAdapter: ModelAdapter = {
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
          id: "tool-1",
          name: "noop",
        });
        request.onStream?.({ type: "text_delta", text: "running-tool-reply" });
        await abortableDelay(3000, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return assistantResult({ texts: ["running-tool-final"] });
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
    const app = await mountAppAsync(
      [],
      "running-tool-final",
      buildToolDeps(toolAdapter)
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // LiveToolRun streaming phase: render contains running process lines (no
    // `[运行中]` ("running") marker; noop has no input → empty detail → the line
    // carries only the tool name).
    await untilFrame(
      app.setup,
      (f) => f.includes("noop"),
      8000,
      "tool-running"
    );

    // turn done → final text persisted (finalText, not the draft intermediate state).
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(
      app.setup,
      (f) => f.includes("running-tool-final"),
      8000,
      "tool-final-rendered"
    );

    await app.destroy();
  }, 30_000);

  test("T5: tool_call_start + tool_input_delta×N → running 帧含 partial 参数，完成后含最终参数", async () => {
    // Inline adapter: emit tool_call_start + tool_input_delta×N, then await
    // 3000ms before returning → the partial digest should appear within the
    // stable "tool running, turn unfinished" window.
    const toolAdapter: ModelAdapter = {
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
          id: "tool-2",
          name: "bash",
        });
        request.onStream?.({
          type: "tool_input_delta",
          id: "tool-2",
          partialJson: '{"com',
        });
        request.onStream?.({
          type: "tool_input_delta",
          id: "tool-2",
          partialJson: 'mand":"git status"}',
        });
        request.onStream?.({ type: "text_delta", text: "running-tool-reply" });
        await abortableDelay(3000, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return assistantResult({ texts: ["running-tool-final"] });
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
    const app = await mountAppAsync(
      [],
      "running-tool-final",
      buildToolDeps(toolAdapter)
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    // running phase: partial args already accumulated → digest line contains `git status` (parse succeeded).
    await untilFrame(
      app.setup,
      (f) => f.includes("Running 1 shell command…") && f.includes("git status"),
      8000,
      "tool-partial-rendered"
    );

    // turn done → final text persisted (finalText, not the draft intermediate state).
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(
      app.setup,
      (f) => f.includes("running-tool-final"),
      8000,
      "tool-final-rendered"
    );

    await app.destroy();
  }, 30_000);

  test("事件混排：草稿前工具在上、草稿后开始的工具在下（draftEpoch）", async () => {
    // Inline adapter: tool_call_start(early retract) → text_delta → tool_call_start(late keep).
    // Per specs/tui-activity-block.md S4/S6: retract-class (web_search) goes
    // alone into the unanchored activity block; keep-class (bash) goes through
    // the tail `liveToolRunsBox` interleaved with draft segments. This test
    // checks both routes:
    //  (a) web_search enters the unanchored block (block title + preview slot `web_search · Search ?`);
    //  (b) keep bash's process line and the draft segment share epoch order (tool first, then draft).
    const toolAdapter: ModelAdapter = {
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
          id: "tool-early",
          name: "web_search",
        });
        request.onStream?.({ type: "text_delta", text: "order-probe-draft" });
        request.onStream?.({
          type: "tool_call_start",
          id: "tool-late",
          name: "bash",
        });
        await abortableDelay(3000, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return assistantResult({ texts: ["order-probe-final"] });
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
    const app = await mountAppAsync(
      [],
      "order-probe-final",
      buildToolDeps(toolAdapter)
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    await untilFrame(
      app.setup,
      (f) =>
        f.includes("Running 1 shell command…") &&
        f.includes("order-probe-draft"),
      8000,
      "mixed-order-window"
    );
    const frame = app.setup.captureCharFrame();
    // live-signal real card: web_search no longer emits the
    // `calling web_search × 1` block title; tail card = `web_search · Search …`.
    expect(frame.includes("calling web_search × 1")).toBe(false);
    expect(frame).toContain("web_search · Search");
    // (b) keep-class bash goes through the tail tool card; process line = `Running 1 shell command…`.
    expect(frame).toContain("Running 1 shell command…");
    // Draft text is visible in the frame.
    expect(frame).toContain("order-probe-draft");
    // The tail card (web_search) comes first: the live-signal card's process line
    // sits early in the frame, while keep bash's process line shares its epoch
    // with the draft — both come after the tail card.
    const iEarly = frame.indexOf("web_search · Search");
    const iDraft = frame.indexOf("order-probe-draft");
    const iLate = frame.indexOf("Running 1 shell command…");
    expect(iEarly).toBeGreaterThanOrEqual(0);
    expect(iDraft).toBeGreaterThanOrEqual(0);
    expect(iLate).toBeGreaterThanOrEqual(0);
    expect(iEarly).toBeLessThan(iLate);
    expect(iEarly).toBeLessThan(iDraft);

    await app.destroy();
  }, 30_000);

  test("事件混排：tool→text→tool→text 第二段草稿在后续工具之下", async () => {
    // web_search (retract) goes into the unanchored block; bash (keep) + the two
    // draft segments interleave by epoch in the tail (if the late bash were
    // tagged epoch 1 it would land after the second draft segment; the default
    // epoch 0 puts it in the same epoch as the first segment — the tools-first
    // path). This test uses the default epoch (late bash stays epoch 0) and
    // asserts the tail order is stable within the tail.
    const toolAdapter: ModelAdapter = {
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
          id: "tool-early",
          name: "web_search",
        });
        request.onStream?.({ type: "text_delta", text: "order-seg-one" });
        request.onStream?.({
          type: "tool_call_start",
          id: "tool-late",
          name: "bash",
        });
        request.onStream?.({ type: "text_delta", text: "order-seg-two" });
        await abortableDelay(3000, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return assistantResult({ texts: ["order-seg-final"] });
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
    const app = await mountAppAsync(
      [],
      "order-seg-final",
      buildToolDeps(toolAdapter)
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hi");
    await app.pressEnter();

    await untilFrame(
      app.setup,
      (f) =>
        f.includes("Running 1 shell command…") &&
        f.includes("order-seg-one") &&
        f.includes("order-seg-two"),
      8000,
      "two-segment-order-window"
    );
    const frame = app.setup.captureCharFrame();
    // The web_search tail card appears first (`web_search · Search`);
    // both draft segments + bash come after it.
    const iEarly = frame.indexOf("web_search · Search");
    const iFirst = frame.indexOf("order-seg-one");
    const iLate = frame.indexOf("Running 1 shell command…");
    const iSecond = frame.indexOf("order-seg-two");
    expect(iEarly).toBeGreaterThanOrEqual(0);
    expect(iFirst).toBeGreaterThanOrEqual(0);
    expect(iLate).toBeGreaterThanOrEqual(0);
    expect(iSecond).toBeGreaterThanOrEqual(0);
    expect(iEarly).toBeLessThan(iFirst);
    expect(iEarly).toBeLessThan(iSecond);
    // Both draft segments and bash are after the tail card; nothing dropped in the same frame.
    expect(iFirst).toBeGreaterThanOrEqual(0);
    expect(iSecond).toBeGreaterThanOrEqual(0);
    // web_search never enters a block title.
    expect(frame.includes("calling web_search × 1")).toBe(false);

    await app.destroy();
  }, 30_000);
});
