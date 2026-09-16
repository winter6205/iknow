/**
 * src/session-api/worktree-deps.ts
 *
 * Layer 1 (specs/subagent-layers-worktree-deps.md items 2–3) — **project**
 * dependency provision for a freshly created task worktree.
 *
 * Contract:
 *   - a new tree whose lockfile names a manager gets that manager's frozen
 *     install argv run IN the tree (`pnpm-lock.yaml` → pnpm,
 *     `bun.lock`/`bun.lockb` → bun, `package-lock.json` → `npm ci`);
 *   - only PROJECT deps: the argv table is the SSOT and contains no global /
 *     prefix form (`-g` / `--global` / `--prefix`), and no runtime downloader;
 *   - no whole-tree `node_modules` symlink to the identity root — the install
 *     runs in the new tree, nothing is linked;
 *   - fail-open: no `package.json`, no lockfile, a tree whose install already
 *     COMPLETED (manager-specific sentinel present), a missing manager binary,
 *     a non-zero/exception install, or an install that outran the runner's own
 *     bound all resolve to a typed outcome that the caller reports. Nothing
 *     here throws, and nothing here rolls back the worktree.
 *
 * Async child process only. A blocking `spawnSync` here would freeze the TUI
 * event loop for the whole install (TUI-reachable path policy) — the runner
 * is `execFile`-shaped and injectable so tests never shell out to a real
 * installer. The install carries its OWN bound
 * (`PACKAGE_MANAGER_INSTALL_TIMEOUT_MS`) so that a slow installer is reported
 * as a typed failure line instead of letting the enclosing ACI tier kill the
 * tool call and discard the receipt — the receipt is this feature's whole
 * point (see the constant's comment for the arithmetic).
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

import { errorMessage } from "../harness/errors.js";
import {
  BASE_ENV_WHITELIST,
  createEnvIsolation,
} from "../harness/sandbox/index.js";

/** Managers this module can drive. */
export type PackageManager = "pnpm" | "bun" | "npm";

/**
 * Lockfile → manager SSOT (decision precedence = `MANAGER_ORDER`). Adding a
 * manager is one row here plus one argv row below, so the decision and the
 * skip/failure wording cannot drift.
 */
export const PACKAGE_MANAGER_LOCKFILES: Readonly<
  Record<PackageManager, ReadonlyArray<string>>
> = Object.freeze({
  pnpm: Object.freeze(["pnpm-lock.yaml"]),
  bun: Object.freeze(["bun.lock", "bun.lockb"]),
  npm: Object.freeze(["package-lock.json"]),
});

/** Decision precedence when a tree carries several lockfiles. */
const MANAGER_ORDER: ReadonlyArray<PackageManager> = Object.freeze([
  "pnpm",
  "bun",
  "npm",
]);

/**
 * Frozen install argv per manager (SSOT consumed by the runner AND asserted
 * by the input-contract tests). PROJECT deps only — `npm ci` installs from
 * the lockfile, pnpm/bun install the declared dependencies; none of these
 * forms takes a global or prefix target.
 */
export const PACKAGE_MANAGER_INSTALL_ARGS: Readonly<
  Record<PackageManager, ReadonlyArray<string>>
> = Object.freeze({
  pnpm: Object.freeze(["install", "--frozen-lockfile"]),
  bun: Object.freeze(["install", "--frozen-lockfile"]),
  npm: Object.freeze(["ci"]),
});

/**
 * D3 — completion evidence per manager: the file the manager writes into
 * `node_modules` only after an install RUN TO COMPLETION. Presence of the
 * directory alone is not evidence: a failed install can leave a partial
 * `node_modules` behind, and treating that as resolved would pin a broken tree
 * as ready forever (fail-closed on a stale artifact).
 *
 *   - npm: `node_modules/.package-lock.json` — `npm ci` / `npm install` write
 *     the hidden lockfile next to a completed tree;
 *   - pnpm: `node_modules/.modules.yaml` — the workspace state pnpm writes
 *     after linking;
 *   - bun: NOT in this table — bun 1.3 writes no marker of its own. Measured
 *     with the hoisted linker, `node_modules` holds `.bin` only when some
 *     dependency ships a binary, and a bin-less tree (lodash alone) has no
 *     dot-entry at all; the isolated linker emits `.bun` but drops `.bin`.
 *     Any layout-derived marker would make a resolved tree re-install, so bun
 *     takes the weak branch in `completionEvidence` instead.
 *
 * Missing evidence is NOT treated as resolved: the provisioner runs the
 * (idempotent, frozen-lockfile) install instead. Fail-open + idempotent beats
 * a permanent false positive.
 */
