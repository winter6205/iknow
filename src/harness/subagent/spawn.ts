/**
 * Production worker-process spawn factory for defaultSubAgentSpawn.
 *
 * build-engine wires it via createSubAgentManager({ spawn:
 * defaultSubAgentSpawn }). Shape = headless re-entry of the same iknow
 * binary: `node <iknow-bin> --subagent-worker` (cli.ts main() dispatching the
 * `__subagent_worker__` command). Worker protocol: one envelope line on
 * stdin → one result line on stdout.
 *
 * Responsibility boundary:
 *   - whether stdinPayload gets written is the manager's job (manager.spawn
 *     does the `write + end` itself once it holds the child); spawn.ts only
 *     spawns and returns the child;
 *
 // (ADR-0001)
 *   - env is inherited from the parent process (no second env protocol is
 *     invented here).
 *
 * The parameters follow the `SubAgentSpawn` signature contract:
 * defaultSubAgentSpawn does not read `def` / `taskId` / `stdinPayload`
 * (consumed manager-side); the underscore prefix sidesteps
 * `noUnusedParameters`.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { YOLO_ENV_KEY, type YoloContext } from "../sandbox/yolo.js";
import {
  FS_MODE_ENV_KEY,
  PRODUCT_ROOT_ENV_KEY,
  WORKSPACE_ROOT_ENV_KEY,
  WORKTREE_GATE_ON_ENV_KEY,
} from "../../config/workspace-root.js";
import type { FsModeContext } from "../sandbox/fs-mode.js";
import type { WorktreeGateReader } from "../isolation/worktree-gate.js";
import type { SubAgentSpawn } from "./manager.js";

const requireFromSpawn = createRequire(import.meta.url);

export interface ResolveSubagentWorkerSpawnArgsOptions {
  readonly execPath: string;
  readonly argv1?: string;
  /**
   * ADR-0037: iknow's own installation root — the tsx loader resolves from
   * there, not from the child's cwd. The child cwd may be a bare task
   * worktree without `node_modules`, where cwd-relative resolution crashes
   * with `Cannot find package 'tsx'`. Absent → anchor back to this module
   * (`import.meta.url`), same as production, so old callers are byte-
   * unchanged.
   */
  readonly installRoot?: string;
  /**
   * Accepted for callers that already collect Node execution arguments. The
   * child receives an explicit loader below, so it does not need inherited
   * execArgv.
   */
  readonly execArgv?: readonly string[];
  /** Test seam: fail tsx resolution without mocking node:module. */
  readonly resolveTsxLoader?: () => string;
}

export class SubagentWorkerSpawnArgsError extends Error {
  override readonly name = "SubagentWorkerSpawnArgsError";

  constructor(
    message = "Cannot spawn subagent worker: process.argv[1] is missing"
  ) {
    super(message);
  }
}

function isNodeExecutable(execPath: string): boolean {
  const executable = execPath.split(/[\\/]/).pop()?.toLowerCase();
  return (
    executable === "node" ||
    executable === "node.exe" ||
    executable === "nodejs"
  );
}

function isTypeScriptEntry(argv1: string): boolean {
  return /\.(?:ts|mts|tsx|cts)$/i.test(argv1);
}

function makeResolveTsxLoader(installRoot?: string): () => string {
  if (installRoot === undefined) return () => requireFromSpawn.resolve("tsx");
  // `createRequire` needs a file anchor; use `<installRoot>/package.json` —
  // it is the package-root marker resolveInstallRoot() finds (the anchor works
  // even if the file does not exist, and in production it always does).
  const requireFromInstall = createRequire(
    resolve(installRoot, "package.json")
  );
  return () => requireFromInstall.resolve("tsx");
}

export function resolveSubagentWorkerSpawnArgs({
  execPath,
  argv1,
  installRoot,
  resolveTsxLoader = makeResolveTsxLoader(installRoot),
}: ResolveSubagentWorkerSpawnArgsOptions): string[] {
  if (!argv1) {
    throw new SubagentWorkerSpawnArgsError();
  }

  // Node children need an explicit tsx ESM loader; Bun runs TypeScript natively.
  // Resolve the loader from `installRoot` (not the child's cwd): `--import tsx`
  // fails when the agent cwd is outside the repo (Cannot find package 'tsx').
  if (isNodeExecutable(execPath) && isTypeScriptEntry(argv1)) {
    let loader: string;
    try {
      loader = resolveTsxLoader();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SubagentWorkerSpawnArgsError(
        `Cannot spawn subagent worker: tsx loader not resolved: ${detail}`
      );
    }
    return ["--import", loader, argv1, "--subagent-worker"];
  }

  return [argv1, "--subagent-worker"];
}

