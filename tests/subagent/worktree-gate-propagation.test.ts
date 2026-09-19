/**
 * issue 1059 / ADR-0109 —— worktree 活开关的父子传播通道（父会话 → worker）。
 *
 * 通道与 fsMode（ADR-0092 SC11）完全同款：
 *   build-engine holder
 *     → `createDefaultSubAgentSpawn({ worktreeGate })`
 *     → 子进程 env `IKNOW_WORKTREE_GATE_ON`（spawn 期读 holder，"1"/"0"）
 *     → `worktreeGateOptionFromEnv(process.env)` 重建 holder
 *     → worker bash 工厂的 `worktreeOnMutate`（UNBOUND_FENCE 段的开关）。
 *
 * holder 在场即写线（"0" 也写 —— 键缺席 = 通道未接 → worker 永不建 holder
 * → 永不发段,字节不变）；非法值 → 键缺席（fail-closed,不猜父进程意图）。
 *
 * 断言分两段（仿 fs-mode-propagation.test.ts 的 A/B 段式样）：
 *   A. 父侧写：真 spawn node 子进程读回 env 字节；
 *   B. worker 侧读：env → holder / 键缺席。
 */
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";
import { worktreeGateOptionFromEnv } from "../../src/harness/subagent/worker.ts";
import { WORKTREE_GATE_ON_ENV_KEY } from "../../src/config/workspace-root.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/** 父进程 ambient env 不得干扰断言（通道值只应由 spawn opts 决定）。 */
const originalEnvValue = process.env[WORKTREE_GATE_ON_ENV_KEY];

afterEach(async () => {
  if (originalEnvValue === undefined) delete process.env[WORKTREE_GATE_ON_ENV_KEY];
  else process.env[WORKTREE_GATE_ON_ENV_KEY] = originalEnvValue;
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

// ── A. 父侧写：spawn env ────────────────────────────────────────────────────

interface GateHolder {
  get(): boolean;
  set(v: boolean): void;
}

function makeHolder(initial: boolean): GateHolder {
  let v = initial;
  return { get: () => v, set: (next: boolean) => { v = next; } };
}

/**
 * 真 spawn 一个 node 子进程打印它看到的 env 值（fs-mode-propagation A 段
 * 同款 process.argv[1] 替换技巧）：断言的是**真实到达子进程的字节**。
 */
async function spawnAndReadGateToken(
  worktreeGate: GateHolder | undefined
): Promise<string> {
  delete process.env[WORKTREE_GATE_ON_ENV_KEY];
  const root = await makeScratch("iknow-gate-wire-");
  const script = join(root, "print-gate.js");
  await writeFile(
    script,
    `process.stdout.write(process.env[${JSON.stringify(WORKTREE_GATE_ON_ENV_KEY)}] ?? "<unset>")`
  );
  const spawnWorker = createDefaultSubAgentSpawn(
    worktreeGate !== undefined ? { worktreeGate } : {}
  );
  const originalArgv1 = process.argv[1];
  process.argv[1] = script;
  let child: ChildProcess;
  try {
    child = spawnWorker({} as never, "task-id", {} as never);
  } finally {
    process.argv[1] = originalArgv1;
  }
  return await new Promise<string>((resolvePromise, reject) => {
    let value = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      value += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", () => resolvePromise(value));
  });
}

describe("A. createDefaultSubAgentSpawn — worktree 开关写入子进程 env", () => {
  it("holder ON → IKNOW_WORKTREE_GATE_ON=1 到达子进程", async () => {
    expect(await spawnAndReadGateToken(makeHolder(true))).toBe("1");
  });

  it("holder OFF → 显式写 0（holder 在场即钉值，键缺席只表示通道未接）", async () => {
    expect(await spawnAndReadGateToken(makeHolder(false))).toBe("0");
  });

  it("holder 缺席（legacy / 测试路径）→ 键不出现，子进程 env 字节不变", async () => {
    expect(await spawnAndReadGateToken(undefined)).toBe("<unset>");
  });

  it("spawn 期读 holder：工厂建好后运行期翻开关，下一次 spawn 带新值", async () => {
    delete process.env[WORKTREE_GATE_ON_ENV_KEY];
    const root = await makeScratch("iknow-gate-wire-flip-");
    const script = join(root, "print-gate.js");
    await writeFile(
      script,
      `process.stdout.write(process.env[${JSON.stringify(WORKTREE_GATE_ON_ENV_KEY)}] ?? "<unset>")`
    );
    const holder = makeHolder(true);
    const spawnWorker = createDefaultSubAgentSpawn({ worktreeGate: holder });
    const readOnce = async (): Promise<string> => {
      const originalArgv1 = process.argv[1];
      process.argv[1] = script;
      let child: ChildProcess;
      try {
        child = spawnWorker({} as never, "task-id", {} as never);
      } finally {
        process.argv[1] = originalArgv1;
      }
      return await new Promise<string>((resolvePromise, reject) => {
        let value = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          value += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", () => resolvePromise(value));
      });
    };
    expect(await readOnce()).toBe("1");
    holder.set(false);
    expect(await readOnce()).toBe("0");
  });
});

// ── B. worker 侧读：env 键 → holder（fail-closed）───────────────────────────

describe("B. worktreeGateOptionFromEnv — worker 侧 env → holder", () => {
  it("IKNOW_WORKTREE_GATE_ON=1 → holder get()=true（worker 可重建 UNBOUND_FENCE 段）", () => {
    const opts = worktreeGateOptionFromEnv({ [WORKTREE_GATE_ON_ENV_KEY]: "1" });
    expect(opts.worktreeOnMutate?.get()).toBe(true);
  });

  it("IKNOW_WORKTREE_GATE_ON=0 → holder get()=false（显式 OFF,与缺席区分）", () => {
    const opts = worktreeGateOptionFromEnv({ [WORKTREE_GATE_ON_ENV_KEY]: "0" });
    expect(opts.worktreeOnMutate?.get()).toBe(false);
  });

  it.each([undefined, "", "   ", "true", "2", "ON", "on"])(
    "非法 / 缺省值 %j → 键缺席（fail-closed：worker 无 holder → 永不发段）",
    (raw) => {
      expect(worktreeGateOptionFromEnv({ [WORKTREE_GATE_ON_ENV_KEY]: raw })).toEqual({});
    }
  );
});
