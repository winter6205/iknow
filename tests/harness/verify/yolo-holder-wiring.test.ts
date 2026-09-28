/**
 * ADR-0119 / specs/yolo-mode.md — the assembly pass-through chain of the yolo
 * holder (assembly + threading).
 *
 * Invariants pinned (Contract §3 / §6, four-route consistency):
 *   1. `createDefaultAciRegistry({ yolo })` passes the holder to the bash factory
 *      **by reference** (not a `.get()` snapshot) — flipping the holder after
 *      assembly is still seen by the per-call snapshot taken at handler entry
 *      (D2, same shape as fsMode), so the fence argv goes from bwrap-prefixed to
 *      bare;
 *   2. `runVerifyLoop({ yolo })` passes the holder to the default executor
 *      `makeDefaultRunVerify` (the closure is built fresh each round => the
 *      snapshot vintage is that round) -> with yolo ON the verify fence argv is
 *      bare, with yolo absent it still carries the bwrap prefix;
 *   3. absent / false -> non-yolo (fail-closed keeps the fence, the V1 baseline is
 *      byte-identical);
 *   4. an in-flight flip is not cross-route atomic (Contract §6): a `/yolo` flip
 *      landing inside a call keeps that call's entry-vintage shape (foreground
 *      fence argv, background request), the next call/spawn reads the fresh
 *      value.
 *
 * Same technique as `tests/harness/aci/yolo-four-routes.test.ts` /
 * `yolo-sandbox-run.test.ts`: module-mock `sandbox/runner.ts` only (the
 * `requireBwrap` probe + a `runInSandbox` stand-in) and keep `createBwrapFence`
 * the real factory — the asserted face is the real fence argv `runInSandbox`
 * receives, with bwrap never actually running.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../../src/harness/sandbox/runner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.ts")
    >();
  return {
    ...actual,
    requireBwrap: vi.fn(),
    runInSandbox: vi.fn(),
  };
});

import * as sandboxRunner from "../../../src/harness/sandbox/runner.ts";
import { createDefaultAciRegistry } from "../../../src/harness/aci/tools/registry.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { runVerifyLoop } from "../../../src/harness/verify/verify-loop.ts";
import { createYoloContext } from "../../../src/harness/sandbox/yolo.ts";
import type {
  BackgroundSpawnRequest,
  BackgroundTaskManager,
} from "../../../src/harness/background/manager.ts";
import { makeNative } from "../../cli/_fixtures.ts";
import type { RunOutcome } from "../../../src/harness/verify/verify-loop.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";
import type { LoopTrace } from "../../../src/harness/loop-trace.ts";

const FIX_CWD = mkdtempSync(join(tmpdir(), "yolo-wiring-cwd-"));
const FIX_SANDBOX = mkdtempSync(join(tmpdir(), "yolo-wiring-sandbox-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
  rmSync(FIX_SANDBOX, { recursive: true, force: true });
});

const capturedArgvs: string[][] = [];

beforeEach(() => {
  capturedArgvs.length = 0;
  vi.mocked(sandboxRunner.requireBwrap).mockReset();
  vi.mocked(sandboxRunner.runInSandbox)
    .mockReset()
    .mockImplementation(async (opts) => {
      capturedArgvs.push([...opts.fence.argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
});

afterEach(() => {
  vi.clearAllMocks();
});

const WEB_ENV = { web: { searchUrl: undefined, proxy: undefined } } as const;

/** Take the registry's bash tool and run the handler once (real fence factory, stand-in runner). */
async function runRegistryBash(
  reg: ReturnType<typeof createDefaultAciRegistry>
): Promise<void> {
  const bash = reg.catalog.get("bash");
  expect(bash).toBeDefined();
  await bash!.handler({ command: "echo hi" }, { conversationId: "yolo-wire" });
}

const EMPTY_TRACE: LoopTrace = Object.freeze({
  turns: Object.freeze([]),
  totals: Object.freeze({
    totalDurationMs: 0,
    cancelKindCounts: Object.freeze({
      none: 0,
      callerAbort: 0,
      timerTimeout: 0,
      hostCancel: 0,
    }),
    toolErrorTotals: Object.freeze({
      ok: 0,
      validation_failed: 0,
      tool_not_found: 0,
      execution_failed: 0,
    }),
  }),
});

/**
 * Content-gate signal: an inert non-doc source edit. Opens the upstream
 * verify gate (text-only stubs would now never enter verify) with zero
 * effect on checkEvidence verdict/reasons.
 */
function gateSignalMessage(): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "gate-edit",
        name: "edit_file",
        input: { filePath: "src/app.ts" },
      },
    ],
  };
}

function stubRun(text: string, userText: string): RunOutcome {
  const messages: AnthropicNativeMessage[] = [
    makeNative({ role: "user", text: userText }),
    gateSignalMessage(),
    makeNative({ role: "assistant", text }),
  ];
  return {
    result: {
      finalText: text,
      messages,
      turnCount: 1,
      stopReason: "completed",
      lastUsage: null,
    },
    trace: EMPTY_TRACE,
  };
}

/** Run one verify closed loop (command path) and return this call's real fence argv. */
async function runVerifyOnce(
  yolo: ReturnType<typeof createYoloContext> | undefined
): Promise<string[]> {
  await runVerifyLoop({
    runFn: async (text) => stubRun("done", text),
    userText: "do it",
    config: { command: "echo hi" },
    sessionId: "yolo-holder-wiring",
    cwd: FIX_CWD,
    ...(yolo !== undefined ? { yolo } : {}),
  });
  expect(capturedArgvs.length).toBeGreaterThan(0);
  return capturedArgvs[0]!;
}

