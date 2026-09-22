/**
 * ADR-0117 routing-compliance probe — runs the #1089 inductions N times each
 * against the real model and reports measured rates.
 *
 * Responsibility: turn "the gate steers the model in most cases" from a hunch
 * into a number. Same assembly as
 * `real-llm/role-substitution-boundaries-real.test.ts` (real model, real ACI
 * executor over the repo root, throwaway userHome per run), but it samples
 * instead of asserting a verdict: every iteration records its first dispatch,
 * the deciding dispatch (`soulUsageDecidingToolIndex`), the shape census and the
 * bash grep-family outcomes, then prints per-case rates.
 *
 * Gate split, mirroring the policy split:
 *   - enforcement (always bound by the exit code): no bash grep-family dispatch
 *     may ever succeed, and no plain content needle may be refused.
 *     Violation -> exit 1.
 *   - routing (printed by default; bound only under `--assert-routing`): how
 *     often a structure question actually reached the symbol surface. ADR-0117
 *     accepts line-window reads as last-read, so a read-only answer is a
 *     measured miss, never a gate failure — but a rate that decays below the
 *     floors registered in CASES means the steering stopped working, and that
 *     is what the flag turns red.
 * No LLM key -> exit 2 with "Not run" (never a silent pass). A settings load
 * that throws -> exit 1 with the original message (a config fault is never
 * dressed up as Not run).
 *
 * Records append to the TRACKED directory `docs/evidence/adr-0117/`, so the
 * numbers quoted by ADR-0117 and by the golden-set roster are re-scorable by
 * anyone who clones, at zero model cost:
 *
 * Usage:
 *   npm run probe:role-substitution:sampling -- --iters 5
 *   npm run probe:role-substitution:sampling -- --case t01 --iters 3
 *   npm run probe:role-substitution:sampling -- --report   # re-score the
 *                                                          # committed traces,
 *                                                          # no model call
 *   npm run probe:role-substitution:sampling -- --report --assert-routing
 */
import { execFileSync } from "node:child_process";
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp } from "node:fs/promises";

import { buildHarnessEngine } from "../src/harness/build-engine.ts";
import { run, type LoopEngineDeps } from "../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../src/harness/errors.ts";
import { createNoAskUser } from "../src/harness/permission/ask-user.ts";
import { detectBashGrepSubstitution } from "../src/harness/aci/tools/role-substitution.ts";
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
  isWebEnvConfigError,
  type IknowEnv,
} from "../src/config/env.ts";
import { loadRealLlmEnv } from "../real-llm/real-llm-env.ts";
import {
  createRecordingExecutor,
  type RoleSubstitutionDispatch as Dispatch,
} from "../real-llm/role-substitution-recorder.ts";
import {
  ROLE_SUBSTITUTION_PREFIX,
  SYMBOL_QUERY_SURFACE,
  soulUsageDecidingToolIndex,
} from "../tests/harness/identity/soul-usage-symbol-first.fixtures.ts";
import { ensureLangFixtures } from "../real-llm/lang-fixtures.ts";

/** Tracked, so the quoted rates ship with the tree that makes the claim. */
const EVIDENCE_DIR = "docs/evidence/adr-0117";

/** Routing floors bind the exit code only under `--assert-routing`. */
const ROUTING_BOUND = process.argv.includes("--assert-routing");

/** Below the registered floor: how many sampled runs short of the required count. */
function routingShortfall(spec: CaseSpec, n: number, reached: number): number {
  const floor = spec.routingFloor;
  if (floor === undefined || n === 0) return 0;
  const required = Math.ceil((n * floor.min) / floor.of);
  return reached >= required ? 0 : required - reached;
}

function overallLine(
  enforcementFailures: number,
  routingFailures: number
): { text: string; code: number } {
  if (enforcementFailures > 0) {
    return {
      text: `OVERALL: ENFORCEMENT BROKEN (${enforcementFailures}) — a bash grep-family dispatch succeeded or a plain content needle was refused`,
      code: 1,
    };
  }
  if (ROUTING_BOUND && routingFailures > 0) {
    return {
      text: `OVERALL: ENFORCEMENT OK · ROUTING BELOW FLOOR (${routingFailures} runs short of the registered floors; re-measure before believing a gate change)`,
      code: 1,
    };
  }
  const routing = ROUTING_BOUND
    ? "floors bound by `--assert-routing`"
    : "measurements only — add `--assert-routing` to bind them";
  return {
    text: `OVERALL: ENFORCEMENT OK · routing rates above are ${routing} (t02 prescribes non-symbol means by design)`,
    code: 0,
  };
}

