import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { ToolExecutionError } from "../errors.js";

export const SENSITIVE_PATHS: readonly string[] = Object.freeze([
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.kube",
  "~/.docker",
]);

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
  /** True when the path is operator-sensitive state (`~/.ssh`, …) or the
   *  protected `<home>/.iknow` / `<workspaceRoot>/.iknow` subtree. Retained
   *  as the soft-fence predicate surface the Round 2 workspace mode consumes;
   *  the global fence binds the host root, so permission + hard-wall carry
   *  the write guard and this predicate does not shape argv. */
  isSensitive(absPath: string): boolean;
}

export interface FsPolicyOptions {
  /** State anchor ONLY (ADR-0019 D1). Drives `~` expansion of the sensitive
   *  set and the `<home>/.iknow` protected-state path. Never a bind root:
   *  the global fence makes home visible below the system ro-binds. */
  readonly home: string;
  /** ADR-0019 (T4): per-root state anchor. Contributes the protected state
   *  path `<workspaceRoot>/.iknow` — and nothing else; it is not a bind root. */
  readonly workspaceRoot?: string;
  /** Session tmp host path for this identity (ADR-0092). Contract input:
   *  blank or missing on disk → typed fail-loud. */
  readonly tmpDir: string;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
  );
}

function expandHome(path: string, home: string): string {
  return path === "~"
    ? home
    : path.startsWith("~/")
      ? resolve(home, path.slice(2))
      : resolve(path);
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
 * Per-root state anchor directories that must NOT be treated as ordinary
 * agent-scratch space, even though `.iknow` is physically inside the workspace
 * root (or home). The whole `<root>/.iknow` subtree is covered — `isWithin`
 * cascades to every child, so listing each file/dir is redundant.
 *
 * Applied to BOTH `<home>/.iknow` and `<workspaceRoot>/.iknow` per D1.4
 * (per-root persona state boundary).
 */
function makeProtectedStatePaths(opts: FsPolicyOptions): readonly string[] {
  const bases = [resolve(opts.home)];
  if (opts.workspaceRoot) bases.push(resolve(opts.workspaceRoot));
  return Object.freeze(bases.map((base) => resolve(base, ".iknow")));
}

/**
 * Global fs policy (ADR-0092): the default bash posture is host real paths,
 * visible and writable below the read-only system prefixes. There is no
 * read/write whitelist any more; this policy carries the identity's session
 * tmp host path (`$TMPDIR` source) and the sensitive/protected-state
 * predicate surface retained for the Round 2 workspace mode.
 */
export function createFsPolicy(opts: FsPolicyOptions): FsPolicy {
  const tmpRoot = contractRoot("tmpDir", opts.tmpDir);
  const sensitive = Object.freeze(
    SENSITIVE_PATHS.map((path) => expandHome(path, resolve(opts.home)))
  );
  const protectedStates = makeProtectedStatePaths(opts);
  const isSensitive = (absPath: string): boolean => {
    const target = resolve(absPath);
    return (
      sensitive.some((root) => isWithin(root, target)) ||
      protectedStates.some((root) => isWithin(root, target))
    );
  };
  return Object.freeze({ tmpRoot: () => tmpRoot, isSensitive });
}
