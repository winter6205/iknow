/**
 * tests/tui/app-tool-event-wiring.test.tsx
 *
 * #298 T4/T5 HIGH 修复：app.tsx post_tool_use 处理器必须把
 * `TuiToolEvent.payload.{oldContent,newContent}`（deps.ts:139 由
 * result.meta 落入）透传给 `liveToolReduce` 事件，否则 liveToolRuns 条目
 * 的 oldContent / newContent 会是 undefined，live-tool-preview.tsx:37-40
 * 落回 intent-diff 兜底（input.old_str / new_str），丢失「写盘前后精确全文
 * diff」这条观测 side-channel。
 *
 * 手动 live smoke（`npm run dev -- chat`）无法在非交互环境驱动，本测试是
 * headless 等价物：驱动真实 TuiApp 装配路径（ink render + toolEventSink），
 * 断言 sink 事件携带 payload 时，渲染的 diff 采纳 payload 精确内容而非
 * 输入片段兜底。
 *
 * 判别设计：input.old_str / new_str 与 payload 的 oldContent / newContent
 * 用彼此不同的 marker。若 wiring 完好，渲染出现 payload 的
 * `+PAYLOAD-NEW` / `-PAYLOAD-OLD`；若 wiring 缺失（回归），渲染只出现
 * 兜底 marker（`+FALLBACK-NEW`），断言的 PAYLOAD marker 缺席 → 失败。
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
import { makeDeps } from "../cli/_fixtures.js";
import type { TuiSessionState } from "../../src/tui/session-state.js";

const CONV_ID = "conv-wiring-test";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly instance: Instance;
  readonly lastOutput: () => string;
  readonly type: (text: string) => Promise<void>;
  readonly ready: () => Promise<void>;
  readonly toolEventSink: ReturnType<typeof createToolEventSink>;
}

describe("TuiApp post_tool_use 事件 wiring（#298 payload → oldContent/newContent）", () => {
  const LONG_TIMEOUT = 30_000;
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  const instances: Instance[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-wiring-"));
    stdout = fakeTtyStream();
    stdin = fakeTtyStream();
  }, LONG_TIMEOUT);

  afterEach(async () => {
    for (const instance of instances) instance.unmount();
    instances.length = 0;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  /**
   * 用固定 conversationId 的 initialSession 挂载：draft 会话 conversationId
   * 为 undefined（liveToolRuns 无法归因），而 postToolUse 配对事件需要
   * 具体会话 id。不驱动真实 turn（stub model 瞬时完成无 in-flight 窗口），
   * 直接对 sink 发事件测 wiring。
   */
  function mountApp(bridge: TuiBridge): DrivenApp {
    const askBridge = createTuiAskUserBridge();
    const toolEventSink = createToolEventSink();
    const initialSession: TuiSessionState = {
      conversationId: CONV_ID,
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
      runState: "idle",
      lastStopReason: undefined,
      lastUsage: null,
    };
    const out: string[] = [];
    stdout.on("data", (chunk) => out.push(String(chunk)));
    const instance = render(
      <TuiApp
        bridge={bridge}
        askBridge={askBridge}
        toolEventSink={toolEventSink}
        initialSession={initialSession}
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

  function makeApp(): DrivenApp {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    return mountApp(bridge);
  }

  it(
    "sink 事件携带 payload → liveToolRuns 渲染 diff 采纳 payload 精确内容（非输入片段兜底）",
    async () => {
      const app = makeApp();
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 判别 marker：input 片段（兜底路径）与 payload 精确内容（正确路径）
      // 用不同文本。若 wiring 缺失，渲染只出现 FALLBACK 而 PAYLOAD 缺席。
      const FALLBACK_OLD = "FALLBACK-OLD\n";
      const FALLBACK_NEW = "FALLBACK-NEW\n";
      const PAYLOAD_OLD = "PAYLOAD-OLD\n";
      const PAYLOAD_NEW = "PAYLOAD-NEW\n";

      app.toolEventSink.emit({
        conversationId: CONV_ID,
        toolName: "edit_file",
        toolUseId: "tu-1",
        kind: "ok",
        input: { path: "a.ts", old_str: FALLBACK_OLD, new_str: FALLBACK_NEW },
        message: "编辑 a.ts",
        payload: { oldContent: PAYLOAD_OLD, newContent: PAYLOAD_NEW },
      });

      // 渲染出精确内容 diff（wiring 完好）。diff 行带 `-`/`+` 前缀，与
      // 状态行的 intent 摘要（`FALLBACK-OLD → FALLBACK-NEW`，无前缀）区分开。
      await waitFor(
        () => app.lastOutput().includes("+PAYLOAD-NEW"),
        8000,
        "payload-new-content-rendered"
      );
      expect(app.lastOutput()).toContain("-PAYLOAD-OLD");
      expect(app.lastOutput()).toContain("+PAYLOAD-NEW");
      // 兜底片段不得作为 diff 行出现（`-FALLBACK-OLD` / `+FALLBACK-NEW`）——
      // 证明 diff 采纳了 payload 精确全文而非 input.old_str/new_str 兜底。
      expect(app.lastOutput()).not.toContain("-FALLBACK-OLD");
      expect(app.lastOutput()).not.toContain("+FALLBACK-NEW");
    },
    LONG_TIMEOUT
  );
});
