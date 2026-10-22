/**
 * tests/cli/parse-args-tui.test.ts
 *
 * parse-args `tui` branch: `tui` / `tui <session-id>` / flag pass-through, and
 * the typed refusal of a chat-only flag on the `tui` head.
 */
import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/parse-args.js";

describe("parseArgs: tui 分支", () => {
  it("iknow tui → command=tui，无 sessionId", () => {
    const parsed = parseArgs({ argv: ["tui"], interactive: true });
    expect(parsed.command).toBe("tui");
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.missingQuery).toBe(false);
  });

  it("iknow tui <session-id> → sessionId 透传（SC 2 直连 resume）", () => {
    const parsed = parseArgs({ argv: ["tui", "abc-123"], interactive: true });
    expect(parsed.command).toBe("tui");
    expect(parsed.sessionId).toBe("abc-123");
  });

  it("--data-dir / --trace-out 透传给 tui", () => {
    const parsed = parseArgs({
      argv: ["tui", "--data-dir", "/tmp/pool", "--trace-out", "/tmp/t.jsonl"],
      interactive: true,
    });
    expect(parsed.command).toBe("tui");
    expect(parsed.dataDir).toBe("/tmp/pool");
    expect(parsed.traceOut).toBe("/tmp/t.jsonl");
  });

  it("非交互模式同样解析 tui（不落入 help）", () => {
    const parsed = parseArgs({ argv: ["tui"], interactive: false });
    expect(parsed.command).toBe("tui");
  });

  it("既有命令不受影响（chat/serve/ask 回归）", () => {
    expect(parseArgs({ argv: ["chat"], interactive: true }).command).toBe(
      "chat"
    );
    expect(parseArgs({ argv: ["serve"], interactive: true }).command).toBe(
      "serve"
    );
    expect(parseArgs({ argv: ["ask", "q"], interactive: true }).command).toBe(
      "ask"
    );
  });

  it("iknow tui --auto-mode → autoMode=true（启动即 full_auto）", () => {
    const parsed = parseArgs({
      argv: ["tui", "--auto-mode"],
      interactive: true,
    });
    expect(parsed.command).toBe("tui");
    expect(parsed.autoMode).toBe(true);
    expect(parsed.sessionId).toBeUndefined();
  });

  it("iknow tui <session-id> --auto-mode → sessionId 与 autoMode 共存", () => {
    const parsed = parseArgs({
      argv: ["tui", "sess-1", "--auto-mode"],
      interactive: true,
    });
    expect(parsed.command).toBe("tui");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.autoMode).toBe(true);
  });

  it("缺省无 --auto-mode → autoMode=false", () => {
    expect(parseArgs({ argv: ["tui"], interactive: true }).autoMode).toBe(
      false
    );
  });
});

