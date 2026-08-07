/**
 * tests/tui/_repro_logo_after_send.test.tsx
 *
 * 复现用户最早的主诉：「一开始发消息就会把logo给去掉」。
 * 直接对比空会话 / 发一条消息 后 TUI 输出。
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(
  cond: () => boolean,
  ms = 6000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await delay(40);
  }
}

function fakeTty(rows = 24, cols = 80) {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    setRawMode: (v: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  s.setRawMode = (): void => {};
  s.ref = (): void => {};
  s.unref = (): void => {};
  return s;
}

describe("REPRO：发消息后 logo 还在不在？", () => {
  it("空会话 → 发一条消息 → banner 仍可见（sticky 头语义验证）", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "logo-repro-"));
    const stdin = fakeTty(30, 80);
    const stdout = fakeTty(30, 80);
    const out: string[] = [];
    stdout.on("data", (c) => out.push(String(c)));
    const deps = makeDeps([assistantResult({ texts: ["hi back"] })]);
    const bridge = createTuiBridge({
      deps,
      inflight: createInflightRegistry(),
    });
    const instance = render(
      <TuiApp
        bridge={bridge}
        askBridge={createTuiAskUserBridge()}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir={baseDir}
      />,
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    try {
      // 空会话：完整 banner 顶部 ╭◆ iknow─…╮ 应该可见。
      // 全量 suite 并行时 CPU 竞争会拖慢 ink 首帧渲染，超时放宽。
      await waitFor(
        () => strip(out.join("")).includes("╭◆ iknow"),
        15000,
        "empty-session-banner-top"
      );
      const emptyText = strip(out.join(""));
      const emptyHasFullBanner = emptyText.includes("Version");
      const emptyHasTop = emptyText.includes("╭◆ iknow");
      console.log(
        `[空会话] has╭◆iknow=${emptyHasTop} hasVersion=${emptyHasFullBanner}`
      );

      // 锚定当前帧长度 → 发消息
      const beforeSend = out.join("").length;
      // 发一条消息
      for (const ch of "hello\r") {
        stdin.write(ch);
        await delay(10);
      }
      // 等 turn 落盘（userMessageEchoed → turnFinished 后 banner 应切到 compact）
      await waitFor(() => bridge.inflight.ids().size === 0, 8000, "turn-done");
      // 等 assistant 答复渲染进 since-window —— 不用固定 delay(150)：全量
      // suite 并行时 CPU 竞争可能拖慢 re-render 帧，内容出现才是真值信号。
      await waitFor(
        () => strip(out.join("")).slice(beforeSend).includes("hi back"),
        8000,
        "assistant-in-window"
      );

      // 发消息后：banner 仍是完整智慧之眼（方案 B：banner + 消息同 row
      // window，输入框固定在底部）。用户可向上滚看见完整 banner，向下滚与
      // 消息一起滚出。这是 2026-08-07 用户复看裁定最终语义：
      // 「下面对话框要固定，消息跟图标可以向上滚动」。
      const afterText = strip(out.join("")).slice(beforeSend);
      const hasFullBannerTop = afterText.includes("╭◆ iknow");
      const hasInfoPanel = afterText.includes("Version");
      const hasUserMsg = afterText.includes("hello");
      const hasAssistant = afterText.includes("hi back");
      console.log(
        `[发消息后] has╭◆iknow=${hasFullBannerTop} hasVersion=${hasInfoPanel} hasHello=${hasUserMsg} hasAssistant=${hasAssistant}`
      );
      console.log("---after text 末尾 800 字符---");
      console.log(afterText.slice(-800));

      // 核心断言：完整眼始终存在（不是塌成 0 行 / 不是塌成单行）
      expect(
        hasFullBannerTop,
        "发消息后完整 banner 顶部 ╭◆ iknow─…╮ 仍可见（不塌成单行）"
      ).toBe(true);
      expect(
        hasInfoPanel,
        "发消息后完整 banner 的 Version/Cwd/Data dir info 栏仍可见"
      ).toBe(true);
      expect(hasUserMsg).toBe(true);
      expect(hasAssistant).toBe(true);
    } finally {
      instance.unmount();
      await rm(baseDir, { recursive: true, force: true });
    }
  }, 30_000);
});
