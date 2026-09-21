import { mergeConfig, type UserConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";
import { CI_EXCLUDES } from "./vitest.ci-excludes.js";

/**
 * Vitest config for CI — test-full (nightly cron + manual dispatch).
 *
 * = local vitest.config.ts + CI_EXCLUDES (SSOT: vitest.ci-excludes.ts).
 * Inherit rather than copy, so local `npm test` / `test:changed` semantics
 * stay unchanged and CI only excludes an extra batch of files that cannot
 * run on the runner.
 *
 * Why the extra excludes: the GHA runner has no user-namespace, so bwrap
 * physical execution cannot start; and requireBwrap() already throws at
 * assembly time in createBashTool / createDefaultAciRegistry /
 * createWorkerDeps / runInSandbox. Per-entry classification and rationale
 * live in vitest.ci-excludes.ts, not restated here. The batch that still
 * cannot physically execute even with bwrap installed must remain excluded
 * — installing bwrap only resolves assembly-time fail-loud.
 *
 * This config affects CI only; local sandbox/ACI tests keep being fully
 * verified on WSL.
 */
export default mergeConfig(baseConfig as UserConfig, {
  test: {
    exclude: [...CI_EXCLUDES],
  },
});
