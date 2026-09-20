/**
 * bash_output / bash_stop ACI tools (model-facing operations surface).
 *
 * Acceptance coverage:
 *   1. happy path (fake manager): bash_output returns `{text, status, exit_code,
 *      task_id}` JSON; bash_stop calls manager.stop(task_id) then returns
 *      `{task_id, status:"stopped"}`.
 *   2. typed-error passthrough: fake manager throws a `{kind, context}` typed
 *      object → the tool renders `${kind}: ${context}` into a
 *      ToolExecutionError (code-quality.md typed-error catch contract, never
 *      `[object Object]`); empty-string task_id passes through →
 *      empty_task_id; unknown task_id → task_not_found.
 *   3. max_bytes clamp (clamp-path-with-annotation): absent / <=0 →
 *      DEFAULT_LOG_MAX_BYTES (12KB, manager.ts SSOT); > MAX_LOG_READ_BYTES
 *      (100KB) → clamped to the cap, no throw. Manager-argument assertions
 *      pin the converged value.
 *   4. real physical truncation (real registry + real manager + fake child):
 *      log beyond the default window → tool.handler({task_id}) → text length
 *      ≤ DEFAULT and equal to the tail of the original (tail semantics, not a
 *      throw). max_bytes overriding the default window uses the same path.
 *   5. bash_stop idempotence (kill_race semantics): a second stop of an
 *      already-terminal task does not throw.
 *   6. assembly consistency: fully-conditional assembly (backgroundManager +
 *      graph overlay) → full length and `toEqual(ACI_TOOLSET_NAMES)` (the
 *      array is the count SSOT; assertions derive from it, no hardcoded
 *      totals); backgroundManager absent → bash_output / bash_stop excluded,
 *      bash kept (resident pass-through semantics).
 *   7. permission shape (checkPermission direct-call, permission.test.ts
 *      precedent): bash_output read-only → default allow; bash_stop write →
 *      ask.
 *
 * bwrap dependency: createDefaultAciRegistry → createBashTool runs a
 * requireBwrap() guard at construction time (bash.ts:56); per the
 * d9-description-guard.test.ts precedent, runner.js requireBwrap is mocked to
 * a no-op to stay CI-portable (local WSL with bwrap can run it directly).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

vi.mock("../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.js")
    >();
  return { ...actual, requireBwrap: () => {} };
});

import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createBashOutputTool } from "../../../src/harness/aci/tools/bash-output.js";
import { createBashStopTool } from "../../../src/harness/aci/tools/bash-stop.js";
import {
  createDefaultAciRegistry,
  ACI_TOOLSET_NAMES,
} from "../../../src/harness/aci/tools/registry.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/aci/permission.js";
import {
  createBackgroundTaskManager,
  DEFAULT_LOG_MAX_BYTES,
  MAX_LOG_READ_BYTES,
} from "../../../src/harness/background/manager.js";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import { createSkillCatalog } from "../../../src/harness/skill/catalog.js";
import type { IknowEnv } from "../../../src/config/env.js";
import type { SubAgentManager } from "../../../src/harness/subagent/manager.js";
import type { CreateWorktreeProvisionFn } from "../../../src/harness/aci/tools/create-worktree.js";
import type { WorktreeEnterToolDeps } from "../../../src/harness/aci/tools/enter-worktree.js";
import type { WorktreeExitToolDeps } from "../../../src/harness/aci/tools/exit-worktree.js";
import type { ListWorktreesToolDeps } from "../../../src/harness/aci/tools/list-worktrees.js";
import type { RemoveWorktreeToolDeps } from "../../../src/harness/aci/tools/remove-worktree.js";
import type { McpManager } from "../../../src/harness/mcp/manager.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** fake manager — observes output/stop args only; real physical truncation goes through the real manager below. */
function makeFakeManager(): {
  manager: BackgroundTaskManager;
  output: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const output = vi.fn();
  const stop = vi.fn(async () => undefined);
  const manager = {
    spawn: vi.fn(),
    status: vi.fn(),
    output,
    stop,
  } as unknown as BackgroundTaskManager;
  return { manager, output, stop };
}

