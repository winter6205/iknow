/**
 * Manifest for the bundled search engine.
 *
 * Contract: the engine is provisioned by the **lockfile** — the `@vscode/ripgrep`
 * dependency carries a prebuilt `rg` per platform as its own
 * `optionalDependencies`, so `npm ci` installs exactly the one this machine runs
 * and no download-then-unpack step exists. At runtime only that path is exec'd,
 * and an `rg` on PATH is never the main path.
 *
 * This module holds no download metadata and touches no network or fs; the one
 * thing it reads is the dependency, and it reads it *lazily* — see
 * {@link engineBinaryPath} for why that matters.
 */

/**
 * Engine version shipped by the pinned `@vscode/ripgrep`.
 *
 * Not a free choice: the dependency's binaries are prebuilt upstream, so this is
 * whatever `@vscode/ripgrep` carries. It is a documentation constant — the
 * binary that actually runs reports its own version, and `type-table.ts` must
 * mirror *that* binary (`rg --type-list`). On upgrade, regenerate
 * `type-table.ts`.
 */
export const RIPGREP_VERSION = "15.0.0";

/**
 * Runtime execution path of the engine the dependency provides, or `undefined`
 * when it cannot be resolved (the caller then uses the Node engine instead of
 * searching PATH).
 *
 * Lazy and failure-typed by necessity: the dependency entry runs
 * `require.resolve()` at **import time** and rethrows a plain `Error` when its
 * per-platform package is absent. A module-scope `import { rgPath }` would
 * therefore turn a missing optional dependency into a process-wide crash — a
 * failure class the call sites would then have to handle. Catching here keeps
 * absence the same typed `undefined` they already handle, so the degrade
 * contract is unchanged (ADR-0089: cannot-start never fails the call).
 *
 * Only a successful resolution is cached. A negative is dropped so a later
 * call retries: absence is a per-call degradation, not permanent process state,
 * and a long-lived `serve` must recover once its install settles.
 */
export async function engineBinaryPath(): Promise<string | undefined> {
  resolution ??= resolveEngineBinaryPath();
  const path = await resolution;
  if (path !== undefined) return path;
  resolution = undefined;
  return undefined;
}

let resolution: Promise<string | undefined> | undefined;

async function resolveEngineBinaryPath(): Promise<string | undefined> {
  try {
    const { rgPath } = await import("@vscode/ripgrep");
    return rgPath;
  } catch {
    return undefined;
  }
}

/**
 * Spawn errnos that mean "the engine cannot start". Which one the OS picks
 * depends on the platform and failure shape (missing binary vs. non-executable
 * vs. restricted exec); matching only ENOENT misreads the others as hard
 * failures (#1131: PATH-less machine surfaced `spawn rg EACCES`).
 */
const UNSTARTABLE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
]);

/**
 * The single cannot-start test shared by every consumer of the pinned engine
 * (grep's rg-engine and glob): membership in {@link UNSTARTABLE_CODES} → the
 * caller downgrades to its Node path instead of failing the call.
 */
export function isEngineUnstartable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && UNSTARTABLE_CODES.has(code);
}
