/**
 * ADR-0109 — parent→worker propagation channel for the worktree live gate.
 *
 * Same shape as the fsMode channel (ADR-0092):
 *   build-engine holder
 *     → `createDefaultSubAgentSpawn({ worktreeGate })`
 *     → child env `IKNOW_WORKTREE_GATE_ON` (holder read at spawn time, "1"/"0")
 *     → `worktreeGateOptionFromEnv(process.env)` rebuilds the holder
 *     → worker bash factory's `worktreeOnMutate` (switch for the UNBOUND_FENCE segment).
 *
 * A present holder always writes the key ("0" included — key absence means the
 * channel is not wired → the worker never creates a holder → never emits the
 * segment, bytes unchanged); invalid values → key absent (fail-closed, never
 * guess the parent's intent).
 *
 * Assertions in two parts (mirroring the A/B layout of fs-mode-propagation.test.ts):
 *   A. parent-side write: a real spawned node child reads back the env bytes;
 *   B. worker-side read: env → holder / key absent.
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

/** The parent's ambient env must not interfere — the value comes only from spawn opts. */
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

// ── A. Parent-side write: spawn env ─────────────────────────────────────────

interface GateHolder {
  get(): boolean;
  set(v: boolean): void;
}

function makeHolder(initial: boolean): GateHolder {
  let v = initial;
  return { get: () => v, set: (next: boolean) => { v = next; } };
}

/**
 * Spawns a real node child that prints the env value it sees (same
 * process.argv[1] swap trick as fs-mode-propagation section A): asserts the
 * bytes that actually reach the child.
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

// ── B. Worker-side read: env key → holder (fail-closed) ─────────────────────

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
