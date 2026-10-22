/** @jsxImportSource @opentui/react */
/**
 * tests/tui/context-usage-call-beat.test.tsx
 *
 * #1079 Track A T4: the ContextBar consumes context_usage call-beat events
 * mid-run. Assembly is the product path: TuiApp + createTuiBridge + real hub
 * + real loop-engine; only the ModelAdapter is a scripted stub.
 *
 * Certified here:
 *  - call #1 succeeds → its post_call correction lands on the bar while the
 *    tool loop of call #1 is still running (turn unfinished, inflight > 0);
 *  - the reading is the call's real usage (no chars/N estimate exists on
 *    this path at all);
 *  - after the turn the bar carries the final call's usage.
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
import {
  attachSession,
  createDraftSession,
  withContextUsageBeat,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import { ContextBar } from "../../src/tui/context-bar.js";
import { occupancyFromUsage } from "../../src/harness/compress/occupancy.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { assistantResult } from "../cli/_fixtures.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.js";
import { createRegistry } from "../../src/harness/tools/registry.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import { toAnthropicToolResults } from "../../src/harness/tools/tool-result.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopEngineDeps,
  LoopState,
  LoopAdapter,
  TokenUsage,
} from "../../src/harness/index.js";
// CountTokensInput is declared here but not re-exported by the harness barrel.
import type { CountTokensInput } from "../../src/harness/model-adapter/types.js";
import type { ToolExecutionResult } from "../../src/harness/tools/types.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Scripted adapter: call #1 asks for the slow tool and carries usage #1;
 *  call #2 answers with usage #2. countTokens reports a distinct measured
 *  pre-call number per beat so the pre_call events are real readings. */
function callBeatAdapter(): LoopAdapter {
  let beat = 0;
  return {
    async step(
      _state: LoopState,
      _request: { onStream?: (e: HarnessStreamEvent) => void },
      _signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      beat += 1;
      if (beat === 1) {
        return assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
          usage: {
            inputTokens: 12800,
            outputTokens: 7,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
        });
      }
      return assistantResult({
        texts: ["call-beat-final"],
        toolCalls: [],
        supplierStop: "success",
        usage: {
          inputTokens: 19200,
          outputTokens: 9,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
      });
    },
    async countTokens(_input: CountTokensInput) {
      return { inputTokens: 6400 };
    },
    encodeUserText(t: string): AnthropicNativeMessage {
      return { role: "user", content: [{ type: "text", text: t }] };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] {
      return toAnthropicToolResults(results);
    },
  };
}

function slowToolDeps(adapter: LoopAdapter): LoopEngineDeps {
  // The tool handler holds the tool loop open for 3s — the observation
  // window in which call #1's post_call must already be on the bar.
  const tool = createStubTool({
    name: "noop",
    next: () => delay(3000).then(() => ({ output: "ok" })),
  });
  const registry = createRegistry([tool]);
  return { adapter, executor: createExecutor(registry), registry, maxTurns: 5 };
}

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await delay(50);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(
    `untilFrame timeout${label ? ` (${label})` : ""}:\n${setup.captureCharFrame()}`
  );
}

async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await delay(50);
  }
}

