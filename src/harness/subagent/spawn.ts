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
import {
  FS_MODE_ENV_KEY,
  PRODUCT_ROOT_ENV_KEY,
  WORKSPACE_ROOT_ENV_KEY,
  WORKTREE_GATE_ON_ENV_KEY,
} from "../../config/workspace-root.js";
import type { FsModeContext } from "../sandbox/fs-mode.js";
import type { WorktreeGateReader } from "../isolation/worktree-gate.js";
import type { SubAgentSpawn } from "./manager.js";

const requireFromSpawn = createRequire(import.meta.url);

export interface ResolveSubagentWorkerSpawnArgsOptions {
  readonly execPath: string;
  readonly argv1?: string;
  /**
   * T5 (plans/worktree-session-roots.md / ADR-0037 §4): iknow 自身的安装根 —
   * tsx loader 从**它**解析，不从子进程 cwd。子进程 cwd 可能是一棵没有
   * `node_modules` 的裸 task worktree，cwd 相对解析在那里以
   * `Cannot find package 'tsx'` 崩掉（硬要求 6）。缺席 → 锚回本模块
   * (`import.meta.url`)，与生产同值，旧调用方字节不变。
   */
  readonly installRoot?: string;
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

function makeResolveTsxLoader(installRoot?: string): () => string {
  if (installRoot === undefined) return () => requireFromSpawn.resolve("tsx");
  // `createRequire` 需要一个文件锚点；用 `<installRoot>/package.json`，它就是
  // resolveInstallRoot() 找到的那个包根标记（文件不必已存在也能作锚，但生产
  // 里它一定在）。
  const requireFromInstall = createRequire(
    resolve(installRoot, "package.json")
  );
  return () => requireFromInstall.resolve("tsx");
}

export function resolveSubagentWorkerSpawnArgs({
  execPath,
  argv1,
  installRoot,
  resolveTsxLoader = makeResolveTsxLoader(installRoot),
}: ResolveSubagentWorkerSpawnArgsOptions): string[] {
  if (!argv1) {
    throw new SubagentWorkerSpawnArgsError();
  }

  // Node children need an explicit tsx ESM loader; Bun runs TypeScript natively.
  // Resolve the loader from `installRoot` (not the child's cwd): `--import tsx`
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
 * Roots the worker child needs, each in its own role. An options object rather
 * than positional strings: all four values are root-shaped paths, and getting
 * the order wrong would silently point identity discovery at the wrong tree.
 */
export interface DefaultSubAgentSpawnOpts {
  readonly traceDir?: string;
  /** ADR-0019 per-root state anchor → child's `IKNOW_WORKSPACE_ROOT`. */
  readonly workspaceRoot?: string;
  /**
   * T3 (plans/worktree-session-roots.md / ADR-0037 §4): the parent session's
   * project identity root → child's `IKNOW_PRODUCT_ROOT` (env var name kept:
   * it is the existing parent→child wire format). The child's cwd may be a
   * gitignored task worktree with no `.iknow` and no `AGENTS.md`, so its rules
   * / project AGENTS.md / project skills discovery must read the identity root.
   * Undefined → var absent → the worker falls back to its cwd (unbound
   * sessions, where both roots are the same value; byte-identical to today).
   */
  readonly projectIdentityRoot?: string;
  /**
   * T5 / T8 (plans/worktree-isolation-model-provision.md hard req 7 +
   * plans/worktree-live-task-root.md §6 T8 D6): the worker child inherits
   * the parent session's REBOUND root as its `cwd`, so writes and
   * workspace-relative bash land in the same tree as the parent.
   *
   * Shape can be either `string` (frozen value) or `() => string` (live
   * cell getter):
   *  - string: build-time decision (legacy / un-rebind), byte-stable to today;
   *  - getter: each spawn closure reads the cell current value, so rebind
   *    before the next spawn automatically lands the worker in the new tree.
   *
   * Undefined (unbound session / worker defaults) = no cwd option = the child
   * inherits the parent process cwd byte-identically to today.
   */
  readonly sessionRoot?: string | (() => string);
  /**
   * T5 (plans/worktree-session-roots.md / ADR-0037 §4): iknow 自身的安装根 —
   * 子进程的 tsx loader 从它解析。**不是**用户项目的 `node_modules`，所以裸
   * task worktree（`sessionRoot` 上无 `node_modules`）也能起 worker，不要求
   * 操作员先 symlink。缺席 → 锚回 spawn 模块自身，与生产同值。
   */
  readonly installRoot?: string;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC11:父会话的 fs 隔离档 holder →
   * 子进程 `IKNOW_FS_MODE`(与 `workspaceRoot` / `productIdentityRoot` 同一条
   * 「父进程设、worker 读」env wire;信封是 untrusted 输入面,不承载本字段)。
   * 值在**每次 spawn 时**读 holder(同 `sessionRoot` getter 的 spawn-time
   * 纪律)——装配期把 holder 冻结成字符串,运行期 `/config fs workspace` 就再
   * 也到不了子进程。holder 在场即写线(值是缺省档也写,父子对「缺省」只有
   * 一种解释:键缺席 = 这条通道未接);holder 缺席(legacy / 测试路径)→ 不写
   * 该键,子进程 env 与今日字节一致。
   */
  readonly fsMode?: FsModeContext;
  /**
   * issue 1059:父会话 worktree-on-mutate 活开关 holder → 子进程
   * `IKNOW_WORKTREE_GATE_ON`(同 fsMode 的 spawn-time 读法:运行期面板翻转
   * 对下一次 spawn 生效)。holder 在场即写线("1"/"0" 都写,键缺席 = 通道
   * 未接 → worker 永不发 UNBOUND_FENCE 段,字节不变)。
   */
  readonly worktreeGate?: WorktreeGateReader;
}

export function createDefaultSubAgentSpawn(
  opts: DefaultSubAgentSpawnOpts = {}
): SubAgentSpawn {
  const {
    workspaceRoot,
    projectIdentityRoot,
    sessionRoot,
    installRoot,
    fsMode,
    worktreeGate,
  } = opts;
  const resolvedTraceDir = resolveSubagentTraceDir(opts.traceDir);
  return (_def, _taskId, _stdinPayload) => {
    // T8 (D6): sessionRoot 在 closure 执行时读 --
    // string 时返回值不变;getter 时返回 cell 当前值,
    // 允许 build-engine 把 build-time 决定换成 spawn-time 闭包。
    const cwd = typeof sessionRoot === "function" ? sessionRoot() : sessionRoot;
    // ADR-0092 Amendment / SC11:fs 档同样在 spawn 期读 holder —— 运行期
    // `/config` 翻档对下一次 spawn 生效(镜像 sessionRoot 的 spawn-time 读法);
    // holder 缺席 → 不写该 env 键(legacy 子进程 env 字节不变)。
    const fsModeToken = fsMode?.get();
    // issue 1059:开关同 fsMode 在 spawn 期读,holder 缺席 → 不写该 env 键。
    const worktreeGateOn = worktreeGate?.get();
    const child = spawn(
      process.execPath,
      resolveSubagentWorkerSpawnArgs({
        execPath: process.execPath,
        argv1: process.argv[1],
        ...(installRoot !== undefined ? { installRoot } : {}),
      }),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          IKNOW_TRACE_OUT: resolvedTraceDir,
          ...(workspaceRoot !== undefined
            ? { [WORKSPACE_ROOT_ENV_KEY]: workspaceRoot }
            : {}),
          ...(projectIdentityRoot !== undefined
            ? { [PRODUCT_ROOT_ENV_KEY]: projectIdentityRoot }
            : {}),
          ...(fsModeToken !== undefined
            ? { [FS_MODE_ENV_KEY]: fsModeToken }
            : {}),
          ...(worktreeGateOn !== undefined
            ? { [WORKTREE_GATE_ON_ENV_KEY]: worktreeGateOn ? "1" : "0" }
            : {}),
        },
        ...(cwd !== undefined ? { cwd } : {}),
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
