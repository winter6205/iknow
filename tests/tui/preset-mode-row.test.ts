/**
 * ADR-0141 / specs/yolo-mode.md §7 — the mode row's two DERIVED indicators.
 *
 * The old projection concatenated the axis labels onto a single red marker, so
 * the row could say "全局档 full_auto · YOLO" — three labels for two facts. Now:
 *
 *  - the YOLO badge shows only while the yolo preset is unmodified;
 *  - 无沙箱 shows whenever the fence is retired, from the effective
 *    configuration or a live bare descendant;
 *  - a per-axis label is suppressed only for an axis a VISIBLE indicator already
 *    states. The yolo badge states all three axes, so `全局档` / `full_auto` drop
 *    out. `--no-sandbox` has no badge, so its row KEEPS the permission label —
 *    an axis that preset never declared (ADR-0141 ruling 5).
 */
import { describe, expect, test } from "bun:test";

import {
  modeRowBaseLabel,
  modeRowText,
  noSandboxMarker,
  yoloBadge,
} from "../../src/tui/app.js";
import type { PermissionMode } from "../../src/harness/permission/modes.js";

describe("modeRowText: the yolo preset states all three axes once", () => {
  test("wide layout: badge + 无沙箱, no permission or fs axis labels", () => {
    const row = modeRowText({
      preset: "yolo",
      fenceRetired: true,
      graphOn: false,
      permMode: "full_auto",
      cols: 80,
    });
    expect(row).toContain("YOLO");
    expect(row).toContain("无沙箱");
    // The badge already names every axis, so they are not repeated.
    expect(row).not.toContain("full_auto");
    expect(row).not.toContain("全局档");
  });

  test("narrow layout keeps both indicators", () => {
    const row = modeRowText({
      preset: "yolo",
      fenceRetired: true,
      graphOn: false,
      permMode: "full_auto",
      cols: 39,
    });
    expect(row).toContain("YOLO");
    expect(row).toContain("无沙箱");
  });
});

describe("modeRowText: --no-sandbox has no badge, so the permission label stays", () => {
  test("a full_auto row under the no-sandbox preset keeps its permission label", () => {
    const row = modeRowText({
      preset: "no-sandbox",
      fenceRetired: true,
      graphOn: false,
      permMode: "full_auto",
      cols: 80,
    });
    expect(row).toContain("无沙箱");
    expect(row).not.toContain("YOLO");
    // no badge ⇒ the permission label is not redundant, so it stays.
    expect(row).toContain("Auto");
  });

  test("the --no-sandbox + --auto-mode composition is 无沙箱 + Auto, with no badge", () => {
    const row = modeRowText({
      preset: "no-sandbox",
      fenceRetired: true,
      graphOn: false,
      permMode: "full_auto",
      cols: 39,
    });
    expect(row).toContain("无沙箱");
    expect(row).not.toContain("YOLO");
    expect(row).toContain("auto");
  });
});

describe("无沙箱 marker is derived from the fence, not from the entry", () => {
  test("a bare descendant keeps the marker lit with no preset in force", () => {
    const row = modeRowText({
      preset: undefined,
      fenceRetired: true,
      graphOn: false,
      permMode: "default",
      cols: 80,
    });
    expect(row).toContain("无沙箱");
    expect(row).not.toContain("YOLO");
  });

  test("no preset and a fenced config is byte-identical to today's row", () => {
    const row = modeRowText({
      preset: undefined,
      fenceRetired: false,
      graphOn: false,
      permMode: "default",
      cols: 80,
    });
    expect(row).toBe(modeRowBaseLabel({ graphOn: false, permMode: "default", cols: 80 }));
  });
});

describe("indicator shapes are stable across widths", () => {
  test("badge and marker each have a narrow and a wide form", () => {
    expect(yoloBadge(80)).toBe(" · YOLO");
    expect(yoloBadge(39)).toBe("[YOLO]");
    expect(noSandboxMarker(80)).toBe(" · 无沙箱");
    expect(noSandboxMarker(39)).toBe("[无沙箱]");
  });
});

describe("suppression is keyed to the visible badge, never to a retired fence", () => {
  test("a retired fence with no preset keeps every axis label", () => {
    for (const permMode of ["default", "plan", "full_auto"] as PermissionMode[]) {
      const row = modeRowText({
        preset: undefined,
        fenceRetired: true,
        graphOn: false,
        permMode,
        cols: 80,
      });
      expect(row).toContain("无沙箱");
      expect(row).not.toContain("YOLO");
    }
  });
});
