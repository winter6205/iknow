/**
 * Findings and report rendering: the markdown/JSON the run leaves behind.
 *
 * Why rendering is its own module (issue 1219, bug 3): the renderer is pure and is the only
 * part of the smoke a reader ever sees. Keeping it separate means the report's claims can be
 * audited against `finalize` without reading any container code.
 *
 * Findings are DERIVED from what the run observed and are reported, never fixed here — the
 * smoke exists to describe the state of the existing tooling, so a module that silenced its
 * own findings would defeat its purpose.
 */
import {
  PROBE_FAILED,
  type NegativeCase,
  type PreflightRow,
  type SmokeFinding,
  type SmokeReport,
  type TaskVerdict,
} from "./smoke-types.js";

/**
 * Defects in the EXISTING modules, derived from what this run actually observed.
 * They are reported, not fixed: `docker.ts` is owned elsewhere.
 */
export function findingsFrom(
  tasks: ReadonlyArray<TaskVerdict>
): ReadonlyArray<SmokeFinding> {
  const findings: SmokeFinding[] = [];
  const lost = tasks.filter(
    (task) => task.reward === null && task.hostReward !== null
  );
  if (lost.length > 0) {
    // Still a derived finding, not a remembered one: `grade()` now reads the reward from the
    // retained host artifact, so a port/host disagreement means that channel regressed, and a
    // detector that stopped firing here would hide exactly that regression.
    findings.push({
      severity: "high",
      where: "docker.ts RunnerPort.grade()",
      finding:
        "the port reported no reward while the grader's retained host reward.txt holds one; " +
        "grade() reads the reward from that host artifact, so the reward channel has regressed",
      evidence: lost
        .map(
          (task) =>
            `${task.task}: port reward=${String(task.reward)} but host reward.txt=${String(task.hostReward)}`
        )
        .join("; "),
    });
  }
  const unproven = tasks.filter((task) => !task.mountsUnified);
  if (unproven.length > 0) {
    findings.push({
      severity: "high",
      where: "runner.ts sharedMounts",
      finding:
        "the real attempt mount list no longer deep-equals the mount list the smoke " +
        "declares independently of it; the /logs bind mount is load-bearing (#1212 A4)",
      evidence: unproven.map((task) => task.task).join(", "),
    });
  }
  return findings;
}

const NOTES = [
  // Every task's test.sh apt-installs curl and installs uv over the network, so a host that
  // reaches the network only through a proxy needs the container to inherit one. `docker run`'s
  // env is an explicit operator option on the CLI now, with no default proxy and nothing read
  // from `process.env`; this smoke keeps injecting the host's proxy variables through the
  // injected ExecFn, which `docker exec` inherits, so a run needs no extra flag. No mount,
  // script, timeout or port behaviour is changed.
  "Every task's test.sh apt-installs curl and installs uv over the network, so a host that reaches the network only through a proxy needs the container to inherit one. `docker run`'s env is an explicit operator option on the CLI (`--container-env NAME=VALUE`, no default proxy and nothing read from `process.env`); this smoke injects the same host variables through its injected ExecFn, which `docker exec` inherits. No mount, script, timeout or port behaviour is changed.",
  "Reward is expected to be 0 on a pristine container because nobody solved the task. The harness proof is the retained host-side CTRF plus a real pytest result line; reward alone is never accepted as proof.",
  "graderExit is recorded but not asserted: test.sh ends in an `if` that writes reward.txt, so it exits 0 even when every test failed.",
  // The mount claim, stated so a reader cannot mistake a construction for a measurement.
  // `preflightMounts` delegates to `sharedMounts`, so comparing the two plans would compare
  // a function with itself and could never fail; what is measured here instead is the REAL
  // `sharedMounts(spec)` against a mount list the smoke declares independently of it.
  "Preflight and attempt provisioning build their mount plan from the same `sharedMounts` function, so their identity is guaranteed BY CONSTRUCTION rather than verified at run time: comparing the two plans would compare a function with itself. What this run does measure is that the real `sharedMounts(spec)` still deep-equals the mount list the smoke declares independently of it, so a dropped or read-only `/logs` bind mount (the #1212 A4 fault) is a hard failure and a high-severity finding.",
];

