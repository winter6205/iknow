/**
 * TUI 装配层（`src/tui/deps.ts`）的 subagent trace 接线（#704 onto #721 master）。
 *
 * master 上单例 subagentManager + hub 同形的 `<traceOut>/subagent.jsonl` 聚合落盘
 * （非旧链 per-conversation registry）。本文件锁：配 traceOut → spawn 三事件写盘；
 * 不配 → Noop。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

const mockState = vi.hoisted(() => ({
  fakeChildren: [] as Array<{
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    emit: (event: string | symbol, ...args: unknown[]) => boolean;
    once: (event: string | symbol, ...args: unknown[]) => unknown;
  }>,
}));

vi.mock("../../src/harness/subagent/manager.ts", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../../src/harness/subagent/manager.ts")
    >();
  const realCreate = actual.createSubAgentManager;
  return {
    ...actual,
    createSubAgentManager: vi.fn((opts: Parameters<typeof realCreate>[0]) => {
      const fakeSpawn: (
        def: unknown,
        taskId: string,
        payload: unknown
      ) => ChildProcess = () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          pid: 4343,
          kill: vi.fn(() => true),
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
        });
        mockState.fakeChildren.push(
          child as unknown as (typeof mockState.fakeChildren)[number]
        );
        return child as unknown as ChildProcess;
      };
      return realCreate({ ...opts, spawn: fakeSpawn as never });
    }),
  };
});

import { buildTuiDeps } from "../../src/tui/deps.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { RuntimeBundle } from "../../src/cli/runtime.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

function makeBundle(apiKey: string): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    subagent: { taskTimeoutMs: 60_000 },
    mcp: { connectTimeoutMs: 60_000 },
    secrets: { mode: "roundtrip" },
    sandbox: { enabled: false },
    verify: { enabled: false },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
  };
  return { env, settings: {} as RuntimeBundle["settings"] };
}

function settle(
  child: (typeof mockState.fakeChildren)[number],
  envelope: SubAgentEnvelope
): void {
  child.stdout.write(JSON.stringify(envelope) + "\n");
  child.emit("close", 0);
}

let scratchDir: string;
let fixtureRoot: string;
let shutdown: (() => Promise<void>) | undefined;

beforeEach(() => {
  mockState.fakeChildren.length = 0;
  scratchDir = mkdtempSync(join(tmpdir(), "iknow-tui-trace-"));
  fixtureRoot = mkdtempSync(join(tmpdir(), "iknow-tui-fix-"));
});

afterEach(async () => {
  if (shutdown) {
    await shutdown();
    shutdown = undefined;
  }
  rmSync(scratchDir, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("buildTuiDeps — subagentTrace 接线", () => {
  it("配了 traceOut → manager 的 spawn/state_change/stop 落 subagent.jsonl", async () => {
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-on"), {
      askUser: createNoAskUser(),
      traceOut: scratchDir,
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    const manager = deps.subagentManager;
    assert.ok(manager, "surface=tui 必须有 subagentManager");
    manager.spawn({ task: "trace me" });
    expect(mockState.fakeChildren.length).toBe(1);
    settle(mockState.fakeChildren[0]!, {
      status: "ok",
      summary: "done",
      result: "r",
    });
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    const types = readFileSync(join(scratchDir, "subagent.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { record_type: string }).record_type);
    expect(types).toContain("subagent_spawn");
    expect(types).toContain("subagent_state_change");
    expect(types).toContain("subagent_stop");
  });

  it("不配 traceOut → 不写盘（NoopTraceService）", async () => {
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-off"), {
      askUser: createNoAskUser(),
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    const manager = deps.subagentManager;
    assert.ok(manager);
    manager.spawn({ task: "no trace" });
    settle(mockState.fakeChildren[0]!, {
      status: "ok",
      summary: "done",
      result: "r",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      !existsSync(join(scratchDir, "subagent.jsonl")),
      "无 traceOut 时不应写 JSONL"
    );
  });
});
