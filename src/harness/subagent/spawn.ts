/**
 * #356 T6 — defaultSubAgentSpawn 生产 worker 进程 spawn 工厂（T2 报告要求的
 * 接线落点）。
 *
 * DI 由 build-engine 注入 createSubAgentManager({ spawn: defaultSubAgentSpawn })。
 * 形态 = 同 iknow binary headless 重入：`node <iknow-bin> --subagent-worker`
 * （cli.ts main() 对 `__subagent_worker__` command 的 dispatch，spec 假设 5）。
 * worker 协议：`stdin` 一行 envelope → `stdout` 一行 result。
 *
 * 职责边界：
 *   - `stdinPayload` 写不写由 manager 负责（manager.spawn 拿到 child 后自己
 *     `write + end`），spawn.ts 只负责 spawn + 返回 child；
 *   - env 继承父进程（ADR-0001，不发明第二条 env 协议）。
 *
 * 形参为 `SubAgentSpawn` 签名契约：defaultSubAgentSpawn 不读 `def` / `taskId`
 * / `stdinPayload`（由 manager 端消费），下划线前缀避开 `noUnusedParameters`。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { SubAgentSpawn } from "./manager.js";

export const defaultSubAgentSpawn: SubAgentSpawn = (
  _def,
  _taskId,
  _stdinPayload
) => {
  const child = spawn(
    process.execPath,
    [process.argv[1], "--subagent-worker"],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env }
  );
  // manager 负责写 stdin（worker 协议：stdin 一行 envelope → stdout 一行 result）。
  return child as ChildProcess;
};
