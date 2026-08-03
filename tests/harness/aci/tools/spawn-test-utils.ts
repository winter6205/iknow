/**
 * 进程类工具测试共享助手（bash / helpers 的进程树 kill 断言复用）。
 *
 * waitForPidFile：子进程启动后把自身 pid 写入文件，测试侧轮询读取
 * （fixture 约定：sh -c 'echo $$ > <file>; ...'）。
 * waitForProcessExit：轮询 process.kill(pid, 0)，ESRCH 即确认进程已死。
 * 两者都带 2s 上限，防止测试挂死。
 */

import { readFile } from "node:fs/promises";

export async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  throw new Error(`timed out waiting for pid file: ${path}`);
}

export async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  throw new Error(`process ${pid} remained alive`);
}