export function resolveSubagentTraceDir(traceDir?: string): string {
  return resolve(traceDir ?? process.env.IKNOW_TRACE_OUT ?? "./trace/");
}

/**
 * Roots the worker child needs, each in its own role. An options object rather
 * than positional strings: all four values are root-shaped paths, and getting
 * the order wrong would silently point identity discovery at the wrong tree.
 */
export interface DefaultSubAgentSpawnOpts {
  readonly traceDir?: string;
  /** ADR-0019 per-root state anchor → child's `IKNOW_WORKSPACE_ROOT`. */
  readonly workspaceRoot?: string;
  /**
   * ADR-0037: the parent session's project identity root → child's
   * `IKNOW_PRODUCT_ROOT` (env var name kept: it is the existing parent→child
   * wire format). The child's cwd may be a gitignored task worktree with no
   * `.iknow` and no `AGENTS.md`, so its rules / project AGENTS.md / project
   * skills discovery must read the identity root. Undefined → var absent →
   * the worker falls back to its cwd (unbound sessions, where both roots are
   * the same value; byte-identical to before).
   */
  readonly projectIdentityRoot?: string;
  /**
   * ADR-0037: the worker child inherits the parent session's REBOUND root as
   * its `cwd`, so writes and workspace-relative bash land in the same tree as
   * the parent.
   *
   * Shape can be either `string` (frozen value) or `() => string` (live cell
   * getter):
   *  - string: build-time decision (legacy / un-rebind), byte-stable to
   *    before;
   *  - getter: each spawn closure reads the cell's current value, so a rebind
   *    before the next spawn automatically lands the worker in the new tree.
   *
   * Undefined (unbound session / worker defaults) = no cwd option = the child
   * inherits the parent process cwd byte-identically to before.
   */
  readonly sessionRoot?: string | (() => string);
  /**
   * ADR-0037: iknow's own installation root — the child's tsx loader
   * resolves from it. **Not** the user project's `node_modules`, so a bare
   * task worktree (no `node_modules` under `sessionRoot`) can still start a
   * worker without asking the operator to symlink anything. Absent → anchor
   * back to this spawn module, same as production.
   */
  readonly installRoot?: string;
  /**
   * Parent session's fs isolation-mode holder → child's `IKNOW_FS_MODE` (the
   *
   // (ADR-0092)
   * same "parent writes, worker reads" env wire as `workspaceRoot` /
   * `productIdentityRoot`; the envelope is an untrusted input surface and
   * carries no such field). The value is read from the holder at **every
   * spawn** (same spawn-time discipline as the `sessionRoot` getter) —
   * freezing the holder into a string at assembly would put `/config fs
   * workspace` permanently out of reach of children. Holder present → the
   * env key is always written (even for the default mode; key absent = this
   * channel is not wired, one interpretation only); holder absent (legacy /
   * test paths) → key omitted, child env byte-identical to before.
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0119 / specs/yolo-mode.md: the parent session's yolo holder → child's
   * `IKNOW_YOLO` (the same "parent writes, worker reads" env wire as `fsMode`;
   * the envelope is an untrusted input face and does not carry this field). The
   * value is read from the holder **on every spawn** — the same spawn-time
   * discipline as `fsMode`, per-spawn semantics.
   *
   * The key is always normalized like `IKNOW_WORKTREE_GATE_ON`: holder
   * present → `"1"` / `"0"` both written; and an inherited `IKNOW_YOLO` from
   * the ambient env is always scrubbed from the child env (see
   * `buildSubAgentChildEnv`), so the worker's yolo posture derives only from
   * this parent's holder — never from a stray host env or a stale inherited
   * wire (fail-closed, code-review H2). Holder absent → key stays absent
   * (legacy wire; the worker-side `yoloOptionFromEnv` reads absent as
   * "fence present").
   */
  readonly yolo?: YoloContext;
  /**
   * Parent session's worktree-on-mutate live switch holder → child's
   * `IKNOW_WORKTREE_GATE_ON` (same spawn-time read as fsMode: a panel flip
   * takes effect for the next spawn). Holder present → the key is always
   * written ("1"/"0" both written; key absent = channel unwired → the worker
   * never emits the UNBOUND_FENCE section, bytes unchanged).
   */
  readonly worktreeGate?: WorktreeGateReader;
}

