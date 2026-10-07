/**
 * The smoke's findings and its rendered markdown.
 *
 * Why this file exists (issue 1219 follow-up): both bugs the smoke found were FIXED, but the
 * renderer kept the old words, so a post-fix run published a report asserting defects that no
 * longer exist. A stale defect claim in an audit artifact is not cosmetic — it is the artifact
 * claiming something false about the instrument, which is the failure class this tooling exists
 * to prevent. So both texts are pinned here:
 *
 *   - `NOTES` may not claim `docker.ts` passes no proxy env, because `docker.ts` now takes an
 *     explicit `containerEnv` option and the CLI forwards `--container-env NAME=VALUE` to it.
 *   - `findingsFrom` may not claim `grade()` never reports a reward, because `grade()` now reads
 *     the retained host `reward.txt`. The DETECTOR is kept on purpose: the finding must still
 *     fire if the port and the host ever disagree again.
 *
 * The finding and the notes are derived from what a run observed, so a pin is written as "this
 * claim must not appear" plus "this guidance must still appear" — never as a frozen copy of the
 * sentence, which would just re-introduce the same drift one layer down.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  findingsFrom,
  finalize,
  NOTES,
  renderMarkdown,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-report.ts";
import type { ValidityVerdict } from "../../../../scripts/eval/terminal-bench-2.1/accounting.ts";
import type {
  SmokeFinding,
  SmokeReport,
  TaskVerdict,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";

const VALID: ValidityVerdict = {
  valid: true,
  failedClauses: [],
  label: "VALID",
};

/**
 * One graded task. `reward` is what the port reported and `hostReward` is what the grader's
 * retained host `reward.txt` holds; after the reward fix the two agree, which is the only
 * reason the real run reports no findings at all.
 */
function verdict(overrides: Partial<TaskVerdict> = {}): TaskVerdict {
  return {
    task: "db-wal-recovery",
    image: "alexgshaw/db-wal-recovery:20251031",
    curlInImage: "ABSENT | /usr/bin/tar",
    mountsUnified: true,
    provisionExit: 0,
    bootVerified: true,
    logsMountWritable: true,
    glibcxxMeasured: "GLIBCXX_3.4.33",
    graderWallSec: 1500,
    graderExit: 0,
    reward: "0",
    hostReward: "0",
    hostCtrfBytes: 6475,
    resultLine: "7 failed",
    networkFailureMarker: false,
    validity: VALID,
    gateVerdict: "EXCLUDE:oracle-or-grader",
    gateReasons: [],
    retainedFiles: ["logs/verifier/reward.txt", "logs/verifier/ctrf.json"],
    passed: true,
    failures: [],
    ...overrides,
  };
}

/** Every text the renderer can publish about a finding, in one string. */
function findingText(findings: ReadonlyArray<SmokeFinding>): string {
  return findings
    .map((finding) => `${finding.where} ${finding.finding}`)
    .join(" ");
}

/** The minimal report `renderMarkdown` reads; `findings` is what is under test. */
function reportWith(findings: ReadonlyArray<SmokeFinding>): SmokeReport {
  return finalize(reportBaseWith({ findings }), []);
}

/**
 * The same report BEFORE `finalize` decides pass/fail. Split out so a test about the decision
 * (an unresolved probe row, say) can build one instead of re-deriving the whole literal.
 */
function reportBaseWith(
  overrides: Partial<Omit<SmokeReport, "passed" | "failures">> = {}
): Omit<SmokeReport, "passed" | "failures"> {
  return {
    startedAtIso: "2026-10-07T06:12:03.980Z",
    nodeArchiveShaMeasured:
      "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    nodeArchiveShaPinned:
      "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    nodeArchiveShaPinSource: "--node-sha",
    shasumsCrossCheck: "SHASUMS256.txt agrees with the measured digest",
    bundleShaMeasured:
      "1525d540457b0cb5a68535890eb2960319fcb4a25126c62b51273954ac1b27e7",
    runnerVersion: "tb2.1-docker/1",
    modelDispatchCalls: 0,
    settingsSha256:
      "4f70455e567aa7c253ed006a64ab5eb675e97d2a961ccc3dcc7144c8e6df1064",
    settingsNote:
      "smoke-generated credential-free placeholder; no real settings file and no key",
    proxyEnvInjected: true,
    curlGap: {
      task: "adaptive-rejection-sampler",
      image: "alexgshaw/adaptive-rejection-sampler:20251031",
      probe: "ABSENT | /usr/bin/tar",
      via: "provision-only-run",
      passed: true,
      detail: "provision_exit=0 boot=true logs_writable=true",
    },
    notes: NOTES,
    tasks: [verdict()],
    negatives: [],
    findings: [],
    preflight: [],
    coverage: {
      totalTasks: 3,
      fullyGraded: 3,
      gateOnly: 0,
      probeFailed: 0,
      verdictHistogram: { "GATE:static-only": 3 },
      statement: "3/3 tasks fully graded",
    },
    containers: { prefix: "tb21-", before: [], after: [], leaked: [] },
    ...overrides,
  };
}

describe("no note claims a defect the tooling no longer has", () => {
  it("does not claim docker.ts passes no proxy env to docker run", () => {
    const notes = NOTES.join(" ");

    assert.doesNotMatch(
      notes,
      /docker\.ts passes no proxy env/,
      `the option exists and the CLI forwards it, so this claim is false; notes: ${notes}`
    );
  });

  it("still tells the operator how the smoke reaches the network, and how to read a verdict", () => {
    const notes = NOTES.join(" ");

    for (const guidance of [
      "ExecFn",
      "docker exec",
      "reward alone is never accepted as proof",
      "graderExit is recorded but not asserted",
      "reward.txt",
    ]) {
      assert.ok(
        notes.includes(guidance),
        `the corrected note must keep the operator guidance "${guidance}"; notes: ${notes}`
      );
    }
  });
});

