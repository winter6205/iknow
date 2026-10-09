/**
 * Shared fixture for the subagent-output-handoff golden set. Both halves bind
 * to it: the offline invariant half (tests/subagent/subagent-output-handoff
 * .test.ts) and the real-model A/B half (real-llm/subagent-output-handoff
 * .test.ts). All content is synthesized — no session report text, no secrets.
 *
 * The incident-4 bodies are the fixed inputs: each exactly 2,061 UTF-16 code
 * units (the ~2.1 KB receipt size class of the reviewed incident), below the
 * 20,000-unit IPC fold limit and the 200-line pad window, longer than the
 * 2,000-unit short handoff can carry, and ending with a distinct WITNESS
 * token. Because the token sits beyond the short handoff's reach, the parent
 * can only answer the incident prompt by retrieving each worker's saved full
 * report — the tool choice that choice makes is the measured variable.
 *
 * The arm strings are the exact model-visible wording before and after the
 * committed handoff change (arm-A = pre-change, arm-B = the text production
 * carries now). The real-model test derives one arm from the live tool text
 * with a targeted segment swap (armSwap), so both arms share every other
 * byte of the presentation and every receipt stays a real production
 * artifact.
 */
import {
  SUMMARY_LIMIT,
  TRUNCATION_LIMIT,
} from "../../src/harness/subagent/envelope.ts";
import {
  PAD_PAGE_CODE_UNIT_BUDGET,
  PAD_ROSTER_LINE_LIMIT,
} from "../../src/harness/subagent/pad-inspect.ts";
import {
  padLineCount as lineCount,
  utf16Units,
} from "./pad-text-invariants.ts";

/**
 * Production limits the scenario shape must sit inside, imported from their
 * SSOT modules (envelope.ts / pad-inspect.ts) — a mirrored copy here could
 * drift and validate a contract production no longer has.
 */
export {
  SUMMARY_LIMIT,
  TRUNCATION_LIMIT,
  PAD_PAGE_CODE_UNIT_BUDGET,
  PAD_ROSTER_LINE_LIMIT,
};
/** Exact size of each incident report, in UTF-16 code units. */
export const INCIDENT_REPORT_UNITS = 2_061;
/**
 * Pad-relative retrieval path the receipt stamps and the reads must pass.
 * A literal on purpose, pinned against the production `FINAL_TEXT_PAD_NAME`
 * by the offline test — the assertion is what makes it a contract, not a guess.
 */
export const EXPECTED_TMP_PATH = "final.md";

/** Fixed trial counts, decided before examining any result (plan T5). */
export const INCIDENT_TRIALS_PER_ARM = 3;
export const CONTROL_TRIALS_PER_ARM = 1;

export interface WorkerReport {
  readonly id: string;
  readonly fileName: string;
  readonly body: string;
  readonly witness: string;
}

function buildIncidentBody(
  title: string,
  findings: readonly string[],
  witness: string
): string {
  const tail = `WITNESS: ${witness}\n`;
  const target = INCIDENT_REPORT_UNITS - utf16Units(tail);
  let body = `# ${title}\n`;
  let n = 0;
  // Stop one long line early so the checksum line absorbs the exact deficit;
  // numbered observations keep the padding restatable by a real worker.
  while (utf16Units(body) + 140 <= target) {
    n += 1;
    const line = findings[(n - 1) % findings.length];
    body += `\n- Observation ${String(n).padStart(2, "0")}: ${line}`;
  }
  const pre = `${body}\n- Checksum `;
  const zeros = "0".repeat(Math.max(0, target - utf16Units(pre) - 1));
  return `${pre}${zeros}\n${tail}`;
}

function makeIncidentReport(
  index: number,
  title: string,
  findings: readonly string[],
  witness: string
): WorkerReport {
  return {
    id: `report-${index}`,
    fileName: `incident-report-${index}.txt`,
    body: buildIncidentBody(title, findings, witness),
    witness,
  };
}