describe("context_usage call-beat → ContextBar（#1079 T4）", () => {
  test("post_call 校正在工具循环未完时已刷条；turn 收尾后为末次读数", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-callbeat-"));
    const bridge: TuiBridge = createTuiBridge({
      dataDir,
      workspaceRoot: dataDir,
      deps: slowToolDeps(callBeatAdapter()),
      inflight: createInflightRegistry(),
    });
    const askBridge = createTuiAskUserBridge();
    const permissionMode = createPermissionModeContext("default");
    const sessionGrants = createSessionGrants();
    let setupRef: TestRendererSetup | undefined;
    const setup = await testRender(
      <TuiApp
        bridge={bridge}
        askBridge={askBridge}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir={dataDir}
        permissionMode={permissionMode}
        sessionGrants={sessionGrants}
        onQuit={() => {
          if (setupRef && !setupRef.renderer.isDestroyed)
            setupRef.renderer.destroy();
        }}
      />,
      { width: 90, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
    );
    setupRef = setup;
    await delay(300);
    await setup.waitForVisualIdle();
    await untilFrame(setup, (f) => f.includes("Version"));

    for (const ch of "hi") {
      setup.mockInput.pressKey(ch);
      await delay(30);
    }
    await delay(100);
    setup.mockInput.pressEnter();
    await delay(100);

    // Observation window: call #1 done, its tool still running → the bar
    // carries the CONFIRMED input-side occupancy (12,800), no `~` marker,
    // before the turn finishes. `projectedNext` (12,807) is on the wire for
    // the image-bearing gate only — it never repaints the bar (2026-10-22
    // confirmed-only amendment).
    const postCallFrame = await untilFrame(
      setup,
      (f) => f.includes("12.8k") && f.includes("5%"),
      8000,
      "confirmed-post-call"
    );
    // The same k-string exists under the old projected display; the marker is
    // what distinguishes the two contracts.
    expect(postCallFrame).not.toMatch(/~\d+%/);
    expect(bridge.inflight.ids().size).toBeGreaterThan(0);
    const [conversationId] = [...bridge.inflight.ids()];
    expect(conversationId).toBeDefined();

    // Turn over → the bar stands at call #2's confirmed usage (19,200 → 19.2k).
    await until(() => bridge.inflight.ids().size === 0, 8000, "turn-done");
    const finalFrame = await untilFrame(
      setup,
      (f) => f.includes("19.2k") && f.includes("8%"),
      8000,
      "final-confirmed"
    );
    expect(finalFrame).not.toMatch(/~\d+%/);

    // Separate assertion: `lastUsage` still equals the CONFIRMED usage of the
    // last call, and the projected display reading never reaches the file.
    const file = await bridge.loadSessionFile(conversationId!);
    expect(file.lastUsage).toEqual({
      inputTokens: 19200,
      outputTokens: 9,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    expect(JSON.stringify(file)).not.toContain("displayOccupancy");

    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }, 30_000);
});

/** Scripted 3-beat adapter: calls #1/#2 demand the slow tool and carry
 *  distinct usage; call #3 closes the turn. Each post_call reading must
 *  reach the bar before the next call is issued (call-beat, #1079 T6). */
function threeCallAdapter(): LoopAdapter {
  const beat1 = {
    inputTokens: 12800,
    outputTokens: 7,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
  const beat2 = {
    inputTokens: 19200,
    outputTokens: 8,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
  const beat3 = {
    inputTokens: 25600,
    outputTokens: 9,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
  let beat = 0;
  return {
    async step(
      _state: LoopState,
      _request: { onStream?: (e: HarnessStreamEvent) => void },
      _signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      beat += 1;
      if (beat === 1) {
        return assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
          usage: beat1,
        });
      }
      if (beat === 2) {
        return assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "noop", input: {} }],
          usage: beat2,
        });
      }
      return assistantResult({
        texts: ["three-call-final"],
        toolCalls: [],
        supplierStop: "success",
        usage: beat3,
      });
    },
    async countTokens(_input: CountTokensInput) {
      return { inputTokens: 6400 };
    },
    encodeUserText(t: string): AnthropicNativeMessage {
      return { role: "user", content: [{ type: "text", text: t }] };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] {
      return toAnthropicToolResults(results);
    },
  };
}

