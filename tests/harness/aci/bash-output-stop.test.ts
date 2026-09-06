/**
 * #502 T4 — bash_output / bash_stop ACI 工具（Track A 模型操作面）。
 *
 * 覆盖计划 acceptance（plans/bash-service-loop.md T4）：
 *   1. happy path（fake manager）：bash_output 返回 `{text, status, exit_code,
 *      task_id}` JSON；bash_stop 调用 manager.stop(task_id) 后返回
 *      `{task_id, status:"stopped"}`。
 *   2. typed-error passthrough：fake manager 抛 `{kind, context}` typed object →
 *      工具渲染 `${kind}: ${context}` 装进 ToolExecutionError（code-quality.md
 *      typed-error catch 契约，禁 [object Object]）；空串 task_id 透传 →
 *      empty_task_id；未知 task_id → task_not_found。
 *   3. max_bytes clamp（T4 定稿，clamp-path-with-annotation）：缺席 / <=0 →
 *      DEFAULT_LOG_MAX_BYTES（12KB，manager.ts SSOT）；> MAX_LOG_READ_BYTES
 *      （100KB）→ 钳到上限，不抛错。manager 入参断言锁定收敛值。
 *   4. 真实物理截断（real registry + real manager + fake child）：log 超默认
 *      窗口 → tool.handler({task_id}) → text 长度 ≤ DEFAULT 且等于原文尾部
 *      （tail 语义，非抛错）。max_bytes 覆盖默认窗口同路径验证。
 *   5. bash_stop 幂等（kill_race 语义，T2 定稿）：对已终态任务二次 stop 不抛。
 *   6. 装配一致性：全条件装配（含 backgroundManager + graph overlay）→ 全长且
 *      `toEqual(ACI_TOOLSET_NAMES)`（件数以数组为真值，本文件断言处为准）；
 *      backgroundManager 缺席 → bash_output / bash_stop 排除（不含 graphAssembly
 *      时 run_graph 同步缺席），bash 保留（T3 常驻透传语义）。
 *      symbol-primary-aci T5 后：旧 10 lsp_* 已退役（件数因此下调）；
 *      disclosure-index-align T2 后：skill_search 已退役（件数再下调）。
 *   7. permission shape（checkPermission direct-call，permission.test.ts 先例）：
 *      bash_output read-only → 默认 allow；bash_stop write → ask（#502 票明说
 *      「bash_stop ask」）。
 *
 * bwrap 依赖：createDefaultAciRegistry → createBashTool 构造期 requireBwrap()
 * 守卫（bash.ts:56），d9-description-guard.test.ts 先例 —— mock runner.js
 * requireBwrap 为 no-op 保持 CI-portable（本地 WSL 有 bwrap 自可直跑）。
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
import type { CreateTaskWorktreeProvisionFn } from "../../../src/harness/aci/tools/create-task-worktree.js";
import type { WorktreeEnterToolDeps } from "../../../src/harness/aci/tools/enter-task-worktree.js";
import type { WorktreeExitToolDeps } from "../../../src/harness/aci/tools/exit-task-worktree.js";
import type { ListTaskWorktreesToolDeps } from "../../../src/harness/aci/tools/list-task-worktrees.js";
import type { RemoveTaskWorktreeToolDeps } from "../../../src/harness/aci/tools/remove-task-worktree.js";
import type { McpManager } from "../../../src/harness/mcp/manager.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** fake manager —— 只观察 output/stop 入参；真实物理截断走下方 real manager。 */
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

/** fake SubAgentManager —— 装配期断言用（镜像 registry.test.ts fixture）。 */
const fakeSubagentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" as const }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  listSubagents: () => [],
  subscribe: () => () => {},
} as unknown as SubAgentManager;

/** fake McpManager —— 装配期断言用（镜像 registry.test.ts fixture）。 */
const fakeMcpManager: McpManager = {
  start: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  status: () => [],
  listResources: () => Promise.reject(new Error("fake: list not stubbed")),
  readResource: () => Promise.reject(new Error("fake: read not stubbed")),
} as unknown as McpManager;

/** fake BackgroundTaskManager —— 装配期断言用（Gate 3 镜像过滤）。 */
const fakeBackgroundManager = {
  spawn: vi.fn(),
  status: vi.fn(),
  output: vi.fn(),
  stop: vi.fn(async () => undefined),
} as unknown as BackgroundTaskManager;

/** fake ChildProcess（沿用 manager.test.ts 先例：EventEmitter + PassThrough）。 */
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