export const INCIDENT_REPORTS: readonly WorkerReport[] = [
  makeIncidentReport(
    1,
    "Cache eviction incident in the eu-west rollout",
    [
      "the warm cache began evicting keys far below its configured ceiling",
      "the retry burst lined up minute by minute with the eviction spikes",
      "no failed health check explained the traffic step during the window",
      "the eviction policy still reported its steady-state hit ratio",
      "worker logs showed the same request shape accepted before the burst",
      "the rollout marker matched the first minute of elevated evictions",
      "queue depth stayed flat while the cache churn tripled",
      "the incident window closed as soon as the rollout was held",
    ],
    "WITNESS-INK4-ALPHA-7731"
  ),
  makeIncidentReport(
    2,
    "Deploy rollback incident on the ingest tier",
    [
      "the ingest tier started dropping batches two deploys after the freeze",
      "the rollback marker landed exactly on the first dropped batch",
      "the health endpoint kept reporting green through the whole drop",
      "the batch retry queue doubled before the operator noticed the lag",
      "no schema migration ran between the last green deploy and the drop",
      "the drained batches all carried the same oversized header block",
      "the tier recovered fully within one minute of the rollback",
      "the post-incident diff pointed at a single serialization change",
    ],
    "WITNESS-INK4-BRAVO-4419"
  ),
  makeIncidentReport(
    3,
    "Queue backlog incident on the notification path",
    [
      "the notification queue backed up while its producers stayed quiet",
      "one slow consumer held the lease pool far past its normal cycle",
      "the retry lane replayed stale events and inflated the backlog",
      "the dashboard showed green saturation for every other lane",
      "the backlog cleared the moment the slow consumer was fenced off",
      "the lease timeout setting had drifted from the reviewed value",
      "no provider outage matched the timing of the stall",
      "the follow-up alert confirmed no notifications were lost",
    ],
    "WITNESS-INK4-CIPHER-9157"
  ),
  makeIncidentReport(
    4,
    "Certificate expiry incident on the edge tier",
    [
      "handshake failures clustered on one edge point of presence",
      "the certificate chain expired an hour before the first failure",
      "the auto-renew job had completed but never pushed to that edge",
      "traffic steering kept sessions pinned to the stale certificate",
      "the failure count fell to zero right after the manual rotation",
      "no other region showed the same handshake signature",
      "the renewal audit log was missing the push step entirely",
      "the monitor now alerts on push freshness, not on expiry alone",
    ],
    "WITNESS-INK4-DALTON-2680"
  ),
];

export const INCIDENT_WITNESSES: readonly string[] = INCIDENT_REPORTS.map(
  (r) => r.witness
);

function restatementTask(fileName: string): string {
  return (
    `Open ${fileName} in this workspace and reply with its complete ` +
    "contents verbatim, every line exactly as stored, including the final " +
    "WITNESS line. Add no commentary."
  );
}

/**
 * Parent prompt for the incident case. It deliberately never names
 * `subagent_result`: which retrieval surface the parent picks is the whole
 * measurement, and pre-naming it would contaminate the A/B variable. The
 * witnesses exist only in the workspace files the workers restate, so the
 * parent cannot answer from its own prompt.
 */
export const INCIDENT_PARENT_PROMPT =
  "Spawn four sub-agents, one per numbered task below, each with wait:true, " +
  "and issue all four spawn calls in a single turn.\n\n" +
  INCIDENT_REPORTS.map(
    (r, i) => `Task ${String(i + 1)}: "${restatementTask(r.fileName)}"`
  ).join("\n") +
  "\n\nAfter all four sub-agents complete, answer with a numbered list of " +
  "the four WITNESS tokens, one per report, exactly as each report spells " +
  "it. The short completion handoff may be condensed; when it does not " +
  "contain a report's WITNESS line, retrieve that task's saved full report " +
  "before answering. Do not answer from the workspace files themselves — " +
  "only from the reports the sub-agents returned.";

function buildPagedBody(): string {
  const lines: string[] = [];
  // Line length is chosen so the first raw page is cut by the code-unit
  // budget, not only the 200-line edge: the tail witness must sit beyond
  // whichever bound trips first.
  for (let i = 1; i <= 228; i += 1) {
    lines.push(
      `PAGE ${String(i).padStart(3, "0")}: counter sample, steady state, no anomalies.`
    );
  }
  lines[2] = "HEAD-WITNESS-INKP-1102 anchors the start of the paged report.";
  lines[226] = "TAIL-WITNESS-INKP-9902 sits beyond the first 200-line window.";
  lines.push("END OF PAGED REPORT.");
  return `${lines.join("\n")}\n`;
}

