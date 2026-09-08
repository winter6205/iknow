/**
 * T2 (plans/worktree-session-roots.md) — 会话三根 SSOT（ADR-0037 §4）。
 *
 * 唯一根策略点：一次输入按**角色**出三个根，调用方（memory / skills /
 * permission / background / config / mcp / subagent spawn）只消费返回值，不再
 * 自行拼 `join(cwd, '.iknow', …)`、读 `process.cwd()` 或判断 task worktree。
 * 唯一例外是装配层选 per-root 状态锚（build-engine 判 `workspaceRoot` 是否已是
 * task worktree，ADR-0037 §4 amended）—— 那是一次策略决策，不是路径拼装。
 * 身份根的**取值**（宿主钉的值，或缺席时 `mainCheckoutOf(cwd)`）同样由装配层
 * 决定，但**校验**在这里，与另外三根同一条规则。
 *
 *  - `productRoot`：开会话时的主 checkout，首次装配钉死，跨 rebind 与重启不变。
 *    `mcp.json` 只问它（`mcpConfigRoot`，#828 已落地，行为不变）；per-root 状态
 *    （记忆库 / tasks）的锚由装配层定：`workspaceRoot` 优先，仅当它自身已是
 *    task worktree 时退到 `productRoot`（ADR-0037 §4 amended）。
 *  - `projectIdentityRoot`：用户此刻在做的那个项目，宿主启动时钉一次，跨 rebind
 *    不变。**项目身份只问它**——rules / 项目 `AGENTS.md` / `permissions.toml` /
 *    项目 skills 发现、子代理继承的身份根、记忆库命名空间名。与 `productRoot`
 *    分开的原因：宿主按 ADR-0019 从 `workspaceRoot` 取 `productRoot`，而
 *    `--workspace-root <dir>` 重定向档下 `<dir>` 不是项目（`dir ≠ cwd`）。
 *  - `taskRoot`：本会话 task worktree（create / enter 切过去，exit 切回主仓）。
 *    **写与工具 cwd 只问它**——写工具 / 会改工作区的 bash / git / LSP 目录 /
 *    子代理工作目录。
 *  - `installRoot`：iknow 运行时自身的安装位置（worker bootstrap 解析 tsx 与
 *    自身依赖）。≠ 用户项目的 `node_modules`，故裸 task worktree 上 worker 仍起。
 *
 * `resolveSessionRoots` 是纯函数：不读 git、不碰文件系统、不持会话状态。缺根 /
 * 空白 / 相对 / 无法规范化一律 fail-closed 抛 `SessionRootError`（「与已固定的根
 * 不一致」归 `resolveMcpRoots({ expectedWorkspaceRoot })`，此处不平行开第二套），
 * **绝不**回退 `process.cwd()`。唯一有 IO 的导出是 `resolveInstallRoot`，它锚在
 * `import.meta.url` 而不是任何会话根。
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SessionRootError } from "./errors.js";

/** 诊断里回显根值的上限：长路径也要保持有限诊断。 */
export const MAX_ROOT_DETAIL_CHARS = 120;

/** 三根，全部已规范化为绝对路径。 */
export interface SessionRoots {
  readonly productRoot: string;
  readonly taskRoot: string;
  readonly installRoot: string;
  readonly projectIdentityRoot: string;
}

/**
 * T3 (plans/write-situation-disclosure.md) — 写处境三态。
 *
 * 单一来源：判定住 `src/harness/isolation/write-situation.ts`，渲染（告知面 /
 * worker prior）住 `src/harness/skill/*`，枚举类型住本文件。SC4 钉死依赖方向：
 * `skill/body.ts` 不 import `isolation/`，故渲染面只消费本枚举 + 一个非隔离根串。
 *
 * 语义（spec SC1 / SC3 / ADR-0069 Decision 2）：
 *   - `writable_main`：隔离 OFF，主仓根 = 写根。**含「隔离 OFF + 树形路径」组合**——
 *     negative 臂钉死防形状判断被单独误用（对齐 ADR-0037 §4 教训）。
 *   - `writable_tree`：隔离 ON + 活根是本会话的 task worktree（路径形状合法）。
 *   - `no_writable_root`：隔离 ON + 活根非树形（主仓对文件改动只读，告知面**不**
 *     点名 `create-task-worktree`——spec SC3）。
 */
export type WriteSituation =
  "writable_main" | "writable_tree" | "no_writable_root";

export interface ResolveSessionRootsInput {
  /** 开会话时的主 checkout；项目身份与 per-root 状态的唯一来源。 */
  readonly productRoot: string | undefined;
  /** 本会话生效的 task worktree（未改绑时等于 `productRoot`）。 */
  readonly taskRoot: string | undefined;
  /** iknow 自身安装位置；生产由 `resolveInstallRoot()` 提供。 */
  readonly installRoot: string | undefined;
  /**
   * 项目身份根。装配层给值：宿主钉下的值优先，缺席时 `mainCheckoutOf(cwd)`。
   * 到这里一律当**必填**校验 —— 显式传空串 / 相对值不得静默按 `process.cwd()`
   * 解释（改绑后那正是 task worktree）。
   */
  readonly projectIdentityRoot: string | undefined;
}

