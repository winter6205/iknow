/**
 * tests/tui/copy-flow.test.tsx
 *
 * #238 鼠标拖选复制端到端：mount 一个 resume 会话（assistant 有内容），
 * 向 stdin 注入 SGR 鼠标序列（左键按下 → 拖动 → 释放），断言：
 *  1. 拖选期间 stdout 出现反色高亮（\x1b[7m…\x1b[27m）；
 *  2. 释放后自动调用 copyToClipboard → notice 出现"已复制"。
 *
 * SGR 序列（DECSET 1002h drag 模式）：
 *  - 按下：\x1b[<0;x;yM
 *  - 拖动：\x1b[<32;x;yM
 *  - 释放：\x1b[<3;x;ym
 *
 * 坐标口径：内容流（banner + 消息）从终端第 1 行起；fake stream 终端
 * 100 列 × 30 行。窗口 = 终端全高（viewport = rows - 状态栏 - 输入框…），
 * 因 fake stream 无真实渲染，靠 ChatView onWindow 回调提供 startRow/endRow
 *（startRow=0 通常；endRow = viewport）。
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
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { attachSession } from "../../src/tui/session-state.js";
import { makeDeps } from "../cli/_fixtures.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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

const LONG_TIMEOUT = 30_000;

describe("TuiApp 鼠标拖选复制（#238）", () => {
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  const instances: Instance[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-drag-"));
    stdout = fakeTtyStream();
    stdin = fakeTtyStream();
  }, LONG_TIMEOUT);
  afterEach(async () => {
    for (const ins of instances) ins.unmount();
    instances.length = 0;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  function mountResumedApp(): {
    readonly out: () => string;
    readonly rawOut: () => string;
  } {
    const initial = attachSession({
      conversation_id: "drag-target",
      messages: [
        { role: "user", content: [{ type: "text", text: "请讲个故事" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "第一行故事内容" },
            { type: "text", text: "第二行故事结尾" },
          ],
        },
      ],
      turnCount: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      jsonMode: false,
    });
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
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
        initialSession={initial}
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
      out: (): string => strip(out.join("")),
      rawOut: (): string => out.join(""),
    };
  }

  it(
    "拖选高亮：注入 按下→拖动→释放，stdout 出现反色 \x1b[7m 且非空",
    async () => {
      const { out, rawOut } = mountResumedApp();
      await delay(400);
      await waitFor(
        () => out().includes("请讲个故事"),
        8000,
        "resumed-session-visible"
      );
      // 在 assistant 文本行上按下并拖动（x=5..20, y 取消息区域）。
      // 内容流起始 = 终端行 1；空会话 banner 完整，这里 resume 有消息后
      // banner = 单行短 banner，消息区紧跟其后。
      const pressY = 2; // 尽量选消息区（内容流第 1 行附近）
      const dragY = 2;
      stdin.write(`\x1b[<0;5;${pressY}M`);
      await delay(50);
      stdin.write(`\x1b[<32;20;${dragY}M`);
      await delay(50);
      stdin.write(`\x1b[<3;20;${dragY}m`);
      await waitFor(
        () => rawOut().includes("\x1b[7m") && rawOut().includes("\x1b[27m"),
        8000,
        "inverse-highlight"
      );
      await delay(100);
      expect(rawOut().includes("\x1b[7m")).toBe(true);
    },
    LONG_TIMEOUT
  );

  it(
    "拖选后释放 → 自动复制（notice 出现 已复制/写入/失败 任一）",
    async () => {
      const { out } = mountResumedApp();
      await delay(400);
      await waitFor(
        () => out().includes("请讲个故事"),
        8000,
        "resumed-session-visible"
      );
      // 按下 → 拖动 → 释放
      stdin.write("\x1b[<0;3;2M");
      await delay(50);
      stdin.write("\x1b[<32;10;2M");
      await delay(50);
      stdin.write("\x1b[<3;10;2m");
      // notice 文案三态（ok → "已复制"；fallback → "文本已写入"；error → "复制失败"）
      await waitFor(
        () => /(已复制|文本已写入|复制失败)/.test(out()),
        8000,
        "drag-copy-notice"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "Ctrl+Y 重复制：拖选复制后（选区已清）再 Ctrl+Y → 复制最近选区",
    async () => {
      const { out } = mountResumedApp();
      await delay(400);
      await waitFor(
        () => out().includes("请讲个故事"),
        8000,
        "resumed-session-visible"
      );
      // 拖选 → 自动复制
      stdin.write("\x1b[<0;3;2M");
      await delay(50);
      stdin.write("\x1b[<32;10;2M");
      await delay(50);
      stdin.write("\x1b[<3;10;2m");
      await waitFor(
        () => /(已复制|文本已写入|复制失败)/.test(out()),
        8000,
        "drag-copy-notice"
      );
      // 选区已清；Ctrl+Y 应命中 lastSelectionRef → 再次复制
      stdin.write("\x19");
      await waitFor(
        () => /(已复制|文本已写入|复制失败)/.test(out()),
        8000,
        "ctrl-y-recopy"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "Ctrl+Y 无选区 → 提示先拖选（不复制、无 \x1b[7m）",
    async () => {
      const { out, rawOut } = mountResumedApp();
      await delay(400);
      await waitFor(
        () => out().includes("请讲个故事"),
        8000,
        "resumed-session-visible"
      );
      stdin.write("\x19"); // Ctrl+Y
      await waitFor(
        () => out().includes("无选区"),
        8000,
        "no-selection-notice"
      );
      await delay(100);
      expect(rawOut().includes("\x1b[7m")).toBe(false);
    },
    LONG_TIMEOUT
  );
});