/** fake SubAgentManager — for assembly-time assertions (mirrors registry.test.ts fixture). */
const fakeSubagentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" as const }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  getCapacity: () => 15,
  listSubagents: () => [],
  subscribe: () => () => {},
} as unknown as SubAgentManager;

/** fake McpManager — for assembly-time assertions (mirrors registry.test.ts fixture). */
const fakeMcpManager: McpManager = {
  start: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  status: () => [],
  listResources: () => Promise.reject(new Error("fake: list not stubbed")),
  readResource: () => Promise.reject(new Error("fake: read not stubbed")),
} as unknown as McpManager;

/** fake BackgroundTaskManager — for assembly-time assertions (registry mirror filtering). */
const fakeBackgroundManager = {
  spawn: vi.fn(),
  status: vi.fn(),
  output: vi.fn(),
  stop: vi.fn(async () => undefined),
} as unknown as BackgroundTaskManager;

/** fake ChildProcess (manager.test.ts precedent: EventEmitter + PassThrough). */
interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(pid = 23456): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

/** Real manager assembly (persists to real fs; the fake spawn factory starts no real process). */
const tempRoots: string[] = [];
async function makeRealManager(): Promise<{
  manager: BackgroundTaskManager;
  spawned: FakeChild[];
}> {
  const root = await mkdtemp(join(tmpdir(), "iknow-bg-tool-"));
  tempRoots.push(root);
  const spawned: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
    spawn: async () => {
      const child = makeFakeChild(23456 + spawned.length);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, spawned };
}