/** real manager 装配（真实 fs 落盘，fake spawn 工厂不真启进程）。 */
const tempRoots: string[] = [];
async function makeRealManager(): Promise<{
  manager: BackgroundTaskManager;
  spawned: FakeChild[];
}> {
  const root = await mkdtemp(join(tmpdir(), "iknow-bg-tool-"));
  tempRoots.push(root);
  const spawned: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir: resolveTasksDir(root),
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

/** 最小合法 env（仅 web 字段；registry 工厂只消费 env.web）。 */
function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

/** worktree isolation host fakes（仅用于 createDefaultAciRegistry 装配期
 * 断言；handler 路径单测在各自工具目录下，不在本文件）。 */
const fakeWorktreeProvision: CreateTaskWorktreeProvisionFn = async () =>
  "/tmp/fake-worktree";
const fakeWorktreeEnter: WorktreeEnterToolDeps["worktreeEnter"] = async () =>
  "/tmp/fake-worktree";
const fakeWorktreeExit: WorktreeExitToolDeps["worktreeExit"] = async () =>
  "/tmp/fake-main";
const fakeWorktreeList: ListTaskWorktreesToolDeps["worktreeList"] =
  async () => [];
const fakeWorktreeRemove: RemoveTaskWorktreeToolDeps["worktreeRemove"] =
  async () => ({
    label: undefined,
    conversationId: "fake-conversation",
    path: "/tmp/fake-worktree",
    branch: "iknow/task-fake-conversation",
    head: "fake-head",
    branchDeleted: false,
  });

/** 全条件装配 opts（五条件键 + backgroundManager + graph overlay + worktree host seams）→ 44 件全量。 */
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
    // D-α T3:graph overlay 在场 → run_graph 入注册表（末位第 31 件）。
    graphAssembly: { enabled: () => true },
    // worktree isolation (ADR-0037):3 件装配路径到场,handler 不触发。
    worktreeProvision: fakeWorktreeProvision,
    worktreeEnter: fakeWorktreeEnter,
    worktreeExit: fakeWorktreeExit,
    worktreeList: fakeWorktreeList,
    worktreeRemove: fakeWorktreeRemove,
  };
}

// ── 1. happy path（fake manager）──────────────────────────────────────────────

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
    // 缺省 max_bytes → manager 收到默认窗口（12KB）。
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

    // 临界值（恰好等于上限）原样透传（不额外钳）。
    await tool.handler({
      task_id: "bg-0123456789ab",
      max_bytes: MAX_LOG_READ_BYTES,
    });
    assert.equal(output.mock.calls[1]?.[1], MAX_LOG_READ_BYTES);
  });
});

// ── 2. typed-error passthrough（fake manager）────────────────────────────────

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

// ── 3. bash_stop happy path + 幂等（fake manager）─────────────────────────────

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

    // 幂等语义（fake）：对已收敛任务的二次 stop 直接成功（mock resolve）。
    await tool.handler({ task_id: "bg-0123456789ab" });
    assert.equal(stop.mock.calls.length, 2);
  });
});

// ── 4. 真实物理截断（real registry + real manager + fake child）──────────────

describe("bash_output 真实物理截断（real manager）", () => {
  it("log 超默认窗口 → text 长度 = DEFAULT_LOG_MAX_BYTES（tail 语义,且 head/tail 可区分时验证 head 被裁）", async () => {
    const { manager, spawned } = await makeRealManager();
    const { task_id } = await manager.spawn({ command: "tail", cwd: "." });

    // head/tail 用不同字节,让物理截断可观察:HEAD_* 头部字节在原文前段,
    // TAIL_* 尾部字节在原文末尾;slice(-limit) 应保留 TAIL_*,不保留 HEAD_*。
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
    // 物理截断:输出恰好等于默认窗口(input > DEFAULT → 截断到 DEFAULT)。
    assert.equal(result.text.length, DEFAULT_LOG_MAX_BYTES);
    // tail:末段保留(最后字符是原文最后一个 'l',与原文末尾 TAIL_ 对齐)。
    assert.equal(result.text.endsWith(tail), true);
    // 物理截断:头段被裁(原文前段 HEAD_ 不出现在输出里)。
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
    // 对已终态 stop × 2：幂等成功，不抛。
    await tool.handler({ task_id });
    await tool.handler({ task_id });
    const st2 = await manager.status(task_id);
    assert.equal(st2.status, "exited");
  });
});

// ── 5. 装配一致性（registry + Gate 3 镜像过滤）───────────────────────────────

describe("装配一致性（bash_output / bash_stop 条件化装配）", () => {
  it("全条件装配（含 backgroundManager + graph overlay）→ 43 件，顺序 = ACI_TOOLSET_NAMES", () => {
    const reg = createDefaultAciRegistry(fullAssemblyOpts());
    const names = reg.inner.list().map((d) => d.name);
    assert.equal(names.length, 43);
    assert.deepEqual(names, [...ACI_TOOLSET_NAMES]);
    assert.ok(reg.catalog.get("bash_output"));
    assert.ok(reg.catalog.get("bash_stop"));
  });

  it("backgroundManager 缺席 → bash_output / bash_stop 排除（36 件），bash 保留（T3 常驻）", () => {
    // ADR-0041 / plans/model-prefix-layering.md B3:`run_graph` 常驻 —
    // 仅 subagentManager 缺席才不在注册表(graphAssembly 缺席由 handler
    // isEnabled 缺省恒关守门,工具面成员不变)。本测试传 subagentManager →
    // run_graph 在场;不传 worktree host seams → 5 件缺席;读侧三轴
    // (query_trace / list_sessions / get_record) 无装配条件仍在场。
    // 43 - 2(bg) - 5(worktree) = 36。
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
    assert.equal(names.length, 36);
    assert.equal(names.includes("bash_output"), false);
    assert.equal(names.includes("bash_stop"), false);
    // bash 常驻：backgroundManager 缺席时参数级能力由 handler 运行时决策。
    assert.equal(names.includes("bash"), true);
    // ADR-0041:run_graph 常驻(subagentManager 在场)→ 工具面成员在场,
    // handler isEnabled 缺省恒关守门。
    assert.equal(names.includes("run_graph"), true);
  });
});

// ── 6. permission shape（checkPermission direct-call）───────────────────────

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
