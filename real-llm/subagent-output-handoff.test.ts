// REAL_LLM: subagent-output-handoff golden set — real-model A/B half.
//
// Paired trajectory comparison of the model-visible handoff wording around the
// REAL production receipt pipeline:
//
//   - arm-B runs the committed HEAD presentation (what production says now);
//   - arm-A runs the pre-change presentation, derived from the live tool text
//     by a targeted segment swap (armSwap in the fixture) fed through
//     `deps.promptTools` — the same seam the memory layer already uses to
//     reshape the prompt tool set. Only the model-visible description/schema
//     text of `spawn_subagent` (and, where a surface injects it, the
//     coordinator parenthetical via a `deps.system` wrapper) differs per arm;
//     the executor, ajv validation, handlers, and receipts are the untouched
//     production registry.
//
// Seam documentation, per the plan's adapter rule: task ids, output paths,
// statuses, and report bodies always come from the real worker path
// (buildHarnessEngine → spawn_subagent → real worker CLI run → pad write →
// subagent_result). Nothing here fabricates a receipt, and no production
// feature flag or env switch exists — the swap is constructed inside this
// test only. A premise break (live text no longer carrying the arm-B segment)
// throws rather than measuring a fabricated arm.
//
// Hard gates bind to tool RESULTS and filesystem bytes, never model prose:
// the folded `truncated:true` receipts, the `subagent_result` reads (matching
// task_id + pad-relative tmp_path from the receipt's output_path), the saved
// pad file content, the assembled page chain reproducing the original, and the
// parent answer containing the fixed WITNESS tokens. When the model simply did
// not take the expected trajectory shape, the trial prints RESIDUAL and is not
// judged — never a hidden pass. Arm-A failures are recorded as a baseline and
// never asserted as a pass; arm-B hard failures throw. Missing credentials are
// Not run (explicit), never a pass. Counts are fixed in the fixture before
// examining any result (see INCIDENT_TRIALS_PER_ARM / CONTROL_TRIALS_PER_ARM).
//
// Note on wait-false observation: a bare `run()` has no host mailbox drain —
// completion becomes visible through the model's own `subagent_result` polls,
// which is exactly the polling contract this control gates.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarnessEngine } from "../src/harness/build-engine.ts";
import { run, type LoopEngineDeps } from "../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../src/harness/errors.ts";
import type {
  ToolDef,
  ToolExecutionResult,
} from "../src/harness/tools/types.ts";
import { createNoAskUser } from "../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../src/config/env.ts";
import { FINAL_TEXT_PAD_NAME } from "../src/harness/subagent/envelope.ts";
import { loadRealLlmEnv } from "./real-llm-env.ts";
import {
  createRecordingExecutor,
  type RoleSubstitutionDispatch as DispatchRecord,
} from "./role-substitution-recorder.ts";
import {
  ARM_A_COORDINATOR_PARENTHETICAL,
  ARM_A_SPAWN_TAIL,
  ARM_A_WAIT_SENTENCE,
  ARM_B_COORDINATOR_PARENTHETICAL,
  ARM_B_SPAWN_TAIL,
  ARM_B_WAIT_SENTENCE,
  CONTROL_TRIALS_PER_ARM,
  EXPECTED_TMP_PATH,
  INCIDENT_PARENT_PROMPT,
  INCIDENT_REPORTS,
  INCIDENT_TRIALS_PER_ARM,
  INCIDENT_WITNESSES,
  IMAGE_INPUT_PROMPT,
  PAGED_PARENT_PROMPT,
  PAGED_REPORT,
  SCENE_IMAGE_FILE_NAME,
  SCENE_PNG_BASE64,
  STATUS_ONLY_PROMPT,
  WAIT_FALSE_PROMPT,
  armSwap,
  validateIncident4Shape,
  validatePagedShape,
  type WorkerReport,
} from "../tests/subagent/subagent-output-handoff.fixtures.ts";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// A throwing load must surface at collection, not masquerade as a skip.
const realEnv = loadRealLlmEnv(REPO_ROOT);
const HAS_KEY = realEnv !== undefined;
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

