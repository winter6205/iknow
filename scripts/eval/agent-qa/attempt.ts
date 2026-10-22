/**
 * Attempt lifecycle: reserve → claim → intent → dispatch → oracles → immutable
 * artifacts → hash index → fresh-reader reconstruction.
 *
 * The ordering is the contract. The claim lands before anything dispatches, so a
 * duplicate attempt costs zero provider calls; the intent lands before the first
 * model step, so a crash mid-run still leaves something a reader can attribute; and
 * reconstruction reads the retained trace through the production reader, so the
 * claim "this attempt is reproducible" is witnessed rather than asserted.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { resolveConversationTodoPath } from "../../../src/harness/aci/tools/todo-write.ts";
import { createJsonlTraceReader } from "../../../src/traceserver/reader.ts";

import {
  claimFile,
  makeDir,
  reserveDir,
  writeHashIndex,
  writeJsonOnce,
} from "./artifacts.ts";
import {
  ArtifactFailure,
  InvalidInputFailure,
} from "./failures.ts";
import { dispatchAttempt, SESSION_LEDGER_BASE, surfaceFor } from "./dispatch.ts";
import type { DispatchResult } from "./dispatch.ts";
import { declaredLimits } from "./plan.ts";
import { allSatisfied, anyUnreadable, evaluateOracle } from "./oracle.ts";
import { attemptDirOf, coverageOf, reconstructAttempt } from "./retained.ts";
import type {
  BytesExpectation,
  EffectExpectation,
  OracleTarget,
} from "./oracle.ts";
import { DENIAL_RECORD_PREFIXES } from "./catalog.ts";
import {
  ATTEMPT_FILE,
  ATTEMPTS_DIR,
  CLAIM_FILE,
  DISPATCH_FILE,
  EFFECT_RESULT_SUFFIX,
  INTENT_FILE,
  ORACLES_DIR,
  OUTCOME_FILE,
  REPORT_SCHEMA_VERSION,
  REQUIRED_ARTIFACTS,
  TRACE_DIR,
  USAGE_FILE,
  type AgentQaCase,
  type AttemptRecord,
  type CaseReference,
  type EffectPrefix,
  type OracleResult,
  type RunPlan,
  type TaskOutcome,
  type Validity,
} from "./types.ts";

const HOLDER = "agent-qa-attempt";

/** Reads one effect entry through one prefix of the closed grammar, or finds nothing. */
function effectValue(entry: string, prefix: EffectPrefix): string | null {
  return entry.startsWith(prefix) ? entry.slice(prefix.length) : null;
}

/**
 * A placeholder root the offline runner cannot construct (`<worktree>`, `<main>`) names
 * an effect no filesystem in this attempt can state. It is never read as an absence: an
 * address nobody can build is `unreadable`, so the slot cannot pass on it.
 */
function unresolved(path: string): boolean {
  return path.includes("<") && path.includes(">");
}

/** The ledger directory this attempt's production `todo_write` will write into. */
function ledgerDirOf(workspaceRoot: string, conversationId: string): string {
  const path = resolveConversationTodoPath({
    projectDir: join(workspaceRoot, SESSION_LEDGER_BASE),
    conversationId,
  });
  return relative(workspaceRoot, dirname(path));
}

/**
 * `<todoDir>` is a per-attempt root, resolved with the production path resolver rather
 * than restated here: the ledger location is the writer's fact, not the runner's guess.
 * The swap reaches every address the attempt can observe — declared effects, seeds, the
 * turns the user states, and the tool arguments the scripted model will send — because a
 * partially resolved case would dispatch a literal placeholder the product cannot open.
 */
function resolvePlaceholders(aCase: AgentQaCase, ledgerDir: string): AgentQaCase {
  const swap = (text: string): string => text.replaceAll("<todoDir>", ledgerDir);
  const swapValue = (value: unknown): unknown => {
    if (typeof value === "string") return swap(value);
    if (Array.isArray(value)) return value.map(swapValue);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
          key,
          swapValue(inner),
        ])
      );
    }
    return value;
  };
  return {
    ...aCase,
    seed: aCase.seed.map((entry) => ({ ...entry, path: swap(entry.path) })),
    allowedEffects: aCase.allowedEffects.map(swap),
    forbiddenEffects: aCase.forbiddenEffects.map(swap),
    turns: aCase.turns.map(swap),
    oracles: aCase.oracles.map((oracle) =>
      oracle.owns === undefined ? oracle : { ...oracle, owns: oracle.owns.map(swap) }
    ),
    scripted: aCase.scripted.map((step) =>
      step.kind === "tool"
        ? { ...step, input: swapValue(step.input) as typeof step.input }
        : { ...step, text: swap(step.text) }
    ),
    ...(aCase.acceptance === undefined
      ? {}
      : { acceptance: { ...aCase.acceptance, command: swap(aCase.acceptance.command) } }),
  };
}