/**
 * Child-env assembly — the single source of the spawn-time env-wire contract.
 * Holder readings arrive pre-resolved by the caller so every read happens at
 * spawn time (mirrors the `sessionRoot` getter discipline).
 *
 * ADR-0119 fail-closed ruling (code-review H2): `IKNOW_YOLO` is stripped from
 * the inherited env before the wire value is laid down. The worker's yolo
 * posture therefore derives only from this parent's holder — an ambient
 * `IKNOW_YOLO=1` on the host (or a leftover from a yolo ancestor process) can
 * never silently retire the fence of a child spawned by a non-yolo parent.
 * Holder present → `"1"` / `"0"` both written (same normalization as
 * `IKNOW_WORKTREE_GATE_ON`); holder absent → the key stays absent (legacy
 * wire).
 */
function buildSubAgentChildEnv(readings: {
  readonly traceDir: string;
  readonly workspaceRoot: string | undefined;
  readonly projectIdentityRoot: string | undefined;
  readonly fsModeToken: string | undefined;
  readonly worktreeGateOn: boolean | undefined;
  readonly yolo: YoloContext | undefined;
}): NodeJS.ProcessEnv {
  const { [YOLO_ENV_KEY]: _ambientYolo, ...inheritedEnv } = process.env;
  return {
    ...inheritedEnv,
    IKNOW_TRACE_OUT: readings.traceDir,
    ...(readings.workspaceRoot !== undefined
      ? { [WORKSPACE_ROOT_ENV_KEY]: readings.workspaceRoot }
      : {}),
    ...(readings.projectIdentityRoot !== undefined
      ? { [PRODUCT_ROOT_ENV_KEY]: readings.projectIdentityRoot }
      : {}),
    ...(readings.fsModeToken !== undefined
      ? { [FS_MODE_ENV_KEY]: readings.fsModeToken }
      : {}),
    ...(readings.worktreeGateOn !== undefined
      ? { [WORKTREE_GATE_ON_ENV_KEY]: readings.worktreeGateOn ? "1" : "0" }
      : {}),
    ...(readings.yolo !== undefined
      ? { [YOLO_ENV_KEY]: readings.yolo.get() === true ? "1" : "0" }
      : {}),
  };
}

export function createDefaultSubAgentSpawn(
  opts: DefaultSubAgentSpawnOpts = {}
): SubAgentSpawn {
  const {
    workspaceRoot,
    projectIdentityRoot,
    sessionRoot,
    installRoot,
    fsMode,
    worktreeGate,
    yolo,
  } = opts;
  const resolvedTraceDir = resolveSubagentTraceDir(opts.traceDir);
  return (_def, _taskId, _stdinPayload) => {
    // sessionRoot is read when the closure executes — a string returns the
    // same value every time; a getter returns the cell's current value, so
    // build-engine can turn a build-time decision into a spawn-time closure.
    const cwd = typeof sessionRoot === "function" ? sessionRoot() : sessionRoot;
    // All three holders are read at spawn time (mirroring sessionRoot's
    // spawn-time read): a mid-session `/config` flip (ADR-0092) or `/yolo`
    // flip (ADR-0119) takes effect for the next spawn; the env-wire contract
    // per key (always-write vs absent) lives in buildSubAgentChildEnv.
    const env = buildSubAgentChildEnv({
      traceDir: resolvedTraceDir,
      workspaceRoot,
      projectIdentityRoot,
      fsModeToken: fsMode?.get(),
      worktreeGateOn: worktreeGate?.get(),
      yolo,
    });
    const child = spawn(
      process.execPath,
      resolveSubagentWorkerSpawnArgs({
        execPath: process.execPath,
        argv1: process.argv[1],
        ...(installRoot !== undefined ? { installRoot } : {}),
      }),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        ...(cwd !== undefined ? { cwd } : {}),
      }
    );
    // The manager owns the stdin write (worker protocol: one envelope line in → one result line out).
    return child as ChildProcess;
  };
}

export const defaultSubAgentSpawn: SubAgentSpawn = (
  def,
  taskId,
  stdinPayload
) => createDefaultSubAgentSpawn()(def, taskId, stdinPayload);
