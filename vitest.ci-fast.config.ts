import { mergeConfig, type UserConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";
import { CI_EXCLUDES, CI_FAST_EXCLUDES } from "./vitest.ci-excludes.js";

/**
 * Vitest config for CI — test-fast (PR-level quick gate, target feedback
 * within ~5min).
 *
 * = local vitest.config.ts + CI_EXCLUDES + CI_FAST_EXCLUDES
 * (SSOT: vitest.ci-excludes.ts). This job does not install bubblewrap, so
 * compared with test-full it additionally excludes the whole
 * e2e / integration / secret-roundtrip directories — these throw at
 * assembly time when bwrap is missing. Per-entry rationale lives in the
 * SSOT module.
 *
 * Timing flakiness is absorbed by --retry 1 in the workflow, not expressed here.
 */
export default mergeConfig(baseConfig as UserConfig, {
  test: {
    exclude: [...CI_EXCLUDES, ...CI_FAST_EXCLUDES],
  },
});