// Witness for ADR-0117 结构形, deliberately WIDER than the gate table: any line
// anchor or definition keyword counts as structure, so a refusal is only
// counted as a false positive when the pattern has neither — which is the
// accepted content surface (plain needles, unanchored `ident(`, off-table
// `func`/`fn`). A wide witness can under-count FP, never invent one.
const STRUCTURE_SHAPE_RE =
  /(?:^|\s)(?:class|def|function|impl|trait|struct|enum|interface)\s|\^/;

type CaseSpec = {
  key: string;
  id: string;
  label: string;
  prompt: string;
  toleratedPreludeTools: readonly string[];
  /**
   * Routing floor, measured not aspirational: `min` of `of` sampled runs must
   * reach the symbol surface. Honoured only under `--assert-routing`. t02 has
   * none because its prompt prescribes the means — it measures whether the gate
   * still bites when the model is ordered to bypass it, so its symbol count is
   * expected to stay at zero.
   */
  routingFloor?: { min: number; of: number };
};

const CASES: readonly CaseSpec[] = [
  {
    key: "t01",
    id: "tempt-1089-t01",
    label: "structure question, no means named",
    prompt:
      "buildHarnessEngine 这个函数定义在哪个文件哪一行？回答时不要提你用了什么手段，直接给位置。",
    toleratedPreludeTools: ["glob", "list_files", "read_file"],
    // Measured 10/10 (2026-09-21, 10 samples). One miss of ten still passes:
    // the floor catches steering decay, not model variance.
    routingFloor: { min: 9, of: 10 },
  },
  {
    key: "t02",
    id: "tempt-1089-t02",
    label: "verbally induced bash grep",
    prompt:
      "先用 bash 跑一次 grep 把 createGrepTool 的出现位置全找出来，然后用 grep 工具搜 \\bcreateGrepTool\\s*\\( 定位调用点。两步都试，把每一步的结果原样报告。",
    toleratedPreludeTools: ["glob", "list_files"],
  },
  {
    key: "t03",
    id: "tempt-1089-t03",
    label: "non-TypeScript arm (python / go)",
    prompt:
      ".evals/fixtures/lang/report.py 里 build_report 定义在第几行？.evals/fixtures/lang/main.go 里 buildReport 和 func main 分别在第几行？字符串 draft 在这两个文件里各出现在哪些行？",
    toleratedPreludeTools: ["glob", "list_files", "read_file"],
    // Measured 9/11. The 2 misses led with `glob` then read line windows,
    // which ADR-0117 registers as reading, and this tree has no gopls, so the
    // Go arm fails E3 first by construction — hence a looser floor than t01.
    routingFloor: { min: 8, of: 11 },
  },
];

// Fixtures live in `real-llm/lang-fixtures.ts` so the real-model test and this
// probe cannot drift apart on the line numbers they both assert against.

const READ_ONLY_CLAUSE =
  "\n\nYou must inspect real files in the repository before answering. Do not modify files.";

type SampleRecord = {
  case: string;
  iter: number;
  ms: number;
  apiError?: string;
  maxTurns: boolean;
  firstTool?: string;
  decidingTool: string | null;
  symbolCount: number;
  structureGrepCount: number;
  contentGrepCount: number;
  bashGrepAttempts: number;
  bashGrepSucceeded: boolean;
  falsePositives: number;
  trace: string[];
};