function renderHeader(report: SmokeReport): string[] {
  return [
    "# Issue 1219 disposable-Docker smoke (zero model dispatch)",
    "",
    `- started: ${report.startedAtIso}`,
    `- runner: ${report.runnerVersion}`,
    `- node archive sha256 MEASURED: \`${report.nodeArchiveShaMeasured}\``,
    `- node archive sha256 PINNED: \`${report.nodeArchiveShaPinned}\` (source: ${report.nodeArchiveShaPinSource})`,
    `- SHASUMS cross-check: ${report.shasumsCrossCheck}`,
    `- bundle sha256 MEASURED: \`${report.bundleShaMeasured}\``,
    `- model dispatch calls: ${report.modelDispatchCalls}`,
    `- settings handed to containers: ${report.settingsNote} (sha256 \`${report.settingsSha256}\`)`,
    `- proxy env injected into containers: ${report.proxyEnvInjected}`,
    `- image without curl: ${report.curlGap.image} (${report.curlGap.probe}) via ${report.curlGap.via} — ${report.curlGap.passed ? "PROVISIONED" : "FAILED"}; ${report.curlGap.detail}`,
    "",
    ...report.notes.map((note) => `> ${note}`),
    "",
  ];
}

function renderTaskTable(tasks: ReadonlyArray<TaskVerdict>): string[] {
  const header = [
    "## Per-task results: ORIGINAL grader on a pristine container",
    "",
    "| task | image | curl | prov | boot | logs | wall | grader | port reward | host reward | host ctrf | result line | net | validity | gate verdict | result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = tasks.map((task) =>
    [
      "|",
      task.task,
      task.image,
      task.curlInImage.split(" | ")[0] ?? "?",
      task.provisionExit,
      task.bootVerified,
      task.logsMountWritable,
      task.graderWallSec,
      task.graderExit,
      String(task.reward),
      String(task.hostReward),
      task.hostCtrfBytes,
      task.resultLine === "" ? "(none)" : task.resultLine,
      task.networkFailureMarker ? "PRESENT" : "none",
      task.validity.label,
      task.gateVerdict,
      task.passed ? "PASS" : `FAIL(${task.failures.join("; ")})`,
      "|",
    ].join(" ")
  );
  return [...header, ...rows, ""];
}

function renderNegatives(negatives: ReadonlyArray<NegativeCase>): string[] {
  const lines = ["## Negative cases (each must be DETECTED)", ""];
  for (const item of negatives) {
    lines.push(
      `### ${item.name} — ${item.detected ? "DETECTED" : "NOT DETECTED"}`,
      `expected: ${item.expected}`
    );
    for (const observed of item.observed) lines.push(`- ${observed}`);
    lines.push("");
  }
  return lines;
}

function renderPreflight(report: SmokeReport): string[] {
  return [
    "## Complete task list preflight",
    report.coverage.statement,
    `- verdicts: ${Object.entries(report.coverage.verdictHistogram)
      .map(([verdict, count]) => `${verdict}=${count}`)
      .join(", ")}`,
    "",
    "| task | image | coverage | image local | grader | glibcxx | verdict |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.preflight.map(
      (row: PreflightRow) =>
        `| ${row.task} | ${row.image} | ${row.coverage} | ${String(row.imageLocal)} | ${row.graderPresent} | ${row.glibcxxMeasured} | ${row.verdict} |`
    ),
    "",
  ];
}

function renderFindings(report: SmokeReport): string[] {
  if (report.findings.length === 0)
    return ["## Findings in existing modules", "none observed", ""];
  return [
    "## Findings in existing modules (reported, not fixed)",
    ...report.findings.map(
      (finding) =>
        `- **[${finding.severity}] ${finding.where}** — ${finding.finding}\n  - evidence: ${finding.evidence}`
    ),
    "",
  ];
}

