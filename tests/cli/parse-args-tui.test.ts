/**
 * tests/cli/parse-args-tui.test.ts
 *
 * #146 parse-args tui 分支：`tui` / `tui <session-id>` / flags 透传。
 */
import { describe, expect, it } from "vitest";
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
