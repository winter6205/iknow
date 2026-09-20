/**
 * Structural pin for the LSP process-exit seam — fixes the TUI /quit hang.
 *
 * Root cause (verified on a real PTY): language-server children spawned by
 * warmup / lsp_* are never killed during exit, so their stdio pipes keep the
 * Bun event loop from draining after runTui returns → /quit hangs; manually
 * SIGTERM-ing the two LSP children let the parent exit immediately (isolation experiment).
 *
 * The LSP pool is **process-level shared** (client.ts defaultPool, same cache
 * as warmup spawns), and shutdownAll latches shutDown (every later getClient
 * returns spawn-failed). So termination calls are only allowed in the
 * **host-process exit seam**:
 *   - TUI: shutdownExtensions (/quit + whenDestroyed fallback + catch path)
 *     and combinedShutdown (signal path);
 *   - chat: chatProcessShutdown (registerShutdown signal hook + natural REPL exit).
 * Engine shutdown (build-engine.ts) must **not** call it — chat rebind triggers
 * it mid-process, and after the latch a rebuilt engine's LSP is permanently
 * spawn-failed.
 *
 * Structural pin (same style as tests/tui/quit-shutdown.test.ts): runTui's
 * full paths need a real renderer, which cannot be injected in bun/vitest
 * test environments, so the seam is pinned via source-wiring assertions.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]): string =>
  readFileSync(join(import.meta.dir, "..", "..", ...parts), "utf8");

describe("LSP 池终止只挂在进程退出缝", () => {
  const runTui = read("src", "tui", "run.tsx");
  const cli = read("src", "cli.ts");
  const buildEngine = read("src", "harness", "build-engine.ts");

  it("run.tsx:shutdownExtensions（/quit 路径）调用 shutdownDefaultLspPool", () => {
    expect(runTui.includes("shutdownDefaultLspPool()")).toBe(true);
  });

  it("run.tsx:combinedShutdown（信号路径）调用 shutdownDefaultLspPool", () => {
    expect(runTui.includes("await shutdownDefaultLspPool();")).toBe(true);
  });

  it("cli.ts:chatProcessShutdown 调用 shutdownDefaultLspPool 且两缝共用", () => {
    expect(cli.includes("shutdownDefaultLspPool()")).toBe(true);
    // The same chatProcessShutdown serves both registerShutdown (signals) and natural REPL exit
    expect(
      cli.includes("registerShutdown({ shutdown: chatProcessShutdown })")
    ).toBe(true);
    expect(cli.includes("await chatProcessShutdown();")).toBe(true);
  });

  it("build-engine.ts 引擎 shutdown 不终止共享 LSP 池（rebind 安全）", () => {
    // Engine shutdown can run mid-process (chat rebind finalizes the old
    // engine) — if the shared pool latches there, a rebuilt engine's LSP tools
    // are permanently spawn-failed. Assert no call form (a mention in a
    // comment does not count as wiring).
    expect(buildEngine.includes("shutdownDefaultLspPool()")).toBe(false);
  });
});
