/**
 * scripts/perf/settings-read.ts — measurement tool (no pass/fail gate).
 *
 * Measures the per-call cost of `currentSecretValues()`
 * (src/harness/sandbox/env-isolation.ts) — the output-masking hot path — and
 * counts how many settings-file disk reads (`fs.readFileSync` on
 * `.../.iknow/settings.json`) the measured loop performs.
 *
 * Usage:
 *   npx tsx scripts/perf/settings-read.ts
 *
 * Output (JSON, one line):
 *   {
 *     "type": "settings-read-perf",
 *     "iterations": 1000,
 *     "elapsedMs": <wall time of the measured loop>,
 *     "settingsFileReads": <readFileSync calls on a .iknow/settings.json path>,
 *     "readsPerCall": <settingsFileReads / iterations>,
 *     "homeSettingsPresent": <bool>, "projectSettingsPresent": <bool>
 *   }
 *
 * Why a child process: an in-script patch of `require("node:fs").readFileSync`
 * is NOT visible to ESM named imports (`import { readFileSync } from
 * "node:fs"`, what src/config/settings.ts uses) — the built-in module's ESM
 * facade snapshots its exports at first instantiation (probed: a patch applied
 * before a dynamic ESM import still missed every ESM-side read). The patch
 * must exist before ANY ESM instantiation of node:fs in the process, i.e. in a
 * CJS preload. This script therefore re-execs itself as
 *
 *   node --require scripts/perf/settings-read-preload.cjs --import tsx \
 *        scripts/perf/settings-read.ts
 *
 * and the preload-installed counter (exposed as globalThis
 * `__SETTINGS_READ_PROBE`) marks the child role. The preload counts only
 * settings.json reads, so tsx loader-internal reads stay out of the number;
 * module-load-time and warmup reads are excluded by snapshotting the counter
 * after warmup, right before the measured loop.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ITERATIONS = 1000;

const here = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(here, "settings-read-preload.cjs");
const repoRoot = join(here, "..", "..");

/** Present only when this process was started with the preload (child role). */
function readProbe(): { count: number } | undefined {
  return (globalThis as { __SETTINGS_READ_PROBE?: { count: number } })
    .__SETTINGS_READ_PROBE;
}

async function runChildMeasurement(): Promise<void> {
  const probe = readProbe();
  if (!probe) {
    console.error(
      "[settings-read-perf] preload counter missing — run via: npx tsx scripts/perf/settings-read.ts"
    );
    process.exit(2);
  }

  // The module under test is imported AFTER the preload is guaranteed active
  // (a --require preload runs before any ESM graph instantiation).
  const { currentSecretValues } = await import(
    pathToFileURL(
      join(repoRoot, "src", "harness", "sandbox", "env-isolation.js")
    ).href
  );

  // Warmup (JIT + module-init reads land here, outside the measured window).
  for (let i = 0; i < 5; i++) currentSecretValues();

  const readsBefore = probe.count;
  const t0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) currentSecretValues();
  const elapsedMs = performance.now() - t0;
  const reads = probe.count - readsBefore;

  console.log(
    JSON.stringify({
      type: "settings-read-perf",
      iterations: ITERATIONS,
      elapsedMs: Math.round(elapsedMs * 1000) / 1000,
      settingsFileReads: reads,
      readsPerCall: Math.round((reads / ITERATIONS) * 1000) / 1000,
      homeSettingsPresent: existsSync(
        join(process.env.HOME ?? "", ".iknow", "settings.json")
      ),
      projectSettingsPresent: existsSync(
        join(process.cwd(), ".iknow", "settings.json")
      ),
    })
  );
}

async function main(): Promise<void> {
  if (readProbe()) {
    await runChildMeasurement();
    return;
  }
  // Parent role: re-exec with the CJS preload ahead of the tsx loader.
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      preloadPath,
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
    ],
    { stdio: "inherit", cwd: repoRoot }
  );
  if (result.error) {
    console.error(
      `[settings-read-perf] failed to spawn measurement child: ${String(result.error)}`
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

void main();
