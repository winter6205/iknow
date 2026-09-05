import { existsSync } from "node:fs";
import { relative } from "node:path";
import { ToolExecutionError } from "../errors.js";
import type { FsPolicy } from "./fs-policy.js";
import { SENSITIVE_PATHS } from "./fs-policy.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ResourceLimits } from "./resource-limits.js";

export interface SeccompProfile {
  readonly fd: number;
}

/**
 * Extra system trees that packaged host tools live in (Chrome under `/opt`,
 * snap apps under `/snap`). Bound read-only when present — same class as
 * `/usr`, not a per-binary allowlist. Absent prefixes stay off argv because
 * bwrap rejects a missing bind source.
 */
export const OPTIONAL_HOST_RO_PREFIXES: readonly string[] = Object.freeze([
  "/opt",
  "/snap",
]);

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
  readonly resourceLimits: ResourceLimits;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly overlaySensitivePaths?: boolean;
  // Per-call network opt-in (#503, ADR-0022). Absent/false = isolated
  // (keep --unshare-net); true = drop --unshare-net so the sandboxed
  // process has host-network visibility. The rest of the fence (user ns /
  // die-with-parent / ro-binds / tmpfs / clearenv / chdir / command) is
  // unchanged — this is the only approval axis this option touches.
  readonly network?: boolean;
  // #562 T5: cwdReadonly — absent/false = V1 path (`--bind cwd cwd`, the
  // writable cwd); true = bind cwd as `--ro-bind cwd cwd` so a validator
  // hole still gets EROFS at the kernel layer. The argv order contract
  // (system --ro-bind → user --bind/--ro-bind → --size/--tmpfs → 可选 cwd
  // 重绑 → --proc/--dev-bind → --chdir → -- → 命令) and the
  // rebind-after-tmpfs rule (cwd isTmpDescendant) stay intact. The readonly
  // path orders overlapping writable parent binds before cwd.
  readonly cwdReadonly?: boolean;
  // #891 T2 (ADR-0037 §4 amendment 2026-09-05): identity-root readonly
  // overlay — worktree isolation ON + rebind 后把主仓（projectIdentityRoot）
  // 整棵树 `--ro-bind` 进围栏，堵住 writable `--bind $HOME` 后挂罩住主仓的
  // 写穿透。排序合同：writable home → identity ro-bind → writable cwd bind
  // （taskRoot 本身在身份根树内，必须最后以可写子挂载夺回）。缺席 = OFF /
  // 未改绑，argv 与今日逐字节一致。身份根空白 / 盘上不存在 → typed
  // fail-loud，不 spawn（合同输入缺席是配置故障，不走
  // optionalHostRoBindArgs 的存在性跳过轴）。
  readonly projectIdentityRoot?: string;
  readonly seccompProfile?: never;
}

export interface BwrapFence {
  readonly argv: readonly string[];
  readonly sealed: true;
}

function pathForHome(fsPolicy: FsPolicy): string {
  const paths = fsPolicy.allowedPaths();
  // cwd + home are always present by construction in createFsPolicy. An
  // empty / single-entry list signals a misconfigured caller — fail loud
  // rather than silently falling back to process.cwd() (which would unbind
  // the fence from the actual workspace).
  if (paths.length < 2) {
    throw new ToolExecutionError(
      `bwrap: fsPolicy.allowedPaths() must contain at least cwd+home (got ${paths.length}); refusing to bind unknown paths`
    );
  }
  return paths[1] as string;
}

function isTmpDescendant(cwd: string, tmp: string): boolean {
  const rel = relative(tmp, cwd);
  return rel !== "" && rel !== ".." && !rel.startsWith("../");
}

function bindArgs(
  fsPolicy: FsPolicy,
  cwd: string,
  overlaySensitivePaths: boolean,
  cwdReadonly: boolean,
  identityRoot: string | undefined
): string[] {
  const paths = fsPolicy.allowedPaths();
  const home = pathForHome(fsPolicy);
  const tmp = paths[2] ?? "/tmp";
  const overlays = overlaySensitivePaths
    ? SENSITIVE_PATHS.flatMap((path) => {
        const target = path.replace("~", home);
        return existsSync(target) ? ["--tmpfs", target] : [];
      })
    : [];
  // #891 T2: identity-root overlay. Fail-loud validation happens once in
  // createBwrapFence (typed, no spawn); here identityRoot is already a
  // checked-on-disk absolute path.
  const identityBind =
    identityRoot !== undefined ? ["--ro-bind", identityRoot, identityRoot] : [];
  // #562 T5: cwdReadonly switches the cwd-bind verb from --bind to --ro-bind.
  // tmp + home stays writable (tmp is the sandbox /tmp mount, home is the
  // user-configurable bind target). The readonly path also orders those
  // writable mounts before cwd so an ancestor cannot cover the ro-bind.
  const cwdVerb = cwdReadonly ? "--ro-bind" : "--bind";
  const cwdBind = [cwdVerb, cwd, cwd];
  const homeBind = ["--bind", home, home];
  // Ordering (both cwdReadonly branches — a later bind covers an earlier
  // one): writable parents/overlays first (home, sensitive overlays,
  // identity ro-bind), cwd last. The identity ro-bind must come after home
  // so it covers the writable ancestor (the #891 leak shape: main repo
  // under $HOME); the cwd (taskRoot under rebind) sits inside the identity
  // tree, so it must come after the ro-bind to reclaim its writability.
  return [
    "--bind",
    tmp,
    tmp,
    ...homeBind,
    ...overlays,
    ...identityBind,
    ...cwdBind,
  ];
}

