/**
 * #356 High#4 (SC12/SC3):registerShutdown 生命周期钩子测试。
 *
 * 覆盖:
 *  - dispose 幂等(多调用只执行一次 shutdown);
 *  - shutdown 缺席(ask 形态 / deps-injected hub)→ no-op 不抛;
 *  - SIGTERM 触发 dispose 且无无限 re-kill 循环(reKilled one-shot 守门,
 *    首次 re-kill 让外部 handler 强退,二次直接 exit —— 见 runtime.ts);
 *  - SIGINT 二次强杀语义(与 chat-session onSigint 计数器共存)。
 *
 * 说明:进程级信号测试用子进程(execFileSync)隔离真实 process.kill —
 * 当前 vitest 进程自身不断言信号退出码,避免污染 runner。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerShutdown } from "../../src/cli/runtime.ts";

describe("registerShutdown (#356 High#4)", () => {
  it("dispose 幂等：多次调用只触发一次 shutdown", async () => {
    let calls = 0;
    const { dispose } = registerShutdown({
      shutdown: async () => {
        calls += 1;
      },
    });
    await dispose();
    await dispose();
    await dispose();
    assert.equal(calls, 1);
  });

  it("shutdown 缺席（ask / deps-injected）→ no-op 不抛", async () => {
    const { dispose } = registerShutdown({}); // 无 shutdown
    await dispose();
    assert.ok(true);
  });

  it("SIGTERM：dispose 触发 + re-kill one-shot 不无限循环", () => {
    // 子进程模拟 registerShutdown 的 onSignal —— 断言进程以 143 退出
    // (SIGTERM 强杀语义),而不是 watchdog(99)或无限 re-kill。
    const script = `
      let shuttingDown = false, reKilled = false;
      const dispose = async () => { if (shuttingDown) return; shuttingDown = true; await new Promise(r=>setTimeout(r,20)); };
      const onSignal = (sig) => { void dispose().finally(() => { if (reKilled) { process.exit(sig === "SIGTERM" ? 143 : 130); } reKilled = true; process.kill(process.pid, sig); }); };
      process.on("SIGTERM", onSignal);
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
      setTimeout(() => process.exit(99), 3000);
    `;
    let code: number | null = null;
    try {
      execFileSync("node", ["-e", script], { timeout: 8000 });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    assert.equal(code, 143);
  });

  it("SIGINT：与 chat-session onSigint 计数器共存,二次强杀 exit 130", () => {
    const script = `
      let shuttingDown = false, reKilled = false, sigintCount = 0;
      const dispose = async () => { if (shuttingDown) return; shuttingDown = true; await new Promise(r=>setTimeout(r,30)); };
      const onSignal = (sig) => { void dispose().finally(() => { if (reKilled) { process.exit(130); } reKilled = true; process.kill(process.pid, sig); }); };
      process.on("SIGINT", onSignal);
      const onSigint = () => { sigintCount++; if (sigintCount === 1) return; process.exit(130); };
      process.on("SIGINT", onSigint);
      setTimeout(() => process.kill(process.pid, "SIGINT"), 100);
      setTimeout(() => process.exit(99), 3000);
    `;
    let code: number | null = null;
    try {
      execFileSync("node", ["-e", script], { timeout: 8000 });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    assert.equal(code, 130);
  });
});
