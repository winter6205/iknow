import { defineConfig } from "vitest/config";

/**
 * Vitest config for real-LLM e2e — archive/tests-real-llm/.
 *
 * Why a separate config: real-LLM e2e (bootstrap-real-llm +
 * tui-subagent-wiring-acceptance) are out of the default `vitest run`
 * collection because they make ~95s of live LLM calls on this dev shell
 * (when ANTHROPIC_AUTH_TOKEN is set) and historically flake on the
 * model prompt path. They are run on demand via
 * `npm run test:real-llm`, matching scripts/i9-*-smoke.ts pattern
 * (缺 key 退出 1). The actual skip guard inside each file remains
 * (describe.skip when key absent / bwrap missing) so a stale key
 * surfaces a clear skip reason rather than a hidden failure.
 */
export default defineConfig({
  test: {
    include: ["archive/tests-real-llm/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    pool: "forks",
    poolOptions: {
      forks: { maxForks: 1, minForks: 1 },
    },
    reporter: "default",
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
