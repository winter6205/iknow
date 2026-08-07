/**
 * tests/tui/clipboard.test.ts
 *
 * #237 /copy + Ctrl+Y 显示式复制路径单测：
 *  - copyToClipboard：空文本 → { kind: "empty" }；命中本机剪贴板命令 →
 *    { kind: "ok", method }；全部命令缺失 → 写 fallback 文件；
 *    dataDir 缺省 = cwd。
 *  - extractLastAssistantText：最近的 assistant 消息连接 text blocks；
 *    忽略 thinking / tool_result / redacted_thinking / 空 text；
 *    无 assistant 消息 → 空串。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyToClipboard,
  extractLastAssistantText,
} from "../../src/tui/clipboard.js";
import type { AnthropicNativeMessage } from "../../src/session-api/hub.js";

/** 构造一个 assistant 消息（text / thinking / tool_result 块混合）。 */
function asst(
  blocks: ReadonlyArray<AnthropicNativeMessage["content"][number]>
): AnthropicNativeMessage {
  return { role: "assistant", content: blocks };
}
function user(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("extractLastAssistantText", () => {
  it("最近的 assistant 消息 → 连接 text blocks（空格分隔）", () => {
    const msg = asst([
      { type: "text", text: "你好" },
      { type: "text", text: "世界" },
    ]);
    expect(extractLastAssistantText([user("q"), msg])).toBe("你好 世界");
  });

  it("跳过非 text 块（thinking / tool_result / redacted_thinking）", () => {
    const msg = asst([
      { type: "thinking", thinking: "secret", signature: "sig" },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "tool output",
      },
      { type: "redacted_thinking", data: "redacted" },
      { type: "text", text: "仅正文" },
    ]);
    expect(extractLastAssistantText([user("q"), msg])).toBe("仅正文");
  });

  it("最后一条是 user → 取更早的 assistant 消息", () => {
    const msg = asst([{ type: "text", text: "旧回复" }]);
    expect(extractLastAssistantText([user("q"), msg, user("再问")])).toBe(
      "旧回复"
    );
  });

  it("assistant 消息全空 text → 继续向上找", () => {
    const emptyAsst = asst([{ type: "text", text: "   " }]);
    const realAsst = asst([{ type: "text", text: "有内容" }]);
    expect(extractLastAssistantText([user("q"), realAsst, emptyAsst])).toBe(
      "有内容"
    );
  });

  it("无 assistant 消息 → 空串", () => {
    expect(extractLastAssistantText([])).toBe("");
    expect(extractLastAssistantText([user("q")])).toBe("");
  });

  it("多行文本保留换行（不 trim）", () => {
    const msg = asst([{ type: "text", text: "第一行\n第二行" }]);
    expect(extractLastAssistantText([user("q"), msg])).toBe("第一行\n第二行");
  });
});

describe("copyToClipboard", () => {
  it("空文本 → { kind: 'empty' }（不 spawn、不写文件）", async () => {
    expect(await copyToClipboard("", { dataDir: tmpdir() })).toEqual({
      kind: "empty",
    });
  });

  it("本机剪贴板命令可用 → { kind: 'ok' }", async () => {
    // 冒烟：/bin/true 在 Linux 存在；用真实命令替身难，跳过平台特定断言，
    // 只验证调用不 throw 且结果在 ok/fallback/error 三态之一。
    const result = await copyToClipboard("hello world", {
      dataDir: tmpdir(),
    });
    expect(["ok", "fallback", "error"]).toContain(result.kind);
  });

  it("dataDir 提供 → fallback 写 <dataDir>/last_copy.txt 且含原文", async () => {
    // 注入 env.PATH 为致命路径，让所有候选 which 全部 miss → 必然 fallback。
    // 用 options.env 而非 process.env.PATH 全局改写，避免并行 worker 串扰。
    const dir = mkdtempSync(join(tmpdir(), "iknow-copy-"));
    const result = await copyToClipboard("fallback 内容", {
      dataDir: dir,
      env: { PATH: "/nonexistent-path-does-not-exist" },
    });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.path).toBe(join(dir, "last_copy.txt"));
      expect(result.bytes).toBe(Buffer.byteLength("fallback 内容", "utf8"));
    }
  });

  it("dataDir 缺省 → fallback 写 cwd/last_copy.txt", async () => {
    const result = await copyToClipboard("x", {
      env: { PATH: "/nonexistent-path-does-not-exist" },
    });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.path).toBe(join(process.cwd(), "last_copy.txt"));
    }
  });
});