/** The bytes a seeded file must still hold; null when the path was never seeded. */
function seedBytes(aCase: AgentQaCase, path: string): string | null {
  const seed = aCase.seed.find((entry) => entry.path === path);
  if (seed === undefined || seed.mode === "mkdir") return null;
  return seed.contents;
}

function requiredBytes(aCase: AgentQaCase): BytesExpectation[] {
  return aCase.allowedEffects
    .map((entry) => effectValue(entry, "bytes:"))
    .filter((value): value is string => value !== null)
    .map((pair) => {
      const split = pair.indexOf("=");
      return {
        path: split === -1 ? pair : pair.slice(0, split),
        contents: split === -1 ? "" : pair.slice(split + 1),
      };
    })
    .filter((entry) => !unresolved(entry.path));
}

function newPaths(aCase: AgentQaCase): string[] {
  return aCase.forbiddenEffects
    .map((entry) => effectValue(entry, "write:"))
    .filter((path): path is string => path !== null && !path.includes("*"))
    .filter((path) => !unresolved(path))
    .filter((path) => seedBytes(aCase, path) === null);
}

function unchangedEffects(aCase: AgentQaCase): EffectExpectation[] {
  const kept = aCase.allowedEffects
    .map((entry) => effectValue(entry, "unchanged:"))
    .filter((path): path is string => path !== null && !unresolved(path))
    .map((path) => ({
      path,
      expected: seedBytes(aCase, path) ?? "absent",
    }));
  return kept;
}

/**
 * One declared oracle becomes one structured target. `OracleDeclaration.evidence`
 * is prose (it is what a reviewer reads to judge the verdict), so the decidable part
 * is derived from the case's machine-readable effect lists, never parsed out of the
 * sentence. A kind with nothing declared stays `unreadable`: a missing expectation
 * cannot be satisfied, and it must never be defaulted into a pass.
 */
type TargetBase = {
  readonly oracleId: string;
  readonly evidence: string;
};

/**
 * The byte counterpart a declaration owes is read from the case's effect lists, never
 * from its wording: `bytes:` names the bytes that must land, `unchanged:` names a file
 * that must still hold its seed (or a path that must not exist), and an oracle that owns
 * neither grades the seeded files no earlier oracle claimed. A byte oracle pins a path
 * either way, so one file is never graded twice.
 */
function workspaceBytesTarget(
  base: TargetBase,
  aCase: AgentQaCase,
  ordinal: number
): OracleTarget | null {
  const targets = requiredBytes(aCase);
  const fresh = newPaths(aCase);
  const claims = unchangedEffects(aCase);
  const pinned = claims
    .filter((entry) => entry.expected !== "absent")
    .map((entry) => ({ path: entry.path, contents: entry.expected as string }));
  const missing = claims
    .filter((entry) => entry.expected === "absent")
    .map((entry) => entry.path);
  const kept = aCase.seed
    .filter((seed) => seed.mode !== "mkdir")
    .filter((seed) => !targets.some((entry) => entry.path === seed.path))
    .map((seed) => ({ path: seed.path, contents: seed.contents }));
  const required =
    ordinal === 0 && targets.length > 0 ? [...targets, ...pinned] : [...pinned, ...kept];
  const forbidden = [...fresh, ...missing];
  if (required.length === 0 && forbidden.length === 0) {
    // EXIT: the declaration states no byte the offline filesystem can state — an
    // empty byte set would read as a satisfied `every()` over nothing, so it is
    // recorded as unreadable instead; nothing owned; the slot cannot pass on it.
    return null;
  }
  return { ...base, kind: "workspace-bytes", required, forbidden };
}

