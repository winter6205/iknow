import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeDir } from "./artifacts.ts";
import { loadCases } from "./catalog.ts";
import {
  armRoots,
  compareReports,
  comparisonPath,
  readPersistedReport,
} from "./compare.ts";
import { InvalidInputFailure, isEvalFailure } from "./failures.ts";
import type { FailurePhase } from "./failures.ts";
import { validateBudget } from "./plan.ts";
import { buildReport, persistReport, reportPathFor } from "./report.ts";
import { DEFAULT_BUDGET, assertRoots, runSuiteOffline } from "./suite.ts";
import type { SuiteResult } from "./suite.ts";
import { IDENTITY_FIELDS, PERMITTED_IDENTITY_DIFF } from "./types.ts";
import type {
  AgentQaReport,
  Budget,
  CaseId,
  Comparison,
  CompareInput,
  IdentityField,
  TreatmentFactor,
} from "./types.ts";

/**
 * The operator's entry to the offline Agent QA mechanism: `run` the frozen catalog,
 * `report` a retained run root, `compare` two retained reports.
 *
 * The exit code describes the measurement, never a case's task verdict. A slot that
 * failed its oracles is admissible data and leaves the code at zero; a run whose
 * evidence is incomplete, halted, invalid, interrupted, or unaccounted for is not
 * measurement and must not read as success. Every number printed here comes from the
 * report the retained artifacts support — no denominator is recomputed by hand.
 */

const USAGE = `agent-qa — offline Agent QA mechanism (scripted provider, real engine)

  npx tsx scripts/eval/agent-qa/cli.ts run --root <dir> [flags]
  npx tsx scripts/eval/agent-qa/cli.ts report --root <dir> [flags]
  npx tsx scripts/eval/agent-qa/cli.ts compare --root <dir> --baseline <runId> \\
      --candidate <runId> --treatment <source|model|prompt|tool> [flags]

run      freezes the whole catalog into <dir>, dispatches the selected slots through
         the production engine against a scripted provider, then rebuilds and retains
         the report from the bytes that were left behind.
report   reads a run root and rebuilds its report. Dispatches nothing.
compare  reads two persisted reports and retains their difference under --root.
         Each run keeps its own root, so the candidate usually comes from
         --candidate-root. Dispatches nothing.

Flags
  --root <dir>            required, absolute, outside the repository. A run root is
                          write-once: a second run needs a fresh <dir>.
  --repo-root <dir>       the repository whose fixtures the catalog locks. Defaults to
                          the repository this file is checked out in.
  --case <caseId>         repeatable; dispatch only these slots. The frozen plan and
                          the denominator still hold all 20.
  --max-turns <n>         per-attempt turn ceiling (default ${DEFAULT_BUDGET.maxTurns}).
  --wall-ms <n>           per-attempt wall ceiling in ms (default ${DEFAULT_BUDGET.wallMs}).
  --provider-usage <v>    reported | absent. "absent" is the unknown-usage arm: it halts
                          dispatch after the first settled slot, whose slot stays in the
                          denominator.
  --persist               report only: also retain the rebuilt report, refused if this
                          run's report already exists.
  --candidate-root <dir>  compare only: the root the candidate arm was retained in.
                          Absent means --root. The difference is still written under
                          --root, and only the candidate's bytes are read elsewhere.
  --allow-diff <field>    compare only: repeatable; one identity field per occurrence,
                          naming what the treatment is allowed to move.
  --json                  print the report or comparison document instead of the summary.
  --help                  this text.

Exit codes
  0  the operation succeeded and the measurement it reports is admissible.
  1  artifacts were retained or read but the measurement is not admissible: a short
     roster, a halt, an invalid/interrupted/provider-error slot, unknown usage, or
     unconfirmed cleanup. A compare reads 1 when either arm falls short, because the
     difference is retained while the claim on it is not. A case's own verdict never
     changes this code.
  2  the command refused: malformed or conflicting input, a budget that cannot be
     applied, an unreadable or corrupt artifact, an incomparable pair. The typed
     failure's kind and phase are on stderr.
`;

type Subcommand = "run" | "report" | "compare";

const SUBCOMMANDS: readonly Subcommand[] = ["run", "report", "compare"];

/**
 * One flag set per command, so a `report --max-turns` is refused as the conflict it is
 * rather than being read and ignored. `json` and `persist` carry no value.
 */
