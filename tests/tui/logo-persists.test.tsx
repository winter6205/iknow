/**
 * tests/tui/_repro_logo_after_send.test.tsx
 *
 * 复现用户最早的主诉：「一开始发消息就会把logo给去掉」。
 * 直接对比空会话 / 发一条消息 后 TUI 输出。
 * 2026-08-08 定稿语义：空会话完整眼；有消息后塌成单行 ◆ iknow 常驻。
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
  it("空会话 → 发一条消息 → logo 仍可见（塌成单行 ◆ iknow 常驻）", async () => {
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

      // 发消息后：banner 塌成单行 `◆ iknow <version>`（2026-08-08 用户裁定
      // 「必须做到完整修复」：矮终端下完整眼 ≈15 行与消息放同一滚动区永远
      // 放不下同一屏，logo 会被顶出屏幕 → 单行常驻保留 logo 标识、把视口
      // 让给消息区。空会话仍是完整眼（见上方 empty-session 断言）。
      const afterText = strip(out.join("")).slice(beforeSend);
      const hasShortBanner = afterText.includes("◆ iknow");
      const hasFullBannerTop = afterText.includes("╭◆ iknow");
      const hasUserMsg = afterText.includes("hello");
      const hasAssistant = afterText.includes("hi back");
      console.log(
        `[发消息后] has◆iknow=${hasShortBanner} has╭◆iknow=${hasFullBannerTop} hasHello=${hasUserMsg} hasAssistant=${hasAssistant}`
      );

      // 核心断言：单行 logo 常驻（不是塌成 0 行），完整眼不再常驻。
      expect(hasShortBanner, "发消息后单行 ◆ iknow 仍可见（logo 不消失）").toBe(
        true
      );
      expect(hasFullBannerTop, "发消息后完整 banner 顶框塌掉（单行语义）").toBe(
        false
      );
      expect(hasUserMsg).toBe(true);
      expect(hasAssistant).toBe(true);
    } finally {
      instance.unmount();
      await rm(baseDir, { recursive: true, force: true });
    }
  }, 30_000);
});
