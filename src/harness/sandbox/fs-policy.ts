import { resolve, relative, sep } from "node:path";
import { ToolExecutionError } from "../errors.js";
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";

export const SENSITIVE_PATHS: readonly string[] = Object.freeze([
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.kube",
  "~/.docker",
]);

export const READ_ONLY_SYSTEM_PATHS: readonly string[] = Object.freeze([
  "/etc",
  "/usr",
  "/bin",
  "/lib",
]);

export interface FsPolicy {
  allowedPaths(): readonly string[];
  isSensitive(absPath: string): boolean;
  isReadOnlySystem(absPath: string): boolean;
  assertWithin(target: string): asserts target is string;
}

interface FsPolicyOpts {
  readonly cwd: string;
  readonly home: string;
  /** ADR-0019 (T4): per-root state anchor. When provided, `<workspaceRoot>/.iknow`
   *  is added to the protected paths and to the fence's bind roots. D1: tilde
   *  expansion still resolves to `home` (global) — this anchor is the state
   *  boundary, not a user-input convenience. */
  readonly workspaceRoot?: string;
  readonly tmpDir?: string;
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
 * Build the bind-root list for the fence. Order is positional:
 *   [0] = cwd (primary soft sandbox)
 *   [1] = home (anchor for `~` expansion + bwrap `--bind home home`)
 *   [2] = tmpDir (optional; bwrap's `--tmpfs /tmp` overlay needs it for the
 *         shadowed-cwd/home rebind paths)
 *   [3] = workspaceRoot (optional; ADR-0019 per-root state anchor)
 * bwrap.ts indexes [1] and [2] positionally — keep this order stable.
 * Dedupe via Set keeps the first occurrence so the order/positional contract
 * survives any workspaceRoot == cwd|home|tmpDir overlap.
 */
function makeRoots(opts: FsPolicyOpts): readonly string[] {
  const roots = [resolve(opts.cwd), resolve(opts.home)];
  if (opts.tmpDir) roots.push(resolve(opts.tmpDir));
  if (opts.workspaceRoot) roots.push(resolve(opts.workspaceRoot));
  return Object.freeze([...new Set(roots)]);
}

/**
 * Per-root state anchor directories that must NOT be touchable by the agent
 * through the fs-policy fence, even though `.iknow` is physically inside
 * the workspace root (or home). The whole `<root>/.iknow` subtree is covered
 * — `isWithin` cascades to every child, so listing each file/dir is redundant.
 * The documented children (user.md / state.json / BOOTSTRAP.md / memory/ /
 * skills/) live here as a comment for the reader, not as data — the policy
 * protects the directory and all its descendants uniformly.
 *
 * The same protection is applied to BOTH `<home>/.iknow` and
 * `<workspaceRoot>/.iknow` per D1.4 (per-root persona state boundary).
 * `<home>/.iknow` is also protected by `write_file`'s containment (cwd-scoped,
 * no extra write roots), but adding it to the fs-policy sensitive set makes
 * the protection visible to `assertWithin` tests and to any future tooling
 * that consults `FsPolicy` directly.
 */
function makeProtectedStatePaths(opts: FsPolicyOpts): readonly string[] {
  const bases = [resolve(opts.home)];
  if (opts.workspaceRoot) bases.push(resolve(opts.workspaceRoot));
  return Object.freeze(bases.map((base) => resolve(base, ".iknow")));
}

export function createFsPolicy(opts: FsPolicyOpts): FsPolicy {
  const roots = makeRoots(opts);
  const sensitive = Object.freeze(
    SENSITIVE_PATHS.map((path) => expandHome(path, resolve(opts.home)))
  );
  const protectedStates = makeProtectedStatePaths(opts);
  const readOnly = Object.freeze(
    READ_ONLY_SYSTEM_PATHS.map((path) => resolve(path))
  );
  const isSensitive = (absPath: string): boolean => {
    const target = resolve(absPath);
    return (
      sensitive.some((root) => isWithin(root, target)) ||
      protectedStates.some((root) => isWithin(root, target))
    );
  };
  const isReadOnlySystem = (absPath: string): boolean => {
    const target = resolve(absPath);
    return readOnly.some((root) => isWithin(root, target));
  };
  const allowedPaths = (): readonly string[] => roots;
  const assertWithin = (target: string): void => {
    const absPath = resolve(target);
    const allowed = roots.some((root) => isWithin(root, absPath));
    if (!allowed || isSensitive(absPath)) {
      throw new ToolExecutionError(
        `${VIOLATION_PREFIXES.fsDenied} path outside fence: ${target}`
      );
    }
  };
  return Object.freeze({
    allowedPaths,
    isSensitive,
    isReadOnlySystem,
    assertWithin,
  });
}