describe("registry -> bash factory: the yolo holder passes by reference (ADR-0119)", () => {
  it("holder reads true -> the bash fence argv is bare (argv[0] = bash)", async () => {
    const reg = createDefaultAciRegistry({
      env: WEB_ENV,
      sandboxRoot: FIX_SANDBOX,
      yolo: createYoloContext(true),
    });
    await runRegistryBash(reg);
    expect(capturedArgvs).toHaveLength(1);
    expect(capturedArgvs[0]!.slice(0, 3)).toEqual(["bash", "-c", "echo hi"]);
    // The yolo assembly path skips the factory-time bwrap probe (a host without
    // bwrap can still assemble).
    expect(vi.mocked(sandboxRunner.requireBwrap)).not.toHaveBeenCalled();
  });

  it("holder absent -> baseline bwrap argv (the V1 baseline holds)", async () => {
    const reg = createDefaultAciRegistry({
      env: WEB_ENV,
      sandboxRoot: FIX_SANDBOX,
    });
    await runRegistryBash(reg);
    expect(capturedArgvs).toHaveLength(1);
    expect(capturedArgvs[0]![0]).toBe("bwrap");
    expect(capturedArgvs[0]!).toContain("--unshare-net");
    expect(vi.mocked(sandboxRunner.requireBwrap)).toHaveBeenCalledTimes(1);
  });

  it("flipping the holder after assembly -> the next handler call reads the new value (per-call snapshot, D2)", async () => {
    // At assembly time the holder's initial value is false (non-yolo), so the
    // factory-time requireBwrap probe runs as before.
    const holder = createYoloContext(false);
    const reg = createDefaultAciRegistry({
      env: WEB_ENV,
      sandboxRoot: FIX_SANDBOX,
      yolo: holder,
    });
    await runRegistryBash(reg);
    expect(capturedArgvs[0]![0]).toBe("bwrap");

    // At runtime `/yolo` flips this same holder instance — no engine rebuild.
    holder.set(true);
    await runRegistryBash(reg);
    expect(capturedArgvs[1]!.slice(0, 3)).toEqual(["bash", "-c", "echo hi"]);
  });
});

describe("runVerifyLoop -> makeDefaultRunVerify: yolo holder pass-through (ADR-0119)", () => {
  it("holder reads true -> the verify fence argv is bare", async () => {
    const argv = await runVerifyOnce(createYoloContext(true));
    expect(argv.slice(0, 3)).toEqual(["bash", "-c", "echo hi"]);
  });

  it("holder absent / reads false -> baseline bwrap argv (fail-closed, same shape)", async () => {
    const absent = await runVerifyOnce(undefined);
    expect(absent[0]).toBe("bwrap");
    expect(absent).toContain("--unshare-net");

    capturedArgvs.length = 0;
    const explicitFalse = await runVerifyOnce(createYoloContext(false));
    expect(explicitFalse).toEqual(absent);
  });

  it("the next closed loop after a flip reads the new value (the executor closure is built per round)", async () => {
    const holder = createYoloContext(false);
    expect((await runVerifyOnce(holder))[0]).toBe("bwrap");

    capturedArgvs.length = 0;
    holder.set(true);
    expect((await runVerifyOnce(holder)).slice(0, 3)).toEqual([
      "bash",
      "-c",
      "echo hi",
    ]);
  });
});

describe("in-flight /yolo flip keeps each route's entry vintage (Contract §6, no cross-route atomicity)", () => {
  it("foreground: a flip landing inside the call never re-fences it — the in-flight argv stays bwrap, the next call is bare", async () => {
    const holder = createYoloContext(false);
    const reg = createDefaultAciRegistry({
      env: WEB_ENV,
      sandboxRoot: FIX_SANDBOX,
      yolo: holder,
    });
    // The flip fires between handler entry (snapshot taken) and completion:
    // per-call snapshot semantics mean THIS call keeps the bwrap fence.
    vi.mocked(sandboxRunner.runInSandbox).mockImplementationOnce(
      async (opts) => {
        capturedArgvs.push([...opts.fence.argv]);
        holder.set(true);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );
    await runRegistryBash(reg);
    expect(capturedArgvs[0]![0]).toBe("bwrap");
    expect(holder.get()).toBe(true);

    // Fresh vintage on the next call: bare.
    await runRegistryBash(reg);
    expect(capturedArgvs[1]!.slice(0, 3)).toEqual(["bash", "-c", "echo hi"]);
  });

  it("background: the request is frozen at handler entry — a flip landing inside manager.spawn keeps this request non-yolo, the next call carries yolo:true", async () => {
    const holder = createYoloContext(false);
    const captured: BackgroundSpawnRequest[] = [];
    const manager = {
      spawn: async (req: BackgroundSpawnRequest) => {
        captured.push(req);
        // Flip lands after this call's snapshot; per-spawn semantics = next
        // spawn reads fresh, this request is untouched.
        holder.set(true);
        return {
          status: "ok",
          task_id: "bg-vintage",
          log_path: join(FIX_SANDBOX, "bg-vintage.log"),
        };
      },
    } as unknown as BackgroundTaskManager;
    const tool = createBashTool(FIX_CWD, {
      tmpDir: FIX_SANDBOX,
      yolo: holder,
      backgroundManager: manager,
    });
    await tool.handler(
      { command: "echo hi", background: true },
      { conversationId: "yolo-vintage" }
    );
    expect(captured[0]!.yolo).toBeUndefined();

    await tool.handler(
      { command: "echo hi", background: true },
      { conversationId: "yolo-vintage" }
    );
    expect(captured[1]!.yolo).toBe(true);
  });
});