/**
 * 规范化一个根候选值的纯结果。不抛错——由各消费者把 rejection 映射成自己的
 * typed error（MCP 侧要保住既有 `McpLifecycleError` kind 分工，见
 * `mcp/roots.ts`），这样规范化规则只有一份实现。
 */
export type RootRejection =
  | { readonly reason: "missing" }
  | { readonly reason: "not_normalizable"; readonly shown: string }
  | { readonly reason: "not_absolute"; readonly shown: string };

export type RootNormalization =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly rejection: RootRejection };

/** 缺席 / 空白 / 含 NUL / 非绝对 → rejection；否则返回规范化的绝对根。 */
export function normalizeRootCandidate(
  value: string | undefined
): RootNormalization {
  if (typeof value !== "string") {
    return { ok: false, rejection: { reason: "missing" } };
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    return {
      ok: false,
      rejection: { reason: "not_normalizable", shown: trimmed },
    };
  }

  const normalized = stripTrailingSeparators(path.normalize(trimmed));
  if (!path.isAbsolute(normalized)) {
    return { ok: false, rejection: { reason: "not_absolute", shown: trimmed } };
  }
  return { ok: true, root: normalized };
}

/** 诊断回显：截断到有限长度，避免超长路径撑爆错误消息。 */
export function quoteRoot(value: string, limit: number): string {
  const shown = value.length > limit ? `${value.slice(0, limit)}…` : value;
  return `'${shown}'`;
}

