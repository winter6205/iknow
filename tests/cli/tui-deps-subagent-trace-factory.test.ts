/**
 * Subagent trace wiring in the TUI assembly layer (`src/tui/deps.ts`), in the
 * per-agent form.
 *
 * ADR-0071: after the parent session-folder merge, subagent
 * lifecycle / content trace uses the per-agent layout —
 * `<parent session folder>/subagents/agent-<taskId>.jsonl` (derivation formula
 * `resolveSubagentTraceDir({projectDir, conversationId})`).
 *
 * Test locks:
 *   - conversationId set → spawn's three events land in
 *     `<subagentsDir>/agent-<taskId>.jsonl` (subagentsDir derived from
 *     `<projectDir>/<conversationId>/subagents/`);
 *   - traceOut is still passed through to diagnosticsDir (stderr pointer), via
 *     the assembly layer's `opts.traceOut` compatibility shape;
 *   - unset → manager falls back to NoopTrace, nothing written to disk.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  capturedSubagentsDir: undefined as string | undefined,
  capturedProjectDir: undefined as string | undefined,
  capturedDiagnosticsDir: undefined as string | undefined,
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
      mockState.capturedSubagentsDir = opts.subagentsDir;
      mockState.capturedProjectDir = opts.projectDir;
      mockState.capturedDiagnosticsDir = opts.diagnosticsDir;
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
    workspaceRoot: undefined,
    productRoot: undefined,
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
  };
  return { env, session: {} };
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
  mockState.capturedSubagentsDir = undefined;
  mockState.capturedDiagnosticsDir = undefined;
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

describe("buildTuiDeps — subagent trace 接线 (T5 per-agent 形态)", () => {
  it("配 conversationId → manager spawn 三事件落 <subagentsDir>/agent-<taskId>.jsonl", async () => {
    const conversationId = "tui-conv-on-1";
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-on"), {
      askUser: createNoAskUser(),
      conversationId,
      traceOut: scratchDir,
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    // subagentsDir is derived by the TUI assembly layer from (projectDir, conversationId);
    // the test reads the actual value via mockState.capturedSubagentsDir to avoid hardcoding
    // resolveProjectSessionDir's `<basename>-<sha1[:12]>` suffix.
    assert.ok(
      mockState.capturedSubagentsDir !== undefined,
      "TUI 必须把 subagentsDir 注入 manager"
    );
    const subagentsDir = mockState.capturedSubagentsDir!;
    assert.match(
      subagentsDir,
      new RegExp(`${conversationId}/subagents$`),
      `subagentsDir 应该以 <conversationId>/subagents 收尾,实际 ${subagentsDir}`
    );

    const manager = deps.subagentManager;
    assert.ok(manager, "surface=tui 必须有 subagentManager");
    const { taskId } = manager.spawn({ task: "trace me" });
    expect(mockState.fakeChildren.length).toBe(1);
    settle(mockState.fakeChildren[0]!, {
      status: "ok",
      summary: "done",
      result: "r",
    });
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    const filePath = join(subagentsDir, taskId, `agent-${taskId}.jsonl`);
    const types = readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { record_type: string }).record_type);
    expect(types).toContain("subagent_spawn");
    expect(types).toContain("subagent_state_change");
    expect(types).toContain("subagent_stop");
  });

  it("traceOut → manager diagnosticsDir uses the traceOut tree (stderr pointer 兼容)", async () => {
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-diagnostics"), {
      askUser: createNoAskUser(),
      conversationId: "tui-conv-diagnostics-1",
      traceOut: scratchDir,
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    expect(mockState.capturedDiagnosticsDir).toBe(scratchDir);
  });

  it("不配 conversationId → 传 projectDir 而非不可计算的 subagentsDir,由 manager 按 spawn 推导", async () => {
    // ADR-0071 wants every spawn under <parent session folder>/subagents/. At TUI
    // assembly the caller does not know the conversationId, and `subagentsDir`
    // takes priority over `projectDir` in the manager — so pinning an
    // assembly-time randomUUID() there would write every worker record under a
    // directory no later process can compute. The entry sweep resolves
    // <projectDir>/<conversationId>/subagents from the real id and would find
    // nothing, leaving an owned worker no process can stop or even see.
    //
    // So the un-known-id case must use the per-spawn derivation seam instead,
    // and this asserts the absence of the uncomputable dir as the load-bearing
    // part — not merely that some directory was passed.
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-off"), {
      askUser: createNoAskUser(),
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    assert.equal(
      mockState.capturedSubagentsDir,
      undefined,
      "caller 未传 conversationId 时不得注入 subagentsDir,否则记录会落在无法推导的目录"
    );
    assert.ok(
      mockState.capturedProjectDir !== undefined,
      "TUI 必须传 projectDir,让 manager 用 def.conversationId 在 spawn 时推导每会话叶子"
    );

    // The stderr pointer is still supplied — it falls back to the manager's own
    // trace root when no subagentsDir is present, which is a STABLE path rather
    // than the assembly-time UUID the old shape produced. The load-bearing
    // assertion is the two above; this one only guards against the pointer
    // being dropped entirely.
    assert.ok(
      mockState.capturedDiagnosticsDir !== undefined,
      "stderr 指针必须仍然提供,否则子进程 stderr 无处落盘"
    );
  });
});
