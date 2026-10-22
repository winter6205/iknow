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
 *  (h) programmatic write (multiline paste, then Ctrl+G expand) → caret at end
 *      in both states (usePaste folds to `[paste#1 · 4 lines · 7 chars]`, the
 *      expand writes the payload back; pasteBracketedText keeps \n with
 *      tail-append semantics, expanded plainText = "ab历\n史\n回\n退");
 *  (i) programmatic write (anchor refill, long multiline) → caret at end
 *      (component-level setState emulates app.tsx, since rewind end-to-end
 *      needs session+checkpoint+picker UI wiring; unit-level verification of
 *      the controlled sync effect is equivalent);
 *  (j) submit clear (Enter) → setInputValue("") → setText("") + gotoBufferEnd
 *      no-op → offset 0, text 0, no crash.
 *  (k)-(p) cell/character caliber of the composer caret: the native buffer
 *      counts terminal cells (CJK 2, `\n` 1) while every draft caret is a UTF-16
 *      index, so writes convert up (k) and reads convert back — the fold-span
 *      lookup (l), the deletion unit (m), the whole Ctrl+G → Ctrl+G → Backspace
 *      sequence on a paste label (o), an `[image#N]` label with the payload
 *      dropped on deletion (p); (n) pins the programmatic-write over-delete
 *      defect that survives the caliber fix (native 8 chars, programmatic 7).
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
import {
  PromptInput,
  type PromptInputHandle,
} from "../../src/tui/prompt-input.js";
import {
  createComposerDraft,
  type ComposerDraft,
} from "../../src/tui/composer-draft.js";
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
import { emptyClipboardImageReader } from "./_fixtures.js";