afterEach(async () => {
  vi.clearAllTimers();
  await Promise.all(
    tempRoots.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

/** Minimal valid env (web fields only; the registry factory consumes only env.web). */
function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

/** Worktree isolation host fakes (createDefaultAciRegistry assembly-time
 * assertions only; handler-path unit tests live under each tool's own directory, not here). */
const fakeWorktreeProvision: CreateWorktreeProvisionFn = async () =>
  "/tmp/fake-worktree";
const fakeWorktreeEnter: WorktreeEnterToolDeps["worktreeEnter"] = async () => ({
  path: "/tmp/fake-worktree",
  receipt: "entered task worktree: /tmp/fake-worktree",
});
const fakeWorktreeExit: WorktreeExitToolDeps["worktreeExit"] = async () =>
  "/tmp/fake-main";
const fakeWorktreeList: ListWorktreesToolDeps["worktreeList"] = async () => [];
const fakeWorktreeRemove: RemoveWorktreeToolDeps["worktreeRemove"] =
  async () => ({
    label: undefined,
    conversationId: "fake-conversation",
    path: "/tmp/fake-worktree",
    branch: "iknow/task-fake-conversation",
    head: "fake-head",
    branchDeleted: false,
  });

/** Full conditional assembly opts (five condition keys + backgroundManager + graph overlay + worktree host seams) → complete toolset (count = ACI_TOOLSET_NAMES). */
function fullAssemblyOpts() {
  return {
    env: makeWebEnv(),
    sandboxRoot: "/tmp/root",
    memoryDir: "/tmp/root/memory",
    skillCatalog: createSkillCatalog([]),
    subagentManager: fakeSubagentManager,
    todoDir: "/tmp/root/session-1/todos",
    mcpManager: fakeMcpManager,
    backgroundManager: fakeBackgroundManager,
    // graph overlay present → run_graph joins the registry.
    graphAssembly: { enabled: () => true },
    // worktree isolation (ADR-0037): host seams present for assembly; handlers not triggered.
    worktreeProvision: fakeWorktreeProvision,
    worktreeEnter: fakeWorktreeEnter,
    worktreeExit: fakeWorktreeExit,
    worktreeList: fakeWorktreeList,
    worktreeRemove: fakeWorktreeRemove,
  };
}

// ── 1. happy path (fake manager) ─────────────────────────────────────────────

describe("bash_output happy path（fake manager）", () => {
  it("返回 {text, status, exit_code, task_id} JSON，缺省 max_bytes → DEFAULT", async () => {
    const { manager, output } = makeFakeManager();
    output.mockResolvedValue({
      text: "listening on :8080",
      status: "running",
      exit_code: null,
      task_id: "bg-0123456789ab",
    });
    const tool = createBashOutputTool({ backgroundManager: manager });

    const result = await tool.handler({ task_id: "bg-0123456789ab" });

    assert.deepEqual(JSON.parse(result as string), {
      text: "listening on :8080",
      status: "running",
      exit_code: null,
      task_id: "bg-0123456789ab",
    });
    assert.equal(output.mock.calls[0]?.[0], "bg-0123456789ab");
    // max_bytes absent → manager receives the default window (12KB).
    assert.equal(output.mock.calls[0]?.[1], DEFAULT_LOG_MAX_BYTES);
  });

  it("max_bytes 缺省 / <=0 → DEFAULT_LOG_MAX_BYTES（12KB）", async () => {
    const { manager, output } = makeFakeManager();
    output.mockResolvedValue({
      text: "x",
      status: "exited",
      exit_code: 0,
      task_id: "bg-0123456789ab",
    });
    const tool = createBashOutputTool({ backgroundManager: manager });

    await tool.handler({ task_id: "bg-0123456789ab", max_bytes: 0 });
    assert.equal(output.mock.calls[0]?.[1], DEFAULT_LOG_MAX_BYTES);
    await tool.handler({ task_id: "bg-0123456789ab", max_bytes: -5 });
    assert.equal(output.mock.calls[1]?.[1], DEFAULT_LOG_MAX_BYTES);
  });

  it("max_bytes > MAX_LOG_READ_BYTES → clamp 到上限（不抛错；manager 入参收敛）", async () => {
    const { manager, output } = makeFakeManager();
    output.mockResolvedValue({
      text: "x",
      status: "exited",
      exit_code: 0,
      task_id: "bg-0123456789ab",
    });
    const tool = createBashOutputTool({ backgroundManager: manager });

    const result = await tool.handler({
      task_id: "bg-0123456789ab",
      max_bytes: MAX_LOG_READ_BYTES + 999,
    });
    assert.equal(output.mock.calls[0]?.[1], MAX_LOG_READ_BYTES);
    assert.equal(JSON.parse(result as string).text, "x");

    // Boundary value (exactly the cap) passes through unchanged (no extra clamping).
    await tool.handler({
      task_id: "bg-0123456789ab",
      max_bytes: MAX_LOG_READ_BYTES,
    });
    assert.equal(output.mock.calls[1]?.[1], MAX_LOG_READ_BYTES);
  });
});

// ── 2. typed-error passthrough (fake manager) ────────────────────────────────

describe("bash_output / bash_stop typed-error passthrough", () => {
  it("task_not_found → ToolExecutionError 渲染 `${kind}: ${context}`（kind 判别）", async () => {
    const { manager } = makeFakeManager();
    manager.output.mockRejectedValue({
      kind: "task_not_found",
      context: "bg-0123456789ab",
    });
    const tool = createBashOutputTool({ backgroundManager: manager });

    await assert.rejects(
      tool.handler({ task_id: "bg-0123456789ab" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === "bash_output: task_not_found: bg-0123456789ab"
    );
  });

  it("empty task_id 透传 → empty_task_id kind 渲染（不拦截空串）", async () => {
    const { manager } = makeFakeManager();
    manager.output.mockRejectedValue({
      kind: "empty_task_id",
      context: "output",
    });
    const tool = createBashOutputTool({ backgroundManager: manager });

    await assert.rejects(
      tool.handler({ task_id: "" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === "bash_output: empty_task_id: output"
    );
  });

  it("missing task_id → 工具层自己拒绝（ToolExecutionError，schema 之外的防御）", async () => {
    const { manager } = makeFakeManager();
    const tool = createBashOutputTool({ backgroundManager: manager });

    await assert.rejects(
      tool.handler({}),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.message.includes("task_id")
    );
    assert.equal(manager.output.mock.calls.length, 0);
  });

  it("bash_stop task_not_found → ToolExecutionError 渲染 `task_not_found: <id>`", async () => {
    const { manager } = makeFakeManager();
    manager.stop.mockRejectedValue({
      kind: "task_not_found",
      context: "bg-0123456789ab",
    });
    const tool = createBashStopTool({ backgroundManager: manager });

    await assert.rejects(
      tool.handler({ task_id: "bg-0123456789ab" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === "bash_stop: task_not_found: bg-0123456789ab"
    );
  });

  it("bash_stop empty task_id 透传 → empty_task_id kind 渲染", async () => {
    const { manager } = makeFakeManager();
    manager.stop.mockRejectedValue({ kind: "empty_task_id", context: "stop" });
    const tool = createBashStopTool({ backgroundManager: manager });

    await assert.rejects(
      tool.handler({ task_id: "" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === "bash_stop: empty_task_id: stop"
    );
  });
});

// ── 3. bash_stop happy path + idempotence (fake manager) ─────────────────────

describe("bash_stop happy path（fake manager）", () => {
  it("manager.stop 收到 task_id；返回 {task_id, status:'stopped'}；二次 stop 不抛", async () => {
    const { manager, stop } = makeFakeManager();
    const tool = createBashStopTool({ backgroundManager: manager });

    const result = await tool.handler({ task_id: "bg-0123456789ab" });
    assert.deepEqual(JSON.parse(result as string), {
      task_id: "bg-0123456789ab",
      status: "stopped",
    });
    assert.equal(stop.mock.calls[0]?.[0], "bg-0123456789ab");

    // Idempotence (fake): a second stop of an already-settled task succeeds directly (mock resolve).
    await tool.handler({ task_id: "bg-0123456789ab" });
    assert.equal(stop.mock.calls.length, 2);
  });
});

// ── 4. real physical truncation (real registry + real manager + fake child) ──

describe("bash_output 真实物理截断（real manager）", () => {
  it("log 超默认窗口 → text 长度 = DEFAULT_LOG_MAX_BYTES（tail 语义,且 head/tail 可区分时验证 head 被裁）", async () => {
    const { manager, spawned } = await makeRealManager();
    const { task_id } = await manager.spawn({ command: "tail", cwd: "." });

    // Distinct head/tail bytes make physical truncation observable: HEAD_* sits at
    // the front of the original, TAIL_* at the end; slice(-limit) must keep TAIL_* and drop HEAD_*.
    const head = "HEAD__HEAD__HEAD__HEAD__HEAD__HEAD__HEAD__HEAD__"; // 56 chars
    const tail = "TAIL__TAIL__TAIL__TAIL__TAIL__TAIL__TAIL__TAIL__"; // 56 chars
    const paddingLen = DEFAULT_LOG_MAX_BYTES + 5000;
    const body =
      head + "y".repeat(paddingLen - head.length - tail.length) + tail;
    await new Promise<void>((resolve) => {
      spawned[0]!.stdout.write(body, () => resolve());
    });
    spawned[0]!.emit("exit", 0, null);

    const tool = createBashOutputTool({ backgroundManager: manager });
    const result = JSON.parse((await tool.handler({ task_id })) as string) as {
      text: string;
      status: string;
      exit_code: number | null;
    };
    assert.equal(result.status, "exited");
    assert.equal(result.exit_code, 0);
    // Physical truncation: output is exactly the default window (input > DEFAULT → truncated to DEFAULT).
    assert.equal(result.text.length, DEFAULT_LOG_MAX_BYTES);
    // tail: the final segment is kept (last char matches the original's trailing TAIL_*).
    assert.equal(result.text.endsWith(tail), true);
    // Physical truncation: the head segment is cut (leading HEAD_* absent from output).
    assert.equal(result.text.includes(head), false);
  });

  it("max_bytes 覆盖默认窗口（物理路径，小窗口返回尾部精华）", async () => {
    const { manager, spawned } = await makeRealManager();
    const { task_id } = await manager.spawn({ command: "tail", cwd: "." });
    await new Promise<void>((resolve) => {
      spawned[0]!.stdout.write("0123456789", () => resolve());
    });
    spawned[0]!.emit("exit", 0, null);

    const tool = createBashOutputTool({ backgroundManager: manager });
    const result = JSON.parse(
      (await tool.handler({ task_id, max_bytes: 5 })) as string
    ) as { text: string };
    assert.equal(result.text, "56789");
  });

  it("bash_stop 对已 exited 任务二次 stop 幂等（real manager，kill_race 语义）", async () => {
    const { manager, spawned } = await makeRealManager();
    const { task_id } = await manager.spawn({ command: "fast", cwd: "." });
    spawned[0]!.emit("exit", 0, null);
    const st = await manager.status(task_id);
    assert.equal(st.status, "exited");

    const tool = createBashStopTool({ backgroundManager: manager });
    // stop × 2 on an already-terminal task: idempotent success, no throw.
    await tool.handler({ task_id });
    await tool.handler({ task_id });
    const st2 = await manager.status(task_id);
    assert.equal(st2.status, "exited");
  });
});

// ── 5. assembly consistency (registry + conditional gating) ──────────────────

describe("装配一致性（bash_output / bash_stop 条件化装配）", () => {
  it("全条件装配（含 backgroundManager + graph overlay）→ ACI_TOOLSET_NAMES 全长，顺序 = SSOT", () => {
    const reg = createDefaultAciRegistry(fullAssemblyOpts());
    const names = reg.inner.list().map((d) => d.name);
    assert.equal(names.length, ACI_TOOLSET_NAMES.length);
    assert.deepEqual(names, [...ACI_TOOLSET_NAMES]);
    assert.ok(reg.catalog.get("bash_output"));
    assert.ok(reg.catalog.get("bash_stop"));
  });

  it("backgroundManager 缺席 → bash_output / bash_stop 排除（全长 − 2 bg − 5 worktree），bash 保留（T3 常驻）", () => {
    // run_graph is resident — absent from the registry only when subagentManager is
    // absent (with graphAssembly absent the handler's default-off isEnabled gates it;
    // tool-surface membership is unchanged). This test passes subagentManager →
    // run_graph present; omitting worktree host seams → 5 worktree tools absent; the
    // read-side trio (query_trace / list_sessions / get_record) has no assembly
    // condition and stays. Count derived from the SSOT: full ACI_TOOLSET_NAMES − 2(bg) − 5(worktree).
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      memoryDir: "/tmp/root/memory",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      todoDir: "/tmp/root/session-1/todos",
      mcpManager: fakeMcpManager,
    });
    const names = reg.inner.list().map((d) => d.name);
    assert.equal(names.length, ACI_TOOLSET_NAMES.length - 2 - 5);
    assert.equal(names.includes("bash_output"), false);
    assert.equal(names.includes("bash_stop"), false);
    // bash is resident: with backgroundManager absent, the parameter-level capability is decided by the handler at runtime.
    assert.equal(names.includes("bash"), true);
    // run_graph is resident (subagentManager present) → present on the tool surface,
    // guarded by the handler's default-off isEnabled.
    assert.equal(names.includes("run_graph"), true);
  });
});

// ── 6. permission shape (checkPermission direct-call) ────────────────────────

describe("bash_output / bash_stop permission shape", () => {
  it("bash_output read-only → 默认 allow；bash_stop write → ask（#502 明示）", () => {
    const policy = createPermissionPolicy();

    const outTool = createBashOutputTool({
      backgroundManager: fakeBackgroundManager,
    });
    const out = checkPermission({
      def: outTool,
      input: { task_id: "bg-0123456789ab" },
      policy,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("read-only"));

    const stopTool = createBashStopTool({
      backgroundManager: fakeBackgroundManager,
    });
    const st = checkPermission({
      def: stopTool,
      input: { task_id: "bg-0123456789ab" },
      policy,
    });
    assert.equal(st.decision, "ask");
    assert.ok(st.reason.includes("ask user"));
  });
});
