/**
 * Shared `run_graph` handler test fixture: fake SubAgentManager + fake child +
 * envelope write-back / wait helpers.
 *
 * Style follows `tests/cli/_fixtures.ts` (local fixture, never re-exported from
 * src/; tests import the harness stubs directly).
 *
 * Used by these four test files:
 *   - tests/harness/graph/run-graph-ledger.test.ts
 *   - tests/harness/graph/run-graph-residual.test.ts
 *   - tests/harness/graph/run-graph-cancel.test.ts
 *   - tests/harness/graph/run-graph-contract.test.ts
 *
 * This fixture pins "the handler really drove manager.spawn": only the child
 * process is faked — the manager itself is real, so spawn counts and
 * output-along-edge flow remain observable ground truth, not mocked away.
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
  /** Payloads accumulated on stdin (the manager's worker input), for asserting task text. */
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

/** Write an envelope to stdout and emit exit, unblocking manager.waitFor. */
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
 * Wait until the children array reaches the target length. The scheduler only
 * pushes a child after spawn, so this is ground truth for "the next
 * sub-agent's child has spawned" — more stable than `setTimeout`/fixed sleep
 * (shared poll-loop across the run_graph handler tests).
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

/** Shape of condense()'s condensed result — the structure unit tests assert against. */
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
