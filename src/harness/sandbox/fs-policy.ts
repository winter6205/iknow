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

function makeRoots(opts: FsPolicyOpts): readonly string[] {
  const roots = [resolve(opts.cwd), resolve(opts.home)];
  if (opts.tmpDir) roots.push(resolve(opts.tmpDir));
  return Object.freeze([...new Set(roots)]);
}

export function createFsPolicy(opts: FsPolicyOpts): FsPolicy {
  const roots = makeRoots(opts);
  const sensitive = Object.freeze(
    SENSITIVE_PATHS.map((path) => expandHome(path, resolve(opts.home)))
  );
  const readOnly = Object.freeze(
    READ_ONLY_SYSTEM_PATHS.map((path) => resolve(path))
  );
  const isSensitive = (absPath: string): boolean => {
    const target = resolve(absPath);
    return sensitive.some((root) => isWithin(root, target));
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