describe("findings are derived, and never describe a fixed defect", () => {
  it("reports nothing when the port reward matches the retained host reward", () => {
    const findings = findingsFrom([verdict()]);

    assert.deepEqual(
      findings,
      [],
      `a post-fix run agrees with the host artifact, so there is no finding to report; got: ${JSON.stringify(findings)}`
    );
    assert.ok(
      renderMarkdown(reportWith(findings)).includes(
        "## Findings in existing modules\nnone observed"
      ),
      "the rendered report must read as no findings, not as an empty list under a defect heading"
    );
  });

  it("never claims grade() scrapes a reward the graders do not echo", () => {
    const text = findingText(findingsFrom([verdict()]));

    assert.doesNotMatch(
      text,
      /\/reward=|always null|never echo/,
      `grade() reads the retained host reward.txt now, so this text asserts a defect that is fixed; got: ${text}`
    );
  });

  it("still fires when the port and the host disagree, and names the disagreement", () => {
    const findings = findingsFrom([verdict({ reward: null })]);

    assert.equal(
      findings.length,
      1,
      `the detector must survive the fix, or a regressed reward channel would be silent; got: ${JSON.stringify(findings)}`
    );
    assert.equal(
      findings[0]?.severity,
      "high",
      "a diverged reward channel is a high-severity finding"
    );
    assert.match(
      findings[0]?.finding ?? "",
      /host reward\.txt/,
      `the finding must name the artifact it disagrees with; got: ${findings[0]?.finding}`
    );
    assert.match(
      findings[0]?.evidence ?? "",
      /port reward=null but host reward\.txt=0/,
      `the evidence must carry the measured disagreement; got: ${findings[0]?.evidence}`
    );
  });

  it("still fires when the real attempt mount list diverges from the declared wiring", () => {
    const findings = findingsFrom([verdict({ mountsUnified: false })]);

    assert.equal(
      findings.length,
      1,
      `the mount finding is unrelated to the reward fix and must remain; got: ${JSON.stringify(findings)}`
    );
    assert.match(
      findings[0]?.where ?? "",
      /runner\.ts sharedMounts/,
      `the finding must name the function that really builds the mounts; preflightMounts is not it, because that function delegates to sharedMounts; got: ${findings[0]?.where}`
    );
    assert.doesNotMatch(
      findings[0]?.where ?? "",
      /preflightMounts/,
      "naming a second function that is defined as `return sharedMounts(spec)` would describe a comparison the run does not make"
    );
  });

  it("renders both findings together rather than reporting only the first", () => {
    const markdown = renderMarkdown(
      reportWith(
        findingsFrom([verdict({ reward: null, mountsUnified: false })])
      )
    );

    assert.ok(
      markdown.includes("reward.txt") && markdown.includes("deep-equals"),
      `a run with both defects must publish both; got: ${markdown.slice(0, 400)}`
    );
  });
});

describe("an unresolved probe row is an unresolved harness fault, never a pass", () => {
  it("fails the run when a preflight row's library probe exited nonzero", () => {
    const report = finalize(
      reportBaseWith({
        coverage: {
          totalTasks: 4,
          fullyGraded: 3,
          gateOnly: 1,
          probeFailed: 1,
          verdictHistogram: { "GATE:static-only": 3, PROBE_FAILED: 1 },
          statement:
            "3 of 4 task(s) were FULLY GRADED; 1 row(s) are PROBE_FAILED",
        },
      }),
      []
    );

    assert.equal(
      report.passed,
      false,
      "a row whose ceiling was never measured is an unknown, and an unknown must not report PASS"
    );
    assert.match(
      report.failures.join(" "),
      /PROBE_FAILED/,
      `the failure must name the unresolved verdict so an operator can find the harness fault; got: ${JSON.stringify(report.failures)}`
    );
    assert.match(
      renderMarkdown(report),
      /PROBE_FAILED/,
      "the rendered report must carry the unresolved count, not only the JSON"
    );
  });

  it("publishes the verdict histogram so a reader can separate exclusions from unknowns", () => {
    const markdown = renderMarkdown(
      finalize(
        reportBaseWith({
          coverage: {
            totalTasks: 4,
            fullyGraded: 3,
            gateOnly: 1,
            probeFailed: 1,
            verdictHistogram: {
              "EXCLUDE:glibcxx": 15,
              "GATE:static-only": 70,
              PROBE_FAILED: 1,
            },
            statement:
              "3 of 4 task(s) were FULLY GRADED; 1 row(s) are PROBE_FAILED",
          },
        }),
        []
      )
    );
    const section = markdown.slice(
      markdown.indexOf("## Complete task list"),
      markdown.indexOf("## Findings")
    );

    assert.match(
      section,
      /verdicts: .*PROBE_FAILED=1/,
      `the histogram is the accounting that makes unresolved rows countable; got: ${section}`
    );
    assert.match(
      section,
      /EXCLUDE:glibcxx=15/,
      `a real exclusion and an unknown must be counted in different buckets, or the reader cannot tell them apart; got: ${section}`
    );
  });
});

describe("the report publishes only what the run actually did", () => {
  it("renders proxyEnvInjected false when nothing was injected", () => {
    const markdown = renderMarkdown(
      finalize(reportBaseWith({ proxyEnvInjected: false }), [])
    );

    assert.ok(
      markdown.includes("proxy env injected into containers: false"),
      `the header must print the measured value, so a no-proxy host cannot publish a claim it did not make; got: ${markdown.slice(0, 600)}`
    );
  });
});