interface TaSnapshot {
  text: string;
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
  const getChildren = rr.getChildren;
  const children =
    typeof getChildren === "function" ? getChildren.call(rr) : undefined;
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
      text: t.plainText as string,
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
      // (h) drives a real bracketed paste; keep the clipboard seam stubbed at
      // its boundary even though a multiline fold never reaches the reader.
      clipboardImageReader={emptyClipboardImageReader}
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

/**
 * Component-level PromptInput wired to a real draft table: `write` is the
 * programmatic buffer+caret entry (`replaceBuffer`, caret = UTF-16 index) and
 * `caret` reads back the handle's cursor contract. Deliberately not app-level:
 * the read direction under test is prompt-input's own conversion, not the
 * app's paste plumbing (which (h) covers).
 */
async function mountDraftInput(draft: ComposerDraft): Promise<{
  setup: TestRendererSetup;
  write: (text: string, caret: number) => void;
  caret: () => number;
}> {
  const inputRef: { current: PromptInputHandle | null } = { current: null };
  let write: ((text: string, caret: number) => void) | null = null;
  function Harness() {
    const [v, setV] = useState("");
    write = (text: string, caret: number) =>
      inputRef.current?.replaceBuffer(text, caret);
    return (
      <PromptInput
        ref={inputRef}
        value={v}
        cols={80}
        active
        draft={draft}
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
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
  return {
    setup,
    write: (text: string, caret: number) => write!(text, caret),
    caret: () => inputRef.current?.getCursorOffset() ?? -1,
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

  test("(h) 程序写入（paste 多行折叠 + Ctrl+G 展开）→ 两种状态光标都在末尾", async () => {
    const app = await mount();
    try {
      // real paste event (pasteBracketedText emits the bracketed-paste
      // sequence, reaching app.tsx usePaste).
      await app.setup.mockInput.typeText("ab", 0);
      await settle(app.setup);
      expect(taSnapshot(app.setup)[0].offset).toBe(2);

      // A multiline paste now folds: the buffer carries the summary label and
      // the payload waits in the draft table. What this case pins — the caret
      // position after a programmatic buffer write — is unchanged by that.
      await app.setup.mockInput.pasteBracketedText("历\n史\n回\n退");
      const folded = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 31,
        "(h) 多行 paste 折叠为摘要"
      );
      expect(folded[0].text).toBe("ab[paste#1 · 4 lines · 7 chars]");
      // ASCII-only label on one visual line: end-of-text offset == text width.
      expect(folded[0].offset).toBe(31);

      // Expanding puts the exact payload back (9 chars: 2 ASCII + 4 CJK + 3 \n).
      app.setup.mockInput.pressKey("g", { ctrl: true });
      const expanded = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 9,
        "(h) Ctrl+G 展开回原文"
      );
      expect(expanded[0].text).toBe("ab历\n史\n回\n退");
      // Measured: the caret write is cell-caliber on the native side, so the
      // UTF-16 index 9 lands on column 13 (1+1+2+1+2+1+2+1+2) at visual column
      // 2 of the last line — both states sit at text end, not at buffer start.
      expect(expanded[0].offset).toBe(13);
      expect(expanded[0].visualCol).toBe(2);

      // Backspace also proves the caret sits at the end behaviorally: a caret
      // left inside the wide cell would delete nothing. Length 7, not 8: the
      // programmatic write path deletes the last grapheme AND its newline
      // (native typing keeps the newline) — measured in (n), where the same
      // over-delete reproduces on an ASCII buffer through the sync effect's own
      // setText + gotoBufferEnd, so it is that path's defect, not this caret's.
      app.setup.mockInput.pressBackspace();
      const afterBackspace = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 7,
        "(h) 展开后光标在末尾（backspace 吃掉末字）"
      );
      expect(afterBackspace[0].text).toBe("ab历\n史\n回");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(k) 程序写入宽字符缓冲：光标按终端列落位，下一次 backspace 删掉末字符", async () => {
    // `cursorOffset` counts terminal cells (CJK 2 columns, `\n` 1) while every
    // caret this module computes is a UTF-16 index: "a历b" ends at cell 4, so
    // passing the raw index 3 parks the caret before "b" (inside the wide "历")
    // and the next backspace deletes the wrong character. Component-level on
    // purpose — (h) also depends on the app's controlled-write ordering.
    const inputRef: { current: PromptInputHandle | null } = { current: null };
    let write: ((text: string, caret: number) => void) | null = null;
    function Harness() {
      const [v, setV] = useState("");
      write = (text: string, caret: number) =>
        inputRef.current?.replaceBuffer(text, caret);
      return (
        <PromptInput
          ref={inputRef}
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

      write!("a历b", 3);
      const after = await waitUntil(
        setup,
        (snaps) => snaps[0]?.textLen === 3,
        "(k) 宽字符缓冲写入完成"
      );
      // Cell caliber: 'a' 1 + '历' 2 + 'b' 1 → end of text is column 4.
      expect(after[0].offset).toBe(4);

      setup.mockInput.pressBackspace();
      const deleted = await waitUntil(
        setup,
        (snaps) => snaps[0]?.textLen === 2,
        "(k) backspace 删掉末字符 b"
      );
      expect(deleted[0].text).toBe("a历");

      // Round trip identity at the handle boundary: a character index written
      // with replaceBuffer reads back through getCursorOffset as the same
      // character index, never as the cell count the native buffer stores.
      const WIDE = "测试a历b\nc";
      for (let k = 0; k <= WIDE.length; k++) {
        write!(WIDE, k);
        expect(inputRef.current?.getCursorOffset()).toBe(k);
      }
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  }, 15_000);

  test("(l) 宽字符段在折叠标签前：Ctrl+G 展开光标所在的标签", async () => {
    // The read side of the same caliber gap: cursorOffset is terminal cells
    // while draft label spans are UTF-16 indices. "测试[paste#1 · 4 lines · 7
    // chars]" ends at cell 33 / char 31, so an unconverted caret reads past
    // the span end and Ctrl+G finds no label to expand.
    const draft = createComposerDraft();
    const { label } = draft.foldPaste("历\n史\n回\n退");
    const buffer = `测试${label}`;
    const input = await mountDraftInput(draft);
    try {
      input.write(buffer, buffer.length);
      const placed = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.textLen === buffer.length,
        "(l) 宽字符折叠缓冲写入完成"
      );
      expect(placed[0].text).toBe(buffer);
      // Cell caliber on the native side, character caliber on the handle.
      expect(placed[0].offset).toBe(33);
      expect(input.caret()).toBe(buffer.length);

      input.setup.mockInput.pressKey("g", { ctrl: true });
      const expanded = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === "测试历\n史\n回\n退",
        "(l) Ctrl+G 展开光标所在标签"
      );
      expect(expanded[0].textLen).toBe(9);
    } finally {
      if (!input.setup.renderer.isDestroyed) input.setup.renderer.destroy();
    }
  }, 15_000);

  test("(m) 宽字符段在折叠标签前：Backspace 把标签当一个删除单元", async () => {
    // Same caret, same span, read direction: unconverted, deleteLabelUnit is
    // handed cell 33 against the span end 31, matches nothing, and the key
    // falls through to the native buffer — one bracket character instead of
    // the whole folded unit.
    const draft = createComposerDraft();
    const { label } = draft.foldPaste("历\n史\n回\n退");
    const buffer = `测试${label}`;
    const input = await mountDraftInput(draft);
    try {
      input.write(buffer, buffer.length);
      await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.textLen === buffer.length,
        "(m) 宽字符折叠缓冲写入完成"
      );

      input.setup.mockInput.pressBackspace();
      const collapsed = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === "测试",
        "(m) Backspace 整块删除标签"
      );
      // Caret lands at the start of the removed span: char 2 = cell 4.
      expect(collapsed[0].offset).toBe(4);
      expect(input.caret()).toBe(2);
      expect(draft.text(label)).toBeUndefined();
    } finally {
      if (!input.setup.renderer.isDestroyed) input.setup.renderer.destroy();
    }
  }, 15_000);

