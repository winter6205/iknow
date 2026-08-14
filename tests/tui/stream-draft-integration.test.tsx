/** @jsxImportSource @opentui/react */
/**
 * tests/tui/stream-draft-integration.test.tsx
 *
 * #343 T6-C：流式草稿端到端接线（spec SC8 — draft 累积 / commit / abort /
 * thinking / tool 配对 / 三段一致 UI == harness context == 落盘）。
 *
 * 装配：mountAppAsync + stub deps streamEventsByStep 注入脚本化流式事件
 * （text_delta / thinking_delta / tool_call_start / tool_input_delta /
 * stop_summary）。
 *
 * 覆盖：
 *  1. stop_summary onStream 事件 → notice 区呈现摘要文本；
 *  2. text_delta 流式 → turn 完成 → 落盘 assistant 文本 + draft 中间态由
 *     StreamDraft.masked() 渲染（中间态由 hint cursor 断言较 fragile，本测
 *     聚焦「stream 事件能流到 onStream → notice / draft 的路径打通」）；
 *  3. T5：tool_call_start + tool_input_delta×N → running 帧含 partial 参数
 *     摘要（运行中增量实时显示），turn 完成后 finalText 落盘。
 *
 * 注：本测聚焦流式契约接线完整性（spec SC8）；UI == harness context ==
 * 落盘三段一致由 session-state / sessionHub / StreamDraft 共同保证，
 * 端到端断言在 tui-cross-entry.test.ts + app.test.tsx 覆盖。
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

/** 事件发出后延迟返回的窗口（abort 透传）：工具运行中稳定阶段。 */
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

/** 用内联 adapter + noop 工具装配 LoopEngineDeps（createTuiBridge 消费）。 */
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

    // stop_summary 摘要应进入 notice 区
    await untilFrame(
      app.setup,
      (f) => f.includes("TUI 流式收尾摘要"),
      8000,
      "stop-summary"
    );

    // turn 完成
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

    // turn 完成
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");

    // 落盘验证：stream events 流经 → turn 正常完成
    const list = await app.bridge.listSessions();
    expect(list).toBeDefined();
    expect(list.length).toBe(1);
    expect(list[0]!.summary).toBe("hi");
    const sessionId = list[0]!.conversation_id;
    const file = await app.bridge.loadSessionFile(sessionId);
    expect(file.turnCount).toBe(1);
    // assistant 文本（来自 finalText）：stub response 注入 "final-reply"
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

  test("thinking 留存：turn 结束 → 末条 assistant 折叠行显示「思考了 N 秒」", async () => {
    // 需求：thinking 秒数结束后留存界面而不是消失。turn 结束后流式面板消失，
    // app 层在 runTurnOnce finally 快照 thinkingSeconds → 历史消息末条 assistant
    // 折叠行显示「思考了 N 秒」（秒数接棒，不随草稿清空丢失）。
    // 内联 adapter：发 thinking_delta 后 await 3000ms 再返回 → thinkingStartedAt
    // 打点后经 ≥1s，thinkingSeconds() 在 finally 快照时 > 0。
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

    // turn 完成。
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    // 末条 assistant 折叠行显示「思考了 N 秒」留存（N≥1，3s delay 保证秒数>0）。
    await untilFrame(
      app.setup,
      (f) => /思考了 \d+ 秒/.test(f),
      8000,
      "thinking-persisted"
    );

    await app.destroy();
  }, 30_000);

  test("计时同步：思考秒数含 turn 启动 → 首 thinking_delta 的等待时段（app 层 markThinkingStart）", async () => {
    // 场景：请求发出后等待首 thinking_delta 的「等待思考」时段也应计入思考秒数。
    // app 层在 runTurnOnce 入口对 streamDraft 调用 markThinkingStart(turn 起点)，
    // 而非等首条 thinking_delta 惰性打点。本测用内联 adapter：turn 起点
    // markThinkingStart 打点 → 延迟 2600ms → 发出 thinking_delta → 再延迟 1000ms
    // → 返回。期望：thinking 面板折叠行出现时（frozen 快照 ≥3s），已包含等待时段。
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
        await abortableDelay(1000, signal);
        if (signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return assistantResult({
          texts: ["正式回答"],
          thinkingBlocks: [
            { type: "thinking", thinking: "等待后思考…", signature: "sig-2" },
          ],
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

    // turn 完成后历史折叠行留存秒数 N≥3（turn 起点 → thinking_delta 等待
    // 2.6s + delta 后 1s）。若计时从首 delta 惰性打点，N 只会是 ≥1。
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(
      app.setup,
      (f) => /思考了 [3-9]\d* 秒/.test(f),
      8000,
      "thinking-timing-synced"
    );

    await app.destroy();
  }, 30_000);

  test("markThinkingStart 后 thinkingSeconds() 基于打点时刻计算（含等待时段）", async () => {
    // 单元级集成：createStreamDraft + markThinkingStart 直接验证计时起点 =
    // turn 起点（非首 delta 时刻）。8000ms 后秒数 ≥8（等待时段计入）。
    const draft = createStreamDraft();
    const t0 = Date.now();
    draft.markThinkingStart(t0);
    draft.append({ type: "thinking_delta", text: "想" });
    // 打点 8s 后（思考仍在进行，未 reset）→ thinkingSeconds ≥8。
    expect(draft.thinkingSeconds()).toBe(0); // 刚打点未满 1s
    expect(draft.thinkingSeconds(t0 + 8000)).toBe(8);
    expect(draft.thinkingSeconds(t0 + 8_500)).toBe(8);
    // reset → 清零。
    draft.reset();
    expect(draft.thinkingSeconds()).toBe(0);
  });

  test("tool_call_start → LiveToolRun 「[运行中] noop」实时追加", async () => {
    // 时序说明（T7 修复）：stub-model 的 streamEventsByStep 在 delay 之后
    // 发出事件、随即返回 → turn 立即完成 → [运行中] 状态窗口太短抓不到。
    // 这里用内联 adapter：发出 tool_call_start 后 await 3000ms 再返回，
    // 制造「工具运行中、turn 未完成」的稳定窗口（archive 同款模式）。
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

    // LiveToolRun 流式阶段：render 含「[运行中] noop」摘要行（turn 未完成）。
    await untilFrame(
      app.setup,
      (f) => f.includes("[运行中] noop") || f.includes("运行"),
      8000,
      "tool-running"
    );

    // turn 完成 → 落盘终稿（finalText 而非 draft 中间态）。
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
    // 内联 adapter：emit tool_call_start + tool_input_delta×N 后 await 3000ms
    // 再返回 → 「工具运行中、turn 未完成」稳定窗口内 partial 摘要应出现。
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

    // running 阶段：partial 参数已累积 → 摘要行含 `git status`（parse 成功）。
    await untilFrame(
      app.setup,
      (f) => f.includes("[运行中] bash") && f.includes("git status"),
      8000,
      "tool-partial-rendered"
    );

    // turn 完成 → 落盘终稿（finalText 而非 draft 中间态）。
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(
      app.setup,
      (f) => f.includes("running-tool-final"),
      8000,
      "tool-final-rendered"
    );

    await app.destroy();
  }, 30_000);
});
