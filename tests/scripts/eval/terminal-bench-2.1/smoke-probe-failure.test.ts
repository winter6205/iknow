/**
 * A library probe that FAILED is not a library that is ABSENT (issue 1219 audit follow-up).
 *
 * Why this file exists: `imageGlibcxx` used to discard `run.code` and map empty stdout to
 * `ABSENT`, so an image whose `docker run … bash -c` probe failed for ANY reason — no `bash`
 * in the image, a blocked exec, a full tmpfs, a daemon error — was published as
 * `EXCLUDE:glibcxx`. That attributes a HARNESS fault to the TASK, which is precisely the
 * mis-attribution this tooling exists to prevent, and it does so silently: a sweep of rows
 * reads like a measured library ceiling when the truth is unknown.
 *
 * So a failed probe is its own verdict, `PROBE_FAILED`:
 *   - distinct from `EXCLUDE:glibcxx` (a task exclusion) and from every `GATE:*`,
 *   - excluded from no task, i.e. it never becomes an exclusion,
 *   - counted in the coverage accounting so a reader can see how many rows are unresolved,
 *   - `ABSENT` still means ABSENT, which is what keeps a real ceiling exclusion honest.
 *
 * The pins below are written against the public seams (`enumerateTasks`, `preflightRows`,
 * `coverageOf`) rather than the private probe, because the mis-attribution happens between
 * them and a test of the private function would not have caught it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, it } from "vitest";

import type { ExecFn } from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import {
  coverageOf,
  preflightRows,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-preflight.ts";
import { enumerateTasks } from "../../../../scripts/eval/terminal-bench-2.1/smoke-tasks.ts";
import { PROBE_FAILED } from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";

const IMAGE = "alexgshaw/db-wal-recovery:20251031";
const TASK = "db-wal-recovery";
const FLOOR = "GLIBCXX_3.4.31";

const roots: string[] = [];

/** One-task dataset: a declared image, a declared verifier timeout and a grader script. */
function dataset(): string {
  const root = mkdtempSync(join(tmpdir(), "iknow-smoke-"));
  roots.push(root);
  const dir = join(root, "tasks", TASK);
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "task.toml"),
    [
      "[environment]",
      `docker_image = "${IMAGE}"`,
      "",
      "[verifier]",
      "timeout_sec = 300",
      "",
    ].join("\n")
  );
  writeFileSync(join(dir, "tests", "test.sh"), "#!/bin/sh\nexit 0\n");
  return root;
}

/**
 * A local image whose in-container `docker run … bash -c` probe exits `probeCode`.
 * `image inspect` succeeds, so the ONLY variable is what the probe itself did.
 */
function probeExec(probeCode: number, stdout = ""): ExecFn {
  return async (_file, args) => ({
    stdout: args[0] === "run" ? stdout : "",
    stderr: args[0] === "run" ? "bash: not found" : "",
    code: args[0] === "run" ? probeCode : 0,
  });
}

afterAll(() => {
  for (const root of roots.splice(0, roots.length))
    rmSync(root, { recursive: true, force: true });
});