describe("parseArgs: tui refuses a chat anchor instead of silently dropping it", () => {
  it("iknow tui --json -> typed tui_entry_refusal naming the chat form", () => {
    const parsed = parseArgs({ argv: ["tui", "--json"], interactive: true });
    assert.equal(parsed.command, "tui");
    const refusal = parsed.tuiEntryRejection;
    assert.ok(
      refusal !== undefined,
      "--json on tui must refuse instead of starting a TUI that ignores JSON output"
    );
    assert.equal(refusal.kind, "tui_entry_refusal");
    assert.equal(refusal.command, "tui");
    assert.equal(refusal.flag, "--json");
    assert.match(refusal.message, /^tui_entry_refusal: /);
    assert.ok(refusal.message.includes("iknow chat --json"));
    assert.ok(refusal.message.includes("iknow tui"));
  });

  it("iknow tui --resume <id> -> the refusal names the positional resume form", () => {
    const parsed = parseArgs({
      argv: ["tui", "--resume", "ses_1"],
      interactive: true,
    });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.resumeId, "ses_1");
    const refusal = parsed.tuiEntryRejection;
    assert.ok(
      refusal !== undefined,
      "--resume on tui must refuse instead of starting a fresh session"
    );
    assert.equal(refusal.kind, "tui_entry_refusal");
    assert.equal(refusal.flag, "--resume");
    assert.match(refusal.message, /^tui_entry_refusal: /);
    assert.ok(refusal.message.includes("iknow tui ses_1"));
    assert.ok(refusal.message.includes("iknow chat --resume ses_1"));
  });

  it("the tui anchor refusal has the same plain union face as the posture conflict", () => {
    const refusal = parseArgs({
      argv: ["tui", "--json"],
      interactive: true,
    }).tuiEntryRejection;
    assert.ok(refusal !== undefined);
    assert.equal(refusal instanceof Error, false);
    assert.deepEqual(Object.keys(refusal).sort(), [
      "command",
      "flag",
      "kind",
      "message",
    ]);
  });

  it("tui --json --resume <id> reports one face, decided by a fixed flag order", () => {
    // --json is the flag that selects an entry, so it is reported first; its own
    // message already points at `iknow chat`, where --resume works.
    const refusal = parseArgs({
      argv: ["tui", "--json", "--resume", "ses_1"],
      interactive: true,
    }).tuiEntryRejection;
    assert.ok(refusal !== undefined);
    assert.equal(refusal.flag, "--json");
  });

  it("tui --json is independent of the TTY (a piped launch refuses the same way)", () => {
    const refusal = parseArgs({
      argv: ["tui", "--json"],
      interactive: false,
    }).tuiEntryRejection;
    assert.ok(refusal !== undefined);
    assert.equal(refusal.kind, "tui_entry_refusal");
  });

  it("tui <session-id> --resume <id> reports the flag form, keeping the positional read", () => {
    const parsed = parseArgs({
      argv: ["tui", "ses_9", "--resume", "ses_1"],
      interactive: true,
    });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.sessionId, "ses_9");
    assert.equal(parsed.resumeId, "ses_1");
    const refusal = parsed.tuiEntryRejection;
    assert.ok(refusal !== undefined);
    assert.equal(refusal.kind, "tui_entry_refusal");
    assert.equal(refusal.flag, "--resume");
  });

  it("a legal tui posture beside the refused flag never joins the refusal", () => {
    // --yolo and --auto-mode have a face on the TUI, so the chat anchor alone is
    // the contradiction here.
    const parsed = parseArgs({
      argv: ["tui", "--json", "--yolo", "--auto-mode"],
      interactive: true,
    });
    assert.equal("yoloRejection" in parsed, false);
    assert.equal(parsed.tuiEntryRejection?.kind, "tui_entry_refusal");
  });

  it("tui --json --eval-state emits one refusal: the chat anchor outranks the posture", () => {
    // Precedence lives in the parser (`baseParsed`), so a two-flag request never
    // yields two fields for the host to order.
    const parsed = parseArgs({
      argv: ["tui", "--json", "--eval-state"],
      interactive: true,
    });
    assert.equal("evalStateRejection" in parsed, false);
    assert.equal(parsed.tuiEntryRejection?.kind, "tui_entry_refusal");
  });

  it("an explicit positional resume keeps working (no refusal)", () => {
    const parsed = parseArgs({ argv: ["tui", "abc-123"], interactive: true });
    assert.equal(parsed.command, "tui");
    assert.equal(parsed.sessionId, "abc-123");
    assert.equal("tuiEntryRejection" in parsed, false);
  });

  it("tui --yolo / tui --auto-mode keep working (no refusal)", () => {
    for (const argv of [
      ["tui", "--yolo"],
      ["tui", "--auto-mode"],
    ]) {
      const parsed = parseArgs({ argv, interactive: true });
      assert.equal(parsed.command, "tui");
      assert.equal("tuiEntryRejection" in parsed, false);
      assert.equal("yoloRejection" in parsed, false);
    }
  });
});