export const PACKAGE_MANAGER_COMPLETION_MARKERS: Readonly<
  Record<"pnpm" | "npm", string>
> = Object.freeze({
  pnpm: "node_modules/.modules.yaml",
  npm: "node_modules/.package-lock.json",
});

/**
 * "This tree's install already completed" evidence for `manager` — the ONE
 * decision point, so the skip path and its receipt wording cannot disagree.
 *
 * bun takes the weak branch on purpose: it writes no marker of its own (see
 * `PACKAGE_MANAGER_COMPLETION_MARKERS`), so the evidence degrades to a
 * non-empty `node_modules`. A failed `bun install` was measured to leave the
 * directory ABSENT, so "non-empty" still rules out the half-written case this
 * check exists to catch; it is weaker than npm/pnpm's sentinel, not absent.
 * An unreadable directory is never evidence.
 */
function completionEvidence(
  worktreePath: string,
  manager: PackageManager
): string | undefined {
  if (manager !== "bun") {
    const marker = PACKAGE_MANAGER_COMPLETION_MARKERS[manager];
    return existsSync(joinPath(worktreePath, marker)) ? marker : undefined;
  }
  const dir = joinPath(worktreePath, "node_modules");
  try {
    return existsSync(dir) && readdirSync(dir).length > 0
      ? "node_modules (non-empty)"
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hard bound on ONE project-dep install, enforced by the runner itself
 * (`execFile` `timeout`, SIGKILL so a manager that ignores SIGTERM cannot
 * keep the promise pending, child killed with the group by Node).
 *
 * Why this exists at all: a Node install routinely exceeds the 30 s `default`
 * ACI tier (measured on this repo: 53 s for one `npm ci`). Hitting that tier
 * yields a bare `timeout` tool result — the receipt line NEVER lands, which is
 * the one outcome this feature must not have. Two changes together keep the
 * receipt: the tool sits at `timeoutTier: "build"` (5 min, same tier bash uses
 * for installs/builds), AND the install is bounded here at 120 s so the typed
 * "install timed out" failure reports from INSIDE the tool result well before
 * any tier timer. 120 s ≈ 2× the measured install and 24× the old tier.
 */
export const PACKAGE_MANAGER_INSTALL_TIMEOUT_MS = 120_000;

/** Overrides for `createPackageManagerRunner`; production passes nothing. */
export interface PackageManagerRunnerOpts {
  /** Bound on one install; default = `PACKAGE_MANAGER_INSTALL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Host env to filter; default = `process.env` read per call. */
  readonly env?: NodeJS.ProcessEnv;
}

/** One manager invocation: binary = the manager name, argv, and the tree cwd. */
export interface PackageManagerInvocation {
  readonly manager: PackageManager;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

/** Result of a completed spawn; a spawn failure THROWS instead. */
export interface PackageManagerRunResult {
  readonly code: number;
  readonly stderr: string;
  /**
   * D2 — true when the install outran `PACKAGE_MANAGER_INSTALL_TIMEOUT_MS` and
   * was killed. Typed rather than folded into `code` so the caller renders a
   * distinct "install timed out" line instead of guessing from a negative exit
   * code. `code` is meaningless when this is set.
   */
  readonly timedOut?: boolean;
}

/**
 * Runner seam. Production = `defaultPackageManagerRunner`; spawn failures
 * (manager binary missing) throw so the caller can report "could not run"
 * distinctly from "install ran and failed".
 */
export type PackageManagerRunner = (
  invocation: PackageManagerInvocation
) => Promise<PackageManagerRunResult>;

/**
 * Production runner: `<manager> <args...>` in the tree.
 *
 * Env policy (D6): the child gets the repo's `BASE_ENV_WHITELIST` — the same
 * nine names (`PATH` / `HOME` / `LANG` / `LC_*` / `TZ` / `TMPDIR` /
 * `NODE_NO_WARNINGS` / `NODE_PATH`) every other non-bwrap child in this repo
 * already gets through `createEnvIsolation`. Fully inheriting `process.env`
 * would hand every API key / token / cloud credential in the environment to
 * an installer that runs `postinstall` scripts from arbitrary packages, and
 * `filter()` already drops the configured secret names on top of the
 * allowlist. `HOME` stays in: managers legitimately read their user config
 * and cache from it. `GIT_*` needs no separate scrub here — none of those
 * names are on the allowlist, so `createEnvIsolation` drops them wholesale
 * (the isolation gate's git runner scrubs them for the same reason).
 *
 * Spawn failures (manager binary missing) reject; a non-zero exit resolves
 * with its `code`, and an install outrunning the bound resolves with
 * `timedOut: true` — so the caller reports each case distinctly instead of
 * letting the enclosing ACI tier kill the call and drop the receipt.
 */
export function createPackageManagerRunner(
  opts: PackageManagerRunnerOpts = {}
): PackageManagerRunner {
  const timeoutMs = opts.timeoutMs ?? PACKAGE_MANAGER_INSTALL_TIMEOUT_MS;
  return (invocation) =>
    new Promise((resolve, reject) => {
      // Filtered per call, like `defaultGitRunner`: a long-lived process can
      // change its environment between calls, and reading it once at module
      // load would freeze whatever the import happened to see.
      const env = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST }).filter(
        opts.env ?? process.env
      );
      execFile(
        invocation.manager,
        [...invocation.args],
        {
          cwd: invocation.cwd,
          encoding: "utf8",
          env,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
        },
        (err, _stdout, stderr) => {
          const code = (err as NodeJS.ErrnoException | null)?.code;
          if (err && typeof code === "number") {
            // manager exited non-zero — a normal result, not a spawn failure
            resolve({ code, stderr: String(stderr) });
            return;
          }
          if (err && (err as { killed?: boolean }).killed === true) {
            // Manager did not finish inside the bound. RESOLVED, not rejected:
            // the caller must render a typed failure line (the receipt) rather
            // than have the whole provision look like a crash.
            resolve({ code: 0, stderr: String(stderr), timedOut: true });
            return;
          }
          if (err) {
            reject(err);
            return;
          }
          resolve({ code: 0, stderr: String(stderr) });
        }
      );
    });
}

/**
 * Production runner (the default instance): the real install bound and the
 * real host environment. `createPackageManagerRunner` exists so tests can
 * drive the SAME real `execFile` path with a short bound / a controlled env —
 * not to replace the runner with a stub.
 */
export const defaultPackageManagerRunner: PackageManagerRunner =
  createPackageManagerRunner();

/** Typed outcome of one project-dep provision attempt (never thrown). */
export type ProjectDepProvisionStatus = "installed" | "skipped" | "failed";

/**
 * Why a skip happened, as a discriminant — callers branch on this rather
 * than pattern-matching the prose in `line`.
 *
 * `already_resolved` is the idempotent case (a second provision / an enter
 * ensure on a tree whose install completed — see
 * `PACKAGE_MANAGER_COMPLETION_MARKERS`): routine, not worth a sentence in
 * every receipt. The other two are actionable and reported.
 */
export type ProjectDepSkipReason =
  "no_package_json" | "no_lockfile" | "already_resolved";

export interface ProjectDepProvisionResult {
  readonly status: ProjectDepProvisionStatus;
  /**
   * One model-facing line stating installed/skipped/failed and why. Every
   * skip and every failure carries a reason; the caller appends it verbatim
   * to the tool receipt.
   */
  readonly line: string;
  /** Present whenever a manager was selected (installed / failed paths). */
  readonly manager?: PackageManager;
  /** Present exactly when `status === "skipped"`. */
  readonly reason?: ProjectDepSkipReason;
}

export interface ProjectDepProvisionerOpts {
  /** Injectable runner (tests never touch a real installer). */
  readonly runner?: PackageManagerRunner;
}

/** Provision one tree; never throws. */
export type ProjectDepProvisioner = (
  worktreePath: string
) => Promise<ProjectDepProvisionResult>;

/** Pick the manager for a tree's lockfiles (pure; array order = precedence). */
export function resolvePackageManager(
  fileNames: ReadonlyArray<string>
): PackageManager | undefined {
  const present = new Set(fileNames);
  for (const manager of MANAGER_ORDER) {
    for (const lockfile of PACKAGE_MANAGER_LOCKFILES[manager]) {
      if (present.has(lockfile)) return manager;
    }
  }
  return undefined;
}

/** `<manager> <args>` — the argv as the model sees it in the receipt. */
function describeInvocation(manager: PackageManager): string {
  return [manager, ...PACKAGE_MANAGER_INSTALL_ARGS[manager]].join(" ");
}

/**
 * Build the project-dep provisioner. The returned function resolves with the
 * typed outcome for `worktreePath` and never rejects:
 *
 *   1. no `package.json` → skipped (not a Node project);
 *   2. no supported lockfile → skipped (never guess an installer);
 *   3. the manager's completion marker is present → skipped (idempotent
 *      re-provision / enter-ensure on a tree whose install actually finished);
 *   4. otherwise run the manager in the tree; non-zero exit, the runner's own
 *      timeout, or a spawn throw → failed with the reason, tree untouched.
 *
 * The skip directions (1–3) and the failure direction (4) are all fail-open:
 * the worst case is an extra idempotent install, never a lost worktree.
 */
export function createProjectDepProvisioner(
  opts: ProjectDepProvisionerOpts = {}
): ProjectDepProvisioner {
  const runner = opts.runner ?? defaultPackageManagerRunner;
  return async (worktreePath) => {
    let packageJson: boolean;
    let lockfiles: ReadonlyArray<string>;
    try {
      // A tree that is not there is a real fault (the caller just created
      // it), not an empty project: report it distinctly from the benign
      // "no package.json" skip, which would otherwise read as "non-Node tree".
      if (!existsSync(worktreePath)) {
        return {
          status: "failed",
          line: `project deps not installed: worktree ${worktreePath} is not readable; install manually in it if the task needs node_modules`,
        };
      }
      packageJson = existsSync(joinPath(worktreePath, "package.json"));
      lockfiles = packageJson
        ? MANAGER_ORDER.flatMap((manager) =>
            PACKAGE_MANAGER_LOCKFILES[manager].filter((name) =>
              existsSync(joinPath(worktreePath, name))
            )
          )
        : [];
    } catch (err) {
      return {
        status: "failed",
        line: `project deps not installed: cannot read ${worktreePath} (${errorMessage(err)})`,
      };
    }

    if (!packageJson) {
      return {
        status: "skipped",
        reason: "no_package_json",
        line: "project deps skipped: no package.json in the worktree (nothing to install)",
      };
    }
    const manager = resolvePackageManager(lockfiles);
    if (manager === undefined) {
      return {
        status: "skipped",
        reason: "no_lockfile",
        line: "project deps skipped: package.json present but no supported lockfile (pnpm-lock.yaml / bun.lock / bun.lockb / package-lock.json)",
      };
    }
    // D3 — completion evidence, not mere directory presence: a `node_modules`
    // left half-written by a failed install must NOT be pinned as ready
    // forever. No evidence (half-written tree, legacy layout) → run the
    // install; it is frozen-lockfile and idempotent, so the fail-open
    // direction is safe.
    const evidence = completionEvidence(worktreePath, manager);
    if (evidence !== undefined) {
      return {
        status: "skipped",
        reason: "already_resolved",
        manager,
        line: `project deps already resolvable in the worktree (${evidence}) — skipped \`${describeInvocation(manager)}\``,
      };
    }

    try {
      const result = await runner({
        manager,
        args: PACKAGE_MANAGER_INSTALL_ARGS[manager],
        cwd: worktreePath,
      });
      if (result.timedOut === true) {
        // D2 — the whole reason this bound exists: the receipt MUST land. The
        // enclosing ACI tier would have killed the tool call with a bare
        // `timeout` and dropped this line on the floor, so the runner's own
        // bound fires first and reports a typed, actionable failure.
        return {
          status: "failed",
          manager,
          line: `project deps install failed: \`${describeInvocation(manager)}\` timed out after ${Math.round(PACKAGE_MANAGER_INSTALL_TIMEOUT_MS / 1000)}s (killed) — the worktree still exists; install manually in it if the task needs node_modules`,
        };
      }
      if (result.code !== 0) {
        return {
          status: "failed",
          manager,
          line: `project deps install failed (\`${describeInvocation(manager)}\` exit ${result.code})${stderrSuffix(result.stderr)} — the worktree still exists; retry the install in it if the task needs node_modules`,
        };
      }
      return {
        status: "installed",
        manager,
        line: `project deps installed with \`${describeInvocation(manager)}\` in the worktree`,
      };
    } catch (err) {
      return {
        status: "failed",
        manager,
        line: `project deps install failed: \`${describeInvocation(manager)}\` could not run (${errorMessage(err)}) — the worktree still exists; install manually if the task needs node_modules`,
      };
    }
  };
}

/** Minimal join — keeps this module free of a path import for one call site. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Last non-empty stderr line, prefixed — keeps receipts short. */
function stderrSuffix(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .pop();
  return line === undefined ? "" : `: ${line}`;
}
