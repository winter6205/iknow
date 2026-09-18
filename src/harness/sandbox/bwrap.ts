import { existsSync } from "node:fs";
import { ToolExecutionError } from "../errors.js";
import type { FsPolicy } from "./fs-policy.js";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
} from "./fs-policy.js";
import type { EgressFenceSpec } from "./egress/session.js";

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
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
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
  /**
   * ADR-0097 / T4:出口代理缝 —— 宿主 socket → 沙箱内代理端口的可选装配。
   *
   * 缺席 → 不发射 unix socket `--bind`、不注入代理 env（`--unshare-net`
   * 仍恒在,无 host-net 直连分支）。fence 装配期注入 socket bind 与
   * 代理 env（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY），沙箱
   * 内命令链（host bwrap 内部拉起的 socat）转 unix socket 回本地端口，
   * 见 `src/harness/sandbox/egress/session.ts`。
   *
   * **mount 序**：socket bind 落在 workspaceMounts 之后、cwdReadonly 之前
   * —— 与既有 mount 块同段（last-mount-wins）。`--setenv` 走既有
   * envArgs 机制（与 `--clearenv` 共用：clearenv 在前、setenv 在后）。
   */
  readonly egress?: EgressFenceSpec;
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
 * ADR-0097:`--unshare-net` 是常量 —— 任何输入都不再摘除。`network` 已从
 * `BwrapFenceOptions` 退役;出网能力由 `egress` 缝 unix socket 代理承载,
 * 沙箱内 netns 恒隔离。Settled invariant #1 在 fence 装配层钉死。
 *
 * bwrap's last-mount-wins semantics drive the ordering contract:
 *  - `--bind / /` is the base token; every later `--ro-bind` is a narrower
 *    mount that reclaims only its own subtree;
 *  - system prefixes (`/usr /bin /lib /lib64 /etc` plus on-disk `/opt`
 *    `/snap`) are re-bound read-only after the `/` bind;
 *  - `--ro-bind <cwd> <cwd>` (cwdReadonly) must come AFTER the `/` bind;
 *  - the workspace-mode block (`workspaceMounts`) sits between the system
 *    block and the cwd override — see `workspaceMountArgs` for its order;
 *  - the egress socket bind (`--bind <unixSocket> <unixSocket>`) sits
 *    between workspaceMounts and cwdReadonly/proc/dev — it is the last
 *    writable mount in the chain (ADR-0097 / T4);
 *  - there is no session-tmp bind at guest `/tmp` and no per-root writable
 *    bind list — the session tmp keeps its host path (ADR-0092).
 */
function baseArgs(
  cwd: string,
  cwdReadonly: boolean,
  workspaceMounts: readonly string[],
  egressBind: readonly string[]
): string[] {
  return [
    "--unshare-user-try",
    // ADR-0097:`--unshare-net` is constant. No conditional, no escape
    // hatch. The only path to the host network is the egress unix socket
    // seam — netns isolation is the sole fence-layer control axis.
    "--unshare-net",
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
    // ADR-0097 / T4 + credential-sentinel T2（invariant 9）:出口代理缝 unix
    // socket `--bind` 与凭据围栏 binds（masked store / trust bundle /
    // masked-file 盖真路径 / deny 盖 /dev/null）—— 在 workspaceMounts
    // 之后、cwdReadonly 之前;socket 段 source=dest 同值 (host 路径 → 沙箱内
    // 同路径)。沙箱内 socat (在 fence 内部命令链拉起) 读该 socket → 把流量
    // 转回 本地 TCP 端口 → 走 HTTP_PROXY 出口。
    ...egressBind,
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

/**
 * ADR-0097 / T4:egress 缝 unix socket `--bind` argv 段 +
 * egress-credential-sentinel T2 / invariant 9:凭据围栏 bind 表
 * （masked-file 盖 bind、masked store 目录、trust bundle、F3 deny 的
 * `/dev/null` 盖 bind）—— 全部落本段，位置不变：workspaceMounts 之后、
 * cwdReadonly 之前，last-mount-wins 盖过根 bind / home ro-bind 下的真路径。
 *
 * `unixSocketPath` 为空 / 缺席 → 不发射 socket 三元组（`--unshare-net`
 * 仍恒在,无 host-net 直连分支）。`binds` 缺席 / 空 → 不发射额外 bind。
 * 三元组形态 `--bind <src> <dest>` —— `src=dest=unixSocketPath`,与既有
 * 工作区档两层写白名单(`bindArgs`)同形态,但不并入 `bindArgs`(后者语义是
 * 「工作区写白名单的省略是收紧方向」,本函数语义是「出口代理缝的省略是
 * fail-closed 但**不**回退到 host-net」—— 两者不混)。
 * 凭据 binds 恒 `--ro-bind`(read-only:store 目录 INVARIANT = 围栏内不可写)。
 */
function egressBindArgs(spec: EgressFenceSpec | undefined): string[] {
  if (spec === undefined) return [];
  const out: string[] = [];
  const { unixSocketPath, binds } = spec;
  if (typeof unixSocketPath === "string" && unixSocketPath.length > 0) {
    out.push("--bind", unixSocketPath, unixSocketPath);
  }
  for (const bind of binds ?? []) {
    out.push("--ro-bind", bind.src, bind.dest);
  }
  return out;
}

export function createBwrapFence(opts: BwrapFenceOptions): BwrapFence {
  // ADR-0097 / T4:egress env 注入 —— spec.env 是 session 已算好的代理
  // 三键 + NO_PROXY;fence 把它拼进自己的 envArgs(与既有 whitelisted
  // env 同形态),`--clearenv` 仍在 setenv 之前。
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === "string") mergedEnv[k] = v;
  }
  if (opts.egress !== undefined) {
    for (const [k, v] of Object.entries(opts.egress.env)) {
      if (typeof v === "string") mergedEnv[k] = v;
    }
  }
  const envArgs = Object.entries(mergedEnv).flatMap(([name, value]) =>
    value === undefined ? [] : ["--setenv", name, value]
  );
  const argv = [
    "bwrap",
    ...baseArgs(
      opts.cwd,
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
      ),
      egressBindArgs(opts.egress)
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
  // ADR-0097:`--unshare-net` 恒定,本层不保留任何可摘除它的参数面(退役的
  // 网络策略参数是旧 fence 唯一的摘除依赖,见 spec Deletion surface);出口能力
  // 由 `egress` 缝 unix socket 代理承担(Spec §Ownership / dispose contract)。
  return Object.freeze({ argv: Object.freeze(argv), sealed: true as const });
}

export type { BwrapFence as BwrapFencePolicy };
