import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ToolExecutionError } from "../errors.js";

/**
 * Fixed system prefixes re-bound read-only in the global fence (ADR-0092):
 * the host of the toolchain and base commands. bwrap consumes this list
 * directly (single source). `/lib64` keeps the historical `/etc /usr /bin
 * /lib` set in one place so the predicate matches the actual bind set.
 */
export const READ_ONLY_SYSTEM_PATHS: readonly string[] = Object.freeze([
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc",
]);

/**
 * Extra system trees that packaged host tools live in (Chrome under `/opt`,
 * snap apps under `/snap`). Re-bound read-only when present — same class as
 * `/usr`, not a per-binary allowlist. Absent prefixes stay off argv because
 * bwrap rejects a missing bind source.
 */
export const OPTIONAL_HOST_RO_PREFIXES: readonly string[] = Object.freeze([
  "/opt",
  "/snap",
]);

export interface FsPolicy {
  /** Host path of this identity's session tmp (ADR-0092, amending ADR-0074):
   *  inside the fence `$TMPDIR` points at it and write tools may target it.
   *  It is a host path only — never a bind target for guest Linux `/tmp`. */
  tmpRoot(): string;
}

export interface FsPolicyOptions {
  /** Session tmp host path for this identity (ADR-0092). Contract input:
   *  blank or missing on disk → typed fail-loud. */
  readonly tmpDir: string;
}

/**
 * Contract-input discipline: a root that is blank or missing on disk is a
 * caller misconfiguration, not an optional host capability. Fail loud (typed,
 * no spawn) instead of silently ignoring it.
 */
function contractRoot(role: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ToolExecutionError(
      `fs-policy: ${role} is blank; refusing to build a sandbox fence without a contract root`
    );
  }
  if (!existsSync(value)) {
    throw new ToolExecutionError(
      `fs-policy: ${role} does not exist on disk: ${value}; refusing to build a sandbox fence with a missing contract root`
    );
  }
  return resolve(value);
}

/**
 * Global fs policy (ADR-0092): the default bash posture is host real paths,
 * visible and writable below the read-only system prefixes. The policy only
 * carries the identity's session tmp host path (the `$TMPDIR` source) — no
 * sensitive-path predicate, no per-root bind roots, no read/write whitelist.
 * Write enforcement lives in the bwrap mount layer (`--bind / /` + system
 * `--ro-bind` over `/etc /usr /bin /lib /lib64`) and the permission chain
 * + hard-walls; a `home` / `workspaceRoot` predicate would not shape argv.
 */
export function createFsPolicy(opts: FsPolicyOptions): FsPolicy {
  const tmpRoot = contractRoot("tmpDir", opts.tmpDir);
  return Object.freeze({ tmpRoot: () => tmpRoot });
}
