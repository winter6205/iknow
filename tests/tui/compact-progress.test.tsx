/** @jsxImportSource @opentui/react */
/**
 * tests/tui/compact-progress.test.tsx
 *
 * Acceptance table for the compact progress panel:
 *  - pure functions: reduceCompactionEvent state machine / compactBarFill
 *    asymptotic time estimate / compactStatusText status-line copy /
 *    start·settle terminal entries;
 *  - render smoke: CompactProgress component (frame capture via the real
 *    renderer);
 *  - English copy: compactNoticeFor all-English branches + chromeReserveRows
 *    compactRows accounting (compact-progress.tsx side).
 *
 * Certified invariants:
 *  1. events are the fast path, the promise result is the terminal authority
 *     — event-less endings (pre-abort early return) and catch must both
 *     reach a terminal state, never leaving a 95% fake in-flight state;
 *  2. once terminal is established, late events are ignored (reference
 *     equality, state unchanged);
 *  3. the bar is a **time estimate, not real progress** (the harness emits
 *     no progress signal; stream.ts:43-52 has only 5 discrete events) —
 *     capped at 0.95, only completed reaches 1.0;
 *  4. non-compaction events return identity (the app layer uses this for a
 *     reference-equality guard, avoiding pointless re-renders).
 */
import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "stream";
import { act } from "react";
import {
  createCliRenderer,
  type CapturedFrame,
  type CliRendererConfig,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import {
  COMPACT_BAR_MAX_FILL,
  COMPACT_HOLD_MS,
  COMPACT_TAU_MS,
  CompactProgress,
  compactBarFill,
  compactHintText,
  compactProgressRows,
  compactStatusText,
  reduceCompactionEvent,
  settleCompactPanel,
  startCompactPanel,
  type CompactProgressState,
} from "../../src/tui/compact-progress.js";
import {
  chromeReserveRows,
  compactCancelledNotice,
  compactFailedNoticePrefix,
  compactGuardNoticeFor,
  compactNoticeFor,
  type CompactGuard,
} from "../../src/tui/app.js";
import { PICKER_WIDTH } from "../../src/tui/thinking-picker.js";
import { tuiPalette } from "../../src/tui/theme.js";

const T0 = 1_700_000_000_000;

function started(droppedCount: number): HarnessStreamEvent {
  return { type: "compaction_started", droppedCount };
}

describe("reduceCompactionEvent（状态机，plan D3）", () => {
  test("case 1 happy：started{droppedCount:12} → completed；读条随 elapsed 单调不减，completed 后 fill=1.0 / 状态 done", () => {
    const s1 = reduceCompactionEvent(undefined, started(12), {
      source: "manual",
      nowMs: T0,
    });
    expect(s1).toBeDefined();
    expect(s1!.droppedCount).toBe(12);
    expect(s1!.source).toBe("manual");
    expect(s1!.startedAt).toBe(T0);
    expect(s1!.terminal).toBeNull();

    // The bar is monotonic: increasing elapsed → non-decreasing fill.
    let prev = compactBarFill(0);
    for (const elapsed of [1_000, 4_000, 8_000, 12_000, 60_000, 600_000]) {
      const fill = compactBarFill(elapsed);
      expect(fill).toBeGreaterThanOrEqual(prev);
      prev = fill;
    }

    // Terminal completed → fill 1.0 (the component passes the flag when
    // terminal.kind === "done").
    const done = reduceCompactionEvent(
      s1,
      { type: "compaction_completed", summaryLen: 99, durationMs: 5_000 },
      {
        source: "manual",
        nowMs: T0 + 5_000,
      }
    );
    expect(done).toBeDefined();
    expect(done!.terminal).toEqual({ kind: "done", atMs: T0 + 5_000 });
    expect(compactStatusText(done!, T0 + 5_000)).toBe("✓  5s · done");
  });

  test("case 2 empty：started{droppedCount:0} → 面板建立（0 条合法），状态行仍渲染 preparing", () => {
    const s = reduceCompactionEvent(undefined, started(0), {
      source: "manual",
      nowMs: T0,
    });
    expect(s).toBeDefined();
    expect(s!.droppedCount).toBe(0);
    expect(compactStatusText(s!, T0)).toBe("◐  0s · preparing");
    // No crash: later events can still be reduced.
    const done = reduceCompactionEvent(
      s,
      { type: "compaction_completed", summaryLen: 1, durationMs: 10 },
      { source: "manual", nowMs: T0 + 1_000 }
    );
    expect(done!.terminal?.kind).toBe("done");
  });

  test("case 3 negative：compactBarFill(-5000) 钳制到 0；fills ∈ [0, 0.95]", () => {
    expect(compactBarFill(-5_000)).toBeGreaterThanOrEqual(0);
    expect(compactBarFill(-5_000)).toBe(compactBarFill(0));
    for (const e of [-100_000, -1, 0, 1, 1_000, 12_000, 100_000, 1e9]) {
      const fill = compactBarFill(e);
      expect(fill).toBeGreaterThanOrEqual(0);
      expect(fill).toBeLessThanOrEqual(COMPACT_BAR_MAX_FILL);
    }
    // A negative elapsed clamps the status line to 0s as well (startedAt in
    // the future).
    const s = startCompactPanel("turn", T0);
    expect(compactStatusText(s, T0 - 5_000)).toBe("◐  0s · preparing");
  });

  test("case 4 无事件终局：仅 settle('cancelled')（pre-abort 早返回路径）→ cancelled 终态，无 started 也不留伪在途", () => {
    const s = startCompactPanel("manual", T0);
    const settled = settleCompactPanel(s, "cancelled", T0 + 300);
    expect(settled.terminal).toEqual({ kind: "cancelled", atMs: T0 + 300 });
    expect(compactStatusText(settled, T0 + 300)).toBe("—  0s · cancelled");
  });

  test("case 5 catch：settle('failed') → failed 终态，状态行 ✗ + summary failed", () => {
    const s = startCompactPanel("manual", T0);
    const settled = settleCompactPanel(s, "failed", T0 + 7_000);
    expect(settled.terminal?.kind).toBe("failed");
    expect(compactStatusText(settled, T0 + 7_000)).toBe(
      "✗  7s · summary failed"
    );
  });

  test("case 6 迟到事件：终态后到达的 started / text_delta / completed 一律忽略（引用相等）", () => {
    const s = settleCompactPanel(
      startCompactPanel("manual", T0),
      "done",
      T0 + 1_000
    );
    const late: ReadonlyArray<HarnessStreamEvent> = [
      started(99),
      { type: "compaction_text_delta", text: "late" },
      { type: "compaction_completed", summaryLen: 1, durationMs: 1 },
      { type: "compaction_failed", reason: "late", durationMs: 1 },
      { type: "compaction_cancelled" },
    ];
    for (const ev of late) {
      expect(
        reduceCompactionEvent(s, ev, { source: "manual", nowMs: T0 + 9_000 })
      ).toBe(s);
    }
  });

  test("case 7 终局缺失：终态前 settle('done') → done 终态优先于任何迟到事件", () => {
    const s = settleCompactPanel(
      startCompactPanel("turn", T0),
      "done",
      T0 + 2_000
    );
    expect(s.terminal?.kind).toBe("done");
    // A late started must not pull the panel back to running.
    expect(
      reduceCompactionEvent(s, started(7), {
        source: "turn",
        nowMs: T0 + 3_000,
      })
    ).toBe(s);
  });

  test("case 8 并发：两个 conversationId 各自 reduce，互不影响（keyed 投影）", () => {
    const a = reduceCompactionEvent(undefined, started(3), {
      source: "turn",
      nowMs: T0,
    });
    const b = reduceCompactionEvent(undefined, started(8), {
      source: "manual",
      nowMs: T0 + 1_000,
    });
    expect(a!.droppedCount).toBe(3);
    expect(b!.droppedCount).toBe(8);
    expect(a!.source).toBe("turn");
    expect(b!.source).toBe("manual");
    // Each ends with its own outcome, no cross-talk.
    const aDone = reduceCompactionEvent(
      a,
      { type: "compaction_completed", summaryLen: 1, durationMs: 1 },
      { source: "turn", nowMs: T0 + 2_000 }
    );
    expect(aDone!.terminal?.kind).toBe("done");
    expect(aDone!.droppedCount).toBe(3);
    expect(b!.terminal).toBeNull();
    expect(b!.startedAt).toBe(T0 + 1_000);
  });

  test("case 9 no-op：compacted:false 非 cancelled → app 立即清除（settle 不被调用；纯函数侧守住无伪造终态）", () => {
    // The no-op path emits no compaction events → reduce receives undefined
    // and builds no panel.
    for (const ev of [
      { type: "compaction_text_delta", text: "x" } as const,
      { type: "compaction_cancelled" } as const,
    ]) {
      expect(
        reduceCompactionEvent(undefined, ev, { source: "manual", nowMs: T0 })
      ).toBeUndefined();
    }
    // A terminal reducer never invents state from nothing.
    expect(
      reduceCompactionEvent(
        undefined,
        { type: "compaction_completed", summaryLen: 1, durationMs: 1 },
        {
          source: "manual",
          nowMs: T0,
        }
      )
    ).toBeUndefined();
  });

  test("case 10 未 terminated 清扫：turn finally 仍非终态 → app 立即清除（settle 前状态可判别）", () => {
    const s = reduceCompactionEvent(undefined, started(5), {
      source: "turn",
      nowMs: T0,
    });
    // The "needs sweep" criterion = terminal === null (the app finally
    // clears on it).
    expect(s!.terminal).toBeNull();
    // settle is idempotent: settling an already-terminal state changes
    // nothing (reference equality, atMs not reset).
    const done = settleCompactPanel(s!, "done", T0 + 1_000);
    expect(settleCompactPanel(done, "failed", T0 + 9_000)).toBe(done);
  });
});

describe("compactBarFill / compactStatusText / hint（纯函数 SSOT）", () => {
  test("compactBarFill：t=0 起点 0.05；渐近上限 0.95（COMPACT_BAR_MAX_FILL）", () => {
    expect(compactBarFill(0)).toBeCloseTo(0.05, 10);
    expect(compactBarFill(COMPACT_TAU_MS)).toBeCloseTo(
      0.05 + 0.9 * (1 - Math.exp(-1)),
      10
    );
    expect(compactBarFill(10 * COMPACT_TAU_MS)).toBeLessThanOrEqual(
      COMPACT_BAR_MAX_FILL
    );
    expect(compactBarFill(10 * COMPACT_TAU_MS)).toBeGreaterThan(0.9);
  });

  test("compactStatusText：running（有/无 droppedCount）/ done / failed / cancelled 全分支", () => {
    const running = startCompactPanel("manual", T0);
    expect(compactStatusText(running, T0 + 12_300)).toBe("◐  12s · preparing");
    expect(
      compactStatusText({ ...running, droppedCount: 48 }, T0 + 12_300)
    ).toBe("◐  12s · 48 messages folded");

    const done = settleCompactPanel(running, "done", T0 + 12_000);
    expect(compactStatusText(done, T0 + 12_300)).toBe("✓  12s · done");
    const failed = settleCompactPanel(running, "failed", T0 + 12_000);
    expect(compactStatusText(failed, T0 + 12_300)).toBe(
      "✗  12s · summary failed"
    );
    const cancelled = settleCompactPanel(running, "cancelled", T0 + 12_000);
    expect(compactStatusText(cancelled, T0 + 12_300)).toBe(
      "—  12s · cancelled"
    );
  });

  test("compactHintText：manual → [Esc] cancel；turn → [Esc] interrupt（无独立取消通道）", () => {
    expect(compactHintText("manual")).toBe("[Esc] cancel");
    expect(compactHintText("turn")).toBe("[Esc] interrupt");
  });

  test("常量钉住：COMPACT_BAR_MAX_FILL=0.95 / COMPACT_TAU_MS=12000 / COMPACT_HOLD_MS=1200", () => {
    expect(COMPACT_BAR_MAX_FILL).toBe(0.95);
    expect(COMPACT_TAU_MS).toBe(12_000);
    expect(COMPACT_HOLD_MS).toBe(1_200);
  });

  test("非 compaction 事件 → identity（同一引用，app 引用相等守卫的依据）", () => {
    const s = startCompactPanel("turn", T0);
    const others: ReadonlyArray<HarnessStreamEvent> = [
      { type: "text_delta", text: "hi" },
      { type: "thinking_delta", text: "hmm" },
      { type: "tool_call_start", name: "noop", id: "t1" },
      { type: "stop_summary", text: "s" },
    ];
    for (const ev of others) {
      expect(
        reduceCompactionEvent(s, ev, { source: "turn", nowMs: T0 + 500 })
      ).toBe(s);
    }
    // undefined + a non-compaction event → still undefined (no panel).
    expect(
      reduceCompactionEvent(
        undefined,
        { type: "text_delta", text: "x" },
        {
          source: "turn",
          nowMs: T0,
        }
      )
    ).toBeUndefined();
  });

  test("compaction_text_delta 恒 identity（活动信号；不推进任何状态）", () => {
    const s = startCompactPanel("manual", T0);
    expect(
      reduceCompactionEvent(
        s,
        { type: "compaction_text_delta", text: "a" },
        {
          source: "manual",
          nowMs: T0 + 5_000,
        }
      )
    ).toBe(s);
  });

  test("started 已在途（非终态）→ 更新 droppedCount，保留 source/startedAt（不重置计时）", () => {
    const s = startCompactPanel("turn", T0);
    const next = reduceCompactionEvent(s, started(17), {
      source: "manual", // a late manual reduce must not rewrite source (panel ownership already decided)
      nowMs: T0 + 9_000,
    });
    expect(next).not.toBe(s);
    expect(next!.droppedCount).toBe(17);
    expect(next!.source).toBe("turn");
    expect(next!.startedAt).toBe(T0);
  });
});

// ── Render smoke (real renderer) ───────────────────────────────────────────

/** Test-only stdout (Writable + isTTY + columns/rows); never touches
 *  process.stdout. */
class TestWriteStream extends Writable {
  readonly isTTY = true;
  columns: number;
  rows: number;
  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  _write(_chunk: unknown, _encoding: string, callback: () => void): void {
    callback();
  }
  getColorDepth(): number {
    return 24;
  }
}

/** Mount CompactProgress on a real memory-buffered renderer; return one
 *  plain-text frame. */
async function renderPanelText(
  state: CompactProgressState,
  cols = 80
): Promise<string> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
  const stdout = new TestWriteStream(cols, 24) as unknown as NodeJS.WriteStream;
  const config: CliRendererConfig = {
    stdin,
    stdout,
    width: cols,
    height: 24,
    bufferedOutput: "memory",
    screenMode: "main-screen",
    consoleMode: "disabled",
    exitOnCtrlC: false,
  };
  const renderer = await createCliRenderer(config);
  const root = createRoot(renderer);
  try {
    act(() => {
      root.render(<CompactProgress state={state} />);
    });
    await renderer.loop();
    const bytes = renderer.currentRenderBuffer.getRealCharBytes(true);
    return new TextDecoder().decode(bytes);
  } finally {
    act(() => root.unmount());
    renderer.destroy();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

/** hex → "r,g,b" (0..255 integers), for span background comparison. */
function hexRgb(hex: string): string {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ].join(",");
}

/**
 * Fill detection for bar cells: the glyph is always `█` (the dry track is
 * drawn with █ too); unfilled cells = dry track (bg = pal.border), filled
 * cells = purple gradient / terminal color (bg necessarily leaves border).
 * So background is the only discriminator — which is exactly the visible
 * proof that the time estimate does not fake progress.
 */
function countBarCells(frame: CapturedFrame): {
  readonly filled: number;
  readonly dry: number;
} {
  const dryRgb = hexRgb(tuiPalette.border);
  let filled = 0;
  let dry = 0;
  for (const line of frame.lines) {
    for (const span of line.spans) {
      const n = [...span.text].filter((c) => c === "█").length;
      if (n === 0) continue;
      const bg = [
        Math.round(span.bg.r * 255),
        Math.round(span.bg.g * 255),
        Math.round(span.bg.b * 255),
      ].join(",");
      if (bg === dryRgb) dry += n;
      else filled += n;
    }
  }
  return { filled, dry };
}

async function renderPanelCells(
  state: CompactProgressState,
  cols = 80
): Promise<{ readonly filled: number; readonly dry: number }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
  const stdout = new TestWriteStream(cols, 24) as unknown as NodeJS.WriteStream;
  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: cols,
    height: 24,
    bufferedOutput: "memory",
    screenMode: "main-screen",
    consoleMode: "disabled",
    exitOnCtrlC: false,
  });
  const root = createRoot(renderer);
  try {
    act(() => {
      root.render(<CompactProgress state={state} />);
    });
    await renderer.loop();
    // Filled and unfilled cells share the `█` glyph; bg is the only
    // discriminator — read the span breakdown of the render buffer directly
    // (the fixture uses the real createCliRenderer, no testRender setup).
    const buffer = renderer.currentRenderBuffer;
    return countBarCells({
      cols: buffer.width,
      rows: buffer.height,
      cursor: [0, 0],
      lines: buffer.getSpanLines(),
    });
  } finally {
    act(() => root.unmount());
    renderer.destroy();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

describe("CompactProgress 渲染（design-25 视觉 smoke）", () => {
  test("case 11：帧含 Compacting 标题 / ╭╰ 圆角框 / █ 填充 / [Esc] cancel", async () => {
    const frame = await renderPanelText({
      ...startCompactPanel("manual", Date.now() - 12_000),
      droppedCount: 48,
    });
    expect(frame).toContain("Compacting");
    expect(frame).toContain("╭");
    expect(frame).toContain("╰");
    expect(frame).toContain("█");
    expect(frame).toContain("[Esc] cancel");
    expect(frame).toContain("48 messages folded");
  });

  test("case 12：宽度 = PICKER_WIDTH（50），不随 cols 变（与 effort 面板同宽）", async () => {
    const state = startCompactPanel("manual", Date.now());
    const narrow = await renderPanelText(state, 60);
    const wide = await renderPanelText(state, 120);
    const topNarrow = narrow.split("\n").find((l) => l.includes("╭"));
    const topWide = wide.split("\n").find((l) => l.includes("╭"));
    expect(topNarrow).toBeDefined();
    expect(topWide).toBeDefined();
    expect(topNarrow!.trimEnd().length).toBe(PICKER_WIDTH);
    expect(topWide!.trimEnd().length).toBe(PICKER_WIDTH);
    expect(topNarrow!.startsWith("╭")).toBe(true);
  });

  test("case 13：failed 帧 ✗ 状态行可见；done 帧 ✓；cancelled 帧 —", async () => {
    const base = startCompactPanel("manual", Date.now() - 12_000);
    const failed = await renderPanelText(
      settleCompactPanel(base, "failed", Date.now())
    );
    expect(failed).toContain("✗");
    expect(failed).toContain("summary failed");
    expect(failed).not.toContain("✓");

    const done = await renderPanelText(
      settleCompactPanel(base, "done", Date.now())
    );
    expect(done).toContain("✓");
    expect(done).toContain("done");

    const cancelled = await renderPanelText(
      settleCompactPanel(base, "cancelled", Date.now())
    );
    expect(cancelled).toContain("—");
    expect(cancelled).toContain("cancelled");
  });

  test("case 14：compactProgressRows() === 6（行账 SSOT：边框 2 + 内容 4）", () => {
    expect(compactProgressRows()).toBe(6);
  });

  test("turn 源提示为 [Esc] interrupt（自动压缩无独立取消通道）", async () => {
    const frame = await renderPanelText({
      ...startCompactPanel("turn", Date.now()),
      droppedCount: 3,
    });
    expect(frame).toContain("[Esc] interrupt");
    expect(frame).not.toContain("[Esc] cancel");
  });

  test("done 帧读条铺满（fill=1.0 渲染证据：45 格全填充、无干轨）", async () => {
    const cells = await renderPanelCells(
      settleCompactPanel(
        startCompactPanel("manual", Date.now() - 1_000),
        "done",
        Date.now()
      )
    );
    // fill=1.0 takes the special branch (skips the 0.95-capped time
    // estimate) → all 45 cells filled.
    expect(cells.filled).toBe(45);
    expect(cells.dry).toBe(0);
  });

  test("在途帧读条未铺满（时间估计上限 0.95 → 至少 1 格干轨）", async () => {
    // With huge elapsed (far beyond tau) fill → 0.95 →
    // 45 - ceil(45*0.95) = 2 cells stay dry — the visible proof of "not real
    // progress" (the bar never runs full).
    const cells = await renderPanelCells({
      ...startCompactPanel("manual", Date.now() - 10 * 60_000),
      droppedCount: 5,
    });
    expect(cells.filled).toBeGreaterThan(0);
    expect(cells.dry).toBeGreaterThanOrEqual(1);
    expect(cells.filled + cells.dry).toBe(45);
  });
});

// ── English copy + row accounting ──────────────────────────────────────────

/** CJK unified ideographs + fullwidth punctuation (incl. ·—「」), used by
 *  the "user-visible copy is English" assertions. */
const CJK_RE = /[　-〿㐀-䶿一-鿿＀-￯]/;

describe("compact 外显文案英文化（acceptance 15-16）", () => {
  test("case 15：compactNoticeFor 成功/无操作分支全英文，无 CJK", () => {
    const lines = [
      ...compactNoticeFor("windowed", true),
      ...compactNoticeFor("full_summary", true),
      ...compactNoticeFor("messages_too_few", false),
    ];
    expect(lines).toEqual([
      "Context compacted (kept tail, trimmed early messages).",
      "Context compacted (structured summary + kept tail).",
      "Nothing to compact — session unchanged.",
    ]);
    for (const line of lines) {
      expect(CJK_RE.test(line)).toBe(false);
    }
    // The contract-breach branch still throws (exhaustiveness is not
    // relaxed by English copy).
    expect(() => compactNoticeFor("messages_too_few", true)).toThrow();
    expect(() => compactNoticeFor("windowed", false)).toThrow();
  });

  test("case 16：面板状态行 / 键位提示全英文，无 CJK", () => {
    const running = startCompactPanel("manual", T0);
    const texts = [
      compactStatusText(running, T0),
      compactStatusText({ ...running, droppedCount: 48 }, T0 + 1_000),
      compactStatusText(settleCompactPanel(running, "done", T0), T0),
      compactStatusText(settleCompactPanel(running, "failed", T0), T0),
      compactStatusText(settleCompactPanel(running, "cancelled", T0), T0),
      compactHintText("manual"),
      compactHintText("turn"),
    ];
    for (const t of texts) {
      expect(CJK_RE.test(t)).toBe(false);
    }
  });

  test("case 16b：入口护栏 / 取消 / 失败文案全英文，无 CJK（Spec review Medium#3：五条 guard 的 SSOT 断言）", () => {
    const guards: ReadonlyArray<CompactGuard> = ["busy", "in_flight", "draft"];
    const texts = [
      ...guards.map((g) => compactGuardNoticeFor(g)),
      compactCancelledNotice(),
      `${compactFailedNoticePrefix()}boom`,
    ];
    expect(texts).toEqual([
      "Session is running; compact after this turn ends.",
      "Compaction already in progress; press Esc to cancel.",
      "Empty session — nothing to compact yet.",
      "Compaction cancelled — session unchanged.",
      "Compaction failed: boom",
    ]);
    for (const t of texts) {
      expect(CJK_RE.test(t)).toBe(false);
    }
  });
});

describe("compactRows 行账（chromeReserveRows 入账）", () => {
  test("case 17：compactRows=6 → delta 7（6 行 + marginBottom 1）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const withCompact = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      compactRows: compactProgressRows(),
    });
    expect(compactProgressRows()).toBe(6);
    expect(withCompact - base).toBe(7);
  });

  test("case 18：compactRows 缺省 0（旧调用零影响）", () => {
    const base = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    const explicitZero = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      compactRows: 0,
    });
    expect(base).toBe(7);
    expect(explicitZero).toBe(base);
  });

  test("compactRows 与 pickerRows 叠加：各自独立入账", () => {
    const stacked = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
      pickerRows: 5,
      compactRows: 6,
    });
    expect(stacked).toBe(7 + 6 + 7);
  });
});