// The two halves bind to one shape; a fixture breach is a build error here,
// not a per-trial condition (the offline half asserts the same validators).
const FIXTURE_BREACH = [...validateIncident4Shape(), ...validatePagedShape()];
if (FIXTURE_BREACH.length > 0) {
  throw new Error(`golden fixture shape broken: ${FIXTURE_BREACH.join("; ")}`);
}

type Arm = "A" | "B";
type CaseId =
  "incident-4" | "paged-report" | "status-only" | "wait-false" | "image-input";

const PROMPTS: Record<CaseId, string> = {
  "incident-4": INCIDENT_PARENT_PROMPT,
  "paged-report": PAGED_PARENT_PROMPT,
  "status-only": STATUS_ONLY_PROMPT,
  "wait-false": WAIT_FALSE_PROMPT,
  "image-input": IMAGE_INPUT_PROMPT,
};

const TRIALS_PER_ARM: Record<CaseId, number> = {
  "incident-4": INCIDENT_TRIALS_PER_ARM,
  "paged-report": 1,
  "status-only": CONTROL_TRIALS_PER_ARM,
  "wait-false": CONTROL_TRIALS_PER_ARM,
  "image-input": CONTROL_TRIALS_PER_ARM,
};

const CASE_ORDER: CaseId[] = [
  "incident-4",
  "status-only",
  "wait-false",
  "image-input",
  "paged-report",
];

let SCRATCH = "";
const SCRATCH_DIRS: string[] = [];

function makeDir(label: string): string {
  const dir = mkdtempSync(join(SCRATCH, `${label}-`));
  SCRATCH_DIRS.push(dir);
  return dir;
}

beforeAll(() => {
  // Scratch lives under the gitignored .evals/ tree, like the other real-llm
  // sets; only scrubbed summaries ever leave this file (into the manifest).
  const base = join(REPO_ROOT, ".evals", "real-llm");
  mkdirSync(base, { recursive: true });
  SCRATCH = mkdtempSync(join(base, "subagent-output-handoff-"));
});

afterAll(() => {
  for (const dir of SCRATCH_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (SCRATCH !== "") rmSync(SCRATCH, { recursive: true, force: true });
});

/* ------------------------------ result helpers ------------------------------ */

function resultText(r: ToolExecutionResult | undefined): string {
  if (r === undefined) return "";
  if (r.kind === "ok") {
    return r.payload.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  }
  if ("message" in r) return r.message;
  return r.kind;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function asInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/* ------------------------------- A/B seam -------------------------------- */

function armSpawnDef(def: ToolDef, arm: Arm): ToolDef {
  if (arm === "B") return def;
  const description = armSwap(
    def.description,
    ARM_B_SPAWN_TAIL,
    ARM_A_SPAWN_TAIL,
    "spawn_subagent description tail"
  );
  const schema = def.inputSchema as {
    properties?: Record<string, Record<string, unknown>>;
  };
  const wait = schema.properties?.wait;
  if (wait === undefined || typeof wait.description !== "string") {
    throw new Error(
      "A/B seam premise broken: spawn_subagent schema carries no `wait` description"
    );
  }
  const waitDescription = armSwap(
    wait.description,
    ARM_B_WAIT_SENTENCE,
    ARM_A_WAIT_SENTENCE,
    "spawn_subagent wait field"
  );
  return {
    ...def,
    description,
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        wait: { ...wait, description: waitDescription },
      },
    },
  };
}

function armPromptTools(
  base: () => ReadonlyArray<ToolDef>,
  arm: Arm
): () => ReadonlyArray<ToolDef> {
  return () =>
    base().map((t) => (t.name === "spawn_subagent" ? armSpawnDef(t, arm) : t));
}

/**
 * Coordinator-segment swap, conditional by construction: the default chat
 * assembly no longer injects the coordinator parenthetical (the guidance
 * lives in the tool description), so on this surface the wrapper is a no-op
 * passthrough. Where a surface does inject it, arm-A sees the pre-change
 * wording; a live text that carries neither arm's parenthetical is left
 * untouched rather than fabricated.
 */
function armSystemText(deps: LoopEngineDeps, arm: Arm) {
  const inner = deps.system;
  if (inner === undefined || arm === "B") return inner;
  return async () => {
    const text = await inner();
    if (text === undefined) return undefined;
    return text.includes(ARM_B_COORDINATOR_PARENTHETICAL)
      ? armSwap(
          text,
          ARM_B_COORDINATOR_PARENTHETICAL,
          ARM_A_COORDINATOR_PARENTHETICAL,
          "coordinator parenthetical"
        )
      : text;
  };
}

