/**
 * Physical-sandbox capability probe for tests that really spawn a bwrap fence.
 *
 * Background: the soft gate `spawnSync("bwrap", ["--version"]).status === 0`
 * only proves the BINARY EXISTS, which is not the property the gated cases
 * depend on. Every real fence argv carries a constant `--unshare-net`
 * (ADR-0097: the network axis is unshared in foreground and background), so a
 * host can pass the existence check and still refuse the spawn with
 * RTM_NEWADDR / EPERM. That is exactly the GitHub Actions runner shape: the
 * test-full job installs bwrap (`.github/workflows/test.yml`), so the soft gate
 * admits the cases, and they go red on the nightly cron instead of skipping.
 * The absence of bwrap is a second, quieter failure of the same gate — the
 * cases silently never run on test-fast, which is no red either.
 *
 * So the gate asks the question the case actually depends on: can a real fence
 * spawn succeed HERE? The probe below runs the same `--ro-bind / /` + `--dev`
 * + `--unshare-net` shape with a trivial guest command, and answers no when the
 * kernel refuses. Callers gate on the answer, so a runner that cannot isolate
 * skips honestly while a capable host runs the case for real.
 *
 * **Only a namespace refusal counts as "cannot run".** The old existence check
 * was bounded by construction; this probe does a full namespace setup plus a
 * `--ro-bind / /`, so a spawn that times out, fails to fork, or dies on
 * EAGAIN/ENOMEM is an *environment* fault, not an absent capability — and
 * collapsing that into a silent `false` would hide real coverage behind a skip
 * with nothing in the log. Those cases throw instead (see `PROBE_TIMEOUT_MS`).
 *
 * Memoized per process, per resolved PATH: spawning bwrap is not free, and a
 * module-level `const SKIP = !canRunBwrapFence()` would otherwise re-probe for
 * every test file the worker loads. Distinct PATHs are cached separately
 * because a file that pins PATH to a hermetic value must be decided under that
 * PATH, not under the host's.
 */
import { spawnSync } from "node:child_process";

/** Probe under a pinned PATH instead of the inherited one. */
export interface BwrapCapabilityProbeOptions {
  readonly path?: string;
}

/**
 * Upper bound on one probe. A fence that cannot even start a trivial
 * `/bin/true` within this window is wedged, not incapable.
 */
const PROBE_TIMEOUT_MS = 10_000;

const results = new Map<string, boolean>();

/**
 * True only when a real bwrap fence (including `--unshare-net`) can start on
 * this host. `options.path` decides the case under a pinned PATH; omit it to
 * use the inherited one.
 *
 * Returns `false` for the two honest "no": bwrap is not installed, or the
 * kernel refused the namespace (bwrap ran and exited non-zero). Throws on a
 * wedged or un-forkable probe so an environment fault cannot masquerade as a
 * capability the tests then silently skip.
 */
export function canRunBwrapFence(
  options: BwrapCapabilityProbeOptions = {}
): boolean {
  const key = options.path ?? "";
  const cached = results.get(key);
  if (cached !== undefined) return cached;
  const r = spawnSync(
    "bwrap",
    [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-net",
      "--",
      "/bin/true",
    ],
    {
      stdio: "ignore",
      timeout: PROBE_TIMEOUT_MS,
      ...(options.path === undefined
        ? {}
        : { env: { ...process.env, PATH: options.path } }),
    }
  );
  if (r.error) {
    // ENOENT is the honest "bwrap is not installed" answer, same as before.
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") {
      results.set(key, false);
      return false;
    }
    // ETIMEDOUT / EAGAIN / ENOMEM / anything else: the probe could not get a
    // verdict, so it must not report "cannot run".
    throw new Error(
      `bwrap capability probe failed unexpectedly (${r.error.code ?? r.error.message}); ` +
        `this is an environment fault, not an absent sandbox capability.`
    );
  }
  const result = r.status === 0;
  results.set(key, result);
  return result;
}