const FLAGS: Readonly<Record<Subcommand, readonly string[]>> = {
  run: [
    "root",
    "repo-root",
    "case",
    "max-turns",
    "wall-ms",
    "provider-usage",
    "json",
  ],
  report: ["root", "persist", "json"],
  compare: [
    "root",
    "baseline",
    "candidate",
    "candidate-root",
    "treatment",
    "allow-diff",
    "json",
  ],
};

const VALUELESS: readonly string[] = ["json", "persist"];

/** Flags that may name more than one value; every other flag is single-valued. */
const REPEATABLE: readonly string[] = ["case", "allow-diff"];

const TREATMENTS: readonly TreatmentFactor[] = Object.keys(
  PERMITTED_IDENTITY_DIFF
) as TreatmentFactor[];

type Command =
  | {
      readonly sub: "run";
      readonly root: string;
      readonly repoRoot: string;
      readonly caseIds?: readonly CaseId[];
      readonly budget: Budget;
      readonly providerUsage: "reported" | "absent";
      readonly json: boolean;
    }
  | {
      readonly sub: "report";
      readonly root: string;
      readonly persist: boolean;
      readonly json: boolean;
    }
  | {
      readonly sub: "compare";
      readonly root: string;
      readonly baseline: string;
      readonly candidate: string;
      readonly candidateRoot?: string;
      readonly treatment: TreatmentFactor;
      readonly allowedDiff?: readonly IdentityField[];
      readonly json: boolean;
    };

/** Either a parsed command or the request to print the usage text. */
export type ParsedInvocation =
  | { readonly command: Command }
  | { readonly usage: true; readonly exitCode: number };

function refuse(diagnostic: string): never {
  // EXIT: the argv is not a command this entry can run; nothing is created and no
  // slot dispatches; the operator gets the typed diagnostic naming the input.
  throw new InvalidInputFailure(diagnostic);
}

/** The repository this entry point is checked out in — the catalog's fixture root. */
function checkoutRoot(): string {
  return realpathSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../..")
  );
}

function readFlags(
  sub: Subcommand,
  argv: readonly string[]
): Map<string, string[]> {
  const values = new Map<string, string[]>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      refuse(`${token} is not a flag; every input is --flag value`);
    }
    const flag = token.slice(2);
    if (!FLAGS[sub].includes(flag)) {
      refuse(
        `--${flag} does not belong to ${sub}; ${sub} takes ${FLAGS[sub].join(", ")}`
      );
    }
    if (VALUELESS.includes(flag)) {
      if (values.has(flag)) refuse(`--${flag} was given more than once`);
      values.set(flag, []);
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      refuse(`--${flag} is missing its value`);
    }
    if (!REPEATABLE.includes(flag) && values.has(flag)) {
      refuse(`--${flag} was given more than once; it takes one value`);
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
    index += 2;
  }
  return values;
}

function one(values: Map<string, string[]>, flag: string): string | undefined {
  return values.get(flag)?.[0];
}

function needed(
  values: Map<string, string[]>,
  sub: Subcommand,
  flag: string
): string {
  const value = one(values, flag);
  if (value === undefined) refuse(`${sub} needs --${flag}`);
  return value;
}

function rootOf(values: Map<string, string[]>, sub: Subcommand): string {
  const root = needed(values, sub, "root");
  if (!isAbsolute(root)) refuse(`--root ${root} is not an absolute path`);
  const resolved = resolve(root);
  // One rule for all three commands: `report` rebuilds a root `run` was forbidden to create
  // inside the tree, and `compare` retains its difference under this root, so a root that
  // lives in the repository is refused before a byte is read or written.
  assertRoots(resolved, checkoutRoot(), ROOT_PHASES[sub]);
  return resolved;
}

const ROOT_PHASES: Readonly<Record<Subcommand, FailurePhase>> = {
  run: "plan-validate",
  report: "report",
  compare: "compare",
};

function choice<T extends string>(
  sub: Subcommand,
  values: Map<string, string[]>,
  flag: string,
  allowed: readonly T[],
  fallback?: T
): T {
  const raw = values.has(flag) ? needed(values, sub, flag) : undefined;
  if (raw === undefined) {
    if (fallback === undefined) refuse(`${sub} needs --${flag}`);
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    refuse(`--${flag} ${raw} is outside ${allowed.join(" | ")}`);
  }
  return raw as T;
}