/** 去掉结尾分隔符，但保留文件系统根本身（posix `/`、win32 `C:\`）。 */
function stripTrailingSeparators(p: string): string {
  const { root } = path.parse(p);
  let out = p;
  while (
    out.length > root.length &&
    (out.endsWith(path.sep) || out.endsWith("/"))
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * 解析三根。任何校验失败都在文件读取 / spawn / 工具执行之前抛出，`detail`
 * 点名出错的角色（`productRoot` / `taskRoot` / `installRoot` /
 * `projectIdentityRoot`），因为漏接的新
 * 消费者要在装配层就看得见是哪个根缺了。
 *
 * 「与已固定的 task 根一致」这条校验**不**在这里：非 ask 面由
 * `resolveMcpRoots({ expectedWorkspaceRoot })` 承担（`McpLifecycleError`
 * kind 分工对既有调用方不变），此处不再平行开第二套同义校验。
 */
export function resolveSessionRoots(
  input: ResolveSessionRootsInput
): SessionRoots {
  const productRoot = requireRoot(input.productRoot, "productRoot");
  const taskRoot = requireRoot(input.taskRoot, "taskRoot");
  const installRoot = requireRoot(input.installRoot, "installRoot");
  const projectIdentityRoot = requireRoot(
    input.projectIdentityRoot,
    "projectIdentityRoot"
  );

  return { productRoot, taskRoot, installRoot, projectIdentityRoot };
}

/** 缺席 → `missing_root`；在场但不可用 → `invalid_root`。 */
function requireRoot(value: string | undefined, label: string): string {
  const result = normalizeRootCandidate(value);
  if (result.ok) return result.root;

  const { rejection } = result;
  if (rejection.reason === "missing") {
    throw new SessionRootError(
      "missing_root",
      `${label} is required and was not provided`
    );
  }
  const requirement =
    rejection.reason === "not_absolute"
      ? "must be an absolute path"
      : "must be a normalizable absolute path";
  throw new SessionRootError(
    "invalid_root",
    `${label} ${requirement}, got ${quoteRoot(rejection.shown, MAX_ROOT_DETAIL_CHARS)}`
  );
}

/**
 * `resolveInstallRoot` 只需算一次：安装位置在进程生命周期内不变，因此刻意不给
 * reset 缝（测试要换安装根就走 `opts.installRoot` 注入，不改进程级缓存）。
 */
let cachedInstallRoot: string | undefined;

/**
 * iknow 自身的安装根：从**本模块文件**向上找最近的 `package.json` 所在目录。
 *
 * 锚点刻意是 `import.meta.url` 而不是任何会话根或 `process.cwd()`——子代理
 * worker 的 cwd 可能是一棵没有 `node_modules` 的裸 task worktree，那时
 * cwd 相对解析会以 `Cannot find package` 崩掉（硬要求 6）。dev（`src/…`）与
 * 打包后（`dist/…`）都落在同一个包根上。
 */
export function resolveInstallRoot(): string {
  if (cachedInstallRoot !== undefined) return cachedInstallRoot;

  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) {
      cachedInstallRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new SessionRootError(
    "missing_root",
    `installRoot could not be derived: no package.json above ${quoteRoot(start, MAX_ROOT_DETAIL_CHARS)}`
  );
}

// --------------------------------------------------------------------------
// T4 (plans/worktree-live-task-root.md §5 D1 / §6 T4) — live `taskRoot`
// holder + single writer.
//
// `resolveSessionRoots` stays a pure function (above). The live holder
// sits alongside it as a sibling export of the same module — the SSOT
// for "会话当前生效根". Writes are gated through ONE entry point
// (`writeLiveTaskRoot`), reached only via the build-engine wrapper around
// host `provision` / `enter` / `exit` seams (`withLiveTaskRootWrite`).
//
// Stable roots (productRoot / projectIdentityRoot / installRoot /
// mcpConfigRoot / stateAnchor / memoryDir / todoDir / traceDir) are NOT
// carried here — the cell holds a single `taskRoot` string, nothing else
// (D3).
// --------------------------------------------------------------------------

/**
 * Internal mutable shell — extends the public `LiveTaskRoot` surface with
 * a closure-captured setter. Module-scoped: only `writeLiveTaskRoot` casts
 * to this type, so the setter cannot leak through the public `LiveTaskRoot`
 * interface. Tests can read via `cell.read()`; only the wrapper around
 * host seams can write.
 */
interface LiveTaskRootInternal extends LiveTaskRoot {
  readonly __write: (value: string) => void;
}

/**
 * Live `taskRoot` cell. Reads return the current snapshot value
 * (synchronously, atomically — JS single-threaded closure reads of a
 * captured `let` have no partial-update window). Writes go through
 * `writeLiveTaskRoot`, the single writer entry point — see
 * `withLiveTaskRootWrite` for the build-engine wrapper.
 */
export interface LiveTaskRoot {
  /** Current snapshot value. */
  read(): string;
}

/**
 * Construct a `LiveTaskRoot` cell from a validated initial value
 * (typically `sessionRoots.taskRoot` produced by `resolveSessionRoots`).
 * The initial value is the pre-rebind snapshot; successful resolutions of
 * the host `provision` / `enter` / `exit` seams update the cell via
 * `writeLiveTaskRoot` / `withLiveTaskRootWrite`.
 */
export function createLiveTaskRoot(initial: string): LiveTaskRoot {
  let current = initial;
  const cell: LiveTaskRootInternal = {
    read: () => current,
    __write: (value: string): void => {
      current = value;
    },
  };
  return cell;
}

/**
 * T4 single writer — update the live `taskRoot` cell. Called only by the
 * build-engine wrapper around host seams (via `withLiveTaskRootWrite`); the
 * public `LiveTaskRoot` interface does not expose a setter, so external
 * callers cannot bypass the wrapper.
 *
 * Does NOT re-validate the input — the seam contract (`WorktreeProvisionFn`
 * / `WorktreeEnterFn` / `WorktreeExitFn`) already requires the resolver
 * to return a normalized absolute root. Wrapping this with extra
 * `normalizeRootCandidate` would surface seam contract violations as
 * `SessionRootError` instead of letting them propagate as the seam's
 * typed error, which would mask the original failure mode.
 */
export function writeLiveTaskRoot(cell: LiveTaskRoot, value: string): void {
  (cell as LiveTaskRootInternal).__write(value);
}

/**
 * T4 (plans/worktree-live-task-root.md §5 D1) — wrap an async root-resolver
 * seam so successful resolutions also update the live `taskRoot` cell.
 *
 *   - seam resolves → write cell, return the resolved value unchanged;
 *   - seam throws (any typed error) → cell **unchanged** (no write, no
 *     rollback — failure means the prior value stays put), error
 *     propagates verbatim to the caller.
 *
 * The wrap is the single writer entry point. build-engine applies this
 * helper to host `provision` / `enter` / `exit` seams uniformly — every
 * successful seam resolution reaches `writeLiveTaskRoot` through here.
 * Stable roots (D3) are not affected; only the seam-resolved value
 * (== `taskRoot`) is written.
 */
export function withLiveTaskRootWrite<
  F extends (...args: any[]) => Promise<unknown>,
>(
  seam: F,
  cell: LiveTaskRoot,
  /**
   * write-situation-disclosure T9: how to extract the ROOT from the seam
   * result. Omitted for plain string seams (`provision` / `exit`); the enter
   * seam resolves to `{ path, receipt }` and passes `(r) => r.path` so the
   * cell keeps receiving the root while the receipt flows to the tool layer.
   */
  rootOf: (value: Awaited<ReturnType<F>>) => string = (value) => value as string
): F {
  return (async (...args: any[]) => {
    const resolved = (await seam(...args)) as Awaited<ReturnType<F>>;
    writeLiveTaskRoot(cell, rootOf(resolved));
    return resolved;
  }) as F;
}
