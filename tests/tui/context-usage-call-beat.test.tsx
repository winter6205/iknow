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
import { attachSession } from "../../src/tui/session-state.js";
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
  CountTokensInput,
  LoopEngineDeps,
  LoopState,
  ModelAdapter,
  TokenUsage,
} from "../../src/harness/index.js";
import type { ToolExecutionResult } from "../../src/harness/tools/types.js";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Scripted adapter: call #1 asks for the slow tool and carries usage #1;
 *  call #2 answers with usage #2. countTokens reports a distinct measured
 *  pre-call number per beat so the pre_call events are real readings. */
function callBeatAdapter(): ModelAdapter {
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

function slowToolDeps(adapter: ModelAdapter): LoopEngineDeps {
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
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await delay(50);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
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
    // must carry call #1's real usage (12.8k) before the turn finishes.
    await untilFrame(setup, (f) => f.includes("12.8k"), 8000);
    expect(bridge.inflight.ids().size).toBeGreaterThan(0);

    // Turn over → the bar stands at call #2's reading (19.2k).
    await until(() => bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(setup, (f) => f.includes("19.2k"), 8000);

    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }, 30_000);
});

/** Scripted 3-beat adapter: calls #1/#2 demand the slow tool and carry
 *  distinct usage; call #3 closes the turn. Each post_call reading must
 *  reach the bar before the next call is issued (call-beat, #1079 T6). */
function threeCallAdapter(): ModelAdapter {
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
    // before call #2 is issued.
    await untilFrame(setup, (f) => f.includes("12.8k"), 8000);
    expect(bridge.inflight.ids().size).toBe(1);

    // Beat 2: the bar already moved again while the turn is still running
    // (call #2's reading during its tool loop, before call #3 is issued).
    await untilFrame(setup, (f) => f.includes("19.2k"), 8000);
    expect(bridge.inflight.ids().size).toBe(1);

    // Turn over → final call's reading.
    await until(() => bridge.inflight.ids().size === 0, 12_000, "turn-done");
    await untilFrame(setup, (f) => f.includes("25.6k"), 8000);
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
    if (!bar.renderer.isDestroyed) bar.renderer.destroy();

    // Reopen, web load path: the replayed last turn carries the same reading.
    const { turns } = await bridge.hub.getSession(conversationId!);
    expect(turns.length).toBeGreaterThan(0);
    const lastAnswer = turns[turns.length - 1]!.answer;
    expect(lastAnswer.lastUsage?.inputTokens).toBe(25600);
  }, 60_000);
});
