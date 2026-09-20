/**
 * Shared helpers for process-oriented tool tests (reused by the bash /
 * helpers process-tree kill assertions).
 *
 * waitForPidFile: the child writes its own pid to a file after startup and
 * the test polls it (fixture convention: sh -c 'echo $$ > <file>; ...').
 * waitForProcessExit: polls process.kill(pid, 0); ESRCH confirms the
 * process is dead.
 * Both cap at 2s so a test can never hang.
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
