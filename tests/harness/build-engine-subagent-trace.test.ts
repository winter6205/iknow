/**
 * #358 review-fix (Fix 1): build-engine 的 subagentTrace 注入缝 ——
 * SC1 生产装配面 (cli.ts chat path + hub.ts ensureDeps)。
 *
 * 契约（plans/358 §SC1 + spec AC）：
 *   1. buildHarnessEngine({ subagentTrace }) → 内置 createSubAgentManager
 *      收到该 trace；通过 fake spawn 工厂触发 spawn 后, 真实 JSONL 含
 *      subagent_spawn / subagent_state_change / subagent_stop 三类事件。
 *   2. 缺省 subagentTrace → manager 走 NoopTraceService（byte-stable）。
 *
 * 与 tests/subagent/manager-trace.test.ts 的差异：后者直接构造 manager,
 * 注入 trace + fake spawn 工厂；本文件验证 build-engine 的 subagentTrace
 * 装配链 —— opts.subagentTrace 正确传入 manager.closure.trace。
 *
 * Mock 策略：vi.mock 整模块（同步 fake — `vi.hoisted` 共享 state），
 * 让 build-engine.ts 的 `import { createSubAgentManager }` 解析到 spy，
 * spy 把 spawn 工厂替换为 fake（不启真实 worker）。ESM live binding 特性
 * 下 vi.spyOn(module, "createSubAgentManager") 只改 namespace 不改
 * import binding（详见 tests/harness/aci/registry-workspace-root.test.ts
 * 注释）；模块级 vi.mock 才是正确的拦截方式。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// Module mock 必须先于 buildHarnessEngine 的 dynamic import。vi.hoisted
// 共享 state 解决 vi.mock 工厂被 hoisted 与 fakeChildren 变量声明顺序问题。
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
  captureCallCount: 0,
  capturedTraceOpt: undefined as unknown,
  capturedDiagnosticsDir: undefined as unknown,
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
      mockState.captureCallCount += 1;
      mockState.capturedTraceOpt = opts.trace;
      mockState.capturedDiagnosticsDir = opts.diagnosticsDir;
      const fakeSpawn: (
        def: unknown,
        taskId: string,
        payload: unknown
      ) => ChildProcess = (_def, _taskId, _payload) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const kill = vi.fn(() => true);
        const child = Object.assign(new EventEmitter(), {
          stdin,
          stdout,
          stderr,
          pid: 12345,
          kill,
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
        });
        mockState.fakeChildren.push(
          child as unknown as (typeof mockState.fakeChildren)[number]
        );
        return child as unknown as ChildProcess;
      };
      return realCreate({
        ...opts,
        spawn: fakeSpawn as never,
      });
    }),
  };
});

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

// ── env fixture ─────────────────────────────────────────────────────────

function makeEnv(apiKey: string): IknowEnv {
  return {
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
}

function okEnvelope(result = "ok"): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function emitEnvelope(
  child: (typeof mockState.fakeChildren)[number],
  env: SubAgentEnvelope
): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

// ── per-test isolation ─────────────────────────────────────────────────

let scratchDir: string;
let built: BuiltEngine | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "iknow-bld-subagent-trace-"));
  mockState.fakeChildren.length = 0;
  mockState.captureCallCount = 0;
  mockState.capturedTraceOpt = undefined;
  mockState.capturedDiagnosticsDir = undefined;
});

afterEach(async () => {
  if (built) {
    await built.shutdown?.();
    built = undefined;
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

// ── SC1 生产装配面 ──────────────────────────────────────────────────────

describe("buildHarnessEngine — subagentTrace 注入缝 (Fix 1 SC1)", () => {
  it("opts.subagentTrace → 内置 createSubAgentManager 收到该 trace, spawn def → JSONL 含三类事件", async () => {
    const trace = createJsonlTraceService({
      filePath: scratchDir,
      conversationId: "subagent",
    });
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-subagent-trace-1"),
      askUser: createNoAskUser(),
      subagentTrace: trace,
    });

    // 1. manager 在场 + createSubAgentManager 被调用, 收到的 trace opt ===
    //    我们注入的（验证 buildHarnessEngine opts.subagentTrace 透传到
    //    createSubAgentManager({trace})）。
    expect(built.subagentManager).toBeDefined();
    expect(mockState.captureCallCount).toBe(1);
    expect(mockState.capturedTraceOpt).toBe(trace);

    // 2. spawn def → JSONL 含 subagent_spawn + subagent_state_change +
    //    subagent_stop 三类事件（mirror manager-trace.test.ts:339）。
    const manager = built.subagentManager!;
    manager.spawn({ task: "do thing" });
    expect(mockState.fakeChildren.length).toBe(1);
    emitEnvelope(mockState.fakeChildren[0]!, okEnvelope("r"));
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    const filePath = join(scratchDir, "subagent.jsonl");
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const recordTypes = lines.map((l) => JSON.parse(l).record_type as string);
    const subagentLines = recordTypes.filter((t) => t.startsWith("subagent_"));
    assert.ok(
      subagentLines.length >= 3,
      `expected >=3 subagent_* lines, got ${subagentLines.length} (${recordTypes.join(",")})`
    );
    expect(recordTypes).toContain("subagent_spawn");
    expect(recordTypes).toContain("subagent_state_change");
    expect(recordTypes).toContain("subagent_stop");
  });

  it("缺省 subagentTrace → createSubAgentManager 收到的 trace 是 NoopTraceService", async () => {
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-subagent-noop-1"),
      askUser: createNoAskUser(),
    });
    expect(built.subagentManager).toBeDefined();
    expect(mockState.captureCallCount).toBe(1);
    // NoopTraceService 注入 → recordSubagentSpawn 调用返回 undefined,
    // 不写盘（验证 byte-stable 默认行为）。
    const traceLike = mockState.capturedTraceOpt as unknown as {
      recordSubagentSpawn: () => Promise<unknown>;
    };
    expect(typeof traceLike.recordSubagentSpawn).toBe("function");
    expect(await traceLike.recordSubagentSpawn({} as never)).toBeUndefined();
  });

  it("subagentDiagnosticsDir → manager receives the crash diagnostics root", async () => {
    built = await buildHarnessEngine({
      env: makeEnv("sk-test-bld-subagent-diagnostics-1"),
      askUser: createNoAskUser(),
      subagentDiagnosticsDir: scratchDir,
    });

    expect(mockState.capturedDiagnosticsDir).toBe(scratchDir);
  });
});