function acceptanceTarget(base: TargetBase, aCase: AgentQaCase): OracleTarget | null {
  const acceptance = aCase.acceptance;
  if (acceptance === undefined) {
    // EXIT: the plan requires an acceptance run the case never declared a command for —
    // an exit code nobody observed cannot be a pass; nothing is owned.
    return null;
  }
  return {
    ...base,
    kind: "acceptance-run",
    command: acceptance.command,
    expectExit: acceptance.expectExit,
  };
}

function effectRecordTarget(base: TargetBase, aCase: AgentQaCase): OracleTarget | null {
  const tools = aCase.allowedEffects
    .map((entry) => effectValue(entry, "tool:"))
    .filter((value): value is string => value !== null);
  const stopped = aCase.allowedEffects
    .map((entry) => effectValue(entry, "stopped:"))
    .filter((value): value is string => value !== null);
  if (tools.length === 0 && stopped.length === 0) {
    // EXIT: the case declares neither a dispatch it expects to see nor a stop it
    // expects the run to end on — an oracle anchored on nothing reads as a satisfied
    // `every()` over an empty check list, so the slot is unreadable instead.
    return null;
  }
  const absent = aCase.forbiddenEffects
    .map((entry) => effectValue(entry, "tool:"))
    .filter((value): value is string => value !== null && !value.endsWith(EFFECT_RESULT_SUFFIX));
  const unresulted = aCase.forbiddenEffects.some(
    (entry) => entry.startsWith("tool:") && entry.endsWith(EFFECT_RESULT_SUFFIX)
  );
  return {
    ...base,
    kind: "effect-record",
    tools,
    expect: unresulted ? "no-recorded-result" : "attempted",
    ...(absent.length === 0 ? {} : { absentTools: absent }),
    ...(stopped.length === 0 ? {} : { stoppedOn: stopped[0] as string }),
  };
}

function permissionTarget(base: TargetBase, aCase: AgentQaCase): OracleTarget | null {
  const denied = aCase.allowedEffects
    .map((entry) => effectValue(entry, "denied:"))
    .filter((value): value is string => value !== null);
  if (denied.length === 0) {
    // EXIT: no blocked tool is declared — a permission oracle with no subject cannot
    // confirm a denial, so it reads as unreadable; nothing is owned.
    return null;
  }
  return {
    ...base,
    kind: "permission-record",
    deniedTool: denied[0] as string,
    prefixes: [...DENIAL_RECORD_PREFIXES],
    effects: unchangedEffects(aCase),
  };
}

/**
 * One oracle's view of the case: with `owns`, only the entries it declared it decides
 * reach the derivation; without it, every entry its kind can interpret does.
 */
function ownedView(aCase: AgentQaCase, owns: readonly string[] | undefined): AgentQaCase {
  if (owns === undefined) return aCase;
  const kept = (entries: readonly string[]): string[] => entries.filter((e) => owns.includes(e));
  return {
    ...aCase,
    allowedEffects: kept(aCase.allowedEffects),
    forbiddenEffects: kept(aCase.forbiddenEffects),
  };
}

function targetFor(
  caseReference: CaseReference,
  aCase: AgentQaCase,
  index: number
): OracleTarget | null {
  const declared = caseReference.oracles[index];
  if (declared === undefined) {
    // EXIT: the plan names an oracle the case does not carry — nothing can be read,
    // so the attempt cannot pass; no owned resource exists yet.
    return null;
  }
  const base: TargetBase = {
    oracleId: declared.oracleId,
    evidence: declared.evidence,
  };
  const view = ownedView(aCase, declared.owns);
  // The byte pairing is positional among the byte oracles, not among all oracles: a
  // case may lead with a record oracle, and the first byte oracle still owes the bytes
  // the declaration says must land.
  const byteOrdinal = caseReference.oracles
    .slice(0, index)
    .filter((entry) => entry.kind === "workspace-bytes").length;
  switch (declared.kind) {
    case "workspace-bytes":
      return workspaceBytesTarget(base, view, byteOrdinal);
    case "acceptance-run":
      return acceptanceTarget(base, view);
    case "effect-record":
      return effectRecordTarget(base, view);
    case "permission-record":
      return permissionTarget(base, view);
  }
}

