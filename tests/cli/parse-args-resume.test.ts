/**
 * tests/cli/parse-args-resume.test.ts
 *
 * T4: `--resume <id>` flag 解析 —— chat REPL 从既有 conversationId 续跑。
 *   - 未设 → resumeId=undefined（=新开会话随机 UUID，与 T2 完全一致）
 *   - 合法 id → 透传（chat 子命令）
 *   - 缺失值 → throws "--resume requires a conversation id argument"
 *   - 空串 / 纯空白 → throws "--resume requires a non-empty conversation id"
 *   - command-agnostic：ask 也解析（host 忽略），不破坏既有命令回归
 *
 * 只覆盖配置解析层；不验证 runChatSession 接线（归 tests/cli/chat-session-resume.test.ts）。
 */
import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/parse-args.ts";

describe("parseArgs: --resume (T4)", () => {
  it("未设 → resumeId=undefined", () => {
    const parsed = parseArgs({ argv: ["chat"], interactive: true });
    expect(parsed.resumeId).toBeUndefined();
  });

  it("--resume <id> → resumeId 透传 (chat 子命令)", () => {
    const parsed = parseArgs({
      argv: ["chat", "--resume", "abc-123"],
      interactive: true,
    });
    expect(parsed.command).toBe("chat");
    expect(parsed.resumeId).toBe("abc-123");
  });

  it("--resume 在 flag 任意位置都可解析（flag 与子命令顺序无关）", () => {
    const parsed = parseArgs({
      argv: ["--resume", "x-y-z", "chat"],
      interactive: true,
    });
    expect(parsed.command).toBe("chat");
    expect(parsed.resumeId).toBe("x-y-z");
  });

  it("--resume 缺失值 → throws", () => {
    assert.throws(
      () => parseArgs({ argv: ["chat", "--resume"], interactive: true }),
      /--resume requires a conversation id argument/
    );
  });

  it("--resume 空串 → throws (empty-class 拒绝)", () => {
    assert.throws(
      () =>
        parseArgs({
          argv: ["chat", "--resume", ""],
          interactive: true,
        }),
      /--resume requires a non-empty conversation id/
    );
  });

  it("--resume 纯空白 → throws (whitespace-class 拒绝)", () => {
    assert.throws(
      () =>
        parseArgs({
          argv: ["chat", "--resume", "   "],
          interactive: true,
        }),
      /--resume requires a non-empty conversation id/
    );
  });

  it("--resume 与其它 flags 共存（--json / --max-turns）", () => {
    const parsed = parseArgs({
      argv: ["chat", "--resume", "id-7", "--json", "--max-turns", "3"],
      interactive: true,
    });
    expect(parsed.command).toBe("chat");
    expect(parsed.resumeId).toBe("id-7");
    expect(parsed.json).toBe(true);
    expect(parsed.maxTurns).toBe(3);
  });

  it("ask 子命令同样解析 --resume（command-agnostic；host 忽略）", () => {
    const parsed = parseArgs({
      argv: ["ask", "hi", "--resume", "ask-id"],
      interactive: true,
    });
    expect(parsed.command).toBe("ask");
    expect(parsed.resumeId).toBe("ask-id");
    expect(parsed.query).toBe("hi");
  });

  it("--resume 在 --version 早返回分支也携带", () => {
    const parsed = parseArgs({ argv: ["--resume", "v-id", "--version"] });
    expect(parsed.command).toBe("help");
    expect(parsed.versionOnly).toBe(true);
    expect(parsed.resumeId).toBe("v-id");
  });

  it("既有命令回归：--resume 不改变 chat/serve/ask 分支解析", () => {
    expect(
      parseArgs({ argv: ["chat"], interactive: true }).resumeId
    ).toBeUndefined();
    expect(
      parseArgs({ argv: ["serve", "--resume", "srv"], interactive: true })
        .command
    ).toBe("serve");
    expect(
      parseArgs({ argv: ["serve", "--resume", "srv"], interactive: true })
        .resumeId
    ).toBe("srv");
    expect(
      parseArgs({ argv: ["tui"], interactive: true }).resumeId
    ).toBeUndefined();
  });
});
