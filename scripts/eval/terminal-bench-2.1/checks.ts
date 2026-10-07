/**
 * Machine-readable required checks that gate any `usable` verdict.
 *
 * Why it exists (issue 1219 requirement 4): #1212's reports ended in prose. A reader could
 * not tell a clean stop from a driver that had been killed mid-attempt, nor whether the
 * stimuli had actually settled. A verdict that says `usable` must be mechanically
 * conditional on checks, so a failed required check prevents it — the check list, not the
 * narrative, is what authorizes the claim.
 *
 * Each check answers one question a reviewer would otherwise have to take on trust:
 *   run-measured      did the run measure the frozen list at all, and no more than it accepted?
 *   clean-stop        did every dispatched attempt settle (no unfinished lifecycle rows)?
 *   stimuli-settled   did the driver dispatch exactly the stimuli it accepted?
 *   evidence-complete did every attempt retain the evidence it claimed?
 *   protocol-compliance was the protocol actually the one that was frozen?
 */
import type { EvidenceAssessment } from "./evidence.js";

export type CheckId =
  | "run-measured"
  | "clean-stop"
  | "stimuli-settled"
  | "evidence-complete"
  | "protocol-compliance";

export interface CheckResult {
  readonly id: CheckId;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProtocolCompliance {
  readonly frozenBeforeAnyOutcome: boolean;
  readonly oneAttemptPerSlot: boolean;
  readonly noRetries: boolean;
  readonly originalGraderUsed: boolean;
}

export interface ChecksInput {
  /** Ledger rows left in `intent` phase with no finalization. */
  readonly unfinishedAttempts: number;
  /** Unparseable ledger lines, i.e. evidence of a kill mid-append. `null` = never read. */
  readonly tornLedgerLines: number | null;
  /** Slots the frozen manifest declared — the denominator this run was asked to measure. */
  readonly declaredSlots: number;
  /** Attempts the run actually produced. Gate records are not attempts and are not counted. */
  readonly attemptedStimuli: number;
  readonly acceptedStimuli: number;
  readonly settledStimuli: number;
  readonly evidence: ReadonlyArray<EvidenceAssessment>;
  readonly protocol: ProtocolCompliance;
  /** Explicit pre-dispatch gate failures; visible, never folded into the attempt count. */
  readonly gateFailures: number;
}

export interface ChecksReport {
  readonly checks: ReadonlyArray<CheckResult>;
  /** True only when every required check passed. */
  readonly usable: boolean;
  readonly failedCheckIds: ReadonlyArray<CheckId>;
}

/**
 * The floor under the run, and its ceiling. Every other check is an equality or an emptiness test
 * over what the run produced, so a run that produced NOTHING satisfied all of them vacuously: an
 * all-excluded run reported `usable` and `unconditional` with zero tokens. This check refuses both
 * degenerate readings — a declared slot list that produced no attempt at all, and a settlement
 * count that exceeds what the run accepted (over-settlement is a protocol fault, so it is reported
 * here rather than absorbed by clamping the count to the accepted one).
 *
 * A manifest that declares ZERO slots is a genuinely empty run, not a void one: there was nothing to
 * measure, so there is nothing for this floor to fail.
 */
function runMeasured(input: ChecksInput): CheckResult {
  const voidRun = input.declaredSlots > 0 && input.attemptedStimuli === 0;
  const overSettled = input.settledStimuli > input.acceptedStimuli;
  const ok = !voidRun && !overSettled;
  const counts = `${input.attemptedStimuli} attempt(s) from ${input.declaredSlots} declared slot(s)`;
  return {
    id: "run-measured",
    ok,
    detail: voidRun
      ? `the manifest declared ${input.declaredSlots} slot(s) but the run produced ${input.attemptedStimuli} attempt(s); nothing was measured`
      : overSettled
        ? `${input.settledStimuli} stimuli settled against ${input.acceptedStimuli} accepted; a run may not settle more than it accepted`
        : `${counts}; ${input.settledStimuli}/${input.acceptedStimuli} stimuli settled within the accepted list`,
  };
}

function cleanStop(input: ChecksInput): CheckResult {
  // An unknown torn-line count cannot satisfy a "no torn line" claim: `null` means the ledger
  // was never read, so the run has no evidence either way about a mid-append kill. Treating
  // that as `0` would report a clean stop for a run whose integrity was never established.
  const torn = input.tornLedgerLines;
  const ok = input.unfinishedAttempts === 0 && torn === 0;
  return {
    id: "clean-stop",
    ok,
    detail: ok
      ? "every dispatched attempt settled and the ledger has no torn line"
      : torn === null
        ? `${input.unfinishedAttempts} unsettled attempt(s), and the ledger was never read so torn lines are unknown`
        : `${input.unfinishedAttempts} unsettled attempt(s), ${torn} torn ledger line(s)`,
  };
}

function stimuliSettled(input: ChecksInput): CheckResult {
  const ok = input.settledStimuli === input.acceptedStimuli;
  return {
    id: "stimuli-settled",
    ok,
    detail:
      `${input.settledStimuli}/${input.acceptedStimuli} accepted stimuli settled` +
      (input.gateFailures > 0
        ? `; ${input.gateFailures} pre-dispatch gate failure(s) excluded`
        : ""),
  };
}

function evidenceComplete(input: ChecksInput): CheckResult {
  const failed = input.evidence.filter(
    (assessment) => assessment.status !== "complete"
  );
  return {
    id: "evidence-complete",
    ok: failed.length === 0,
    detail:
      failed.length === 0
        ? `all ${input.evidence.length} attempt(s) retained complete evidence`
        : `${failed.length}/${input.evidence.length} attempt(s) have evidence failures: ` +
          failed
            .map((assessment) =>
              assessment.failures.map((failure) => failure.code).join("+")
            )
            .join("; "),
  };
}

function protocolCompliance(input: ChecksInput): CheckResult {
  const broken = Object.entries(input.protocol)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  return {
    id: "protocol-compliance",
    ok: broken.length === 0,
    detail:
      broken.length === 0
        ? "the frozen protocol was followed"
        : `protocol clauses violated: ${broken.join(", ")}`,
  };
}

/** Evaluate every required check. All five are required; none is advisory. */
export function evaluateChecks(input: ChecksInput): ChecksReport {
  const checks: CheckResult[] = [
    runMeasured(input),
    cleanStop(input),
    stimuliSettled(input),
    evidenceComplete(input),
    protocolCompliance(input),
  ];
  const failedCheckIds = checks
    .filter((check) => !check.ok)
    .map((check) => check.id);
  return { checks, usable: failedCheckIds.length === 0, failedCheckIds };
}

/**
 * An UNCONDITIONAL `usable` verdict is authorized only by a clean report. Any failed
 * required check returns a conditional verdict that names what is missing, so a report can
 * never read as clean while a check is red.
 */
export function usableVerdict(report: ChecksReport): "usable" | "not-usable" {
  return report.usable ? "usable" : "not-usable";
}

/** True only when a verdict may be stated unconditionally. */
export function isUnconditionallyUsable(report: ChecksReport): boolean {
  return report.usable && report.failedCheckIds.length === 0;
}