describe("long turn ≥3 llm_calls + reopen（#1079 T6）", () => {
  test("条在第 2、3 拍调用发出前已各自刷新；重开会话读数非 0%", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-reopen-"));
    const bridge: TuiBridge = createTuiBridge({
      dataDir,
      workspaceRoot: dataDir,
      deps: slowToolDeps(threeCallAdapter()),
      inflight: createInflightRegistry(),
    });
    const askBridge = createTuiAskUserBridge();
    const permissionMode = createPermissionModeContext("default");
    const sessionGrants = createSessionGrants();
    let setupRef: TestRendererSetup | undefined;
    const setup = await testRender(
      <TuiApp
        bridge={bridge}
        askBridge={askBridge}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir={dataDir}
        permissionMode={permissionMode}
        sessionGrants={sessionGrants}
        onQuit={() => {
          if (setupRef && !setupRef.renderer.isDestroyed)
            setupRef.renderer.destroy();
        }}
      />,
      { width: 90, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
    );
    setupRef = setup;
    await delay(300);
    await setup.waitForVisualIdle();
    await untilFrame(setup, (f) => f.includes("Version"));

    for (const ch of "hi") {
      setup.mockInput.pressKey(ch);
      await delay(30);
    }
    await delay(100);
    setup.mockInput.pressEnter();
    await delay(100);

    await until(() => bridge.inflight.ids().size === 1, 8000, "inflight-1");
    const [conversationId] = [...bridge.inflight.ids()];
    expect(conversationId).toBeDefined();

    // Beat 1: call #1's post_call on the bar while its tool loop runs —
    // before call #2 is issued. The bar shows the CONFIRMED input-side
    // occupancy of the call (no `~`); projectedNext is gate-only.
    const beat1Frame = await untilFrame(
      setup,
      (f) => f.includes("12.8k") && f.includes("5%"),
      8000,
      "beat-1-confirmed"
    );
    expect(beat1Frame).not.toMatch(/~\d+%/);
    expect(bridge.inflight.ids().size).toBe(1);

    // Beat 2: the bar already moved again while the turn is still running
    // (call #2's confirmed reading during its tool loop, before call #3 is
    // issued).
    const beat2Frame = await untilFrame(
      setup,
      (f) => f.includes("19.2k") && f.includes("8%"),
      8000,
      "beat-2-confirmed"
    );
    expect(beat2Frame).not.toMatch(/~\d+%/);
    expect(bridge.inflight.ids().size).toBe(1);

    // Turn over → final call's confirmed reading (25,600 → 25.6k).
    await until(() => bridge.inflight.ids().size === 0, 12_000, "turn-done");
    const finalFrame = await untilFrame(
      setup,
      (f) => f.includes("25.6k") && f.includes("10%"),
      8000,
      "final-confirmed"
    );
    expect(finalFrame).not.toMatch(/~\d+%/);
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();

    // Reopen, TUI attach path: persisted snapshot → attachSession → bar
    // numerator non-zero (the ContextBar reads exactly this field).
    const file = await bridge.loadSessionFile(conversationId!);
    const attached = attachSession(file);
    expect(attached.lastUsage).not.toBeNull();
    expect(occupancyFromUsage(attached.lastUsage as TokenUsage)).toBe(25600);
    const bar = await testRender(
      <ContextBar
        lastUsage={attached.lastUsage}
        contextWindow={200_000}
        running={false}
        cols={60}
      />,
      { width: 60, height: 5, consoleMode: "disabled" }
    );
    await bar.renderOnce();
    expect(bar.captureCharFrame()).toContain("25.6k");
    // Attach falls back to the CONFIRMED persisted reading: no `~` marker
    // until a projected beat arrives (Plan A T4).
    expect(bar.captureCharFrame()).not.toContain("~");
    if (!bar.renderer.isDestroyed) bar.renderer.destroy();

    // Reopen, web load path: the replayed last turn carries the same reading.
    const { turns } = await bridge.hub.getSession(conversationId!);
    expect(turns.length).toBeGreaterThan(0);
    const lastAnswer = turns[turns.length - 1]!.answer;
    expect(lastAnswer.lastUsage?.inputTokens).toBe(25600);
  }, 60_000);
});

/**
 * Deterministic display sequence for the beats the real harness emits (Plan A
 * T4 / 2026-10-22 confirmed-only amendment): each `context_usage` beat is
 * applied through the session-state reducer and rendered by the product
 * ContextBar. This pins the TUI half without the slow tool loop:
 *  - a projected beat does NOT move the bar (gate-only input for the
 *    image-bearing request path);
 *  - a post_call beat shows the CONFIRMED input-side occupancy — the
 *    event's `projectedNext` is ignored for display (that is the flicker
 *    root cause: outputTokens are not guaranteed to be replayed into the
 *    next measured input by every provider);
 *  - a later MEASURED beat (a `pre_call` / `post_call` with a different
 *    confirmed usage) is the only thing that moves the bar;
 *  - a projected beat never mutates `lastUsage`;
 *  - attach (reopen) still renders the confirmed persisted reading, no `~`
 *    marker anywhere in the frame.
 */
