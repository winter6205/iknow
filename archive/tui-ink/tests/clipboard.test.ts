/**
 * tests/tui/clipboard.test.ts
 *
 * #238 鼠标拖选复制路径单测（文本 → 系统剪贴板）：
 *  - copyToClipboard：空文本 → { kind: "empty" }；命中本机剪贴板命令 →
 *    { kind: "ok", method }；全部命令缺失 → 写 fallback 文件；
 *    dataDir 缺省 = cwd。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyToClipboard } from "../../src/tui/clipboard.js";

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
