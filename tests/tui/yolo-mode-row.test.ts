/**
 * tests/tui/yolo-mode-row.test.ts
 *
 * ADR-0119 / specs/yolo-mode.md T6: the persistent red marker on the mode row.
 *  - yolo ON: both shapes (wide layout / narrow layout, `cols < 40`) project the
 *    YOLO token (the narrow-layout branch is unreachable in TuiApp because cols is
 *    clamped at 40, so the assertion goes through the exported pure projections);
 *  - yolo OFF: the mode row is byte-identical to the existing labels (Default /
 *    Auto / Graph / narrow [def] / [auto] / [graph], snapshot assertions do not
 *    regress);
 *  - chromeReserveRows is untouched by yolo: the red marker rides the existing mode
 *    row (no new bottom-bar row), and the confirmation modal bills through the
 *    existing modalRows slot;
 *  - the coloring wiring (pal.error, no new theme token) is pinned via the repo's
 *    source-assertion precedent (the readFileSync shape in chrome-budget.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chromeReserveRows,
  modeRowBaseLabel,
  modeRowText,
  modeRowYoloMarker,
} from "../../src/tui/app.js";
import { yoloModalRows } from "../../src/tui/yolo-picker.js";
import { tuiPalette } from "../../src/tui/theme.js";

describe("modeRowText: yolo ON is visible in both layouts", () => {
  test("wide layout: ` · YOLO` appended after the label (default / full_auto faces)", () => {
    expect(
      modeRowText({
        yoloOn: true,
        graphOn: false,
        permMode: "default",
        cols: 80,
      })
    ).toBe("mode: Default · YOLO");
    expect(
      modeRowText({
        yoloOn: true,
        graphOn: false,
        permMode: "full_auto",
        cols: 80,
      })
    ).toBe("mode: Auto · YOLO");
  });

  test("narrow layout (cols < 40): the bracket form appends [YOLO]", () => {
    expect(
      modeRowText({
        yoloOn: true,
        graphOn: false,
        permMode: "full_auto",
        cols: 39,
      })
    ).toBe("[auto][YOLO]");
    expect(
      modeRowText({
        yoloOn: true,
        graphOn: false,
        permMode: "default",
        cols: 39,
      })
    ).toBe("[def][YOLO]");
  });

  test("red-marker token: brackets when narrow, ` · ` separator when wide (never empty)", () => {
    expect(modeRowYoloMarker(80)).toBe(" · YOLO");
    expect(modeRowYoloMarker(39)).toBe("[YOLO]");
  });
});

describe("modeRowText: yolo OFF is byte-identical to the existing labels (no snapshot regression)", () => {
  test("wide layout: mode: Default / Auto / Graph", () => {
    expect(
      modeRowText({
        yoloOn: false,
        graphOn: false,
        permMode: "default",
        cols: 80,
      })
    ).toBe("mode: Default");
    expect(
      modeRowText({
        yoloOn: false,
        graphOn: false,
        permMode: "full_auto",
        cols: 80,
      })
    ).toBe("mode: Auto");
    expect(
      modeRowText({
        yoloOn: false,
        graphOn: true,
        permMode: "default",
        cols: 80,
      })
    ).toBe("mode: Graph");
  });

  test("narrow layout (cols < 40): [def] / [auto] / [graph]", () => {
    expect(
      modeRowBaseLabel({ graphOn: false, permMode: "default", cols: 39 })
    ).toBe("[def]");
    expect(
      modeRowBaseLabel({ graphOn: false, permMode: "full_auto", cols: 39 })
    ).toBe("[auto]");
    expect(
      modeRowBaseLabel({ graphOn: true, permMode: "default", cols: 39 })
    ).toBe("[graph]");
  });

  test("OFF projection = base label (the red-marker node leaves entirely, no empty-string node left behind)", () => {
    expect(
      modeRowText({
        yoloOn: false,
        graphOn: false,
        permMode: "default",
        cols: 80,
      })
    ).toBe(modeRowBaseLabel({ graphOn: false, permMode: "default", cols: 80 }));
  });
});

describe("chromeReserveRows is not touched by yolo (zero cost in the line budget)", () => {
  const baseOpts = {
    noticeRows: 0,
    inputHintRows: 0,
    bgLine: false,
    inputRows: 1,
  };

  test("baseline stays 6 (the red marker rides the existing mode row, no new bottom-bar row)", () => {
    expect(chromeReserveRows(baseOpts)).toBe(6);
  });

  test("the confirmation modal bills through the existing modalRows slot (rows + marginBottom 1, no new slot)", () => {
    const yoloModal = yoloModalRows(80);
    const withYoloModal = chromeReserveRows({
      ...baseOpts,
      modalRows: yoloModal,
    });
    expect(withYoloModal - chromeReserveRows(baseOpts)).toBe(yoloModal + 1);
  });
});

describe("coloring wiring: pal.error and no new theme token (source-assertion precedent)", () => {
  test("the yolo red-marker node on the mode row is colored pal.error (render slot and projection concatenate the same string)", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src/tui/app.tsx"),
      "utf8"
    );
    expect(src).toMatch(/yoloOn && <text fg=\{pal\.error\}>/);
    expect(src).toMatch(/modeRowYoloMarker\(cols\)/);
  });

  test("theme.ts gains no yolo token (reuses the existing pal.error)", () => {
    const theme = readFileSync(
      join(import.meta.dir, "..", "..", "src/tui/theme.ts"),
      "utf8"
    );
    expect(theme).not.toMatch(/[Yy][Oo][Ll][Oo]/);
    // pal.error itself stays put (the existing token T6 relies on).
    expect(tuiPalette.error).toBe("#c95d47");
  });
});
