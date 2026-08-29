/**
 * TUI /quit 收口收敛修复（2026-08-29 第二轮 review）—— /quit 路径必须关掉
 * 全部引擎。shutdownExtensions 原本只调 tuiExtensions.shutdown()（初始引擎
 * 的组合句柄）；rebind 后 per-root 重建引擎的 shutdown 只挂在
 * combinedShutdown（信号路径），/quit → onQuitBridge.destroy →
 * shutdownExtensions 会漏关重建引擎。修复：shutdownExtensions 追加
 * hubRef.current.shutdown()（hub.shutdown 幂等，与信号路径重复调用无害）。
 *
 * 结构性钉子（与 chat-session-rebind "wrapRebuiltDeps" 钉同风格）：runTui
 * 全路径需要真实 renderer + runtime bundle，bun test 环境不可注入；钉
 * shutdownExtensions 闭包内的 hub shutdown 接线与 hubRef 回填点。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(import.meta.dir, "..", "..", "src", "tui", "run.tsx"),
  "utf8"
);

describe("TUI /quit 关掉全部引擎（hub.shutdown 接线）", () => {
  it("shutdownExtensions 内追加 hubRef hub.shutdown（/quit 路径收口重建引擎）", () => {
    // shutdownExtensions 定义在 try 外 —— 必须经外层 hubRef 盒访问 bridge.hub
    expect(src.includes("const hubRef")).toBe(true);
    expect(src.includes("hubRef.current?.shutdown()")).toBe(true);
    // bridge 创建后回填 hubRef（与 bridgeRef.hub 同点）
    expect(src.includes("hubRef.current = bridge.hub")).toBe(true);
  });

  it("信号路径 combinedShutdown 仍读 bridgeRef.hub（双路径都收口 hub）", () => {
    expect(src.includes("bridgeRef.hub) await bridgeRef.hub.shutdown()")).toBe(
      true
    );
  });
});