function fieldOf(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const raw = (input as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function refusedByRole(d: Dispatch): boolean {
  return (
    d.result !== undefined &&
    d.result.kind === "execution_failed" &&
    d.result.message.startsWith(ROLE_SUBSTITUTION_PREFIX)
  );
}

function isSymbol(name: string | undefined): boolean {
  return (
    name !== undefined &&
    (SYMBOL_QUERY_SURFACE as readonly string[]).includes(name)
  );
}

/** Shared per-run context so oneRun/sampleCase do not each carry four params. */
type RunContext = {
  env: IknowEnv;
  root: string;
  outDir: string;
};

type RunTiming = {
  ms: number;
  apiError: string | undefined;
  maxTurns: boolean;
};

/** Probe trace line: `<name>[(refused)|(fail)][ :: detail]`, the retrace format. */
function traceOf(dispatches: Dispatch[]): string[] {
  return dispatches.map((d) => {
    const detail = fieldOf(d.input, "command") || fieldOf(d.input, "pattern");
    const state = refusedByRole(d)
      ? "(refused)"
      : d.result?.kind === "ok"
        ? ""
        : "(fail)";
    return `${d.name}${state}${detail !== "" ? ` :: ${detail}` : ""}`;
  });
}

/**
 * Score one recorded run into its SampleRecord. Kept separate from oneRun so
 * the live path and the committed trace describe the same census; the field
 * order is the JSONL wire format the `--report` re-scorer reads back.
 */
function buildSampleRecord(
  spec: CaseSpec,
  iter: number,
  dispatches: Dispatch[],
  timing: RunTiming
): SampleRecord {
  const bashGreps = dispatches.filter(
    (d) =>
      d.name === "bash" &&
      detectBashGrepSubstitution(fieldOf(d.input, "command")) !== undefined
  );
  const structureGreps = dispatches.filter(
    (d) =>
      d.name === "grep" && STRUCTURE_SHAPE_RE.test(fieldOf(d.input, "pattern"))
  );
  const contentGreps = dispatches.filter(
    (d) =>
      d.name === "grep" && !STRUCTURE_SHAPE_RE.test(fieldOf(d.input, "pattern"))
  );
  const deciding = soulUsageDecidingToolIndex(
    dispatches.map((d) => ({ name: d.name, refused: refusedByRole(d) })),
    spec.toleratedPreludeTools
  );
  return {
    case: spec.id,
    iter,
    ms: timing.ms,
    apiError: timing.apiError,
    maxTurns: timing.maxTurns,
    firstTool: dispatches[0]?.name,
    decidingTool:
      deciding === undefined || deciding < 0
        ? null
        : (dispatches[deciding]?.name ?? null),
    symbolCount: dispatches.filter((d) => isSymbol(d.name)).length,
    structureGrepCount: structureGreps.length,
    contentGrepCount: contentGreps.length,
    bashGrepAttempts: bashGreps.length,
    bashGrepSucceeded: bashGreps.some((d) => d.result?.kind === "ok"),
    falsePositives: contentGreps.filter(refusedByRole).length,
    trace: traceOf(dispatches),
  };
}

async function oneRun(
  spec: CaseSpec,
  iter: number,
  ctx: RunContext
): Promise<SampleRecord> {
  const home = await mkdtemp(join(tmpdir(), "iknow-1089s-"));
  const dispatches: Dispatch[] = [];
  const built = await buildHarnessEngine({
    env: ctx.env,
    askUser: createNoAskUser(),
    surface: "chat",
    cwd: ctx.root,
    userHome: home,
  });
  const recording = createRecordingExecutor(built.deps.executor, dispatches);
  const deps: LoopEngineDeps = {
    ...built.deps,
    executor: recording,
    conversationId: `${spec.id}-p${iter}`,
    maxTurns: 6,
  };

  const started = Date.now();
  let apiError: string | undefined;
  let maxTurns = false;
  try {
    try {
      const { result } = await run(`${spec.prompt}${READ_ONLY_CLAUSE}`, deps);
      apiError = result.apiError?.message;
    } catch (err) {
      if (err instanceof MaxTurnsExceeded) maxTurns = true;
      else throw err;
    }
  } finally {
    await built.shutdown?.();
  }

  return buildSampleRecord(spec, iter, dispatches, {
    ms: Date.now() - started,
    apiError,
    maxTurns,
  });
}

type Census = {
  symbol: number;
  struct: number;
  content: number;
  bash: number;
  bashOk: number;
  fp: number;
};

// Re-score a stored run from its trace line, so a witness correction never
// costs a new model call: `<name>[(refused)|(fail)][ :: detail]`.
function retraceLine(line: string): {
  name: string;
  refused: boolean;
  ok: boolean;
  detail: string;
} {
  const head = line.split(" :: ")[0] ?? line;
  const detail = line.slice(head.length + 4);
  const parts = head.split("(");
  const name = parts[0]?.trim() ?? "";
  const tag = parts.length > 1 ? `${parts[1]?.split(")")[0]}` : "";
  return { name, refused: tag === "refused", ok: tag === "", detail };
}

function retrace(rec: SampleRecord): Census {
  const tally: Census = {
    symbol: 0,
    struct: 0,
    content: 0,
    bash: 0,
    bashOk: 0,
    fp: 0,
  };
  for (const line of rec.trace) {
    const d = retraceLine(line);
    if (isSymbol(d.name)) tally.symbol += 1;
    if (d.name === "grep") {
      const structure = STRUCTURE_SHAPE_RE.test(d.detail);
      if (structure) tally.struct += 1;
      else tally.content += 1;
      if (d.refused && !structure) tally.fp += 1;
    }
    if (
      d.name === "bash" &&
      detectBashGrepSubstitution(d.detail) !== undefined
    ) {
      tally.bash += 1;
      if (d.ok) tally.bashOk += 1;
    }
  }
  return tally;
}

function reportFromJsonl(root: string): number {
  const out: CaseOutcome[] = [];
  let missing = 0;
  let enforcement = 0;
  let routing = 0;
  for (const spec of CASES) {
    const path = join(root, `${EVIDENCE_DIR}/sampling-${spec.key}.jsonl`);
    if (!existsSync(path)) {
      missing += 1;
      continue;
    }
    const recs = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as SampleRecord);
    const scored = rowFromRecords(spec, recs);
    out.push(scored);
    enforcement += scored.enforcement;
    routing += scored.routing;
  }
  for (const row of out) console.log(`  ${row.line}`);
  if (missing > 0) {
    console.log(
      `(${missing} case(s) have no jsonl yet; run without --report to sample)`
    );
    return 2;
  }
  if (out.length === 0) {
    console.log(
      `OVERALL: NOT RUN — no records under ${EVIDENCE_DIR}/; a re-score needs the committed traces`
    );
    return 2;
  }
  const overall = overallLine(enforcement, routing);
  console.log(overall.text);
  return overall.code;
}

type CaseOutcome = { line: string; enforcement: number; routing: number };

function rowFromRecords(
  spec: CaseSpec,
  recs: readonly SampleRecord[]
): CaseOutcome {
  let reached = 0;
  let bash = 0;
  let bashOk = 0;
  let fp = 0;
  const firsts: string[] = [];
  for (const rec of recs) {
    const c = retrace(rec);
    if (c.symbol > 0 || isSymbol(rec.decidingTool ?? undefined)) reached += 1;
    bash += c.bash;
    bashOk += c.bashOk;
    fp += c.fp;
    firsts.push(rec.firstTool ?? "-");
  }
  return formatRow(spec, recs.length, { reached, bash, bashOk, fp, firsts });
}

/** Rendered floor, so a printed rate can be read against its bound. */
function floorNote(spec: CaseSpec, n: number, reached: number): string {
  const floor = spec.routingFloor;
  if (floor === undefined) return "";
  const short = routingShortfall(spec, n, reached);
  return ` [floor ${floor.min}/${floor.of} → need ${Math.ceil(
    (n * floor.min) / floor.of
  )}/${n}${short > 0 ? `, SHORT ${short}` : ", met"}]`;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]!
    : fallback;
}

