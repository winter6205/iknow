/**
 * 共享 `run_graph` handler 测试 fixture:fake SubAgentManager + 假 child +
 * envelope 写回 / 等待工具。
 *
 * 风格参考 `tests/cli/_fixtures.ts`(本地 fixture,不从 src/ 出口外露;
 * 测试通过直接 import 拿到 harness stub)。
 *
 * 涵盖的四个测试文件:
 *   - tests/harness/graph/run-graph-ledger.test.ts
 *   - tests/harness/graph/run-graph-residual.test.ts
 *   - tests/harness/graph/run-graph-cancel.test.ts
 *   - tests/harness/graph/run-graph-contract.test.ts
 *
 * 这套 fixture 钉住「handler 真的驱动了 manager 的 spawn」—— 用 fake
 * 替代会让我们要验的真 spawn / 零 spawn / 产出沿边流动被 mock 掉。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { vi } from "vitest";

import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../../src/harness/subagent/envelope.ts";

export interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
  /** 累积写进 stdin 的 payload(manager 的 worker 载荷),供 task 文本断言。 */
  readonly written: string[];
}

export function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    written,
  }) as unknown as FakeChild;
}

export interface MakeManagerOpts {
  readonly maxConcurrentWorkers?: number;
}

export interface FakeManagerBundle {
  readonly manager: SubAgentManager;
  readonly children: FakeChild[];
}

export function makeManager(opts: MakeManagerOpts = {}): FakeManagerBundle {
  const children: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    },
    ...(opts.maxConcurrentWorkers !== undefined
      ? { maxConcurrentWorkers: opts.maxConcurrentWorkers }
      : {}),
  });
  return { manager, children };
}

/** 写一份 envelope + 触发 child 退出,让 manager.waitFor 解除阻塞。 */
export function settle(child: FakeChild, envelope: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(envelope) + "\n");
  child.emit("exit", 0, null);
}

export function ok(result: string): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

export function fail(error: string): SubAgentEnvelope {
  return {
    status: "failed",
    summary: "boom",
    reason: error,
    result: "",
  };
}

/**
 * 等到 children 累计到目标数。scheduler 在 spawn 后才把它放进数组,
 * 所以是「下一个子代理的 child 已 spawn」的 ground truth —— 比
 * `setTimeout` / 固定 sleep 更稳定(SPEC 文件里 handler 测试共享
 * 这个 poll-loop)。
 */
export async function waitForChildren(
  children: FakeChild[],
  target: number
): Promise<void> {
  if (children.length >= target) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (children.length >= target) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
}

/** condense() 返回的浓缩结果结构 —— 单测断言形状。 */
export interface CondensedNode {
  readonly id: string;
  readonly status: string;
  readonly output?: string;
  readonly error?: string;
  readonly reason?: string;
}

export interface Condensed {
  readonly waveCount: number;
  readonly nodes: ReadonlyArray<CondensedNode>;
}

export function parseCondensed(raw: unknown): Condensed {
  if (typeof raw !== "string") {
    throw new Error(
      `expected condense() to return a string, got ${typeof raw}`
    );
  }
  return JSON.parse(raw) as Condensed;
}
