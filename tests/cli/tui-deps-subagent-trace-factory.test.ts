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
  capturedSubagentsDir: undefined as string | undefined,
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

  it("不配 conversationId → TUI 派生一个 fallback conversationId, subagentsDir 仍注入 manager", async () => {
    // ADR-0071: the TUI entry requires every spawn to locate
    // <parent session folder>/subagents/. Even when the caller omits
    // conversationId, the assembly layer falls back to randomUUID() so the
    // per-agent layout is always writable — no longer dependent on caller
    // configuration. Verify the derived capturedSubagentsDir ends with
    // /subagents (independent of the conversationId segment: once the manager
    // gets the derived dir, it creates it).
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-trace-off"), {
      askUser: createNoAskUser(),
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    // No conversationId passed → the TUI falls back to an internal randomUUID, still
    // deriving subagentsDir and injecting it into the manager (captured field non-empty).
    assert.ok(
      mockState.capturedSubagentsDir !== undefined,
      "TUI 必须给 manager 一个 subagentsDir,即便 caller 没传 conversationId"
    );
    assert.match(
      mockState.capturedSubagentsDir!,
      /\/subagents$/,
      `subagentsDir 应以 /subagents 收尾, 实际 ${mockState.capturedSubagentsDir}`
    );

    // diagnosticsDir defaults to falling back to subagentsDir (the stderr pointer follows the parent dir)
    assert.equal(
      mockState.capturedDiagnosticsDir,
      mockState.capturedSubagentsDir
    );
  });
});
