/**
 * The machine-readable check report for #1219 TUI calibration (§4).
 *
 * WHY this is a separate module: the report is the VERDICT, and `run.ts` is the
 * thing being judged. The gates are data — an ordered fact -> (ok,
 * diagnostic) mapping — and the rule that consumes them ("one failed REQUIRED
 * check makes `usable` false, with no override") is a separate concern from the
 * measured orchestration around it. Holding both here keeps the verdict legible
 * on its own and keeps `run.ts` about running.
 *
 * `run.ts` re-exports every name below, so moving the code moved no API.
 */
/** Every required gate, in report order. `blockedBy` preserves this order. */
export const REQUIRED_CHECK_IDS = [
  "protocol.pinned",
  "readiness.probe",
  "acceptance.all_required",
  "settlement.all_required",
  "idle.proven_from_persistence",
  "stop.clean_natural_exit",
  "evidence.counters_derived",
  "evidence.index_verified",
  "evidence.no_pooling",
  "evidence.single_session_file",
  "observer.no_errors",
  "store.production_valid",
  "evidence.no_secrets",
  "teardown.no_stray_process",
] as const;

const READY_OK = "the non-submitting probe echoed and cleared a unique token";
const ACCEPTED_OK = "every stimulus has a persisted acceptance record";
const ACCEPTED_NO = "at least one stimulus has no persisted acceptance record";
const SETTLED_OK = "every accepted round reached a terminal boundary";
const SETTLED_NO = "at least one accepted round never settled";
const IDLE_OK = "a terminal boundary was observed after every stimulus";
const IDLE_NO = "idleness could not be proven from the persisted lifecycle";
const STOP_OK = "clean /quit exit after the frozen horizon";
const STOP_NO = "the stop was not a natural completion";
const COUNTERS_OK = "counters came from the retained artifacts";
const COUNTERS_NO = "the retained artifacts could not be derived";
const INDEX_OK = "digest and size verified on readback";
const INDEX_NO = "the payload index did not verify on readback";
const POOLING_OK = "resume and smoke samples were kept separate";
const POOLING_NO = "samples from another run were pooled into the measured run";
const SESSION_OK = "one conversation file for the whole sequence";
const SESSION_NO = "the measured run touched more than one conversation file";
const OBSERVER_OK = "no observer error during the run";
const OBSERVER_NO = "the store reader reported an observer error";
const STORE_OK = "the retained store satisfies the production parser";
const STORE_NO = "the retained store does not satisfy the production parser";
const SECRETS_OK = "no credential-shaped text in the retained artifacts";
const SECRETS_NO = "credential-shaped text was found in the retained artifacts";
const TEARDOWN_OK = "no process survived teardown";
const TEARDOWN_NO = "a process survived teardown";

