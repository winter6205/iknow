/**
 * tests/tui/banner-scroll-fixes.test.tsx
 *
 * 2026-08-07 banner-scroll 双 bug 修复的回归电池（systematic-debugging：
 * root-cause → failing test → fix → red-to-green）：
 *  - 空会话完整 banner 在矮终端能看见顶部（不再被窗口切掉，且 useInput
 *    守卫移除后 PgUp/Home/End 在空会话也生效——之前完全冻死）；
 *  - 长会话 PgUp → 行级滚动指示出现；End → 指示消失（diff window 断言）。
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

  it("24 行终端 + initialSession 长会话：PgUp 出现行级指示；End 复位消失", async () => {
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
      await waitFor(
        () => strip(out.join("")).includes("内容第40行"),
        5000,
        "resumed-content"
      );
      // PgUp → 顶部「↑ N 行历史」出现
      stdin.write("[5~"); // PgUp
      await delay(400);
      const m = strip(out.join("")).match(/↑ (\d+) 行历史/);
      expect(m, "PgUp 后应出现行级滚动指示").not.toBeNull();
      const n = Number(m![1]);
      expect(n).toBeGreaterThan(0);
      // End → diff window 断言之后帧不含「行历史」（buffer 累积故不能用 tail）
      const beforeEnd = out.join("").length;
      stdin.write("[F"); // End
      await waitFor(
        () => !strip(out.join("").slice(beforeEnd)).includes("行历史"),
        3000,
        "end-resets-scroll"
      );
    } finally {
      instance.unmount();
      await rm(baseDir, { recursive: true, force: true });
    }
  }, 15_000);
});
