import { existsSync } from "node:fs";
import type { FsPolicy } from "./fs-policy.js";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
} from "./fs-policy.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ResourceLimits } from "./resource-limits.js";

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
  readonly resourceLimits: ResourceLimits;
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
}

export interface BwrapFence {
  readonly argv: readonly string[];
  readonly sealed: true;
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
 *  - there is no session-tmp bind at guest `/tmp` and no per-root writable
 *    bind list — the session tmp keeps its host path (ADR-0092).
 */
function baseArgs(
  cwd: string,
  resources: ResourceLimits,
  network: boolean,
  cwdReadonly: boolean
): string[] {
  void resources;
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
    // cwdReadonly: EROFS override after the `/` bind.
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
      opts.resourceLimits,
      opts.network === true,
      opts.cwdReadonly === true
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
  // The global policy no longer shapes argv (no whitelist emission); the
  // session tmp host path is consumed by the bash handlers for `$TMPDIR`.
  void opts.fsPolicy;
  return Object.freeze({ argv: Object.freeze(argv), sealed: true as const });
}

export type { BwrapFence as BwrapFencePolicy };