  test("(n) 末行只有一个字符时 backspace：程序写入比原生多删一个（已知缺陷）", async () => {
    // Native typing deletes one grapheme; the same buffer reached by a
    // programmatic write deletes the grapheme AND its newline, while both
    // report the identical caret. The ASCII phase below reproduces it with the
    // sync effect's own setText + gotoBufferEnd, so the cause is the programmatic
    // write path, not the cell/character caliber. Pinned as measured.
    const input = await mountDraftInput(createComposerDraft());
    const setup = input.setup;
    try {
      await setup.mockInput.typeText("ab历", 0);
      for (const line of ["史", "回", "退"]) {
        setup.mockInput.pressEnter({ shift: true });
        await setup.renderOnce();
        await setup.mockInput.typeText(line, 0);
      }
      const nativeBefore = taSnapshot(setup)[0];
      expect(nativeBefore.text).toBe("ab历\n史\n回\n退");
      expect(nativeBefore.offset).toBe(13);
      setup.mockInput.pressBackspace();
      await settle(setup);
      expect(taSnapshot(setup)[0].text).toBe("ab历\n史\n回\n");

      input.write("ab历\n史\n回\n退", 9);
      const refilled = await waitUntil(
        setup,
        (snaps) => snaps[0]?.textLen === 9,
        "(n) 程序写入同样缓冲"
      );
      // The caret really sits at text end in both paths: same cell, same column.
      expect(refilled[0].offset).toBe(13);
      expect(refilled[0].visualCol).toBe(2);
      setup.mockInput.pressBackspace();
      await settle(setup);
      const programmatic = taSnapshot(setup)[0];
      expect(programmatic.text).toBe("ab历\n史\n回");
      expect(programmatic.textLen).toBe(7);

      const ta = walk(
        setup.renderer.root,
        (r) => "plainText" in r && "visualCursor" in r
      )[0] as unknown as {
        setText: (text: string) => void;
        gotoBufferEnd: () => void;
      };
      ta.setText("ab\nk");
      ta.gotoBufferEnd();
      await settle(setup);
      expect(taSnapshot(setup)[0].offset).toBe(4);
      setup.mockInput.pressBackspace();
      await settle(setup);
      expect(taSnapshot(setup)[0].text).toBe("ab");

      // Native-typing control on the same ASCII shape: backspace removes the
      // single grapheme and keeps its newline. Both paths report offset 4 / the
      // same caret, so the over-delete is the programmatic write path's own
      // defect and no cell/character caliber is involved.
      input.write("", 0);
      await settle(setup);
      await setup.mockInput.typeText("xy", 0);
      setup.mockInput.pressEnter({ shift: true });
      await setup.renderOnce();
      await setup.mockInput.typeText("z", 0);
      const nativeAscii = taSnapshot(setup)[0];
      expect(nativeAscii.text).toBe("xy\nz");
      expect(nativeAscii.offset).toBe(4);
      setup.mockInput.pressBackspace();
      await settle(setup);
      expect(taSnapshot(setup)[0].text).toBe("xy\n");
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  }, 15_000);

  test("(o) 宽字符前缀的 paste 标签：Ctrl+G 展开、折回后 Backspace 仍按标签整块删", async () => {
    // One mount, both read sites in sequence, on a buffer whose cell caliber runs
    // 2 columns ahead of the character caliber: the native caret must be
    // converted before the span lookup (toggleFold), the adjacency test
    // (deleteLabelUnit) and the boundary check at the label's left edge.
    const draft = createComposerDraft();
    const { label } = draft.foldPaste("历\n史\n回\n退");
    const buffer = `测试${label}`;
    expect(buffer.length).toBe(31);
    const input = await mountDraftInput(draft);
    try {
      // Character caliber in, character caliber out, at both ends of the label
      // and through its interior (the cell caliber would be 2 columns higher).
      for (const k of [0, 2, 3, 15, 30, 31]) {
        input.write(buffer, k);
        expect(input.caret()).toBe(k);
      }

      input.write(buffer, buffer.length);
      const placed = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.textLen === buffer.length,
        "(o) 折叠缓冲写入完成"
      );
      expect(placed[0].offset).toBe(33);

      input.setup.mockInput.pressKey("g", { ctrl: true });
      const expanded = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === "测试历\n史\n回\n退",
        "(o) Ctrl+G 展开"
      );
      // Caret goes to the payload end: char 9 = cell 15 (4 for "测试" + 2+1 × 3
      // + 2 for "退"), still text end, not buffer start.
      expect(expanded[0].offset).toBe(15);
      expect(input.caret()).toBe(9);

      // The second Ctrl+G collapses what was just revealed (the label is no
      // longer under the caret, so only the remembered target can refold it);
      // applyBuffer parks the caret at the label's left edge — char 2, cell 4.
      input.setup.mockInput.pressKey("g", { ctrl: true });
      const refolded = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === buffer,
        "(o) 第二次 Ctrl+G 折回"
      );
      expect(refolded[0].offset).toBe(4);
      expect(input.caret()).toBe(2);

      // At span.start the label sits to the caret's right, outside the backward
      // adjacency window (span.start < caret), so Backspace deletes only the
      // preceding wide character. The unconverted cell 4 would read as char 4 —
      // inside the span — and swallow the whole label instead.
      input.setup.mockInput.pressBackspace();
      const oneChar = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === `测${label}`,
        "(o) 标签左边缘 backspace 只删一个字符"
      );
      expect(oneChar[0].textLen).toBe(30);
      expect(input.caret()).toBe(1);