export const PAGED_REPORT: WorkerReport = {
  id: "paged-1",
  fileName: "paged-report.txt",
  body: buildPagedBody(),
  witness: "TAIL-WITNESS-INKP-9902",
};

export const PAGED_HEAD_WITNESS = "HEAD-WITNESS-INKP-1102";

export const PAGED_PARENT_PROMPT =
  'Spawn one sub-agent with this task text: "' +
  restatementTask(PAGED_REPORT.fileName) +
  '". After it completes, retrieve the saved full report for that task — ' +
  "it is longer than a single read window — and answer with the exact " +
  "WITNESS token from the report's final line.";

export const STATUS_ONLY_PROMPT =
  'Spawn one sub-agent with wait:false and this task text: "Reply with ' +
  'exactly: SUBAGENT-STATUS-PING". Then poll its status with ' +
  "`subagent_result` using only the `task_id` — never pass `tmp_path`, and " +
  "do not read any report file. Finish by stating the final status you " +
  "observed.";

export const WAIT_FALSE_PROMPT =
  'Spawn one sub-agent with wait:false and this task text: "Reply with ' +
  'exactly: SUBAGENT-WAITFALSE-TOKEN-5566". While the task is still ' +
  "running, poll status with `subagent_result` using only the `task_id`. " +
  "Do not attempt any report read before the task completes; after it " +
  "completes you may read the saved report and quote the token.";

export const SCENE_IMAGE_FILE_NAME = "scene.png";

/** Minimal valid 8x8 fully-red PNG, synthesized for the image control. */
export const SCENE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

export const IMAGE_INPUT_PROMPT =
  "The workspace contains an image file named scene.png. Inspect the image " +
  "with the image-reading tool and answer with its dominant color. Do not " +
  "spawn sub-agents.";

/* ------------------------- A/B arm wording (verbatim) ------------------------- */

/** Tail of the spawn_subagent descriptionPrefix, both arms. */
export const ARM_B_SPAWN_TAIL =
  "When the short handoff is not enough, use `subagent_result` to read the " +
  "full worker report: pass the receipt's `task_id` and the pad-relative " +
  "`tmp_path` (for example `final.md`, taken from the receipt's " +
  "`output_path`); `tmp_root` stays diagnostic metadata. ";
export const ARM_A_SPAWN_TAIL =
  "Use `subagent_result` only for an explicit status query. ";

/** Final sentence of the spawn_subagent `wait` field description, both arms. */
export const ARM_B_WAIT_SENTENCE =
  "While the task runs, use subagent_result to poll status; once it " +
  "completes, use subagent_result with the receipt's task_id and the " +
  "pad-relative tmp_path (for example final.md, taken from the receipt's " +
  "output_path) to read the full report.";
export const ARM_A_WAIT_SENTENCE =
  "Use subagent_result only for an explicit status query.";

/** Coordinator-segment parenthetical, both arms (present only on surfaces
 *  that inject the coordinator segment; the default assembly moved this
 *  guidance into the tool description). */
export const ARM_B_COORDINATOR_PARENTHETICAL =
  "(For wait:false in chat/tui/serve, terminal completion wakes a silent " +
  "run through the host mailbox/subscription; while a task runs, use " +
  "subagent_result to poll status, and once it completes, use " +
  "subagent_result with the receipt's `task_id` and the pad-relative " +
  "`tmp_path` (for example `final.md`, taken from the receipt's " +
  "`output_path`) to read the full report.)";
export const ARM_A_COORDINATOR_PARENTHETICAL =
  "(For wait:false in chat/tui/serve, terminal completion wakes a silent " +
  "run through the host mailbox/subscription; use subagent_result only " +
  "for an explicit status query.)";

/**
 * Targeted segment swap for the A/B presentation seam. A miss is a premise
 * break, not a silent no-op: if the live text no longer carries the segment,
 * the two arms would not differ in exactly one variable, so the paired
 * comparison must stop rather than measure a fabricated arm.
 */
export function armSwap(
  text: string,
  from: string,
  to: string,
  label: string
): string {
  if (!text.includes(from)) {
    throw new Error(
      `A/B seam premise broken for ${label}: live text does not contain ` +
        `the expected segment; the paired comparison is invalid.`
    );
  }
  return text.split(from).join(to);
}

/* ------------------------------- validators ------------------------------- */

