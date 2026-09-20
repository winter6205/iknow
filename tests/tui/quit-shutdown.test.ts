/**
 * TUI /quit shutdown convergence fix — the /quit path must shut down all
 * engines. shutdownExtensions originally called only tuiExtensions.shutdown()
 * (the combined handle of the initial engines); after rebind, per-root rebuilt
 * engines had their shutdown attached only to combinedShutdown (the signal
 * path), so /quit → onQuitBridge.destroy → shutdownExtensions missed the
 * rebuilt engines. Fix: shutdownExtensions also calls
 * hubRef.current.shutdown() (hub.shutdown is idempotent; a duplicate call
 * alongside the signal path is harmless).
 *
 * Structural pin (same style as the chat-session-rebind "wrapRebuiltDeps"
 * pin): the full runTui path needs a real renderer + runtime bundle that
 * cannot be injected under bun test; pin the hub shutdown wiring inside the
 * shutdownExtensions closure and the hubRef backfill point.
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
    // shutdownExtensions is defined outside the try — it must reach bridge.hub via the outer hubRef box
    expect(src.includes("const hubRef")).toBe(true);
    expect(src.includes("hubRef.current?.shutdown()")).toBe(true);
    // hubRef backfilled after bridge creation (same point as bridgeRef.hub)
    expect(src.includes("hubRef.current = bridge.hub")).toBe(true);
  });

  it("信号路径 combinedShutdown 仍读 bridgeRef.hub（双路径都收口 hub）", () => {
    expect(src.includes("bridgeRef.hub) await bridgeRef.hub.shutdown()")).toBe(
      true
    );
  });
});