function baseArgs(
  cwd: string,
  fsPolicy: FsPolicy,
  resources: ResourceLimits,
  overlaySensitivePaths: boolean,
  network: boolean,
  cwdReadonly: boolean,
  identityRoot: string | undefined
): string[] {
  const tmp = fsPolicy.allowedPaths()[2] ?? "/tmp";
  // #562 T5: cwdRebind (post-tmpfs --bind cwd cwd when cwd is /tmp descendant)
  // also respects cwdReadonly — readonly fence must stay read-only even after
  // the post-tmpfs rebind, otherwise the rebind silently promotes it back to
  // writable. Readonly mode also places an overlapping home rebind before the
  // cwd rebind so a writable ancestor cannot cover the read-only cwd.
  const cwdRebindVerb = cwdReadonly ? "--ro-bind" : "--bind";
  const cwdRebind = isTmpDescendant(cwd, tmp) ? [cwdRebindVerb, cwd, cwd] : [];
  // `--tmpfs /tmp` (below) mounts an empty tmpfs over /tmp, which hides every
  // /tmp/* subtree that was bound earlier in bindArgs — including a home dir
  // that lives under /tmp (e.g. tests/CI set HOME to mkdtemp(join(tmpdir(),…)))
  // or a workspace root on a tmp-mount. Without a post-tmpfs rebind, writes to
  // ~/.iknow inside the fence land on the throwaway tmpfs and vanish when the
  // fence exits. isTmpDescendant detects the shadowed case and re-binds the
  // real home after `--tmpfs /tmp`. Production home is /home/<user>, which is
  // NOT under /tmp, so homeRebind stays empty and production argv is
  // byte-for-byte unchanged.
  const home = pathForHome(fsPolicy);
  const homeRebind = isTmpDescendant(home, tmp) ? ["--bind", home, home] : [];
  // #891 T2: identity rebind mirrors the home rebind — a post-tmpfs writable
  // home rebind would cover the pre-tmpfs identity ro-bind, so when home is
  // under /tmp the identity tree must be re-asserted read-only after the
  // tmpfs (still before cwd, which reclaims writability).
  const identityRebind =
    identityRoot !== undefined && isTmpDescendant(identityRoot, tmp)
      ? ["--ro-bind", identityRoot, identityRoot]
      : [];
  // Absent identity → the V1 rebind order ([cwd, home] writable / [home, cwd]
  // readonly) so the OFF/unbound argv stays byte-identical to pre-#891
  // (amendment (d)). Identity present → the cover-then-reclaim order
  // [home, identity, cwd]: home must not cover the identity ro-bind, and cwd
  // must reclaim writability over both.
  const postTmpfsRebinds =
    identityRoot !== undefined
      ? [...homeRebind, ...identityRebind, ...cwdRebind]
      : cwdReadonly
        ? [...homeRebind, ...cwdRebind]
        : [...cwdRebind, ...homeRebind];
  return [
    "--unshare-user-try",
    // network:true is the only axis that drops --unshare-net (ADR-0022 #1);
    // every line below stays byte-for-byte unchanged either way.
    ...(network ? [] : ["--unshare-net"]),
    "--die-with-parent",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    ...optionalHostRoBindArgs(),
    ...bindArgs(
      fsPolicy,
      cwd,
      overlaySensitivePaths,
      cwdReadonly,
      identityRoot
    ),
    "--size",
    String(resources.tmp),
    "--tmpfs",
    "/tmp",
    // Readonly cwd must be rebound after an overlapping writable home so the
    // child mount remains read-only when HOME contains the workspace. With
    // #891 the identity ro-bind sits between home and cwd for the same
    // cover-then-reclaim reason.
    ...postTmpfsRebinds,
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
  ];
}

export function createBwrapFence(opts: BwrapFenceOptions): BwrapFence {
  // #891 T2: identity-root overlay validation — contract input, so blank or
  // missing-on-disk is a caller misconfiguration, not an optional prefix.
  // Fail loud (typed, no spawn) instead of existsSync-skipping like
  // OPTIONAL_HOST_RO_PREFIXES, which is a different axis (host capability
  // detection vs fence contract).
  let identityRoot: string | undefined;
  if (opts.projectIdentityRoot !== undefined) {
    const identity = opts.projectIdentityRoot;
    if (identity.trim().length === 0) {
      throw new ToolExecutionError(
        "bwrap: projectIdentityRoot is blank; refusing to build a fence without a writable-root cover (worktree isolation contract, ADR-0037 §4)"
      );
    }
    if (!existsSync(identity)) {
      throw new ToolExecutionError(
        `bwrap: projectIdentityRoot does not exist on disk: ${identity}; refusing to build a fence that cannot bind the main repo read-only (worktree isolation contract, ADR-0037 §4)`
      );
    }
    identityRoot = identity;
  }
  const envArgs = Object.entries(opts.env).flatMap(([name, value]) =>
    value === undefined ? [] : ["--setenv", name, value]
  );
  const argv = [
    "bwrap",
    ...baseArgs(
      opts.cwd,
      opts.fsPolicy,
      opts.resourceLimits,
      opts.overlaySensitivePaths ?? true,
      opts.network === true,
      opts.cwdReadonly === true,
      identityRoot
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