/**
 * The selection is checked against the registry before the run root exists: an id the
 * catalog cannot dispatch, a repeated id, and an empty name are input faults, and a
 * refused command owes the operator no directory.
 */
function selectionOf(values: Map<string, string[]>): CaseId[] | undefined {
  const requested = values.get("case");
  if (requested === undefined) return undefined;
  const known = new Set<CaseId>(loadCases().map((entry) => entry.caseId));
  const picked = new Set<CaseId>();
  for (const caseId of requested) {
    if (caseId.length === 0) refuse("--case was given an empty id");
    if (!known.has(caseId)) refuse(`--case ${caseId} is not in the catalog`);
    if (picked.has(caseId)) refuse(`--case ${caseId} was given more than once`);
    picked.add(caseId);
  }
  return requested;
}

function budgetOf(values: Map<string, string[]>): Budget {
  // A ceiling that is not a whole finite count reaches `validateBudget` and fails as an
  // unreadable or unenforceable budget, which is the typed fact the operator needs.
  return validateBudget({
    maxTurns: Number(one(values, "max-turns") ?? DEFAULT_BUDGET.maxTurns),
    wallMs: Number(one(values, "wall-ms") ?? DEFAULT_BUDGET.wallMs),
    inputTokens: null,
    outputTokens: null,
  });
}

export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const [sub, ...rest] = argv;
  if (sub === undefined) {
    // EXIT: no command was named, so nothing is read or written; usage is the answer.
    return { usage: true, exitCode: 2 };
  }
  if (sub === "--help" || sub === "help" || rest.includes("--help")) {
    return { usage: true, exitCode: 0 };
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    refuse(
      `${sub} is not a command; expected one of ${SUBCOMMANDS.join(" | ")}`
    );
  }
  const command = sub as Subcommand;
  const values = readFlags(command, rest);
  const json = values.has("json");

  if (command === "run") {
    const root = rootOf(values, command);
    const repoRoot = resolve(one(values, "repo-root") ?? checkoutRoot());
    // `rootOf` already proved the root is outside this checkout before the root could be
    // created; a declared `--repo-root` names a second tree the run must not write into.
    assertRoots(root, repoRoot);
    const cases = selectionOf(values);
    return {
      command: {
        sub: "run",
        root,
        repoRoot,
        ...(cases === undefined ? {} : { caseIds: cases }),
        budget: budgetOf(values),
        providerUsage: choice(
          command,
          values,
          "provider-usage",
          ["reported", "absent"],
          "reported"
        ),
        json,
      },
    };
  }
  if (command === "report") {
    return {
      command: {
        sub: "report",
        root: rootOf(values, command),
        persist: values.has("persist"),
        json,
      },
    };
  }
  return { command: compareCommandOf(values, json) };
}

/**
 * The compare arm's inputs. `--candidate-root` is validated as a root and not as a run
 * id: it names where bytes live, and a relative one names nothing.
 */
function compareCommandOf(
  values: Map<string, string[]>,
  json: boolean
): Command {
  const allowedDiff = values.get("allow-diff") ?? [];
  for (const field of allowedDiff) {
    if (!IDENTITY_FIELDS.includes(field as IdentityField)) {
      refuse(`--allow-diff ${field} is not an identity field`);
    }
  }
  const candidateRoot = one(values, "candidate-root");
  if (candidateRoot !== undefined && !isAbsolute(candidateRoot)) {
    refuse(`--candidate-root ${candidateRoot} is not an absolute path`);
  }
  return {
    sub: "compare",
    root: rootOf(values, "compare"),
    baseline: needed(values, "compare", "baseline"),
    candidate: needed(values, "compare", "candidate"),
    ...(candidateRoot === undefined
      ? {}
      : { candidateRoot: resolve(candidateRoot) }),
    treatment: choice("compare", values, "treatment", TREATMENTS),
    ...(allowedDiff.length === 0
      ? {}
      : { allowedDiff: allowedDiff as IdentityField[] }),
    json,
  };
}

/**
 * Whether what the run retained can be read as measurement at all. A failed case is
 * admissible data; a short, halted, invalid, interrupted, under-covered, unaccounted,
 * or uncleared run is not, and cannot be reported green.
 */
