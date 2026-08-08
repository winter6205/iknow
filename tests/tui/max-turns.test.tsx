/**
 * tests/tui/max-turns.test.tsx
 *
 * plan T6: TUI 适配 MaxTurnsExceeded throw + stop_summary 呈现。
 *
 * 流程:mount TuiApp + stub deps maxTurns=1 → 发消息 → runTurnOnce 路径:
 *   1. bridge.postMessage → hub.postMessage;hub 侧 wrapper 捕获 stop_summary
 *      并**原样转发**给 runTurnOnce onStream;
 *   2. hub catch MaxTurnsExceeded → 返回 stopReason="maxTurns" turn DTO
 *      (bridge.postMessage 不 reject);
 *   3. runTurnOnce onStream 收到 stop_summary → setNotice({ lines: [text] }),
 *      摘要进入 notice 区。
 *
 * 断言:notice 含摘要文本;turn 完成后 inflight 清空;无 unhandledRejection。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
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
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import { createStubTool } from "../../src/harness/stubs/stub-tool.js";
import { createRegistry } from "../../src/harness/tools/registry.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import type { LoopEngineDeps } from "../../src/harness/index.js";
import { assistantResult } from "../cli/_fixtures.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  stream.setRawMode = (): void => undefined;
  stream.ref = (): void => undefined;
  stream.unref = (): void => undefined;
  return stream;
}

describe("TUI maxTurns (plan T6)", () => {
  const LONG_TIMEOUT = 30_000;
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  const instances: Instance[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-max-turns-"));
    stdout = fakeTtyStream();
    stdin = fakeTtyStream();
  }, LONG_TIMEOUT);
  afterEach(async () => {
    for (const instance of instances) instance.unmount();
    instances.length = 0;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  /**
   * 照 tests/tui/app.test.tsx 模式 mount TuiApp,提供 stream/delay helpers。
   * 用 stub deps:maxTurns=1 + script (tool-call, 摘要) → 第 2 轮 throw,
   * hub 侧 catch,bridge.postMessage 不 reject → TUI 的 onStream 接到
   * stop_summary → setNotice。
   */
  function mountWithMaxTurns(): {
    bridge: TuiBridge;
    instance: Instance;
    lastOutput: () => string;
    type: (text: string) => Promise<void>;
    ready: () => Promise<void>;
  } {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = createStubModel({
      responses: [
        // 第 1 轮 tool-call
        assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
        }),
        // 摘要 epilogue
        assistantResult({
          texts: ["TUI 收尾摘要：已达上限"],
          toolCalls: [],
        }),
      ],
    });
    const deps: LoopEngineDeps = {
      adapter,
      executor,
      registry,
      maxTurns: 1,
    };
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps,
      inflight: createInflightRegistry(),
    });
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
        permissionMode={createPermissionModeContext("default")}
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

  // unhandledRejection 监探(hub 侧 catch 后,TUI 不应再看到 throw;该监听无触发
  // 即为契约)。
  const rejections: unknown[] = [];
  function captureRejections(): () => void {
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);
    return () => process.off("unhandledRejection", listener);
  }

  it(
    "maxTurns=1: notice 含收尾摘要,turn 正常落幕,无 unhandledRejection",
    async () => {
      const unhook = captureRejections();
      const app = mountWithMaxTurns();
      await app.ready();

      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 提交消息 → turn 跑出 maxTurns → hub catch → bridge 不 reject →
      // runTurnOnce 接 stop_summary → setNotice。
      await app.type("go\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      // notice 区呈现摘要文本
      await waitFor(
        () => app.lastOutput().includes("TUI 收尾摘要：已达上限"),
        8000,
        "summary-notice"
      );
      // 摘要文本被 hook(setNotice)保留到下一次 sendTurn;此处只断言存在性
      expect(app.lastOutput()).toContain("TUI 收尾摘要：已达上限");

      // 给可能迟到的 unhandledRejection 一个 timeout 窗口
      await delay(500);
      assert.deepEqual(
        rejections,
        [],
        `不应有 unhandledRejection(实际: ${rejections.map(String).join(", ")})`
      );
      unhook();
    },
    LONG_TIMEOUT
  );
});