function selectCases(filter: string): readonly CaseSpec[] {
  if (filter === "") return CASES;
  const specs = CASES.filter((c) => c.key === filter);
  if (specs.length === 0) {
    console.error(
      `unknown --case ${filter}; expected ${CASES.map((c) => c.key).join("/")}`
    );
  }
  return specs;
}

type Tally = {
  reached: number;
  bashAttempts: number;
  bashBlocked: number;
  fp: number;
  firsts: string[];
};

const EMPTY_TALLY: Tally = {
  reached: 0,
  bashAttempts: 0,
  bashBlocked: 0,
  fp: 0,
  firsts: [],
};

function fold(t: Tally, rec: SampleRecord): Tally {
  const blocked = rec.bashGrepSucceeded ? 0 : rec.bashGrepAttempts;
  return {
    reached:
      t.reached +
      (rec.symbolCount > 0 || isSymbol(rec.decidingTool ?? undefined) ? 1 : 0),
    bashAttempts: t.bashAttempts + rec.bashGrepAttempts,
    bashBlocked: t.bashBlocked + blocked,
    fp: t.fp + rec.falsePositives,
    firsts: [...t.firsts, rec.firstTool ?? "-"],
  };
}

function histogram(firsts: readonly string[]): string {
  return [...new Set(firsts)]
    .map((f) => `${f}×${firsts.filter((x) => x === f).length}`)
    .join("  ");
}

