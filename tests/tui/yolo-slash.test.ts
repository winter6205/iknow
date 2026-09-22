/**
 * tests/tui/yolo-slash.test.ts
 *
 * ADR-0119 / specs/yolo-mode.md T5: `/yolo` joins the TUI slash vocabulary (four
 * touch points, mirroring the vocabulary group in tests/tui/rewind.test.ts):
 *  - exact parseTuiInput hit (case, surrounding whitespace, trailing args);
 *  - `/yolox` does not false-hit on the prefix (unknown);
 *  - helpLines covers `/yolo` and stays emoji-free;
 *  - the suggestion blurb (SLASH_HINT_DESCRIPTIONS) is registered.
 * The two Chinese literals asserted below are slash.ts's real runtime UI strings.
 */
import { describe, expect, test } from "bun:test";
import {
  helpLines,
  parseTuiInput,
  slashSuggestions,
  SLASH_HINT_DESCRIPTIONS,
} from "../../src/tui/slash.js";

describe("slash: the four /yolo vocabulary touch points", () => {
  test("/yolo -> command yolo", () => {
    expect(parseTuiInput("/yolo")).toEqual({
      kind: "command",
      command: "yolo",
    });
  });

  test("tolerates case and surrounding whitespace", () => {
    expect(parseTuiInput("  /YOLO  ")).toEqual({
      kind: "command",
      command: "yolo",
    });
  });

  test("args after the command still hit the command (vocabulary commands take no args)", () => {
    expect(parseTuiInput("/yolo now")).toEqual({
      kind: "command",
      command: "yolo",
    });
  });

  test("/yolox -> unknown (no false prefix hit)", () => {
    expect(parseTuiInput("/yolox")).toEqual({ kind: "unknown", raw: "/yolox" });
  });

  test('the full "/" suggestion list contains yolo (vocabulary membership projection)', () => {
    const commands = slashSuggestions("/").map((c) =>
      c.kind === "command" ? c.command : c.name
    );
    expect(commands).toContain("yolo");
  });

  test('the "/y" prefix suggestions hit yolo', () => {
    expect(slashSuggestions("/y")).toEqual([
      { kind: "command", command: "yolo" },
    ]);
  });

  test("/help covers /yolo and stays emoji-free", () => {
    const joined = helpLines().join("\n");
    expect(joined).toContain("/yolo");
    expect(joined).toContain("无沙箱模式");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined)).toBe(false);
  });

  test("the suggestion blurb is registered (HINT_DESCRIPTIONS range completed)", () => {
    expect(SLASH_HINT_DESCRIPTIONS.yolo).toBe("无沙箱模式（确认后切换）");
  });
});