function outcomeOf(results: readonly OracleResult[], validity: Validity): TaskOutcome {
  if (validity !== "valid") {
    // EXIT: an inadmissible measurement (interrupted, invalid, provider fault) is not
    // the model's verdict to win or lose; the retained evidence stays as written.
    return "undetermined";
  }
  if (results.length === 0) {
    // EXIT: no required oracle was evaluable — absence is not a pass; dispatch is
    // already finished, so only teardown remains.
    return "undetermined";
  }
  if (anyUnreadable(results)) return "undetermined";
  return allSatisfied(results) ? "passed" : "failed";
}

function intentRecord(
  plan: RunPlan,
  caseReference: CaseReference,
  attemptId: string,
  startedAt: number
): AttemptRecord {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    attemptId,
    runId: plan.runId,
    caseId: caseReference.caseId,
    fixtureDigest: caseReference.fixture.digest,
    startedAtEpochMs: startedAt,
    settledAtEpochMs: null,
    phase: "intent",
    outcome: "undetermined",
    validity: "not-run",
    coverage: "missing",
    posture: plan.posture,
    // The frozen budget, stated as nothing-observed: an intent that never dispatched
    // owes the same limit names a settled record does, or the roster of dimension 4
    // would depend on how far the run got.
    limits: declaredLimits(plan.budget),
    usage: {
      inputTokens: null,
      outputTokens: null,
      wallMs: null,
      usageComplete: false,
    },
    oracles: [],
    traceRef: null,
    failure: null,
    cleanup: { status: "not-applicable", owned: [] },
  };
}

/**
 * The retained trace is the evidence a reviewer re-reads, so it has to agree with the
 * record built from it: read the artifacts back through the production reader and
 * refuse the record when the trace shows no run.
 */
export function verifyTraceReconstruction(
  record: AttemptRecord,
  tracePath: string
): void {
  if (record.traceRef === null) {
    // EXIT: the record carries no trace reference — reconstruction has nothing to
    // resolve against, so the attempt is not verifiable; nothing to clean.
    throw new ArtifactFailure(
      "missing-reference",
      "artifact-read",
      `${record.attemptId} settled without a trace reference`
    );
  }
  const reader = createJsonlTraceReader({ filePath: tracePath });
  const turns = reader.query({ recordType: "turn", limit: 200 });
  const calls = reader.query({ recordType: "tool_call", limit: 200 });
  if (turns.total === 0 && calls.total === 0) {
    // EXIT: a retained trace holding neither a turn nor a tool row never happened —
    // the outcome cannot be reconstructed, so the attempt is refused, not rewritten.
    throw new ArtifactFailure(
      "artifact-corrupt",
      "artifact-read",
      `${record.attemptId} trace holds no reconstructable rows`
    );
  }
}

/**
 * Which provider arm one attempt dispatches under. `absent` is the unknown-usage arm:
 * it is a measurement choice, so it is never inferred from a case and never defaulted
 * into the reported arm by a reader.
 */
export type AttemptArm = {
  readonly providerUsage?: "reported" | "absent";
};

