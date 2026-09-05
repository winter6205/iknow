import { existsSync } from "node:fs";
import { relative } from "node:path";
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

// Defined in fs-policy.ts (single source with the node-toolchain collapse);
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
  // die-with-parent / ro-binds / tmpfs / clearenv / chdir / command) is
  // unchanged — this is the only approval axis this option touches.
  readonly network?: boolean;
  // #562 T5: cwdReadonly — absent/false = `--bind cwd cwd` (the writable
  // cwd); true = bind cwd as `--ro-bind cwd cwd` so a validator hole still
  // gets EROFS at the kernel layer, and the post-tmpfs rebind stays
  // read-only. The closed-world argv order contract (system --ro-bind →
  // read-whitelist --ro-bind → write --bind → --size/--tmpfs → post-tmpfs
  // rebinds → --proc/--dev-bind) and the rebind-after-tmpfs rule (cwd
  // isTmpDescendant) stay intact.
  readonly cwdReadonly?: boolean;
  readonly seccompProfile?: never;
}

export interface BwrapFence {
  readonly argv: readonly string[];
  readonly sealed: true;
}

function isTmpDescendant(path: string, tmp: string): boolean {
  const rel = relative(tmp, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../");
}

/** Effective read whitelist for argv: the policy's contract read roots and
 *  on-disk optional members. Single source is the fs-policy read axis — the
 *  bwrap layer adds no roots of its own (the T2 identity option died in T5;
 *  identity enters through `FsPolicyOptions.projectIdentityRoot`). */
function readWhitelist(fsPolicy: FsPolicy): readonly string[] {
  return [
    ...new Set([...fsPolicy.readRoots(), ...fsPolicy.optionalReadRoots()]),
  ];
}

/**
 * Closed-world argv (ADR-0037 §9.2): system ro-binds → read-whitelist
 * ro-binds → write binds → tmpfs → post-tmpfs rebinds → proc/dev.
 *
 * bwrap's last-mount-wins semantics drive the ordering contract:
 *  - every read root enters as `--ro-bind` BEFORE the write binds, so the
 *    writable cwd bind reclaims writability when taskRoot sits inside a read
 *    root (a worktree under the main repo);
 *  - there is no writable-home base token at all — home content outside the
 *    whitelist is invisible, which is what retires the SENSITIVE_PATHS tmpfs
 *    overlays (a tmpfs over an invisible path is a no-op);
 *  - the tmp write channel binds by role (`fsPolicy.tmpRoot()`), followed by
 *    the cwd bind as the last mount so nothing covers it.
 */
function baseArgs(
  cwd: string,
  fsPolicy: FsPolicy,
  resources: ResourceLimits,
  network: boolean,
  cwdReadonly: boolean
): string[] {
  const tmp = fsPolicy.tmpRoot();
  const readRoots = readWhitelist(fsPolicy);
  const readBinds = readRoots.flatMap((root) => ["--ro-bind", root, root]);
  // #562 T5: cwdReadonly switches the cwd-bind verb; the tmp write channel
  // stays writable (it is the sandbox /tmp mount) and orders before cwd.
  const cwdVerb = cwdReadonly ? "--ro-bind" : "--bind";
  // `--tmpfs /tmp` (below) mounts an empty tmpfs over /tmp, which hides every
  // /tmp/* subtree bound earlier — read roots and the cwd alike. The
  // post-tmpfs rebinds re-assert them: read roots read-only first, the cwd
  // last so it reclaims writability (or stays read-only under cwdReadonly).
  // The old home rebind (#196 T12b) died with the writable-home base — home
  // is no longer a bind root. The mechanism is uniform over the read
  // whitelist: every read root (identity included, as a policy member) gets
  // the same treatment, with no identity-specific conditional layer.
  const readRebinds = readRoots
    .filter((root) => isTmpDescendant(root, tmp))
    .flatMap((root) => ["--ro-bind", root, root]);
  const cwdRebind = isTmpDescendant(cwd, tmp) ? [cwdVerb, cwd, cwd] : [];
  const postTmpfsRebinds = [...readRebinds, ...cwdRebind];
  return [
    "--unshare-user-try",
    // network:true is the only axis that drops --unshare-net (ADR-0022 #1);
    // every line below stays unchanged either way.
    ...(network ? [] : ["--unshare-net"]),
    "--die-with-parent",
    // System block (§9.2 #1): fixed prefixes from fs-policy's single source
    // + optional host prefixes existence-skipped.
    ...READ_ONLY_SYSTEM_PATHS.flatMap((path) => ["--ro-bind", path, path]),
    ...optionalHostRoBindArgs(),
    // Read whitelist (§9.2 #4–#7): contract roots + on-disk optional members,
    // all read-only.
    ...readBinds,
    // Write whitelist (§9.2 #2–#3): tmp by role + cwd/taskRoot, last.
    "--bind",
    tmp,
    tmp,
    cwdVerb,
    cwd,
    cwd,
    "--size",
    String(resources.tmp),
    "--tmpfs",
    "/tmp",
    ...postTmpfsRebinds,
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
      opts.fsPolicy,
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
  return Object.freeze({ argv: Object.freeze(argv), sealed: true as const });
}

export type { BwrapFence as BwrapFencePolicy };
