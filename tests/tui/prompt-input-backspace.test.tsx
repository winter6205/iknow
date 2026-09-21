/** @jsxImportSource @opentui/react */
/**
 * tests/tui/prompt-input-backspace.test.tsx
 *
 * User report: "when the input box has multiple lines, pressing backspace
 * jumps the caret from the end straight to the first character" — i.e. after
 * backspace on multiline input the caret resets to buffer start.
 *
 * Recon (prior agent, measured):
 *  - multiline CJK wrapped to 2 visual lines, internal backspace: caret steps
 *    back normally (visualCol 42→40, one CJK deleted), no jump-to-start — the
 *    library's visualCol/logicalCol accounting is self-consistent;
 *  - the `ta.plainText !== props.value` guard in prompt-input.tsx's controlled
 *    sync effect always holds on normal type/backspace paths; the setText
 *    overwrite never fires there.
 *
 * Root cause (measured evidence):
 *  - pure backspace in every scenario (inside wrap / unwrap boundary / across
 *    \n / single line) moves the caret back normally — backspace itself is fine;
 *  - culprit = prompt-input.tsx controlled sync effect: programmatic-write
 *    paths (↑ history recall / Tab completion / rewind anchor refill) call
 *    `ta.setText(value)`, and OpenTUI upstream setText resets the caret to
 *    offset 0 (measured: offset=0 after recalling "历史消息二"). The user then
 *    presses backspace to delete at the end → caret already sits at the first
 *    char, appearing as "caret jumped to start".
 *  - fix: after setText call `ta.gotoBufferEnd()` to restore end-of-text
 *    (every programmatic write in this app is a full replace / tail append,
 *    so end caret = correct UX).
 *  - excluded: mockInput.typeText / per-char user typing / delete paths do not
 *    trigger setText — the buffer is pre-updated via onContentChange, so
 *    `ta.plainText !== props.value` stays false and the branch never runs.
 *    paste (app.tsx usePaste setInputValue(prev => prev + text) via setState)
 *    does trigger setText + gotoBufferEnd: pasteBracketedText measured keeps
 *    \n with tail-append semantics, offset = end-of-text column — end caret
 *    after paste is correct UX, so it is pinned here too (see (h)).
 *  - additionally: rewind anchor refill (app.tsx setInputValue(anchor) via
 *    setState) and submit clear (app.tsx setInputValue("") → setText of empty
 *    string + gotoBufferEnd no-op) both flow through the same controlled sync
 *    effect; see (i)/(j).
 *
 * This file completes the boundary into a regression suite:
 *  (a) wrap crossing the unwrap boundary: text is exactly 2 visual lines; the
 *      backspace that shrinks it to 1 line must leave the caret at text end
 *      (offset = new-width column, not 0);
 *  (b) real newline (Shift+Enter emits \n) multiline backspace across the line
 *      boundary → caret does not jump to start;
 *  (c) single-line backspace does not regress (caret steps back);
 *  (d) inside wrapped multiline (no boundary crossed) caret stays normal (pinned against regression);
 *  (e) programmatic write (history recall ↑) → caret at end (setText-to-zero regression);
 *  (f) programmatic write (Tab completion) → caret at end (setText-to-zero regression);
 *  (g) single-line programmatic write → caret also at end (no regression; polling wait reduces parallel flakiness);
 *  (h) programmatic write (multiline paste append) → caret at end (usePaste
 *      setState triggers setText; pasteBracketedText keeps \n with
 *      tail-append semantics, plainText = "ab历\n史\n回\n退");
 *  (i) programmatic write (anchor refill, long multiline) → caret at end
 *      (component-level setState emulates app.tsx, since rewind end-to-end
 *      needs session+checkpoint+picker UI wiring; unit-level verification of
 *      the controlled sync effect is equivalent);
 *  (j) submit clear (Enter) → setInputValue("") → setText("") + gotoBufferEnd
 *      no-op → offset 0, text 0, no crash.
 *
 * Observation method: walk renderer.root to find the textarea renderable
 * (plainText + visualCursor) and read `offset`/`visualCol` directly — the
 * screen cursorState only gives screen coordinates, distorted by chrome
 * layout/scroll, not precise enough.
 *
 * offset semantics (measured): visualCursor.offset = text-width columns (one
 * CJK char = 2 cols: "abc"→3, "历史消息二"→10, "第一行\n第二行"→13). End-of-text
 * offset = sum of per-line width columns + number of newlines.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { PromptInput } from "../../src/tui/prompt-input.js";
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

interface TaSnapshot {
  textLen: number;
  offset: number;
  visualCol: number;
  height: number;
}

function walk(
  r: unknown,
  pred: (r: Record<string, unknown>) => boolean,
  depth = 0,
  out: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (!r || typeof r !== "object") return out;
  const rr = r as Record<string, unknown>;
  if (pred(rr)) out.push(rr);
  if (depth > 12) return out;
  const children = rr.getChildren?.();
  if (Array.isArray(children)) {
    for (const c of children) walk(c, pred, depth + 1, out);
  }
  return out;
}

function taSnapshot(setup: TestRendererSetup): TaSnapshot[] {
  const tas = walk(
    setup.renderer.root,
    (r) => "plainText" in r && "visualCursor" in r
  );
  return tas.map((t) => {
    const vc = (
      t as unknown as { visualCursor: { offset: number; visualCol: number } }
    ).visualCursor;
    return {
      textLen: (t.plainText as string).length,
      offset: vc.offset,
      visualCol: vc.visualCol,
      height: (t as unknown as { height?: unknown }).height as number,
    };
  });
}

async function settle(setup: TestRendererSetup, ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await setup.renderOnce();
}

/**
 * Polling wait: until the textarea snapshot satisfies the predicate or times
 * out (default 2000ms, 25ms interval). Replaces fixed sleeps — under parallel
 * full runs the new cases and (g) flake occasionally from too-short fixed
 * sleeps (snapshot read before effect/setState streams flush); only polling
 * on the real condition is stable.
 *
 * Used only by the new cases and (g); existing settle paths untouched.
 */
