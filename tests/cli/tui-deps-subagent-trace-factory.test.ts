/**
 * TUI 装配层（`src/tui/deps.ts`）的 subagent trace 接线。
 *
 * 背景：`buildTuiDeps` 委托 `buildHarnessEngine({ surface: "tui" })`，但一直没把
 * trace 工厂交出去 —— chat（cli.ts）与 serve（hub.ts）都在 traceOut 配置时传
 * `subagentTraceFactory`，只有 TUI 这条产品路径让 manager 落回 build-engine 的
 * 默认 NoopTraceService。后果：TUI 下 turn / tool 记录照常落
 * `<traceOut>/<conversationId>.jsonl`（hub 侧写），子代理生命周期三事件却一条都
 * 没有。这不是转发被吞（那是 cli/runtime.ts 那条缝，见
 * tests/cli/runtime-subagent-trace-factory.test.ts），TUI 是压根没接线。
 *
 * 本文件锁的是 TUI 这一跳：`buildTuiDeps({ traceOut })` → registry 按会话建的
 * manager 真的把 spawn / state_change / stop 写进
 * `<traceOut>/<conversationId>.jsonl`；不配 traceOut → 不写盘。build-engine 内部
 * 如何消费工厂由 tests/harness/build-engine-subagent-trace.test.ts 覆盖，不重复。
 *
 * 为什么不在 tests/tui/：那个目录由 bun:test 驱动（OpenTUI 原生 FFI 只有 bun
 * 有），而本测试要用 vitest 的模块级 vi.mock 换掉 `createSubAgentManager` 的
 * spawn 工厂（不起真实 worker 进程）—— bun 侧同款拦截要走 mock.module，deps.ts
 * 注释记录的 bun require 死锁正是为此绕开的。`src/tui/deps.ts` 本身是纯 TS 模块
 * （无 ink / OpenTUI 依赖），在 Node 下可直接 import。
 *
 * Mock 策略与 tests/cli/runtime-subagent-trace-factory.test.ts 同源。
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
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
  };
  return { env, session: {} };
}

function settle(
  child: (typeof mockState.fakeChildren)[number],
  envelope: SubAgentEnvelope
): void {
  child.stdout.write(JSON.stringify(envelope) + "\n");
  child.emit("exit", 0, null);
}

let scratchDir: string;
let fixtureRoot: string;
let shutdown: (() => Promise<void>) | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "iknow-tui-trace-factory-"));
  // tmp userHome / cwd 隔离真实 ~/.iknow 与 worktree 的 .iknow/mcp.json
  // （否则装配期起真实 stdio server），与 tests/tui/deps-tools.test.ts 同款。
  fixtureRoot = mkdtempSync(join(tmpdir(), "iknow-tui-trace-root-"));
  mockState.fakeChildren.length = 0;
});

afterEach(async () => {
  if (shutdown) {
    await shutdown();
    shutdown = undefined;
  }
  rmSync(scratchDir, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("buildTuiDeps — subagentTraceFactory 接线", () => {
  it("配了 traceOut → 会话 manager 的 spawn/state_change/stop 落 <traceOut>/<conversationId>.jsonl", async () => {
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-on"), {
      askUser: createNoAskUser(),
      traceOut: scratchDir,
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    const registry = deps.subagentManagers;
    assert.ok(registry, "surface=tui 必须有 manager registry");
    const manager = registry.forConversation("conv-tui");
    manager.spawn({ task: "trace me" });
    expect(mockState.fakeChildren.length).toBe(1);
    settle(mockState.fakeChildren[0]!, {
      status: "ok",
      summary: "done",
      result: "r",
    });
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    const types = readFileSync(join(scratchDir, "conv-tui.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { record_type: string }).record_type);
    expect(types).toContain("subagent_spawn");
    expect(types).toContain("subagent_state_change");
    expect(types).toContain("subagent_stop");
  });

  it("两个会话各自成桶：事件按 conversationId 分文件，不再有聚合文件", async () => {
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-split"), {
      askUser: createNoAskUser(),
      traceOut: scratchDir,
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    const registry = deps.subagentManagers;
    assert.ok(registry);
    registry.forConversation("conv-a").spawn({ task: "task-a" });
    registry.forConversation("conv-b").spawn({ task: "task-b" });
    expect(mockState.fakeChildren.length).toBe(2);
    for (const child of mockState.fakeChildren) {
      settle(child, { status: "ok", summary: "done", result: "r" });
    }
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    for (const conversationId of ["conv-a", "conv-b"]) {
      const types = readFileSync(
        join(scratchDir, `${conversationId}.jsonl`),
        "utf8"
      )
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { record_type: string }).record_type);
      expect(types).toContain("subagent_spawn");
      expect(types).toContain("subagent_state_change");
      expect(types).toContain("subagent_stop");
    }
    assert.ok(
      !existsSync(join(scratchDir, "subagent.jsonl")),
      "归属由文件名承担，不该再写聚合的 subagent.jsonl"
    );
  });

  it("不配 traceOut → 不写盘（零副作用，与 build-engine 默认 Noop 一致）", async () => {
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-off"), {
      askUser: createNoAskUser(),
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    const manager = deps.subagentManagers?.forConversation("conv-tui");
    assert.ok(manager);
    manager.spawn({ task: "no trace" });
    settle(mockState.fakeChildren[0]!, {
      status: "ok",
      summary: "done",
      result: "r",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      !existsSync(join(scratchDir, "conv-tui.jsonl")),
      "未配 traceOut 时不该产生 JSONL"
    );
  });
});