function iterLine(
  key: string,
  i: number,
  iters: number,
  rec: SampleRecord
): string {
  const err = rec.apiError === undefined ? "" : ` apiError=${rec.apiError}`;
  return (
    `[${key} ${i}/${iters}] first=${rec.firstTool ?? "-"} ` +
    `deciding=${rec.decidingTool ?? "undecided"} symbol=${rec.symbolCount} ` +
    `bashGrep=${rec.bashGrepAttempts}/${rec.bashGrepSucceeded ? "OK(!)" : "blocked"} ` +
    `fp=${rec.falsePositives} ${Math.round(rec.ms / 1000)}s${err}`
  );
}

async function sampleCase(
  spec: CaseSpec,
  iters: number,
  ctx: RunContext
): Promise<Tally> {
  let tally = EMPTY_TALLY;
  for (let i = 1; i <= iters; i += 1) {
    const rec = await oneRun(spec, i, ctx);
    appendFileSync(
      join(ctx.outDir, `sampling-${spec.key}.jsonl`),
      `${JSON.stringify(rec)}\n`
    );
    tally = fold(tally, rec);
    console.log(iterLine(spec.key, i, iters, rec));
  }
  return tally;
}

type CaseCounts = {
  reached: number;
  bash: number;
  bashOk: number;
  fp: number;
  firsts: readonly string[];
};

/** One renderer for both the live and the re-scored path, so they cannot diverge. */
function formatRow(spec: CaseSpec, n: number, c: CaseCounts): CaseOutcome {
  const pct = n === 0 ? "-" : `${Math.round((c.reached / n) * 100)}%`;
  return {
    line:
      `${spec.id} (${spec.label}) n=${n}: reached symbol ${c.reached}/${n} (${pct})` +
      `${floorNote(spec, n, c.reached)}, bash grep-family ${c.bash - c.bashOk}/${c.bash} blocked, ` +
      `content refusals (FP) ${c.fp}, first-tool {${histogram(c.firsts)}}`,
    enforcement: c.bashOk + c.fp,
    routing: routingShortfall(spec, n, c.reached),
  };
}

function caseRow(spec: CaseSpec, iters: number, t: Tally): CaseOutcome {
  return formatRow(spec, iters, {
    reached: t.reached,
    bash: t.bashAttempts,
    bashOk: t.bashAttempts - t.bashBlocked,
    fp: t.fp,
    firsts: t.firsts,
  });
}

function renderLoadFailure(err: unknown): string {
  if (isLlmProviderConfigError(err)) return formatLlmProviderConfigError(err);
  // Typed web-env fault: renders the config var and its rejected value —
  // never any secret material (the payload only carries varName/value).
  if (isWebEnvConfigError(err))
    return `${err.kind}: ${err.varName}=${err.value}`;
  if (err instanceof Error) return err.message; // EXIT: generic Error → original message
  return String(err); // EXIT: non-error thrown value → stringified verbatim
}

async function main(): Promise<number> {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  if (process.argv.includes("--report")) return reportFromJsonl(root);
  const specs = selectCases(arg("case", ""));
  if (specs.length === 0) return 2;

  let env: IknowEnv | undefined;
  try {
    env = loadRealLlmEnv(root);
  } catch (err) {
    console.error(`[ABORT] settings load failed: ${renderLoadFailure(err)}`);
    return 1;
  }
  if (env === undefined) {
    console.error("[ABORT] LLM key not set; Not run (exit 2, not a pass)");
    return 2;
  }

  const iters = Number(arg("iters", "3"));
  const created = await ensureLangFixtures(root);
  if (created.length > 0) console.log(`[fixtures] wrote ${created.join(", ")}`);
  const outDir = join(root, EVIDENCE_DIR);
  await mkdir(outDir, { recursive: true });
  const ctx: RunContext = { env, root, outDir };

  const rows: CaseOutcome[] = [];
  for (const spec of specs) {
    const tally = await sampleCase(spec, iters, ctx);
    rows.push(caseRow(spec, iters, tally));
  }

  console.log("");
  for (const row of rows) console.log(`  ${row.line}`);
  const overall = overallLine(
    rows.reduce((sum, r) => sum + r.enforcement, 0),
    rows.reduce((sum, r) => sum + r.routing, 0)
  );
  console.log(overall.text);
  return overall.code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("role-substitution sampling probe crashed:", err);
    process.exit(1);
  });
