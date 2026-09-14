import { existsSync } from "node:fs";
import { ToolExecutionError } from "../errors.js";
import type { FsPolicy } from "./fs-policy.js";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
} from "./fs-policy.js";
import type { NetworkPolicy } from "./network-policy.js";

export interface SeccompProfile {
  readonly fd: number;
}

// Defined in fs-policy.ts (single source with the system prefix list);
// re-exported so existing import sites keep working.
export { OPTIONAL_HOST_RO_PREFIXES };

function optionalHostRoBindArgs(): string[] {
  return OPTIONAL_HOST_RO_PREFIXES.flatMap((path) =>
    existsSync(path) ? ["--ro-bind", path, path] : []
  );
}

export interface BwrapFenceOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly fsPolicy: FsPolicy;
  readonly networkPolicy: NetworkPolicy;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  // Per-call network opt-in (#503, ADR-0022). Absent/false = isolated
  // (keep --unshare-net); true = drop --unshare-net so the sandboxed
  // process has host-network visibility. The rest of the fence (user ns /
  // die-with-parent / system ro-binds / clearenv / chdir / command) is
  // unchanged — this is the only approval axis this option touches.
  readonly network?: boolean;
  // #562 T5 / ADR-0092: cwdReadonly — absent/false = the host root bind
  // already makes cwd writable; true = additionally `--ro-bind cwd cwd` so a
  // validator hole still gets EROFS at the kernel layer.
  readonly cwdReadonly?: boolean;
  readonly seccompProfile?: never;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC11:工作区档 home ro-bind 源端 + 目标端
   * 宿主绝对路径。**仅** workspace 档消费;该档下缺席 / 空串 → typed
   * fail-loud(见 `workspaceHomeRoBindArgs`),不退化成全局档。
   */
  readonly homeRoot?: string;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC12:工作区档 **taskRoot** 写白名单源端 +
   * 目标端宿主绝对路径。缺席 / 空串 → 不发射对应 bind。**仅** workspace
   * 档消费,且与 home ro-bind 同处 mount 序中段。
   *
   * **命名注意**:字段名沿用了历史名 `workspaceRoot`,但语义是 ADR-0092 的
   * 「活 taskRoot」(调用方传 `waveRoot` / `opts.cwd`),**不是** ADR-0019 /
   * registry.ts 的 `workspaceRoot`(per-root state anchor,明确非 bind 根)。
   * 两者同名不同义,读本字段时以本注释为准。
   */
  readonly workspaceRoot?: string;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC12:工作区档会话 tmp 写白名单源端 +
   * 目标端宿主绝对路径。生产路径取自 `fsPolicy.tmpRoot()`(由 fs-policy 合同
   * 根保证非空存在);缺席 → 不发射该 bind。**仅** workspace 档消费。
   */
  readonly tmpRoot?: string;
}

export interface BwrapFence {
  readonly argv: readonly string[];
  readonly sealed: true;
}

/**
 * 一个 `--bind path path` 三元组；路径缺席 / 空串 → 不发射。
 *
 * **只**用于工作区档两处写白名单(`workspaceRoot` / `tmpRoot`):这两层缺席是
 * 收紧方向(少一处可写 = fail-closed),可以静默跳过。home ro-bind 层不走此
 * 函数 —— 它的缺席是放宽方向,必须 fail-loud(见 `workspaceHomeRoBindArgs`),
 * 且形态不同(`--ro-bind`),故此处不接受 flag 形参(YAGNI:唯一调用值恒为
 * `--bind`,留 union 只会多一个不可达分支)。
 */
function bindArgs(path: string | undefined): string[] {
  return path === undefined || path.length === 0 ? [] : ["--bind", path, path];
}

/**
 * 工作区档 home ro-bind 层(ADR-0092 Amendment 2026-09-13,SC11):该档的语义
 * 本体 —— home 可见但只读,靠这一层落地。
 *
 * 缺席 / 空串 → **typed fail-loud**,不静默跳过。理由(home 与另两层的判别):
 *   - 跳过 `--bind <workspaceRoot>` / `--bind <tmpRoot>` 是**收紧**方向:少了
 *     一处可写 = fail-closed,没有洞;
 *   - 跳过 `--ro-bind <home>` 是**放宽**方向:argv 退化成全局档形态,home 恢复
 *     可写,且调用方拿不到任何信号 —— workspace 档下「home 只读」是本档存在
 *     的全部理由,静默降级等于把安全档悄悄换成默认档。
 *
 * 层次选型:守卫放在本 argv 构造函数,而不是各调用点(`bash.ts` /
 * `sandbox-run.ts` / `background/manager.ts`)。因为 `mode` 与 `homeRoot` 都在
 * 本函数的入参里 —— 任何调用点漏传都会汇到这里;若在调用点各加守卫,则是 N
 * 份同一策略、下一个新调用点重新开洞(本守卫要修的正是这个形态)。与
 * `fs-policy.ts` 的合同根纪律(blank / missing → typed、不 spawn)同款。
 */
function workspaceHomeRoBindArgs(
  homeRoot: string | undefined
): readonly string[] {
  if (homeRoot === undefined || homeRoot.length === 0) {
    throw new ToolExecutionError(
      "bwrap: workspace fs mode requires homeRoot; refusing to build a fence that would silently degrade to global mode (home writable)"
    );
  }
  return ["--ro-bind", homeRoot, homeRoot];
}