async function waitUntil(
  setup: TestRendererSetup,
  pred: (snaps: TaSnapshot[]) => boolean,
  label: string,
  timeoutMs = 2000,
  intervalMs = 25
): Promise<TaSnapshot[]> {
  const start = Date.now();
  let last: TaSnapshot[] = [];
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await setup.renderOnce();
    last = taSnapshot(setup);
    if (pred(last)) return last;
  }
  throw new Error(`waitUntil timeout (${label}): ${JSON.stringify(last)}`);
}

interface MountCtx {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
}

async function mount(): Promise<MountCtx> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-bs-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: [] })]),
    inflight: createInflightRegistry(),
  });
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
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
  };
}

describe("输入框 backspace 光标不跳头（2026-08-15 用户反馈）", () => {
  test("(c) 单行输入 backspace：光标正常后退", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("abc");
      await settle(app.setup);
      const before = taSnapshot(app.setup)[0];
      expect(before.offset).toBe(3);

      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // delete 1 char, caret stays at the end (offset=2, not 0).
      expect(after.textLen).toBe(2);
      expect(after.offset).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(d) wrap 多行内部 backspace：光标正常后退（不跨 unwrap 边界）", async () => {
    const app = await mount();
    try {
      // 39 full-width CJK → visual width 78 > inner 74 → wraps to 2 lines (measured).
      const cjk =
        "的换行行为是否正确本汉字序列测试一下长文本的换行行为是否正确汉字序列测试一下长";
      await app.setup.mockInput.typeText(cjk, 0);
      await settle(app.setup);
      const before = taSnapshot(app.setup)[0];
      // 39 chars; offset=78 = text-width columns (1 CJK = 2 cols), wrapped to 2 lines.
      expect(before.textLen).toBe(39);
      expect(before.offset).toBe(78);
      expect(before.height).toBe(2);

      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // delete 1 CJK, still inside the 2-line wrap, caret stays at the end (offset=76, not 0).
      expect(after.textLen).toBe(38);
      expect(after.offset).toBe(76);
      expect(after.height).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(a) wrap 跨 unwrap 边界 backspace：光标仍停在文本末尾（不跳头）", async () => {
    const app = await mount();
    try {
      // Use a shorter overlong text to hold the wrap at 2 lines, such that
      // deleting 1 CJK falls back to exactly 1 line.
      // innerCols = 80 - 6 = 74; need visualWidth(text) > 74 but visualWidth(minus one) <= 74.
      // visualWidth is even, pick 76: 38 CJK chars (width 76 → 2 lines), after deleting 1 → 74 → 1 line.
      // base is 33 chars → pad 5 "换" up to 38 (measured: 38 chars width 76 = 2 lines;
      // delete 1 → 37 chars width 74 = exactly 1 line).
      const base =
        "本汉字序列测试一下长文本的换行行为是否正确本汉字序列测试一下长文本";
      const cjk = (base + "换换换换换").slice(0, 38);
      expect(cjk.length).toBe(38);
      const beforeType = taSnapshot(app.setup)[0];
      expect(beforeType.textLen).toBe(0);

      await app.setup.mockInput.typeText(cjk, 0);
      await settle(app.setup);
      const full = taSnapshot(app.setup)[0];
      expect(full.textLen).toBe(38);
      expect(full.offset).toBe(76);
      expect(full.height).toBe(2);

      // delete 1 CJK → visual width 74 = innerCols → shrinks to exactly 1 line (unwrap boundary).
      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const unwrapped = taSnapshot(app.setup)[0];
      expect(unwrapped.textLen).toBe(37);
      expect(unwrapped.height).toBe(1);
      // regression assertion: caret must still sit at text end (offset=74, not 0).
      expect(unwrapped.offset).toBe(74);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(b) 真实换行（Shift+Enter 产 \\n）backspace 跨行边界：光标停在合并行末尾", async () => {
    const app = await mount();
    try {
      // short first line + Shift+Enter newline → caret after the \n (start of the
      // new line, measured visualRow=1 visualCol=0 offset=7); backspace now deletes the \n across lines.
      await app.setup.mockInput.typeText("第一行");
      await settle(app.setup);
      app.setup.mockInput.pressEnter({ shift: true });
      await settle(app.setup);

      const before = taSnapshot(app.setup)[0];
      // content = "第一行\n": 4 chars; offset=7 = 6+1 (CJK double width + \n 1 col).
      expect(before.textLen).toBe(4);
      expect(before.offset).toBe(7);
      expect(before.height).toBe(2);

      // caret after the \n (start of new line); backspace → deletes \n, lines merge, caret lands at merged line end.
      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      expect(after.textLen).toBe(3); // "第一行" is 3 chars
      expect(after.height).toBe(1);
      // no jump to start: offset=6 (3 chars × 2 cols) is text end.
      expect(after.offset).toBe(6);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(e) 程序写入（↑ 历史召回多行）→ 光标在末尾（setText 归零回归）", async () => {
    const app = await mount();
    try {
      // seed one multiline history: Shift+Enter newline + Enter submit → handleSubmit enqueues history.
      await app.setup.mockInput.typeText("历史第一行");
      await settle(app.setup);
      app.setup.mockInput.pressEnter({ shift: true });
      await settle(app.setup);
      await app.setup.mockInput.typeText("历史第二行");
      await settle(app.setup);
      app.setup.mockInput.pressEnter();
      await settle(app.setup, 300);

      // ↑ recall on empty input → props.onChange(multiline history) → setText + gotoBufferEnd.
      app.setup.mockInput.pressArrow("up");
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // content = "历史第一行\n历史第二行": 5+1+5 = 11 chars; end offset = 10+1+10 = 21 cols.
      expect(after.textLen).toBe(11);
      expect(after.offset).toBe(21);
      expect(after.height).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(f) 程序写入（Tab 补全）→ 光标在末尾（setText 归零回归）", async () => {
    const app = await mount();
    try {
      // "/hel" unique match → Tab completes to "/help " (full-replace path).
      await app.setup.mockInput.typeText("/hel", 0);
      await settle(app.setup);
      app.setup.mockInput.pressTab();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // content "/help ": 6 chars; end offset = 6 (all ASCII).
      expect(after.textLen).toBe(6);
      expect(after.offset).toBe(6);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(g) 单行程序写入 → 光标也在末尾（不回归）", async () => {
    const app = await mount();
    try {
      // seed one single-line history.
      await app.setup.mockInput.typeText("历史消息");
      await settle(app.setup);
      app.setup.mockInput.pressEnter();
      await settle(app.setup, 300);

      // ↑ recalls the single-line history → setText + gotoBufferEnd.
      app.setup.mockInput.pressArrow("up");
      // polling wait replaces the fixed sleep: under parallel full runs (g)
      // occasionally read a stale snapshot before the effect/setState streams
      // finished flushing; continue only once textLen reaches 4.
      const after = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 4 && snaps[0]?.offset === 8,
        "(g) 单行召回后光标在末尾"
      );
      expect(after[0].textLen).toBe(4);
      // 4 chars × 2 cols = 8, caret at end, not 0.
      expect(after[0].offset).toBe(8);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(h) 程序写入（paste 多行追加）→ 光标在末尾（usePaste setState 触发 setText 回归）", async () => {
    const app = await mount();
    try {
      // real paste event (pasteBracketedText emits the bracketed-paste
      // sequence, reaching app.tsx usePaste setInputValue(prev => prev + text) setState).
      // Measured: \n preserved, plainText = "ab历\n史\n回\n退", tail-append semantics.
      await app.setup.mockInput.typeText("ab", 0);
      await settle(app.setup);
      expect(taSnapshot(app.setup)[0].offset).toBe(2);

      await app.setup.mockInput.pasteBracketedText("历\n史\n回\n退");
      const after = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 9,
        "(h) paste 多行追加后光标在末尾"
      );
      const snap = after[0];
      // content "ab历\n史\n回\n退": 9 chars (2 ASCII + 4 CJK + 3 \n).
      expect(snap.textLen).toBe(9);
      // end offset = 2(ab) + 2+1+2+1+2+1+2 (width of "历\n史\n回\n退") = 13 cols; not 0.
      expect(snap.offset).toBe(13);
      // first column of the last visual row ("退" CJK width 2) — caret is truly at the last line's end.
      expect(snap.visualCol).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(i) 程序写入（anchor 填回，长多行）→ 光标在末尾（setText 归零回归）", async () => {
    // rewind end-to-end needs session file + checkpoint + rewind picker UI
    // wiring, and app.tsx is just a setInputValue(anchorTextForInput)
    // setState — equivalent to this component's controlled sync effect. Here
    // we render PromptInput directly at component level and change value
    // externally to emulate the programmatic write path, asserting exactly the
    // regression point "caret at end after setText + gotoBufferEnd" (history
    // recall (e)/(g) already covers the same effect end-to-end).
    let fill: ((s: string) => void) | null = null;
    function Harness() {
      const [v, setV] = useState("");
      fill = setV;
      return (
        <PromptInput
          value={v}
          cols={80}
          active
          onChange={setV}
          onSubmit={() => {}}
        />
      );
    }
    const setup = await testRender(<Harness />, {
      width: 80,
      height: 10,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();

      // refill a long multi-line anchor (3 CJK lines) — setState → setText + gotoBufferEnd.
      const ANCHOR = "锚点第一行\n锚点第二行\n锚点第三行";
      fill!(ANCHOR);
      const after = await waitUntil(
        setup,
        (snaps) => snaps[0]?.textLen === 17,
        "(i) anchor 填回后光标在末尾"
      );
      const snap = after[0];
      // "锚点第一行\n锚点第二行\n锚点第三行" = 5+1+5+1+5 = 17 chars.
      expect(snap.textLen).toBe(17);
      // end offset = 10+1+10+1+10 = 32 cols; not 0 (setText-to-zero regression).
      expect(snap.offset).toBe(32);
      // first column of the last visual row (leading char of "锚点第三行"), proving the
      // caret is truly on the last line rather than coincidentally at some line start.
      expect(snap.visualCol).toBe(10);
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  }, 15_000);

  test('(j) submit 清空 → setText("") + gotoBufferEnd no-op → offset 0 不 crash', async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("abc", 0);
      await settle(app.setup);
      expect(taSnapshot(app.setup)[0].offset).toBe(3);

      // Enter submits → app.tsx setInputValue("") → setText("") +
      // gotoBufferEnd (no-op on the empty string). Empty-message submit is a
      // no-op (handleSubmit early-returns), producing no side content.
      app.setup.mockInput.pressEnter();
      const after = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 0 && snaps[0]?.offset === 0,
        "(j) submit 清空后 offset 0"
      );
      expect(after[0].textLen).toBe(0);
      expect(after[0].offset).toBe(0);
    } finally {
      await app.destroy();
    }
  }, 30_000);
});