/* ------------------------------- trial run ------------------------------- */

function seedWorkspace(caseId: CaseId, workspace: string): void {
  const textFiles: WorkerReport[] =
    caseId === "incident-4"
      ? [...INCIDENT_REPORTS]
      : caseId === "paged-report"
        ? [PAGED_REPORT]
        : [];
  for (const r of textFiles) {
    writeFileSync(join(workspace, r.fileName), r.body, "utf8");
  }
  if (caseId === "image-input") {
    writeFileSync(
      join(workspace, SCENE_IMAGE_FILE_NAME),
      Buffer.from(SCENE_PNG_BASE64, "base64")
    );
  }
}

interface TrialRun {
  readonly arm: Arm;
  readonly caseId: CaseId;
  readonly trial: number;
  readonly workspace: string;
  readonly dispatches: DispatchRecord[];
  readonly finalText: string;
  readonly stopReason: string;
}

async function runArmTrial(
  arm: Arm,
  caseId: CaseId,
  trial: number
): Promise<TrialRun> {
  const dir = makeDir(`${caseId}-${arm}-t${trial}`);
  const workspace = join(dir, "workspace");
  const home = join(dir, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  seedWorkspace(caseId, workspace);
  const built = await buildHarnessEngine({
    env: realEnv as IknowEnv,
    askUser: createNoAskUser(),
    surface: "chat",
    cwd: workspace,
    workspaceRoot: workspace,
    sandboxRoot: workspace,
    userHome: home,
    skipCountTokens: true,
    // The pad anchor: with no subagentsDir the manager omits output_path and
    // the retrieval contract under test cannot exist at all.
    subagentsDir: join(dir, "subagents"),
  });
  const dispatches: DispatchRecord[] = [];
  const recording = createRecordingExecutor(built.deps.executor, dispatches);
  const promptBase =
    built.deps.promptTools ?? (() => built.deps.registry.list());
  const deps: LoopEngineDeps = {
    ...built.deps,
    executor: recording,
    promptTools: armPromptTools(promptBase, arm),
    system: armSystemText(built.deps, arm),
    conversationId: `handoff-${caseId}-${arm}-${trial}`,
    maxTurns: 12,
  };
  let stopReason = "unknown";
  let finalText = "";
  try {
    try {
      const result = await run(PROMPTS[caseId], deps);
      stopReason = result.result.stopReason;
      finalText = result.result.finalText ?? "";
    } catch (err) {
      if (err instanceof MaxTurnsExceeded) {
        stopReason = "max_turns";
      } else {
        throw err;
      }
    }
  } finally {
    await built.shutdown?.();
  }
  return {
    arm,
    caseId,
    trial,
    workspace,
    dispatches,
    finalText,
    stopReason,
  };
}

/* ------------------------------ dispatch reads ----------------------------- */

interface Receipt {
  readonly dispatchIndex: number;
  readonly taskId: string;
  readonly status: string | undefined;
  readonly truncated: boolean | undefined;
  readonly outputPath: string | undefined;
  readonly tmpRoot: string | undefined;
  readonly handoffResult: string;
}

function spawnReceipts(run: TrialRun): Receipt[] {
  const out: Receipt[] = [];
  run.dispatches.forEach((d, i) => {
    if (d.name !== "spawn_subagent") return;
    const obj = parseJsonObject(resultText(d.result));
    if (obj === undefined) return;
    const taskId = str(obj.task_id);
    if (taskId === undefined) return;
    out.push({
      dispatchIndex: i,
      taskId,
      status: str(obj.status),
      truncated: typeof obj.truncated === "boolean" ? obj.truncated : undefined,
      outputPath: str(obj.output_path),
      tmpRoot: str(obj.tmp_root),
      handoffResult: str(obj.result) ?? "",
    });
  });
  return out;
}

interface PadRead {
  readonly dispatchIndex: number;
  readonly taskId: string;
  readonly tmpPath: string;
  readonly offset: number | undefined;
  readonly content: string;
  readonly eof: boolean | undefined;
  readonly nextOffset: number | undefined;
}

function padReads(run: TrialRun): PadRead[] {
  const out: PadRead[] = [];
  run.dispatches.forEach((d, i) => {
    if (d.name !== "subagent_result") return;
    const input = asInput(d.input);
    const tmpPath = str(input.tmp_path);
    const taskId = str(input.task_id);
    if (tmpPath === undefined || taskId === undefined) return;
    const obj = parseJsonObject(resultText(d.result));
    if (obj === undefined || obj.status !== "ok") return;
    const content = str(obj.content);
    if (content === undefined) return;
    out.push({
      dispatchIndex: i,
      taskId,
      tmpPath,
      offset: typeof input.offset === "number" ? input.offset : undefined,
      content,
      eof: typeof obj.eof === "boolean" ? obj.eof : undefined,
      nextOffset:
        typeof obj.next_offset === "number" ? obj.next_offset : undefined,
    });
  });
  return out;
}

function savedReport(receipt: Receipt): string | undefined {
  if (receipt.tmpRoot === undefined) return undefined;
  try {
    return readFileSync(
      join(receipt.tmpRoot, receipt.outputPath ?? FINAL_TEXT_PAD_NAME),
      "utf8"
    );
  } catch {
    return undefined;
  }
}

/* --------------------------------- gates --------------------------------- */

interface GateResult {
  readonly hard: string[];
  readonly residual: string[];
  readonly witnessRetrieved: boolean | undefined;
  readonly answerHasWitness: boolean | undefined;
}

/**
 * The shared "no witness verdict" gate shape: either the trial never produced
 * its premise (nothing was judged) or the case has no report read at all
 * (status-only / wait-false / image-input controls). `undefined`, not `false`,
 * keeps the manifest honest — `false` would read as "retrieval failed" for
 * something that was never measured.
 */
function notJudged(residual: string[] = [], hard: string[] = []): GateResult {
  return {
    hard,
    residual,
    witnessRetrieved: undefined,
    answerHasWitness: undefined,
  };
}

function witnessForSpawnInput(input: unknown): WorkerReport | undefined {
  const task = str(asInput(input).task) ?? "";
  return INCIDENT_REPORTS.find((r) => task.includes(r.fileName));
}

function forbiddenRouteViolations(run: TrialRun): string[] {
  const padRoots = spawnReceipts(run)
    .map((r) => r.tmpRoot)
    .filter((t): t is string => t !== undefined);
  const directTargets = [
    EXPECTED_TMP_PATH,
    ...INCIDENT_REPORTS.map((r) => r.fileName),
    ...padRoots,
  ];
  return run.dispatches.flatMap((d, i) => {
    if (
      d.name === "read_image" ||
      d.name === "read_file" ||
      d.name === "grep"
    ) {
      return [`${d.name} used at #${i} — generic content route is off-limits`];
    }
    if (
      d.name === "bash" &&
      directTargets.some((t) => JSON.stringify(d.input).includes(t))
    ) {
      return [`bash at #${i} reads a report or pad file directly`];
    }
    return [];
  });
}

function incidentGate(run: TrialRun): GateResult {
  const hard: string[] = [];
  const residual: string[] = [];
  const completed = spawnReceipts(run).filter((r) => r.status === "ok");
  if (completed.length < INCIDENT_REPORTS.length) {
    residual.push(
      `only ${completed.length}/${INCIDENT_REPORTS.length} completed wait:true receipts; ` +
        "the four-report premise was not produced"
    );
    return notJudged(residual, hard);
  }
  const reads = padReads(run);
  const retrieval = incidentRetrieval(run, completed, reads);
  if (retrieval.premiseBreak.length > 0) {
    return notJudged(retrieval.premiseBreak, hard);
  }
  hard.push(...retrieval.hard);
  hard.push(...forbiddenRouteViolations(run));
  for (const read of reads) {
    for (const report of INCIDENT_REPORTS) {
      const own = retrieval.pairing.get(read.taskId) === report.witness;
      if (!own && read.content.includes(report.witness)) {
        hard.push(
          `read #${read.dispatchIndex} of task ${shortTask(run, read.taskId)} carries the witness of another report`
        );
      }
    }
  }
  const missing = INCIDENT_WITNESSES.filter((w) => !run.finalText.includes(w));
  if (missing.length > 0) {
    hard.push(
      `parent answer is missing ${missing.length}/4 witnesses (${missing.join(", ")})`
    );
  }
  return {
    hard,
    residual,
    witnessRetrieved: retrieval.retrieved,
    answerHasWitness: missing.length === 0,
  };
}

function incidentRetrieval(
  run: TrialRun,
  receipts: Receipt[],
  reads: PadRead[]
): {
  premiseBreak: string[];
  hard: string[];
  pairing: Map<string, string>;
  retrieved: boolean;
} {
  const premiseBreak: string[] = [];
  const hard: string[] = [];
  const pairing = new Map<string, string>();
  let retrieved = receipts.length > 0;
  for (const receipt of receipts) {
    const report = witnessForSpawnInput(
      run.dispatches[receipt.dispatchIndex]?.input
    );
    if (report === undefined || receipt.outputPath === undefined) {
      premiseBreak.push(
        `receipt #${receipt.dispatchIndex} cannot be paired to a fixture report ` +
          `(spawn task names no fixture file${receipt.outputPath === undefined ? ", and no output_path was stamped" : ""})`
      );
      continue;
    }
    pairing.set(receipt.taskId, report.witness);
    const saved = savedReport(receipt);
    if (saved === undefined || !saved.includes(report.witness)) {
      premiseBreak.push(
        `saved ${report.fileName} for task ${shortTask(run, receipt.taskId)} does not carry its witness — worker did not restate verbatim`
      );
      continue;
    }
    if (receipt.truncated !== true) {
      hard.push(
        `receipt for task ${shortTask(run, receipt.taskId)} is not truncated:true although the full report exceeds the short handoff`
      );
    }
    if (receipt.handoffResult.includes(report.witness)) {
      hard.push(
        `receipt handoff for task ${shortTask(run, receipt.taskId)} carries the witness the fold should have hidden`
      );
    }
    const own = reads.filter(
      (r) => r.taskId === receipt.taskId && r.tmpPath === receipt.outputPath
    );
    if (own.length === 0) {
      hard.push(
        `no subagent_result read of ${receipt.outputPath} for task ${shortTask(run, receipt.taskId)}`
      );
      retrieved = false;
      continue;
    }
    if (!own.some((r) => r.content.includes(report.witness))) {
      hard.push(
        `reads of task ${shortTask(run, receipt.taskId)} never expose its own witness`
      );
      retrieved = false;
    }
  }
  return { premiseBreak, hard, pairing, retrieved };
}

function shortTask(run: TrialRun, taskId: string): string {
  const ids: string[] = [];
  for (const d of run.dispatches) {
    const obj =
      d.name === "spawn_subagent"
        ? parseJsonObject(resultText(d.result))
        : asInput(d.input);
    const id = str(obj?.task_id);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  const idx = ids.indexOf(taskId);
  return `task#${idx < 0 ? "?" : idx + 1}`;
}

function pagedGate(run: TrialRun): GateResult {
  const hard: string[] = [];
  const residual: string[] = [];
  const receipt = spawnReceipts(run).find((r) => r.status === "ok");
  if (receipt === undefined || receipt.outputPath === undefined) {
    residual.push(
      "no completed receipt with output_path; paging premise not produced"
    );
    return notJudged(residual, hard);
  }
  const saved = savedReport(receipt);
  if (saved === undefined || !saved.includes(PAGED_REPORT.witness)) {
    residual.push(
      "saved report does not carry the tail witness (worker did not restate the whole file)"
    );
    return notJudged(residual, hard);
  }
  const reads = padReads(run).filter((r) => r.taskId === receipt.taskId);
  hard.push(...pageChainViolations(reads, saved));
  const retrieved = reads.some((r) => r.content.includes(PAGED_REPORT.witness));
  const answerHas = run.finalText.includes(PAGED_REPORT.witness);
  if (!answerHas) {
    hard.push("parent answer does not contain the tail witness");
  }
  return {
    hard,
    residual,
    witnessRetrieved: retrieved,
    answerHasWitness: answerHas,
  };
}

function pageChainViolations(reads: PadRead[], saved: string): string[] {
  const raw = reads
    .filter((r) => r.offset !== undefined)
    .sort((a, b) => a.offset! - b.offset!);
  if (raw.length === 0) {
    return [
      "no bounded raw-page read via offset continuation; the tail was not reached by paging",
    ];
  }
  const issues: string[] = [];
  let expected = 0;
  let assembled = "";
  let reachedEof = false;
  for (const page of raw) {
    if (reachedEof) {
      issues.push(`read after eof at offset ${page.offset}`);
      break;
    }
    if (page.offset !== expected) {
      issues.push(
        `page chain breaks at offset ${page.offset}, expected ${expected}`
      );
      break;
    }
    assembled += page.content;
    if (page.eof === true) {
      reachedEof = true;
      break;
    }
    if (page.nextOffset === undefined) {
      issues.push(
        `non-final page at offset ${page.offset} carries no next_offset`
      );
      return issues;
    }
    expected = page.nextOffset;
  }
  if (!reachedEof && issues.length === 0) {
    issues.push("page chain never reached eof");
  }
  if (issues.length === 0 && assembled !== saved) {
    issues.push("assembled pages do not reproduce the saved report in order");
  }
  return issues;
}

function statusOnlyGate(run: TrialRun): GateResult {
  const hard: string[] = [];
  const residual: string[] = [];
  const polls = run.dispatches.filter((d) => d.name === "subagent_result");
  const spawned = run.dispatches.some((d) => d.name === "spawn_subagent");
  if (!spawned || polls.length === 0) {
    residual.push("no spawn + task_id-only poll sequence observed");
    return notJudged(residual, hard);
  }
  polls.forEach((d, i) => {
    const tmpPath = str(asInput(d.input).tmp_path);
    if (tmpPath !== undefined) {
      hard.push(
        `poll #${i} passed tmp_path (${tmpPath}) — status-only forbids any report read`
      );
    }
  });
  const otherRoutes = run.dispatches.filter((d) =>
    ["read_file", "read_image", "grep"].includes(d.name)
  );
  if (otherRoutes.length > 0) {
    hard.push(
      `generic file-read route used: ${otherRoutes.map((d) => d.name).join(", ")}`
    );
  }
  return notJudged(residual, hard);
}

function waitFalseGate(run: TrialRun): GateResult {
  const hard: string[] = [];
  const residual: string[] = [];
  const launched = run.dispatches.find(
    (d) => d.name === "spawn_subagent" && asInput(d.input).wait === false
  );
  if (launched === undefined) {
    residual.push(
      "task was not launched with wait:false; ordering contract not produced"
    );
    return notJudged(residual, hard);
  }
  const receipt = parseJsonObject(resultText(launched.result));
  const taskId = str(receipt?.task_id);
  const polls = run.dispatches.filter((d) => {
    if (d.name !== "subagent_result") return false;
    return taskId !== undefined && str(asInput(d.input).task_id) === taskId;
  });
  if (polls.length === 0) {
    residual.push("no task_id-only polling dispatch observed");
    return notJudged(residual, hard);
  }
  const terminal = polls.findIndex((d) => {
    const obj = parseJsonObject(resultText(d.result));
    return obj?.status === "completed" || obj?.status === "failed";
  });
  const firstTerminalIndex =
    terminal < 0
      ? run.dispatches.length + 1
      : run.dispatches.indexOf(polls[terminal]!);
  polls.forEach((d) => {
    const idx = run.dispatches.indexOf(d);
    const tmpPath = str(asInput(d.input).tmp_path);
    if (tmpPath !== undefined && idx < firstTerminalIndex) {
      hard.push(
        `tmp_path (${tmpPath}) requested at #${idx} before any observed completion at #${firstTerminalIndex}`
      );
    }
  });
  return notJudged(residual, hard);
}

function imageGate(run: TrialRun): GateResult {
  const hard: string[] = [];
  const residual: string[] = [];
  const subagentTool = run.dispatches.find(
    (d) => d.name === "spawn_subagent" || d.name === "subagent_result"
  );
  if (subagentTool !== undefined) {
    hard.push(`sub-agent tool ${subagentTool.name} used on the image control`);
  }
  const inspected = run.dispatches.some(
    (d) =>
      d.name === "read_image" &&
      JSON.stringify(d.input).includes(SCENE_IMAGE_FILE_NAME)
  );
  if (!inspected) {
    residual.push(
      "no read_image dispatch on the scene file; selection not observed"
    );
  }
  return notJudged(residual, hard);
}

const GATES: Record<CaseId, (run: TrialRun) => GateResult> = {
  "incident-4": incidentGate,
  "paged-report": pagedGate,
  "status-only": statusOnlyGate,
  "wait-false": waitFalseGate,
  "image-input": imageGate,
};

/* --------------------------- judging & manifest --------------------------- */

interface TrialRecord {
  readonly arm: Arm;
  readonly case: CaseId;
  readonly trial: number;
  readonly stop: string;
  readonly verdict: "pass" | "fail" | "residual";
  readonly hard: string[];
  readonly residual: string[];
  readonly sequence: string[];
  readonly toolErrors: string[];
  readonly fullReportWitnessRetrieved: boolean | null;
  readonly parentAnswerContainsWitness: boolean | null;
}

const TRIALS: TrialRecord[] = [];

function compactArgs(d: DispatchRecord): string {
  const input = asInput(d.input);
  if (d.name === "spawn_subagent") {
    return `wait=${String(input.wait !== undefined ? input.wait : true)}`;
  }
  if (d.name === "subagent_result") {
    const taskId = str(input.task_id);
    const tmpPath = str(input.tmp_path);
    const offset =
      typeof input.offset === "number" ? ` offset=${input.offset}` : "";
    return `task=${taskId === undefined ? "?" : shortTaskIdOnly(taskId)}${tmpPath === undefined ? "" : ` tmp_path=${tmpPath}`}${offset}`;
  }
  return JSON.stringify(input).slice(0, 60);
}

const TASK_LABELS = new Map<string, string>();

function shortTaskIdOnly(taskId: string): string {
  let label = TASK_LABELS.get(taskId);
  if (label === undefined) {
    label = `t${TASK_LABELS.size + 1}`;
    TASK_LABELS.set(taskId, label);
  }
  return label;
}

function scrubPaths(text: string, run: TrialRun): string {
  return text.replaceAll(run.workspace, "<WS>").replaceAll(REPO_ROOT, "<REPO>");
}

function captureSequence(run: TrialRun): string[] {
  return run.dispatches.map(
    (d, i) =>
      `${i} ${d.name} ${compactArgs(d)} kind=${d.result?.kind ?? "unset"}`
  );
}

function captureToolErrors(run: TrialRun): string[] {
  const errors: string[] = [];
  run.dispatches.forEach((d, i) => {
    if (d.result === undefined || d.result.kind === "ok") return;
    const reason = scrubPaths(resultText(d.result), run).slice(0, 140);
    errors.push(`#${i} ${d.name} ${d.result.kind}: ${reason}`);
  });
  return errors;
}

function judge(run: TrialRun): void {
  const gate = GATES[run.caseId](run);
  const verdict =
    gate.hard.length > 0
      ? "fail"
      : gate.residual.length > 0
        ? "residual"
        : "pass";
  const record: TrialRecord = {
    arm: run.arm,
    case: run.caseId,
    trial: run.trial,
    stop: run.stopReason,
    verdict,
    hard: gate.hard.map((h) => scrubPaths(h, run)),
    residual: gate.residual.map((r) => scrubPaths(r, run)),
    sequence: captureSequence(run),
    toolErrors: captureToolErrors(run),
    fullReportWitnessRetrieved: gate.witnessRetrieved ?? null,
    parentAnswerContainsWitness: gate.answerHasWitness ?? null,
  };
  TRIALS.push(record);
  const tag = `[${run.caseId}/arm-${run.arm}/trial-${run.trial}]`;
  console.log(`${tag} verdict=${verdict} stop=${run.stopReason}`);
  for (const line of record.sequence) console.log(`${tag} ${line}`);
  for (const e of record.toolErrors) console.log(`${tag} TOOL-ERROR ${e}`);
  if (verdict === "residual") {
    console.log(
      `${tag} RESIDUAL (not judged, never a hidden pass): ${record.residual.join("; ")}`
    );
    return;
  }
  if (verdict === "fail") {
    if (run.arm === "A") {
      // Arm A is the pre-change baseline: recorded, never asserted as a pass.
      console.log(
        `${tag} BASELINE FAIL (recorded, not asserted): ${record.hard.join("; ")}`
      );
      return;
    }
    expect(record.hard, `${tag} arm-B hard gates`).toEqual([]);
  }
}

async function runCaseTrials(arm: Arm, caseId: CaseId): Promise<void> {
  for (let trial = 1; trial <= TRIALS_PER_ARM[caseId]; trial += 1) {
    judge(await runArmTrial(arm, caseId, trial));
  }
}

function tally(caseId: CaseId, arm: Arm): number {
  return TRIALS.filter((t) => t.case === caseId && t.arm === arm).length;
}

function printManifest(): void {
  console.log("[manifest] fixed counts decided before results:");
  for (const caseId of CASE_ORDER) {
    console.log(
      `[manifest] ${caseId}: planned ${TRIALS_PER_ARM[caseId]} trials/arm; recorded A=${tally(caseId, "A")} B=${tally(caseId, "B")}`
    );
  }
  const kinds = (caseId: CaseId, arm: Arm) =>
    TRIALS.filter((t) => t.case === caseId && t.arm === arm).map(
      (t) => t.verdict
    );
  for (const caseId of CASE_ORDER) {
    console.log(
      `[manifest] ${caseId} verdicts A=[${kinds(caseId, "A").join(",")}] B=[${kinds(caseId, "B").join(",")}]`
    );
  }
  const incidentA = kinds("incident-4", "A");
  if (
    incidentA.length === INCIDENT_TRIALS_PER_ARM &&
    incidentA.every((k) => k === "pass")
  ) {
    console.log(
      "[manifest] GAIN RULE: arm A already passes every incident trial — no demonstrated gain; reassess the wording change (plan T5)."
    );
  }
  // Counter-guard over EVERY arm-B case, not only the incident case: arm-B is
  // also the half that has to show the image / status-only / wait:false
  // controls and the bounded page chain still hold. A residual, a failed, or
  // an unrecorded arm-B trial leaves that control undemonstrated — it is not
  // evidence that the control survived, so no pass may be claimed for it.
  for (const caseId of CASE_ORDER) {
    const armB = kinds(caseId, "B");
    const planned = TRIALS_PER_ARM[caseId];
    const reasons: string[] = [];
    const notPassed = armB.filter((k) => k !== "pass");
    if (notPassed.length > 0) {
      reasons.push(
        `${notPassed.length}/${armB.length} recorded trial(s) not passed (${notPassed.join(", ")})`
      );
    }
    if (armB.length < planned) {
      reasons.push(
        `${planned - armB.length}/${planned} trial(s) never recorded`
      );
    }
    if (reasons.length === 0) continue;
    console.log(
      `[manifest] MANIFEST-INCOMPLETE: ${caseId} arm-B not fully judged (${reasons.join("; ")}) — no "controls preserved" pass may be claimed for this case.`
    );
  }
}

/* --------------------------------- suite --------------------------------- */

// The key check lives only at this boundary: without a key the block is
// `describe.skip`, so no `it` body runs and a body-level guard would be dead
// code. The `[SKIP] … Not run` line is printed once at module load, above.
(HAS_KEY ? describe : describe.skip)(
  "subagent-output-handoff — real-model A/B (test:real-llm)",
  () => {
    const guarded = (arm: Arm, caseId: CaseId, timeout: number) =>
      it(
        `${caseId}: arm-${arm} (${TRIALS_PER_ARM[caseId]} trial(s)${arm === "A" ? ", baseline recording" : ", hard gates"})`,
        { timeout },
        async () => {
          await runCaseTrials(arm, caseId);
        }
      );

    for (const caseId of CASE_ORDER) {
      const timeout =
        caseId === "incident-4"
          ? 2_400_000
          : caseId === "paged-report"
            ? 1_500_000
            : 600_000;
      // A before B per case: the baseline is captured first, exactly as the
      // paired-comparison protocol records it.
      guarded("A", caseId, timeout);
      guarded("B", caseId, timeout);
    }

    it(
      "manifest — fixed counts, per-trial captures, gain rule",
      { timeout: 60_000 },
      () => {
        printManifest();
        // Premise only, never a results gate: the run itself may legitimately
        // record failures and residuals.
        expect(existsSync(SCRATCH)).toBe(true);
      }
    );
  }
);