/**
 * 工作区档三层 mount(ADR-0092 Amendment 2026-09-13),严格遵循 last-mount-wins
 * 序:`--ro-bind <homeRoot> <homeRoot>`(home 可见但只读)在前,
 * `--bind <workspaceRoot>` + `--bind <tmpRoot>`(两处写白名单覆盖回可写)在后。
 *
 * 非工作区档 → 不发射任何一层(也不做 homeRoot 守卫 —— global 档本来就不发
 * home ro-bind,缺席不是降级)。home 层缺席 → typed fail-loud(见
 * `workspaceHomeRoBindArgs`);两处写白名单各自缺席 / 空串 → 只跳过该层。
 */
function workspaceMountArgs(
  fsPolicy: FsPolicy,
  homeRoot: string | undefined,
  workspaceRoot: string | undefined,
  tmpRoot: string | undefined
): string[] {
  if (fsPolicy.mode !== "workspace") return [];
  return [
    ...workspaceHomeRoBindArgs(homeRoot),
    ...bindArgs(workspaceRoot),
    ...bindArgs(tmpRoot),
  ];
}

/**
 * Global-mode argv (ADR-0092): bind the host root `/` first (real paths
 * visible and writable), then re-bind the system prefixes read-only, then the
 * read-only cwd override, then proc/dev.
 *
 * bwrap's last-mount-wins semantics drive the ordering contract:
 *  - `--bind / /` is the base token; every later `--ro-bind` is a narrower
 *    mount that reclaims only its own subtree;
 *  - system prefixes (`/usr /bin /lib /lib64 /etc` plus on-disk `/opt`
 *    `/snap`) are re-bound read-only after the `/` bind;
 *  - `--ro-bind <cwd> <cwd>` (cwdReadonly) must come AFTER the `/` bind;
 *  - the workspace-mode block (`workspaceMounts`) sits between the system
 *    block and the cwd override — see `workspaceMountArgs` for its order;
 *  - there is no session-tmp bind at guest `/tmp` and no per-root writable
 *    bind list — the session tmp keeps its host path (ADR-0092).
 */
function baseArgs(
  cwd: string,
  network: boolean,
  cwdReadonly: boolean,
  workspaceMounts: readonly string[]
): string[] {
  return [
    "--unshare-user-try",
    // network:true is the only axis that drops --unshare-net (ADR-0022 #1);
    // every line below stays unchanged either way.
    ...(network ? [] : ["--unshare-net"]),
    "--die-with-parent",
    // Host root: real paths visible and writable.
    "--bind",
    "/",
    "/",
    // System block: fixed prefixes from fs-policy's single source + optional
    // host prefixes existence-skipped. Re-binds the toolchain read-only over
    // the writable `/` base.
    ...READ_ONLY_SYSTEM_PATHS.flatMap((path) => ["--ro-bind", path, path]),
    ...optionalHostRoBindArgs(),
    // 工作区档三层由调用方算好后整段插入:系统块之后、cwdReadonly 与 proc/dev
    // 之前(mount 序在此处是最末一段可写 bind)。
    ...workspaceMounts,
    // cwdReadonly: EROFS override after the `/` bind (与工作区档三层正交,
    // 即使工作区档三层叠加,cwdReadonly 仍在最末;后者按字面是 mount 序最末)。
    ...(cwdReadonly ? ["--ro-bind", cwd, cwd] : []),
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
  ];
}

export function createBwrapFence(opts: BwrapFenceOptions): BwrapFence {
  const envArgs = Object.entries(opts.env).flatMap(([name, value]) =>
    value === undefined ? [] : ["--setenv", name, value]
  );
  const argv = [
    "bwrap",
    ...baseArgs(
      opts.cwd,
      opts.network === true,
      opts.cwdReadonly === true,
      // 工作区档会话 tmp bind 源端由调用方显式透传(opts.tmpRoot)。`fsPolicy.tmpRoot()`
      // 不在 bwrap 这层隐式回退 —— 否则 opts.tmpRoot === undefined 的「缺席」
      // 边界与「与 fsPolicy 同值」会无法区分。bash handler /
      // defaultBackgroundSpawn / makeDefaultRunVerify 在装配 fence 前用
      // fsPolicy.tmpRoot() 算出 session tmp 绝对路径后传入。
      workspaceMountArgs(
        opts.fsPolicy,
        opts.homeRoot,
        opts.workspaceRoot,
        opts.tmpRoot
      )
    ),
    // --clearenv must precede every --setenv so the sandbox inherits only the
    // whitelisted entries, never the host env (bwrap otherwise copies the whole
    // environment of the process that launches it). #225.
    "--clearenv",
    ...envArgs,
    "--chdir",
    opts.cwd,
    "--",
    opts.command,
    ...opts.args,
  ];
  // networkPolicy has no enforcement in the fence layer (STATIC_NETWORK_WHITELIST
  // is not executed here, see network-policy.ts). The real network control axis
  // is the --unshare-net switch driven by the `network` option above; keep
  // networkPolicy as the declared-but-inert contract input (ADR-0022 fog).
  void opts.networkPolicy;
  return Object.freeze({ argv: Object.freeze(argv), sealed: true as const });
}

export type { BwrapFence as BwrapFencePolicy };
