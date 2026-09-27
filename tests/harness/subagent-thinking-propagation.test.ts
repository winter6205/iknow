import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import type { IknowEnv } from "../../src/config/env.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createLoopEngine } from "../../src/harness/loop-engine.ts";
import {
  createSubAgentManager,
  type SubAgentDefinition,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { withThinkingOverride } from "../../src/session-api/thinking-override.ts";
import { wrapWithViolationHook } from "../../src/harness/sandbox/violation-executor.ts";
import { assistantResult } from "../cli/_fixtures.ts";

interface CapturedLaunch {
  readonly definition: SubAgentDefinition;
  readonly taskId: string;
  readonly payload: WorkerEnvelope;
  readonly child: FakeWorkerChild;
}

interface FakeWorkerChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeWorkerChild(): FakeWorkerChild {
  const child = new EventEmitter();
  const stderr = new PassThrough();
  return Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    pid: 4242,
    kill: () => {
      setImmediate(() => {
        stderr.end();
        child.emit("exit", null, "SIGTERM");
      });
      return true;
    },
  }) as unknown as FakeWorkerChild;
}

function makeEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "test-key",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "off",
      maxTurns: 5,
    },
    chat: { showThinking: false, quiet: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined, maxConcurrentWorkers: 15 },
    workspaceRoot: undefined,
    productRoot: undefined,
  } as unknown as IknowEnv;
}

async function finishWorker(
  manager: ReturnType<typeof createSubAgentManager>,
  launch: CapturedLaunch
): Promise<void> {
  const settled = manager.waitFor(launch.taskId, 2_000);
  const envelope: SubAgentEnvelope = {
    status: "ok",
    summary: "finished",
    result: "finished",
  };
  launch.child.stdout.write(JSON.stringify(envelope) + "\n");
  launch.child.emit("exit", 0, null);
  await settled;
}

describe("parent thinking propagation through the assembled harness executor", () => {
  it("preserves the per-turn snapshot through ACI, permission, sandbox, and worktree wrappers", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-thinking-propagation-"));
    const taskRoot = join(root, ".iknow", "worktrees", "conv-1");
    await mkdir(taskRoot, { recursive: true });

    const launches: CapturedLaunch[] = [];
    const manager = createSubAgentManager({
      sandboxRoot: taskRoot,
      subagentsDir: join(root, "subagents"),
      spawn: (definition, taskId, payload) => {
        const child = makeFakeWorkerChild();
        launches.push({ definition, taskId, payload, child });
        return child as unknown as ChildProcess;
      },
    });
    const provisionCalls: Array<{
      readonly conversationId?: string;
      readonly root: string;
    }> = [];
    const env = makeEnv();
    let built: Awaited<ReturnType<typeof buildHarnessEngine>> | undefined;

    try {
      built = await buildHarnessEngine({
        env,
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: taskRoot,
        sandboxRoot: taskRoot,
        workspaceRoot: taskRoot,
        productRoot: root,
        projectIdentityRoot: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: {
          provision: async (context) => {
            provisionCalls.push(context);
            return taskRoot;
          },
        },
        skipCountTokens: true,
        mcpFirstTurnReadyTimeoutMs: 10,
      });

      const turnDeps = withThinkingOverride({
        deps: built.deps,
        override: { mode: "adaptive", effort: "xhigh" },
        env,
      });
      const model = createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [
              {
                id: "toolu-spawn",
                name: "spawn_subagent",
                input: {
                  title: "inspect implementation",
                  task: "inspect the implementation",
                  subagent_type: "general-purpose",
                  wait: false,
                },
              },
            ],
          }),
          assistantResult({ texts: ["done"], supplierStop: "success" }),
        ],
      });
      const engine = createLoopEngine({
        ...turnDeps,
        adapter: model,
        executor: wrapWithViolationHook({
          inner: turnDeps.executor,
          onKill: () => undefined,
        }),
        conversationId: "conv-1",
      });

      const { result } = await engine.run("delegate a task");

      expect(result.stopReason).toBe("completed");
      expect(provisionCalls).toHaveLength(1);
      expect(provisionCalls[0]?.root).toBe(taskRoot);
      expect(launches).toHaveLength(1);
      assert.deepEqual(launches[0]!.payload.parentThinking, {
        mode: "adaptive",
        effort: "xhigh",
      });
      assert.deepEqual(launches[0]!.definition.parentThinking, {
        mode: "adaptive",
        effort: "xhigh",
      });
    } finally {
      for (const launch of launches) {
        await finishWorker(manager, launch);
      }
      if (built !== undefined) await built.shutdown?.();
      else await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