export async function runAttempt(
  root: string,
  plan: RunPlan,
  caseReference: CaseReference,
  aCase: AgentQaCase,
  arm: AttemptArm = {}
): Promise<AttemptRecord> {
  const planned = plan.attempts.find((item) => item.caseId === caseReference.caseId);
  if (planned === undefined) {
    // EXIT: the frozen plan holds no attempt for this case — dispatch is refused
    // before any provider exists, so no owned resource needs teardown.
    throw new InvalidInputFailure(
      `run plan ${plan.runId} freezes no attempt for caseId ${caseReference.caseId}`,
      "claim"
    );
  }
  const dir = attemptDirOf(root, planned.attemptId);
  makeDir(join(root, ATTEMPTS_DIR), "artifact-write", planned.attemptId);
  reserveDir(dir, planned.attemptId);
  claimFile(join(dir, CLAIM_FILE), HOLDER, planned.attemptId);

  const startedAt = Date.now();
  writeJsonOnce(join(dir, INTENT_FILE), intentRecord(plan, caseReference, planned.attemptId, startedAt));

  const conversationId = randomUUID();
  const workspaceRoot = join(root, "workspaces", planned.attemptId);
  const dataDir = join(root, "state", planned.attemptId);
  const traceDir = join(dir, TRACE_DIR);
  // Per-attempt placeholder roots: the ledger path exists only once the conversation id
  // is minted, and the trajectory names it too (a real run reads its own ledger back).
  const subject = resolvePlaceholders(aCase, ledgerDirOf(workspaceRoot, conversationId));
  makeDir(workspaceRoot, "dispatch", planned.attemptId);
  for (const seed of subject.seed) {
    const path = join(workspaceRoot, seed.path);
    if (seed.mode === "mkdir") {
      makeDir(path, "dispatch", planned.attemptId);
      continue;
    }
    makeDir(dirname(path), "dispatch", planned.attemptId);
    writeSeed(path, seed.contents);
  }

  const dispatched: DispatchResult = await dispatchAttempt({
    workspaceRoot,
    dataDir,
    traceDir,
    conversationId,
    turns: subject.turns,
    scripted: subject.scripted,
    surface: surfaceFor(aCase.caseId),
    providerUsage: arm.providerUsage ?? "reported",
    budget: plan.budget,
  });

  writeJsonOnce(join(dir, DISPATCH_FILE), dispatched);
  const results: OracleResult[] = [];
  const oracleDir = join(dir, ORACLES_DIR);
  makeDir(oracleDir, "artifact-write", planned.attemptId);
  for (let index = 0; index < caseReference.oracles.length; index += 1) {
    const declaration = caseReference.oracles[index] as (typeof caseReference.oracles)[number];
    const target = targetFor(caseReference, subject, index);
    if (target === null) {
      // EXIT: the declaration has no decidable counterpart in the case — retained as
      // unreadable so a missing expectation can never become a pass, and retained as a
      // file so the oracle directory cannot under-count the lock; nothing owned.
      const unreadableResult = unreadable(declaration.oracleId, declaration.kind);
      results.push(unreadableResult);
      writeJsonOnce(join(oracleDir, `${declaration.oracleId}.json`), unreadableResult);
      continue;
    }
    const read = await evaluateOracle(target, {
      workspaceRoot,
      tracePath: dispatched.tracePath,
      conversationId: dispatched.conversationId,
      stopReason: dispatched.stopReason,
    });
    results.push(read);
    writeJsonOnce(join(oracleDir, `${declaration.oracleId}.json`), read);
  }

  const outcome = outcomeOf(results, dispatched.validity);
  writeJsonOnce(join(dir, OUTCOME_FILE), { outcome, oracles: results });
  writeJsonOnce(join(dir, USAGE_FILE), dispatched.usage);
  // attempt.json is not counted yet: it is what this verdict is about to create.
  const coverage = coverageOf(
    dir,
    REQUIRED_ARTIFACTS.filter((name) => name !== ATTEMPT_FILE)
  );
  const record: AttemptRecord = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    attemptId: planned.attemptId,
    runId: plan.runId,
    caseId: caseReference.caseId,
    fixtureDigest: caseReference.fixture.digest,
    startedAtEpochMs: startedAt,
    settledAtEpochMs: Date.now(),
    phase: "settled",
    outcome,
    validity: dispatched.validity,
    coverage,
    posture: plan.posture,
    limits: dispatched.limits,
    usage: dispatched.usage,
    oracles: results,
    traceRef: dispatched.tracePath,
    failure: dispatched.failure,
    cleanup: dispatched.cleanup,
  };
  writeJsonOnce(join(dir, ATTEMPT_FILE), record);
  writeHashIndex(dir);

  const reread = reconstructAttempt(root, planned.attemptId);
  if (reread.outcome !== record.outcome || reread.attemptId !== record.attemptId) {
    // EXIT: a fresh reader does not reproduce the settled outcome — the artifacts are
    // retained untouched and the attempt is rejected, never silently rewritten.
    throw new ArtifactFailure(
      "artifact-corrupt",
      "artifact-read",
      `${planned.attemptId} does not reconstruct to its settled outcome`
    );
  }
  verifyTraceReconstruction(record, dispatched.tracePath);
  return record;
}

/** Seeded bytes are written plainly: a scratch workspace is not a retained artifact. */
function writeSeed(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
}

function unreadable(
  oracleId: string,
  kind: OracleResult["kind"]
): OracleResult {
  return {
    oracleId,
    kind,
    status: "unreadable",
    evidenceRef: `oracle:${oracleId}:undeclared`,
    digest: "0".repeat(64),
  };
}
