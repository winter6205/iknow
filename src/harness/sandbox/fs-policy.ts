import { existsSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
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

/**
 * Fixed system prefixes of the closed-world fence (ADR-0037 §9.2 #1): the
 * host of the toolchain and base commands. Bound read-only by bwrap, and the
 * dedup-collapse target for the node toolchain root. `/lib64` joins the
 * historical `/etc /usr /bin /lib` set so the predicate matches the actual
 * bind set emitted by bwrap.ts (single source — bwrap consumes this list).
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
 * snap apps under `/snap`). Bound read-only when present — same class as
 * `/usr`, not a per-binary allowlist. Absent prefixes stay off argv because
 * bwrap rejects a missing bind source. Defined here (not bwrap.ts) so the
 * node-toolchain collapse can consult them without an import cycle; bwrap
 * re-exports for compatibility.
 */
export const OPTIONAL_HOST_RO_PREFIXES: readonly string[] = Object.freeze([
  "/opt",
  "/snap",
]);

export interface FsPolicy {
  /** The tmp root of the write axis (§9.2 #3) — the tmpfs shadow target for
   *  the post-`--tmpfs /tmp` rebind checks. */
  tmpRoot(): string;
  /** Writable roots: `[taskRoot, tmpRoot]` — the §9.2 write whitelist
   *  (`taskRoot` + `/tmp`), nothing else. */
  writeRoots(): readonly string[];
  /** Contract read roots (§9.2 #4–#6): blank or missing-on-disk inputs are
   *  rejected at construction (config-fault fail-loud, §9.4), so every entry
   *  here is an absolute, on-disk path. */
  readRoots(): readonly string[];
  /** Optional read members (§9.2 #7, e.g. git global config): existence-
   *  skipped at construction — only on-disk entries survive. A missing
   *  optional member is a runtime-observable gap, never a construction error
   *  (the two error surfaces must not blur). */
  optionalReadRoots(): readonly string[];
  isSensitive(absPath: string): boolean;
  isReadOnlySystem(absPath: string): boolean;
  assertWithin(target: string): asserts target is string;
}

export interface FsPolicyOptions {
  /** `taskRoot` (ADR-0037 §4) — the sole writable workspace root and the
   *  primary bind of the fence. Contract input: blank or missing on disk →
   *  typed fail-loud (§9.4). */
  readonly cwd: string;
  /** State anchor ONLY (ADR-0019 D1). Drives `~` expansion of the sensitive
   *  set and the `<home>/.iknow` protected-state path. Never a bind root:
   *  the closed world makes home invisible below its whitelisted subtrees. */
  readonly home: string;
  /** ADR-0019 (T4): per-root state anchor. Contributes the protected state
   *  path `<workspaceRoot>/.iknow` — and nothing else; it is not a bind root.
   *  D1: tilde expansion still resolves to `home` (global) — this anchor is
   *  the state boundary, not a user-input convenience. */
  readonly workspaceRoot?: string;
  /** Write-axis tmp root (§9.2 #3). Defaults to `/tmp` when omitted.
   *  Contract input when provided: blank or missing on disk → fail-loud. */
  readonly tmpDir?: string;
  /** iknow runtime install location (§9.2 #4, ADR-0037 §4 fourth role):
   *  read channel for the project's own toolchain (`node_modules/.bin`).
   *  Contract read root: blank or missing on disk → fail-loud. */
  readonly installRoot?: string;
  /** Project identity root (§9.2 #6): the main checkout, unconditionally a
   *  read-whitelist member in the closed world (no more conditional overlay).
   *  Contract read root: blank or missing on disk → fail-loud. */
  readonly projectIdentityRoot?: string;
  /** node toolchain root (§9.2 #5). Defaults to `dirname(process.execPath)`
   *  — the directory of the node running the harness. Collapses into the
   *  system prefixes when it already falls under them. */
  readonly nodeToolchainRoot?: string;
  /** Optional read members (§9.2 #7): existence-skipped, e.g. git global
   *  config files. Never fail-loud. */
  readonly optionalReadRoots?: readonly string[];
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
 * Contract-input discipline (ADR-0037 §9.4 config-fault class): a whitelist
 * root that is blank or missing on disk is a caller misconfiguration, not an
 * optional host capability. Fail loud (typed, no spawn) instead of
 * existsSync-skipping like the optional-member axis, which is a different
 * error surface.
 */
function contractRoot(role: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ToolExecutionError(
      `fs-policy: ${role} is blank; refusing to build a closed-world fence without a contract root (ADR-0037 §9.4 config-fault class)`
    );
  }
  if (!existsSync(value)) {
    throw new ToolExecutionError(
      `fs-policy: ${role} does not exist on disk: ${value}; refusing to build a closed-world fence with a missing contract root (ADR-0037 §9.4 config-fault class)`
    );
  }
  return resolve(value);
}

/** System prefixes in effect on this host: the fixed set plus the optional
 *  host prefixes that exist (the ones bwrap will actually ro-bind). */
function systemPrefixesInEffect(): readonly string[] {
  return [
    ...READ_ONLY_SYSTEM_PATHS,
    ...OPTIONAL_HOST_RO_PREFIXES.filter((prefix) => existsSync(prefix)),
  ];
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
 */
function makeProtectedStatePaths(opts: FsPolicyOptions): readonly string[] {
  const bases = [resolve(opts.home)];
  if (opts.workspaceRoot) bases.push(resolve(opts.workspaceRoot));
  return Object.freeze(bases.map((base) => resolve(base, ".iknow")));
}

/**
 * Closed-world fs policy (ADR-0037 §9): the fence splits into a write axis
 * (`taskRoot` + tmp) and a read whitelist. `home` is a state anchor only —
 * it drives tilde expansion and the protected-state paths and appears on
 * neither axis, so home content below the whitelisted subtrees is invisible
 * (not merely read-only) inside the fence. Roots are taken by role
 * (`writeRoots` / `readRoots` / `tmpRoot` / `optionalReadRoots`); the
 * historical positional `allowedPaths()` contract is retired.
 */
export function createFsPolicy(opts: FsPolicyOptions): FsPolicy {
  const taskRoot = contractRoot("taskRoot (cwd)", opts.cwd);
  const tmpRoot =
    opts.tmpDir === undefined
      ? resolve("/tmp")
      : contractRoot("tmpDir", opts.tmpDir);
  const installRoot =
    opts.installRoot === undefined
      ? undefined
      : contractRoot("installRoot", opts.installRoot);
  const identityRoot =
    opts.projectIdentityRoot === undefined
      ? undefined
      : contractRoot("projectIdentityRoot", opts.projectIdentityRoot);
  // §9.2 #5: the node toolchain root defaults to the directory of the node
  // running the harness (caller override wins) and collapses into the system
  // prefixes when it already falls under them — no redundant bind.
  const nodeRoot = contractRoot(
    "nodeToolchainRoot",
    opts.nodeToolchainRoot ?? dirname(process.execPath)
  );
  const nodeCollapsed = systemPrefixesInEffect().some((prefix) =>
    isWithin(prefix, nodeRoot)
  );
  const writeRoots = Object.freeze([...new Set([taskRoot, tmpRoot])]);
  const readRoots = Object.freeze([
    ...new Set([
      ...(installRoot !== undefined ? [installRoot] : []),
      ...(identityRoot !== undefined ? [identityRoot] : []),
      ...(nodeCollapsed ? [] : [nodeRoot]),
    ]),
  ]);
  // Optional members: existence-skip, never fail-loud (§9.2 #7). Blank
  // entries resolve to the process cwd, so they are dropped before resolve.
  const optionalReadRoots = Object.freeze(
    [
      ...new Set(
        (opts.optionalReadRoots ?? [])
          .filter((path) => path.trim().length > 0)
          .map((path) => resolve(path))
      ),
    ].filter((path) => existsSync(path))
  );
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
  // Closed-world visibility: a path is inside the fence iff it falls within
  // a write root or a whitelisted read root. Home content outside those
  // subtrees is denied here — the soft-fence mirror of the mount-level
  // invisibility bwrap enforces.
  const assertWithin = (target: string): void => {
    const absPath = resolve(target);
    const allowed = [...writeRoots, ...readRoots, ...optionalReadRoots].some(
      (root) => isWithin(root, absPath)
    );
    if (!allowed || isSensitive(absPath)) {
      throw new ToolExecutionError(
        `${VIOLATION_PREFIXES.fsDenied} path outside fence: ${target}`
      );
    }
  };
  return Object.freeze({
    tmpRoot: () => tmpRoot,
    writeRoots: () => writeRoots,
    readRoots: () => readRoots,
    optionalReadRoots: () => optionalReadRoots,
    isSensitive,
    isReadOnlySystem,
    assertWithin,
  });
}
