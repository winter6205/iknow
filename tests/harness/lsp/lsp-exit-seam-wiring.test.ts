/**
 * LSP 进程退出缝 wiring 结构钉 — TUI /quit 挂死修复。
 *
 * 根因（真实 PTY 复验）：warmup / lsp_* spawn 的 language server 子进程在
 * 退出链中从不被终止,stdio 管道让 Bun 事件循环在 runTui 返回 0 后永不排空
 * → /quit 挂死;手动 SIGTERM 两个 LSP 子进程后父进程立即退出（隔离实验）。
 *
 * LSP 池是**进程级共享**（client.ts defaultPool,warmup spawn 缓存同源），
 * shutdownAll 会 latch shutDown（此后 getClient 一律 spawn-failed）。因此
 * 终止调用只允许出现在**宿主进程退出缝**：
 *   - TUI：shutdownExtensions（/quit + whenDestroyed 兜底 + catch 路径）与
 *     combinedShutdown（信号路径）；
 *   - chat：chatProcessShutdown（registerShutdown 信号钩 + REPL 自然退出）。
 * 引擎 shutdown（build-engine.ts）**不得**调用 —— chat rebind 收口旧引擎时
 * 会在进程中途触发,latch 后重建引擎的 LSP 永久 spawn-failed（review High）。
 *
 * 结构性钉子（与 tests/tui/quit-shutdown.test.ts 同风格）：runTui 全路径
 * 需要真实 renderer,bun/vitest 测试环境不可注入,以源码接线断言钉缝位。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]): string =>
  readFileSync(join(import.meta.dir, "..", "..", "..", ...parts), "utf8");

describe("LSP 池终止只挂在进程退出缝", () => {
  const runTui = read("src", "tui", "run.tsx");
  const cli = read("src", "cli.ts");
  const buildEngine = read("src", "harness", "build-engine.ts");

  it("run.tsx:shutdownExtensions（/quit 路径）调用 shutdownDefaultLspPool", () => {
    expect(runTui.includes("shutdownDefaultLspPool()")).toBe(true);
  });

  it("run.tsx:combinedShutdown（信号路径）调用 shutdownDefaultLspPool", () => {
    expect(
      runTui.includes("await shutdownDefaultLspPool();")
    ).toBe(true);
  });

  it("cli.ts:chatProcessShutdown 调用 shutdownDefaultLspPool 且两缝共用", () => {
    expect(cli.includes("shutdownDefaultLspPool()")).toBe(true);
    // 同一 chatProcessShutdown 同时接 registerShutdown（信号）与 REPL 自然退出
    expect(cli.includes("registerShutdown({ shutdown: chatProcessShutdown })")).toBe(
      true
    );
    expect(cli.includes("await chatProcessShutdown();")).toBe(true);
  });

  it("build-engine.ts 引擎 shutdown 不终止共享 LSP 池（rebind 安全）", () => {
    // 引擎 shutdown 会在进程中途被调用（chat rebind 收口旧引擎）——共享池
    // 一旦在此 latch,重建引擎的 LSP 工具永久 spawn-failed。断言无调用形式
    // （注释提及不算接线）。
    expect(buildEngine.includes("shutdownDefaultLspPool()")).toBe(false);
  });
});
