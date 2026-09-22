/**
 * tests/tui/yolo-picker.test.ts
 *
 * ADR-0119 / specs/yolo-mode.md T5: the pure-content module of the /yolo **entry**
 * confirmation modal (mirroring how tests/tui/rewind.test.ts covers rewind-picker's
 * pure functions):
 *  - the yoloEnterConfirmContent shape (dangerous-operation copy + execute/cancel
 *    options); **no exit arm** — ADR-0119 ruling 6 plus the lock table's "exit is
 *    immediate": exiting passes no modal, app.tsx's case "yolo" calls
 *    controller.exit() directly;
 *  - reduceYoloConfirmKey's guard order (ctrl/meta checked first -> Esc -> Enter,
 *    everything else including ↑↓ is ignore — same sequence as reduceRewindKey's
 *    confirm state);
 *  - yoloModalRows shares its source with selectModalRows (one SSOT for rendering
 *    and row accounting).
 *
 * The string assertions below match the runtime modal copy verbatim, so they stay
 * in the language the UI actually renders.
 */
import { describe, expect, test } from "bun:test";
import {
  selectModalRows,
  wrapModalLines,
  type ModalKeyEvent,
} from "../../src/tui/modal.js";
import {
  reduceYoloConfirmKey,
  yoloEnterConfirmContent,
  yoloModalRows,
} from "../../src/tui/yolo-picker.js";

describe("yoloEnterConfirmContent", () => {
  test("entry arm: dangerous-operation copy + execute/cancel options + Enter/Esc hint", () => {
    const content = yoloEnterConfirmContent();
    expect(content.title).toBe("启用 yolo 模式？");
    expect(content.description).toContain("危险操作");
    expect(content.options).toEqual([
      { value: "execute", label: "启用 yolo" },
      { value: "cancel", label: "取消" },
    ]);
    expect(content.hint).toContain("Enter");
    expect(content.hint).toContain("Esc");
  });

  test("no exit arm: the export surface carries no exit projection (ADR-0119 ruling 6, exit opens no modal)", () => {
    const mod = yoloPickerModuleKeys();
    expect(mod).not.toContain("yoloExitConfirmContent");
  });

  test("no emoji in the copy (vocabulary / modal copy discipline)", () => {
    const content = yoloEnterConfirmContent();
    const joined = [
      content.title,
      content.description ?? "",
      content.hint ?? "",
      ...content.options.map((o) => o.label),
    ].join("\n");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });
});

/** Export-surface snapshot — feeds the "no exit arm" assertion (keys only, no values). */
function yoloPickerModuleKeys(): string[] {
  const mod = require("../../src/tui/yolo-picker.js") as Record<
    string,
    unknown
  >;
  return Object.keys(mod);
}

describe("reduceYoloConfirmKey (confirm-state key routing, guard order mirrors reduceRewindKey)", () => {
  const noKey = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    tab: false,
    space: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
  };
  const key = (patch: Partial<ModalKeyEvent["key"]>): ModalKeyEvent => ({
    input: "",
    key: { ...noKey, ...patch },
  });

  test("Enter -> execute; Esc -> cancel", () => {
    expect(reduceYoloConfirmKey(key({ return: true }))).toBe("execute");
    expect(reduceYoloConfirmKey(key({ escape: true }))).toBe("cancel");
  });

  test("ctrl/meta combinations are checked first -> ignore (app-level keys such as Ctrl+C/O are not swallowed)", () => {
    expect(reduceYoloConfirmKey(key({ return: true, ctrl: true }))).toBe(
      "ignore"
    );
    expect(reduceYoloConfirmKey(key({ escape: true, meta: true }))).toBe(
      "ignore"
    );
    expect(reduceYoloConfirmKey(key({ ctrl: true }))).toBe("ignore");
  });

  test("up/down carry no selection semantics -> ignore (in a confirm state the selected row is pinned to execute)", () => {
    expect(reduceYoloConfirmKey(key({ upArrow: true }))).toBe("ignore");
    expect(reduceYoloConfirmKey(key({ downArrow: true }))).toBe("ignore");
  });

  test("remaining keys (Tab/Space/printable) -> ignore", () => {
    expect(reduceYoloConfirmKey(key({ tab: true }))).toBe("ignore");
    expect(reduceYoloConfirmKey(key({ space: true }))).toBe("ignore");
    expect(reduceYoloConfirmKey({ input: "y", key: { ...noKey } })).toBe(
      "ignore"
    );
  });
});

describe("yoloModalRows (row accounting sourced from selectModalRows)", () => {
  test("row count equals the selectModalRows projection (selectedIndex always 0)", () => {
    expect(yoloModalRows(80)).toBe(
      selectModalRows(yoloEnterConfirmContent(), 80, 0)
    );
  });

  test("additive formula check: 2 borders + title + description + two options + hint (cols=80)", () => {
    const content = yoloEnterConfirmContent();
    const inner = 76; // selectModalInnerWidth(80)
    const expected =
      2 +
      wrapModalLines(content.title, inner).length +
      wrapModalLines(content.description ?? "", inner).length +
      content.options.length + // labels stay far shorter than inner, one physical row each
      wrapModalLines(content.hint ?? "", inner).length;
    expect(yoloModalRows(80)).toBe(expected);
  });

  test("a narrow column wraps into more rows (the wrap accounting never undercounts)", () => {
    expect(yoloModalRows(20)).toBeGreaterThan(yoloModalRows(80));
  });
});
