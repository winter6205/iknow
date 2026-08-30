/**
 * #356 T6 — defaultSubAgentSpawn 生产 worker 进程 spawn 工厂（T2 报告要求的
 * 接线落点）。
 *
 * DI 由 build-engine 注入 createSubAgentManager({ spawn: defaultSubAgentSpawn })。
 * 形态 = 同 iknow binary headless 重入：`node <iknow-bin> --subagent-worker`
 * （cli.ts main() 对 `__subagent_worker__` command 的 dispatch，spec 假设 5）。
 * worker 协议：`stdin` 一行 envelope → `stdout` 一行 result。
 *
 * 职责边界：
 *   - `stdinPayload` 写不写由 manager 负责（manager.spawn 拿到 child 后自己
 *     `write + end`），spawn.ts 只负责 spawn + 返回 child；
 *   - env 继承父进程（ADR-0001，不发明第二条 env 协议）。
 *
 * 形参为 `SubAgentSpawn` 签名契约：defaultSubAgentSpawn 不读 `def` / `taskId`
 * / `stdinPayload`（由 manager 端消费），下划线前缀避开 `noUnusedParameters`。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { SubAgentSpawn } from "./manager.js";

const requireFromSpawn = createRequire(import.meta.url);

export interface ResolveSubagentWorkerSpawnArgsOptions {
  readonly execPath: string;
  readonly argv1?: string;
  /**
   * Accepted for callers that already collect Node execution arguments. The
   * child receives an explicit loader below, so it does not need inherited
   * execArgv.
   */
  readonly execArgv?: readonly string[];
  /** Test seam: fail tsx resolution without mocking node:module. */
  readonly resolveTsxLoader?: () => string;
}

export class SubagentWorkerSpawnArgsError extends Error {
  override readonly name = "SubagentWorkerSpawnArgsError";

  constructor(
    message = "Cannot spawn subagent worker: process.argv[1] is missing"
  ) {
    super(message);
  }
}

function isNodeExecutable(execPath: string): boolean {
  const executable = execPath.split(/[\\/]/).pop()?.toLowerCase();
  return (
    executable === "node" ||
    executable === "node.exe" ||
    executable === "nodejs"
  );
}

function isTypeScriptEntry(argv1: string): boolean {
  return /\.(?:ts|mts|tsx|cts)$/i.test(argv1);
}

function defaultResolveTsxLoader(): string {
  return requireFromSpawn.resolve("tsx");
}

export function resolveSubagentWorkerSpawnArgs({
  execPath,
  argv1,
  resolveTsxLoader = defaultResolveTsxLoader,
}: ResolveSubagentWorkerSpawnArgsOptions): string[] {
  if (!argv1) {
    throw new SubagentWorkerSpawnArgsError();
  }

  // Node children need an explicit tsx ESM loader; Bun runs TypeScript natively.
  // Resolve the loader from this module (not the child's cwd): `--import tsx`
  // fails when the agent cwd is outside the repo (Cannot find package 'tsx').
  if (isNodeExecutable(execPath) && isTypeScriptEntry(argv1)) {
    let loader: string;
    try {
      loader = resolveTsxLoader();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SubagentWorkerSpawnArgsError(
        `Cannot spawn subagent worker: tsx loader not resolved: ${detail}`
      );
    }
    return ["--import", loader, argv1, "--subagent-worker"];
  }

  return [argv1, "--subagent-worker"];
}

export function resolveSubagentTraceDir(traceDir?: string): string {
  return resolve(traceDir ?? process.env.IKNOW_TRACE_OUT ?? "./trace/");
}

/**
 * T5 (plans/worktree-isolation-model-provision.md, hard req 7): the worker
 * child inherits the parent session's REBOUND root. When the parent session
 * was rebound to its task worktree, build-engine passes that root here and
 * the child starts with `cwd` = the task worktree (its 说明书 discovery /
 * skill scan / bash-relative reads happen in the same tree as the parent);
 * undefined (unbound session / worker defaults) = no cwd option = the child
 * inherits the parent process cwd byte-identically to today.
 */
export function createDefaultSubAgentSpawn(
  traceDir?: string,
  workspaceRoot?: string,
  sessionRoot?: string
): SubAgentSpawn {
  const resolvedTraceDir = resolveSubagentTraceDir(traceDir);
  return (_def, _taskId, _stdinPayload) => {
    const child = spawn(
      process.execPath,
      resolveSubagentWorkerSpawnArgs({
        execPath: process.execPath,
        argv1: process.argv[1],
      }),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          IKNOW_TRACE_OUT: resolvedTraceDir,
          ...(workspaceRoot !== undefined
            ? { IKNOW_WORKSPACE_ROOT: workspaceRoot }
            : {}),
        },
        ...(sessionRoot !== undefined ? { cwd: sessionRoot } : {}),
      }
    );
    // manager 负责写 stdin（worker 协议：stdin 一行 envelope → stdout 一行 result）。
    return child as ChildProcess;
  };
}

export const defaultSubAgentSpawn: SubAgentSpawn = (
  def,
  taskId,
  stdinPayload
) => createDefaultSubAgentSpawn()(def, taskId, stdinPayload);