export function isAdmissible(report: AgentQaReport): boolean {
  return (
    report.measurementComplete &&
    report.fullCatalogCoverage &&
    report.conditionalScore !== null &&
    report.measurementCoverage === 1 &&
    report.attempts.every((attempt) => attempt.coverage === "complete") &&
    report.counts.notRun === 0 &&
    report.counts.invalid === 0 &&
    report.counts.unknown === 0 &&
    report.counts.interrupted === 0 &&
    report.counts.providerErrors === 0 &&
    report.usageTotals.usageComplete &&
    report.cleanupUnconfirmed.length === 0
  );
}

function scoreOf(value: number | null): string {
  // An undefined score keeps its own word: a dash or a zero would read as a measurement.
  return value === null ? "undefined (no valid attempt)" : value.toFixed(3);
}

function counterOf(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function summaryOf(report: AgentQaReport): string[] {
  const counts = report.counts;
  const lines = [
    `run ${report.runId}  evaluator ${report.identities.evaluator}  posture ${report.identities.posture}`,
    `counts  planned ${counts.planned}  executed ${counts.executed}  valid ${counts.valid}  ` +
      `passed ${counts.passed}  interrupted ${counts.interrupted}  ` +
      `provider-error ${counts.providerErrors}  invalid ${counts.invalid}  ` +
      `not-run ${counts.notRun}  unknown ${counts.unknown}`,
    `conditional score ${scoreOf(report.conditionalScore)}  ` +
      `measurement coverage ${report.measurementCoverage.toFixed(3)}  ` +
      `full catalog coverage ${report.fullCatalogCoverage ? "yes" : "no"}  ` +
      `measurement complete ${report.measurementComplete ? "yes" : "no"}`,
    `usage  in ${counterOf(report.usageTotals.inputTokens)}  ` +
      `out ${counterOf(report.usageTotals.outputTokens)}  ` +
      `wall ${counterOf(report.usageTotals.wallMs)}ms  ` +
      `complete ${report.usageTotals.usageComplete ? "yes" : "no (unknown usage blocks dispatch)"}`,
    `cleanup unconfirmed  ${
      report.cleanupUnconfirmed.length === 0
        ? "none"
        : report.cleanupUnconfirmed.join(", ")
    }`,
  ];
  for (const [state, caseIds] of Object.entries(report.roster)) {
    if (caseIds.length > 0)
      lines.push(`roster ${state}  ${caseIds.join(", ")}`);
  }
  for (const attempt of report.attempts) {
    lines.push(
      `  ${attempt.caseId.padEnd(12)} ${attempt.outcome.padEnd(12)} ` +
        `${attempt.validity.padEnd(15)} ${attempt.coverage.padEnd(9)} ` +
        `oracles ${attempt.oracleRefs.length}`
    );
  }
  lines.push(
    `capability claim  ${report.mayClaimCapability ? "yes" : "no"} — ` +
      "offline tooling evidence measures the mechanism, never a model."
  );
  return lines;
}

export function comparisonSummaryOf(comparison: Comparison): string[] {
  const changed = comparison.transitions.filter(
    (row) => row.baseline !== row.candidate
  );
  return [
    `comparison ${comparison.baselineRunId} → ${comparison.candidateRunId}  ` +
      `treatment ${comparison.treatmentFactor}`,
    `counts delta  ${Object.entries(comparison.countsDelta)
      .map(([field, value]) => `${field} ${value >= 0 ? "+" : ""}${value}`)
      .join("  ")}`,
    changed.length === 0
      ? `case outcomes  unchanged across ${comparison.transitions.length} cases`
      : `case outcomes  ${changed
          .map((row) => `${row.caseId} ${row.baseline}→${row.candidate}`)
          .join(", ")}`,
    `statistically established  ${comparison.statisticallyEstablished ? "yes" : "no"} — ` +
      "a difference between two arms is not a demonstrated gain.",
  ];
}

function emit(document: unknown, json: boolean, summary: string[]): void {
  process.stdout.write(
    json ? `${JSON.stringify(document, null, 2)}\n` : `${summary.join("\n")}\n`
  );
}

function finishRun(
  root: string,
  report: AgentQaReport,
  suite: SuiteResult,
  json: boolean
): number {
  // `persistReport` answers with the artifact's digest; the path is printed beside it so
  // an operator is pointed at bytes rather than at a hash of them.
  const digest = persistReport(root, report);
  emit(report, json, [
    ...summaryOf(report),
    `report retained at ${reportPathFor(root, report.runId)}`,
    `report digest ${digest}`,
  ]);
  if (suite.haltedAfter !== null) {
    process.stderr.write(
      `halted after ${suite.haltedAfter.caseId} (${suite.haltedAfter.reason}): ` +
        "the rest of the frozen roster stays planned and not run.\n"
    );
  }
  return gateOf(report, json);
}

function gateOf(report: AgentQaReport, json: boolean): number {
  if (isAdmissible(report)) return 0;
  if (!json) {
    process.stderr.write(
      "exit 1 — the measurement is not admissible; read the counts.\n"
    );
  }
  return 1;
}

/**
 * A difference is retained whichever arms produced it, but the exit code follows the
 * arms: a comparison drawn from a halted or short run must not read as a clean result.
 * The gate uses compare's own reader and its own root resolution, so what it judges is
 * exactly the pair of reports the difference was drawn from.
 */
function gateArms(input: CompareInput, json: boolean): number {
  const roots = armRoots(input);
  const arms = [
    readPersistedReport(roots.baselineRoot, input.baselineRunId),
    readPersistedReport(roots.candidateRoot, input.candidateRunId),
  ];
  const short = arms.filter((arm) => !isAdmissible(arm)).length;
  if (short === 0) return 0;
  if (!json) {
    process.stderr.write(
      `exit 1 — ${short} of 2 arms is not admissible measurement; ` +
        "the difference is retained, the claim on it is not.\n"
    );
  }
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedInvocation;
  try {
    parsed = parseInvocation(argv);
  } catch (error) {
    if (isEvalFailure(error)) {
      process.stderr.write(
        `${error.kind}@${error.phase}: ${error.diagnostic}\n\n${USAGE}`
      );
      return 2;
    }
    throw error;
  }
  if ("usage" in parsed) {
    process.stdout.write(USAGE);
    return parsed.exitCode;
  }

  const command = parsed.command;
  try {
    if (command.sub === "run") {
      makeDir(command.root, "plan-validate");
      const suite = await runSuiteOffline({
        root: command.root,
        repoRoot: command.repoRoot,
        ...(command.caseIds === undefined ? {} : { caseIds: command.caseIds }),
        budget: command.budget,
        providerUsage: command.providerUsage,
      });
      return finishRun(
        command.root,
        buildReport(suite.root),
        suite,
        command.json
      );
    }
    if (command.sub === "report") {
      const report = buildReport(command.root);
      const path = reportPathFor(command.root, report.runId);
      const digest = command.persist
        ? persistReport(command.root, report)
        : null;
      emit(report, command.json, [
        ...summaryOf(report),
        digest === null
          ? `read-only rebuild of ${path}; nothing dispatched, nothing written`
          : `report retained at ${path}`,
        ...(digest === null ? [] : [`report digest ${digest}`]),
      ]);
      return gateOf(report, command.json);
    }
    const input: CompareInput = {
      root: command.root,
      baselineRunId: command.baseline,
      candidateRunId: command.candidate,
      treatmentFactor: command.treatment,
      ...(command.allowedDiff === undefined
        ? {}
        : { allowedDiff: command.allowedDiff }),
      ...(command.candidateRoot === undefined
        ? {}
        : { candidateRoot: command.candidateRoot }),
    };
    const comparison = compareReports(input);
    emit(comparison, command.json, [
      ...comparisonSummaryOf(comparison),
      `comparison retained at ${comparisonPath(command.root, comparison)}`,
    ]);
    return gateArms(input, command.json);
  } catch (error) {
    if (isEvalFailure(error)) {
      process.stderr.write(
        `${error.kind}@${error.phase}: ${error.diagnostic}\n`
      );
      process.stderr.write(
        "exit 2 — refused; retained bytes were not replaced.\n"
      );
      return 2;
    }
    process.stderr.write(`${String(error)}\n`);
    // EXIT: an untyped throw means the lifecycle broke outside its own contract; the
    // refusal code still holds because no admissible measurement was reported.
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith(join("agent-qa", "cli.ts"));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 2;
    }
  );
}