/**
 * Each report sits in the band the incident scenario needs: exactly the pinned
 * size, below the fold limit and the pad line window (so the receipt is a real
 * folded short handoff, not a terminal), and above the short handoff's reach
 * (so the witness cannot ride it).
 */
function sizeWithinBand(report: WorkerReport): string[] {
  const units = utf16Units(report.body);
  const v: string[] = [];
  if (units !== INCIDENT_REPORT_UNITS) {
    v.push(
      `${report.id}: body is ${units} units, want ${INCIDENT_REPORT_UNITS}`
    );
  }
  if (units >= TRUNCATION_LIMIT)
    v.push(`${report.id}: body reaches fold limit`);
  if (lineCount(report.body) >= PAD_ROSTER_LINE_LIMIT) {
    v.push(
      `${report.id}: body reaches the ${PAD_ROSTER_LINE_LIMIT}-line pad window`
    );
  }
  if (units <= SUMMARY_LIMIT) {
    v.push(`${report.id}: witness band fits inside the short handoff`);
  }
  return v;
}

/**
 * The witness must be the report's final line and must be unreachable from the
 * folded handoff — otherwise the parent could answer the incident prompt from
 * the receipt alone and the retrieval choice would not be measured.
 */
function witnessIsFinalAndUnreachable(report: WorkerReport): string[] {
  const v: string[] = [];
  if (!report.body.endsWith(`WITNESS: ${report.witness}\n`)) {
    v.push(`${report.id}: witness is not the final line`);
  }
  if (report.body.slice(0, SUMMARY_LIMIT).includes(report.witness)) {
    v.push(`${report.id}: witness reachable from the folded handoff`);
  }
  return v;
}

/**
 * Cross-report distinctness: each witness appears in exactly one body, so a
 * parent quote is attributable to a single task's retrieval.
 */
function witnessesAreMutuallyExclusive(
  reports: readonly WorkerReport[]
): string[] {
  const v: string[] = [];
  const unique = new Set(reports.map((r) => r.witness));
  if (unique.size !== reports.length) {
    v.push("witnesses are not pairwise distinct");
  }
  for (const a of reports) {
    for (const b of reports) {
      if (a !== b && b.body.includes(a.witness)) {
        v.push(`${b.id} leaks witness of ${a.id}`);
      }
    }
  }
  return v;
}

/**
 * Incident-4 scenario shape, as the shared witness both halves bind to.
 * Returns violation strings (empty = the shape holds); throwing here would
 * couple consumers to a failure style, so the offline test asserts the
 * empty array and the real-model test can reuse the same check as a premise.
 */
export function validateIncident4Shape(): string[] {
  const v: string[] = [];
  if (INCIDENT_REPORTS.length !== 4) v.push("expected exactly 4 reports");
  for (const r of INCIDENT_REPORTS) {
    v.push(...sizeWithinBand(r), ...witnessIsFinalAndUnreachable(r));
  }
  v.push(...witnessesAreMutuallyExclusive(INCIDENT_REPORTS));
  return v;
}

/** Paged-report scenario shape: tail witness beyond every first window. */
export function validatePagedShape(): string[] {
  const v: string[] = [];
  const body = PAGED_REPORT.body;
  if (lineCount(body) <= PAD_ROSTER_LINE_LIMIT) {
    v.push(`paged body must exceed ${PAD_ROSTER_LINE_LIMIT} lines`);
  }
  const lines = body.split("\n");
  const tailLine = lines.findIndex((l) => l.includes(PAGED_REPORT.witness));
  if (tailLine + 1 <= PAD_ROSTER_LINE_LIMIT) {
    v.push("tail witness must sit beyond the first line window");
  }
  const tailUnits = utf16Units(lines.slice(0, tailLine).join("\n"));
  if (tailUnits <= PAD_PAGE_CODE_UNIT_BUDGET) {
    v.push("tail witness must also sit beyond the first code-unit page");
  }
  const headLine = lines.findIndex((l) => l.includes(PAGED_HEAD_WITNESS));
  if (headLine < 0 || headLine >= tailLine) {
    v.push("head witness must precede the tail witness for order checks");
  }
  if (utf16Units(body) >= TRUNCATION_LIMIT) {
    v.push("paged body stays below the fold limit (paging, not folding)");
  }
  return v;
}
