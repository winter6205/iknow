import { defineConfig } from "vitest/config";

/**
 * Vitest config for iknow.
 *
 * Why a separate config: tests/ live outside tsconfig.json's `include` (which
 * is scoped to src/ for the dist build), so we give vitest its own TS-aware
 * include here. ESM is honored via the project's `"type": "module"`.
 */
export default defineConfig({
  test: {
    // .tsx: TUI component tests; after #343 T0 the ink TUI tests were archived
    // to archive/tui-ink/ (outside tests/, so this include never collects them).
    // real-LLM e2e (bootstrap-real-llm / tui-subagent-wiring-acceptance) was
    // archived to archive/tests-real-llm/ — same principle as tui-ink: outside
    // tests/, never collected by include, explicitly triggered via package.json
    // "test:real-llm" (vitest.real-llm.config.ts).
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // D2 ruling: tests/tui is driven by bun:test (OpenTUI native FFI is
    // bun-only; under Node/vitest createTestRenderer reports "native FFI is
    // not available"). See the package.json "test" script for the aggregate entry.
    // archive/** defensive exclusion: archived dirs never enter default
    // collection (same rationale as the tui-ink note).
    exclude: ["tests/tui/**", "archive/**", "**/node_modules/**"],
    pool: "forks",
    // On a 4-core machine the default forks min(cores, fileCount) parallel
    // processes, which combined with real timers/TUI polling inside each test
    // file tends to amplify intermittent failures. Capping at 3 forks
    // noticeably reduces contention-induced flakiness (real failures are unaffected).
    poolOptions: {
      forks: { maxForks: 3, minForks: 1 },
    },
    // vitest default testTimeout = 5_000ms. Many cases here really assemble
    // engines (buildHarnessEngine / runChatSession / createWorkerDeps), really
    // spawn subprocesses, really read git — that is IO/assembly budget, not the
    // contract under test: under full load the same case's wall clock can grow
    // several-fold and hitting 5s gets recorded as a timeout red. Raising to 30s
    // makes timeout a signal of "actually hung" again; slower cases get narrowed
    // individually.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporter: "default",
  },
});