describe("context_usage 拍的条上序列（confirmed-only / 投影不刷条 / 隔离）", () => {
  const WINDOW = 256_000;

  function confirmedUsage(input: number, output = 0): TokenUsage {
    return {
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
  }

  /** Render the product bar for one session state. */
  async function renderSession(session: TuiSessionState) {
    const setup = await testRender(
      <ContextBar
        lastUsage={session.lastUsage}
        displayOccupancy={session.displayOccupancy}
        contextWindow={WINDOW}
        running={true}
        cols={80}
      />,
      { width: 80, height: 5, consoleMode: "disabled" }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    return frame;
  }

  /** k-value of the numerator (`X.Xk/`), for the raise/drop assertions. */
  function shownK(frame: string): number {
    const match = /(\d+\.\d)k\//.exec(frame);
    if (match === null) throw new Error(`no k-value in frame:\n${frame}`);
    return Number.parseFloat(match[1]!);
  }

  test("projected 拍不刷条；post_call 上确认读数；投影 append/compact 不动；后来 measured 才移动；lastUsage 不被投影改写", async () => {
    const draft = createDraftSession();
    expect(draft.displayOccupancy).toBeNull();
    expect(draft.lastUsage).toBeNull();

    // 1. Projected pre-call (image-bearing request): a client estimate, no
    //    usage — it is a gate input only. Same session identity, no repaint.
    const projectedPre = withContextUsageBeat(draft, {
      type: "context_usage",
      phase: "projected",
      occupancy: { tokens: 20_000, source: "projected" },
    });
    expect(projectedPre).toBe(draft);
    expect(projectedPre.lastUsage).toBeNull();
    expect(projectedPre.displayOccupancy).toBeNull();

    // 2. post_call with a projectedNext: the bar shows the CONFIRMED
    //    input-side occupancy (20,000 → 20.0k / 8%), the `projectedNext`
    //    (20,500) is ignored for display. lastUsage holds the confirmed usage.
    let session = withContextUsageBeat(projectedPre, {
      type: "context_usage",
      phase: "post_call",
      source: "measured",
      usage: confirmedUsage(20_000, 500),
      projectedNext: { tokens: 20_500, source: "projected" },
    });
    expect(session.lastUsage).toEqual(confirmedUsage(20_000, 500));
    expect(session.displayOccupancy).toEqual({
      tokens: 20_000,
      source: "measured",
    });
    const postCallFrame = await renderSession(session);
    expect(shownK(postCallFrame)).toBe(20);
    expect(postCallFrame).toContain("8%");
    // no `~NN%` occupancy marker anywhere in the frame
    expect(postCallFrame).not.toMatch(/~\d+%/);

    // 3. Tool append: the harness re-projects (24,000). The bar stays put —
    //    projected beats are gate-only.
    session = withContextUsageBeat(session, {
      type: "context_usage",
      phase: "projected",
      occupancy: { tokens: 24_000, source: "projected" },
    });
    const appended = await renderSession(session);
    expect(shownK(appended)).toBe(20);
    expect(appended).not.toMatch(/~\d+%/);
    expect(session.lastUsage).toEqual(confirmedUsage(20_000, 500));
    expect(session.displayOccupancy).toEqual({
      tokens: 20_000,
      source: "measured",
    });

    // 4. Compaction: another projected beat (lower unanchored estimate).
    //    Still no repaint.
    session = withContextUsageBeat(session, {
      type: "context_usage",
      phase: "projected",
      occupancy: { tokens: 10_000, source: "projected" },
    });
    const compacted = await renderSession(session);
    expect(shownK(compacted)).toBe(20);
    expect(compacted).not.toMatch(/~\d+%/);
    expect(session.lastUsage).toEqual(confirmedUsage(20_000, 500));

    // 5. Only a later MEASURED beat moves the bar: pre_call 10,000 → 10.0k / 4%.
    session = withContextUsageBeat(session, {
      type: "context_usage",
      phase: "pre_call",
      source: "measured",
      usage: confirmedUsage(10_000),
    });
    const measured = await renderSession(session);
    expect(shownK(measured)).toBe(10);
    expect(measured).toContain("4%");
    expect(measured).not.toMatch(/~\d+%/);
    expect(session.lastUsage).toEqual(confirmedUsage(10_000));
    expect(session.displayOccupancy).toEqual({
      tokens: 10_000,
      source: "measured",
    });

    // 6. Attach (reopen): the UI-only display reading is gone; the confirmed
    //    value renders without the marker until the next measured beat arrives.
    const now = new Date().toISOString();
    const attached = attachSession({
      schemaVersion: 2,
      conversation_id: "conv-projection",
      messages: [],
      jsonMode: false,
      turnCount: 1,
      updatedAt: now,
      title: "projection",
      cwd: "/tmp/proj",
      sanitized_at: now,
      lastUsage: confirmedUsage(20_000, 500),
    });
    expect(attached.displayOccupancy).toBeNull();
    const reopened = await renderSession(attached);
    expect(reopened).toContain("20.0k");
    expect(reopened).not.toMatch(/~\d+%/);
  });
});
