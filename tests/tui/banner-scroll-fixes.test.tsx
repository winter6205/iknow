/**
 * tests/tui/banner-scroll-fixes.test.tsx
 *
 * 2026-08-07 banner-scroll 双 bug 修复的回归电池（systematic-debugging：
 * root-cause → failing test → fix → red-to-green）：
 *  - 空会话完整 banner 在矮终端能看见顶部（不再被窗口切掉，且 useInput
 *    守卫移除后 PgUp/Home/End 在空会话也生效——之前完全冻死）；
 *  - 长会话 PgUp → 窗口上移，底部末段被裁（diff window 断言新帧不含末段）；
 *    End → 窗口回到底，末段恢复（朴素滚动，2026-08-07 移除所有指示文案）。
 *
 * 单元窄终端 short 档回归见 render-smoke.test.tsx
 * 「窄终端 SHORT 档也保留单行」。
 */
import { describe, expect, it } from "vitest";
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
import { makeDeps } from "../cli/_fixtures.js";

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

describe("banner + scroll 修复回归（2026-08-07）", () => {
  it("空会话 24 行终端：完整 banner 顶部可见（不再被窗口切到只剩底部 5 行）", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-banner-"));
    const stdin = fakeTty(24, 80);
    const stdout = fakeTty(24, 80);
    const out: string[] = [];
    stdout.on("data", (c) => out.push(String(c)));
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
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
      // 等完整 banner 顶部 ╭◆ iknow─…╮ 渲染出来。
      // 旧实现：viewport=5，banner 16 行被切到只剩底部 5 行 → 顶部从未出现。
      await waitFor(
        () => strip(out.join("")).includes("╭◆ iknow"),
        5000,
        "banner-top"
      );
      const text = strip(out.join(""));
      // 完整 banner 还应包含 info 栏（Version/Cwd/Data dir）
      expect(text).toContain("Version");
      expect(text).toContain("Data dir");
    } finally {
      instance.unmount();
      await rm(baseDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("24 行终端 + initialSession 长会话：PgUp 窗口上移 → 顶部老内容进入；End 回到底", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-banner-"));
    const stdin = fakeTty(24, 80);
    const stdout = fakeTty(24, 80);
    const out: string[] = [];
    stdout.on("data", (c) => out.push(String(c)));
    const { attachSession } = await import("../../src/tui/session-state.js");
    const body = Array.from({ length: 40 }, (_, i) => `内容第${i + 1}行`).join(
      "\n"
    );
    const initial = attachSession({
      conversation_id: "resumed-session",
      messages: [
        { role: "user", content: [{ type: "text", text: "resumed-q" }] },
        { role: "assistant", content: [{ type: "text", text: body }] },
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
    const instance = render(
      <TuiApp
        bridge={bridge}
        askBridge={createTuiAskUserBridge()}
        toolEventSink={createToolEventSink()}
        initialSession={initial}
        cwd="/tmp/proj"
        dataDir={baseDir}
      />,
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    try {
      await delay(400);
      // 等 mount + initialSession 渲染完。contentRows = banner(15~16) + user(2) +
      // assistant(40 + 1 = 41) ≈ 58~59。viewportRows = 24 - reserved(4) = 20。
      // maxScroll ≈ 38。scroll=0：窗口 [~38, 58)，最新末段「内容第40行」可见。
      // 用 assistant 内容行作窗口 sentinel（「内容第40行」只出现在 assistant
      // 内容里，状态栏会话摘要 = user 文本，不冲突）。
      await waitFor(
        () => strip(out.join("")).includes("内容第40行"),
        5000,
        "resumed-content"
      );
      // 初始 scrollRows=0（auto-follow 底）：最新末段可见
      expect(strip(out.join("")).slice(-2000)).toContain("内容第40行");

      // PgUp → 窗口上移 step=floor(20/2)=10 → scroll=10。末段「内容第40行」
      // 被窗口底切（diff-window 断言新帧不含该行）。
      // 必须等 PgUp 后 ink re-render 稳定（400ms）再 anchor End，否则中间瞬态帧
      // 会让 End anchor 错过 a4/末段恢复帧。
      const beforePgUp = out.join("").length;
      stdin.write("[5~"); // PgUp
      await waitFor(
        () => !strip(out.join("").slice(beforePgUp)).includes("内容第40行"),
        5000,
        "pgup-window-slide"
      );
      await delay(400); // 等 PgUp re-render 稳定
      expect(strip(out.join("").slice(beforePgUp))).not.toContain("内容第40行");

      // End → scroll=0（auto-follow 底）：末段「内容第40行」恢复。
      const beforeEnd = out.join("").length;
      stdin.write("[F"); // End
      await waitFor(
        () => strip(out.join("").slice(beforeEnd)).includes("内容第40行"),
        3000,
        "end-restores-bottom"
      );
    } finally {
      instance.unmount();
      await rm(baseDir, { recursive: true, force: true });
    }
  }, 15_000);
});
