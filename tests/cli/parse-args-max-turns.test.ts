/**
 * tests/cli/parse-args-max-turns.test.ts
 *
 * plan T5: `--max-turns` CLI flag 解析。
 *   - 未设 → undefined（=无限，与 plan T5 默认行为一致）
 *   - 合法正整数 → 透传
 *   - 缺失值 → throws
 *   - 非整数 (0 / -1 / 1.5 / abc) → throws "Invalid --max-turns: ..."
 *
 * 只覆盖配置解析层；不验证 LoopEngine 接线（归其他 agent 的 LoopEngineDeps 改造）。
 */
import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/parse-args.ts";

describe("parseArgs: --max-turns (plan T5)", () => {
  it("未设 → maxTurns=undefined", () => {
    const parsed = parseArgs({ argv: ["chat"], interactive: true });
    expect(parsed.maxTurns).toBeUndefined();
  });

  it("--max-turns 3 → maxTurns=3 (chat 子命令)", () => {
    const parsed = parseArgs({
      argv: ["chat", "--max-turns", "3"],
      interactive: true,
    });
    expect(parsed.command).toBe("chat");
    expect(parsed.maxTurns).toBe(3);
  });

  it("--max-turns 120 → maxTurns=120 (oneshot 子命令)", () => {
    const parsed = parseArgs({ argv: ["--max-turns", "120", "ask", "hi"] });
    expect(parsed.command).toBe("ask");
    expect(parsed.maxTurns).toBe(120);
  });

  it("--max-turns 1 → maxTurns=1 (boundary: 最小合法正整数)", () => {
    const parsed = parseArgs({
      argv: ["serve", "--max-turns", "1"],
      interactive: true,
    });
    expect(parsed.command).toBe("serve");
    expect(parsed.maxTurns).toBe(1);
  });

  it("--max-turns 缺失值 → throws", () => {
    assert.throws(
      () => parseArgs({ argv: ["chat", "--max-turns"], interactive: true }),
      /--max-turns/
    );
  });

  it("--max-turns 0 → throws (n<1 拒绝)", () => {
    assert.throws(
      () =>
        parseArgs({
          argv: ["chat", "--max-turns", "0"],
          interactive: true,
        }),
      /Invalid --max-turns: 0/
    );
  });

  it("--max-turns -1 → throws (negative-class 拒绝)", () => {
    assert.throws(
      () =>
        parseArgs({
          argv: ["chat", "--max-turns", "-1"],
          interactive: true,
        }),
      /Invalid --max-turns: -1/
    );
  });

  it("--max-turns abc → throws (非数字拒绝)", () => {
    assert.throws(
      () =>
        parseArgs({
          argv: ["chat", "--max-turns", "abc"],
          interactive: true,
        }),
      /Invalid --max-turns: abc/
    );
  });

  it("--max-turns 1.5 → throws (非整数拒绝, Number.isInteger)", () => {
    assert.throws(
      () =>
        parseArgs({
          argv: ["chat", "--max-turns", "1.5"],
          interactive: true,
        }),
      /Invalid --max-turns: 1.5/
    );
  });

  it("--max-turns 在 --version 早返回分支也携带 (command=help, versionOnly=true)", () => {
    const parsed = parseArgs({
      argv: ["--max-turns", "7", "--version"],
    });
    expect(parsed.command).toBe("help");
    expect(parsed.versionOnly).toBe(true);
    expect(parsed.maxTurns).toBe(7);
  });

  it("--max-turns 在 --help 早返回分支也携带 (command=help, versionOnly=false)", () => {
    const parsed = parseArgs({
      argv: ["--max-turns", "9", "--help"],
    });
    expect(parsed.command).toBe("help");
    expect(parsed.versionOnly).toBe(false);
    expect(parsed.maxTurns).toBe(9);
  });

  it("--max-turns 不影响其它 flags (与 --data-dir / --trace-out 共存)", () => {
    const parsed = parseArgs({
      argv: ["serve", "--max-turns", "4", "--data-dir", "/tmp/pool"],
      interactive: true,
    });
    expect(parsed.command).toBe("serve");
    expect(parsed.maxTurns).toBe(4);
    expect(parsed.dataDir).toBe("/tmp/pool");
  });
});