      // Same label, now one wide character shorter and with the caret on its
      // right edge: the folded unit goes as a whole.
      input.write(`测${label}`, 30);
      const repositioned = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.offset === 31,
        "(o) 光标移到标签右端"
      );
      expect(repositioned[0].textLen).toBe(30);
      expect(input.caret()).toBe(30);
      input.setup.mockInput.pressBackspace();
      const whole = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === "测",
        "(o) Backspace 整块删除标签"
      );
      expect(whole[0].offset).toBe(2);
      expect(input.caret()).toBe(1);
      expect(draft.text(label)).toBeUndefined();
    } finally {
      if (!input.setup.renderer.isDestroyed) input.setup.renderer.destroy();
    }
  }, 30_000);

  test("(p) 宽字符前缀的 image 标签：读方向按字符取中，Backspace 整块删并丢附件", async () => {
    // The app layer inserts `[image#N]` at the live cursor (getCursorOffset is
    // its entry), so a nine-cell label behind CJK must resolve at both ends in
    // character caliber, and the native caret landing inside a wide glyph has
    // one deterministic reading.
    const draft = createComposerDraft();
    const image = draft.addImage({
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    const buffer = `测试${image}`;
    expect(buffer.length).toBe(11);
    const input = await mountDraftInput(draft);
    try {
      for (const k of [0, 2, 9, 10, 11]) {
        input.write(buffer, k);
        expect(input.caret()).toBe(k);
      }
      input.write(buffer, buffer.length);
      const placed = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.textLen === buffer.length,
        "(p) image 标签缓冲写入完成"
      );
      // Cell caliber: 4 for "测试" + 9 ASCII → char 11 reads back as char 11.
      expect(placed[0].offset).toBe(13);
      expect(input.caret()).toBe(11);

      // An image label has no text to reveal: Ctrl+G must leave buffer and caret
      // alone rather than expanding to an empty payload.
      input.setup.mockInput.pressKey("g", { ctrl: true });
      await settle(input.setup);
      expect(taSnapshot(input.setup)[0].text).toBe(buffer);
      expect(input.caret()).toBe(11);

      input.setup.mockInput.pressBackspace();
      const removed = await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === "测试",
        "(p) Backspace 整块删除 image 标签"
      );
      expect(removed[0].offset).toBe(4);
      expect(input.caret()).toBe(2);
      // Deleting the display label drops the payload authority with it.
      expect(draft.image(image)).toBeUndefined();

      // Rounding at the handle: cell 3 falls inside the double-width "试" (cells
      // 2-3) and reads back as that character's start. A cell the text cannot
      // hold never reaches this conversion — the library's own setter
      // normalizes it first (measured: 99 lands at 0, and a cell past the last
      // glyph of a single line lands at that glyph's start), so this is the one
      // out-of-boundary reading the component can observe.
      input.write("测试", 2);
      await waitUntil(
        input.setup,
        (snaps) => snaps[0]?.text === "测试" && snaps[0]?.offset === 4,
        "(p) 探测前刷新缓冲"
      );
      const ta = walk(
        input.setup.renderer.root,
        (r) => "plainText" in r && "visualCursor" in r
      )[0] as unknown as { cursorOffset: number };
      ta.cursorOffset = 3;
      expect(input.caret()).toBe(1);
    } finally {
      if (!input.setup.renderer.isDestroyed) input.setup.renderer.destroy();
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
