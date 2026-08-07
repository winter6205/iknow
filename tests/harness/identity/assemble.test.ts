/**
 * #228 / SC16: memory_layer slot 降级契约 — 对齐 #196 readUserProfile 模式
 * (assemble.ts:117-131)：resolver throw → warn + skip + 不毒化下一 turn。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { createIknowSystemResolver } from "../../../src/harness/identity/assemble.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory_layer slot — resolver 降级契约", () => {
  afterEach(() => vi.restoreAllMocks());

  it("memoryEnabled=false → memory_layer absent (ask 全 opt-out)", async () => {
    const resolver = createIknowSystemResolver({
      cwd: "/tmp",
      userHome: "/tmp",
      surface: "ask",
      memoryEnabled: false,
    });
    const out = (await resolver()) ?? "";
    expect(out).toContain("iknow Identity");
    expect(out).not.toContain("memory_recall(query)");
  });

  it("resolver throws → console.warn emitted, undefined returned, no rethrow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver = createIknowSystemResolver({
      cwd: "/tmp",
      userHome: "/tmp",
      surface: "ask",
      memoryEnabled: true,
      memoryResolver: async () => {
        throw new Error("resolver boom");
      },
    });
    const out = (await resolver()) ?? "";
    expect(out).toContain("iknow Identity"); // identity 层不受影响
    expect(out).not.toContain("resolver boom"); // 错误内容不入 prompt
    expect(warn).toHaveBeenCalled();
    const warnMsg = warn.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(warnMsg).toContain("memory_layer resolver failed");
  });

  it("memoryEnabled=true 但 memoryResolver 缺席 → memory_layer absent, 不抛", async () => {
    const resolver = createIknowSystemResolver({
      cwd: "/tmp",
      userHome: "/tmp",
      surface: "ask",
      memoryEnabled: true,
    });
    const out = (await resolver()) ?? "";
    expect(out).toContain("iknow Identity");
    expect(out).not.toContain("memory_recall(query)");
  });
});
