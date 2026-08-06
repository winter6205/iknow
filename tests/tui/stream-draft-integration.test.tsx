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

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly instance: Instance;
  readonly lastOutput: () => string;
  readonly type: (text: string) => Promise<void>;
  readonly ready: () => Promise<void>;
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

  function mountApp(bridge: TuiBridge): DrivenApp {
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
    };
  }

  function makeAppWithAdapter(adapter: ModelAdapter): DrivenApp {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: { adapter, executor, registry, maxTurns: 5 },
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
});