describe("a failed library probe is never an absent library", () => {
  it("records PROBE_FAILED when the in-container probe exits nonzero", async () => {
    const facts = await enumerateTasks(dataset(), probeExec(127), true);

    assert.equal(
      facts[0]?.imageLocal,
      true,
      `the image must be local, or the probe is skipped and the row proves nothing; got: ${JSON.stringify(facts[0])}`
    );
    assert.equal(
      facts[0]?.glibcxxMeasured,
      PROBE_FAILED,
      `a nonzero probe exit means the ceiling is UNKNOWN, and unknown must not read as ABSENT; got: ${facts[0]?.glibcxxMeasured}`
    );
    assert.notEqual(
      facts[0]?.glibcxxMeasured,
      "ABSENT",
      "ABSENT is a measurement, and a probe that never ran produced none"
    );
  });

  it("still records a genuinely absent library as ABSENT, because the probe ran and found nothing", async () => {
    // The probe is a pipeline ending in `tail -1`, so an image with no libstdc++.so.6 exits 0
    // with empty stdout. That is a real measurement and must keep its old meaning.
    const facts = await enumerateTasks(dataset(), probeExec(0, ""), true);

    assert.equal(
      facts[0]?.glibcxxMeasured,
      "ABSENT",
      `an exit-0 probe with no match is a real ABSENT; got: ${facts[0]?.glibcxxMeasured}`
    );
  });

  it("still records a measured ceiling when the probe succeeds", async () => {
    const facts = await enumerateTasks(
      dataset(),
      probeExec(0, "GLIBCXX_3.4.33\n"),
      true
    );

    assert.equal(
      facts[0]?.glibcxxMeasured,
      "GLIBCXX_3.4.33",
      `the happy path must be untouched by the probe-exit check; got: ${facts[0]?.glibcxxMeasured}`
    );
  });
});

describe("PROBE_FAILED is its own row verdict, not a task exclusion", () => {
  it("never reads as EXCLUDE:glibcxx", async () => {
    const facts = await enumerateTasks(dataset(), probeExec(1), true);
    const rows = preflightRows(facts, [], FLOOR);

    assert.equal(
      rows[0]?.verdict,
      PROBE_FAILED,
      `a failed probe must not be published as a library exclusion; got: ${rows[0]?.verdict}`
    );
    assert.notEqual(
      rows[0]?.verdict,
      "EXCLUDE:glibcxx",
      "this verdict is the whole defect: an unknown ceiling attributed to the task"
    );
    assert.ok(
      (rows[0]?.reasons ?? []).join(" ").includes("unknown"),
      `the row must say the ceiling is unknown, so no reader treats it as a measurement; got: ${JSON.stringify(rows[0]?.reasons)}`
    );
  });

  it("keeps a genuinely absent ceiling excluded, so the real exclusion path survives", async () => {
    const facts = await enumerateTasks(dataset(), probeExec(0, ""), true);
    const rows = preflightRows(facts, [], FLOOR);

    assert.equal(
      rows[0]?.verdict,
      "EXCLUDE:glibcxx",
      `a measured ABSENT ceiling below the floor is a real exclusion and must stay one; got: ${rows[0]?.verdict}`
    );
  });

  it("counts an unresolved row in the coverage accounting", async () => {
    const facts = await enumerateTasks(dataset(), probeExec(1), true);
    const rows = preflightRows(facts, [], FLOOR);
    const coverage = coverageOf(rows);

    assert.equal(
      coverage.probeFailed,
      1,
      `a reader must be able to see how many rows are unresolved; got: ${JSON.stringify(coverage)}`
    );
    assert.equal(
      coverage.verdictHistogram[PROBE_FAILED],
      1,
      `the histogram must carry PROBE_FAILED next to the task verdicts; got: ${JSON.stringify(coverage.verdictHistogram)}`
    );
    assert.equal(
      coverage.verdictHistogram["EXCLUDE:glibcxx"],
      undefined,
      `a failed probe must not be counted as a task exclusion anywhere; got: ${JSON.stringify(coverage.verdictHistogram)}`
    );
    assert.ok(
      coverage.statement.includes(PROBE_FAILED),
      `the coverage statement must name the unresolved rows; got: ${coverage.statement}`
    );
  });

  it("reports zero unresolved rows when every probe ran", async () => {
    const facts = await enumerateTasks(
      dataset(),
      probeExec(0, "GLIBCXX_3.4.33\n"),
      true
    );
    const coverage = coverageOf(preflightRows(facts, [], FLOOR));

    assert.equal(
      coverage.probeFailed,
      0,
      `a clean sweep must not report phantom harness faults; got: ${JSON.stringify(coverage)}`
    );
  });
});