function renderCleanup(report: SmokeReport): string[] {
  const containers = report.containers;
  return [
    "## Cleanup proof",
    `- prefix queried: \`${containers.prefix}\``,
    `- docker ps -a before: \`${JSON.stringify(containers.before)}\``,
    `- docker ps -a after: \`${JSON.stringify(containers.after)}\``,
    `- leaked (created by this run and still present): \`${JSON.stringify(containers.leaked)}\``,
    "",
    `## Result: ${report.passed ? "PASS" : "FAIL"}`,
    ...report.failures.map((failure) => `- ${failure}`),
  ];
}

/** Markdown report, written to `--out` and printed, so the run is readable without tooling. */
export function renderMarkdown(report: SmokeReport): string {
  const sections = [
    renderHeader(report),
    renderTaskTable(report.tasks),
    renderNegatives(report.negatives),
    renderPreflight(report),
    renderFindings(report),
    renderCleanup(report),
  ];
  return `${sections.flat().join("\n")}\n`;
}

/**
 * The marker a report carries when its run did not reach a normal `finalize`.
 *
 * A Ctrl-C during a grader wall, or a throw after the first task, used to leave NO report at
 * all: the catch printed to stderr and exited, so the host-side verdicts already paid for were
 * lost, the container inventory was never re-read, and "zero leaked containers" was evidenced
 * only for a clean run. A report that exists but does not say it is partial is its own kind of
 * overclaim, so the interruption is stated in the notes (top of the rendered report) AND as a
 * failure (so `passed` can never be true).
 */
export function interruptedNote(reason: string): string {
  return (
    `RUN DID NOT COMPLETE: ${reason}. Everything below is the evidence retained up to that ` +
    `point, not a full smoke result; this run cannot report PASS.`
  );
}

/**
 * Failures carried by the things the run did one of: a task verdict, a negative case.
 *
 * Split from the run-wide guards because the two read differently: these are per-item results
 * already carrying their own detail, while the guards below are properties of the run as a whole.
 */
function itemFailures(
  report: Omit<SmokeReport, "passed" | "failures">,
  negatives: ReadonlyArray<NegativeCase>
): string[] {
  const failures: string[] = [];
  for (const task of report.tasks)
    if (!task.passed)
      failures.push(`${task.task}: ${task.failures.join("; ")}`);
  for (const item of negatives)
    if (!item.detected)
      failures.push(`negative case NOT detected: ${item.name}`);
  return failures;
}

/** Failures carried by the run as a whole. Each one is a claim the report otherwise overclaims. */
function guardFailures(
  report: Omit<SmokeReport, "passed" | "failures">
): string[] {
  const failures: string[] = [];
  if (!report.curlGap.passed)
    failures.push(
      `image without curl did not provision: ${report.curlGap.image}`
    );
  if (report.containers.leaked.length > 0)
    failures.push(`leaked containers: ${report.containers.leaked.join(", ")}`);
  if (report.coverage.probeFailed > 0)
    failures.push(
      `unresolved harness fault: ${report.coverage.probeFailed} preflight row(s) are ${PROBE_FAILED}, ` +
        `so their library ceiling is unknown and they exclude nothing`
    );
  if (report.modelDispatchCalls !== 0)
    failures.push(
      `model dispatch happened ${report.modelDispatchCalls} time(s)`
    );
  return failures;
}

/** Decide the run's exit status. Every failure is listed verbatim, never summarised away. */
export function finalize(
  report: Omit<SmokeReport, "passed" | "failures">,
  negatives: ReadonlyArray<NegativeCase>,
  interruption: string | null = null
): SmokeReport {
  // Order is the report's reading order and is unchanged by the split: the run-level reason
  // first, then the per-item results, then the run-wide guards.
  const failures = [
    ...(interruption === null ? [] : [`run did not complete: ${interruption}`]),
    ...itemFailures(report, negatives),
    ...guardFailures(report),
  ];
  return { ...report, passed: failures.length === 0, failures };
}

export { NOTES };