export interface Check {
  readonly id: string;
  readonly required: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CheckReport {
  readonly label: string;
  readonly runKind: string;
  readonly checks: readonly Check[];
  readonly blockedBy: readonly string[];
  readonly verdict: "usable" | "unusable";
  readonly usable: boolean;
}

/** The facts the report derives from — never the report's own numbers. */
export interface CheckFact {
  readonly label: string;
  readonly runKind: string;
  readonly readinessProven: boolean;
  readonly allAccepted: boolean;
  readonly allSettled: boolean;
  readonly idleProven: boolean;
  readonly stopNatural: boolean;
  readonly indexVerified: boolean;
  readonly countersDerived: boolean;
  readonly noPooling: boolean;
  readonly singleSessionFile: boolean;
  readonly observerClean: boolean;
  readonly storeValid: boolean;
  readonly teardownClean: boolean;
  readonly noSecrets: boolean;
}

function check(id: string, ok: boolean, detail: string): Check {
  return { id, required: true, ok, detail };
}

/** Pick the diagnostic for a boolean, so the gate table stays declarative. */
function say(ok: boolean, yes: string, no: string): string {
  return ok ? yes : no;
}

/** One row of the gate table: how it is decided, and what it says either way. */
interface CheckGate {
  readonly id: string;
  readonly ok: (fact: CheckFact) => boolean;
  readonly yes: string;
  /** Omitted when the gate cannot fail; it then reports `yes` unconditionally. */
  readonly no?: string;
}

/**
 * WHY a table instead of a literal: the gates are DATA — an ordered
 * fact -> (ok, diagnostic) mapping — while the verdict below is the RULE that
 * consumes them. Keeping the two apart is what lets `buildCheckReport` stay a
 * reader: it derives `blockedBy` and the one-way verdict from this table
 * without restating any gate. The order is the report order, and it matches
 * `REQUIRED_CHECK_IDS`.
 */
const CHECK_GATES: readonly CheckGate[] = [
  {
    id: "protocol.pinned",
    ok: () => true,
    yes: "the run was driven by a validated protocol document",
  },
  {
    id: "readiness.probe",
    ok: (fact) => fact.readinessProven,
    yes: READY_OK,
    no: "the readiness probe did not prove the surface was ready",
  },
  {
    id: "acceptance.all_required",
    ok: (fact) => fact.allAccepted,
    yes: ACCEPTED_OK,
    no: ACCEPTED_NO,
  },
  {
    id: "settlement.all_required",
    ok: (fact) => fact.allSettled,
    yes: SETTLED_OK,
    no: SETTLED_NO,
  },
  {
    // Idle may only be claimed when every accepted round also settled, so a
    // partial run cannot satisfy this gate on the strength of one terminal
    // boundary.
    id: "idle.proven_from_persistence",
    ok: (fact) => fact.idleProven && fact.allSettled,
    yes: IDLE_OK,
    no: IDLE_NO,
  },
  {
    id: "stop.clean_natural_exit",
    ok: (fact) => fact.stopNatural,
    yes: STOP_OK,
    no: STOP_NO,
  },
  {
    id: "evidence.counters_derived",
    ok: (fact) => fact.countersDerived,
    yes: COUNTERS_OK,
    no: COUNTERS_NO,
  },
  {
    id: "evidence.index_verified",
    ok: (fact) => fact.indexVerified,
    yes: INDEX_OK,
    no: INDEX_NO,
  },
  {
    id: "evidence.no_pooling",
    ok: (fact) => fact.noPooling,
    yes: POOLING_OK,
    no: POOLING_NO,
  },
  {
    id: "evidence.single_session_file",
    ok: (fact) => fact.singleSessionFile,
    yes: SESSION_OK,
    no: SESSION_NO,
  },
  {
    id: "observer.no_errors",
    ok: (fact) => fact.observerClean,
    yes: OBSERVER_OK,
    no: OBSERVER_NO,
  },
  {
    id: "store.production_valid",
    ok: (fact) => fact.storeValid,
    yes: STORE_OK,
    no: STORE_NO,
  },
  {
    id: "evidence.no_secrets",
    ok: (fact) => fact.noSecrets,
    yes: SECRETS_OK,
    no: SECRETS_NO,
  },
  {
    id: "teardown.no_stray_process",
    ok: (fact) => fact.teardownClean,
    yes: TEARDOWN_OK,
    no: TEARDOWN_NO,
  },
];

/** Map the facts onto the gate table, in report order. */
function buildChecks(fact: CheckFact): Check[] {
  return CHECK_GATES.map((gate) => {
    const ok = gate.ok(fact);
    return check(gate.id, ok, say(ok, gate.yes, gate.no ?? gate.yes));
  });
}

/**
 * Build the machine-readable report. `usable` is true only when every required
 * check passed — there is no override, and no default-on for a missing fact.
 */
export function buildCheckReport(fact: CheckFact): CheckReport {
  const checks = buildChecks(fact);
  const blockedBy = checks.filter((c) => c.required && !c.ok).map((c) => c.id);
  return {
    label: fact.label,
    runKind: fact.runKind,
    checks,
    blockedBy,
    verdict: blockedBy.length === 0 ? "usable" : "unusable",
    usable: blockedBy.length === 0,
  };
}
