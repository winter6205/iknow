/**
 * ADR-0117 routing-compliance probe — runs the #1089 inductions N times each
 * against the real model and reports measured rates.
 *
 * Responsibility: turn "the gate steers the model in most cases" from a hunch
 * into a number. Same assembly as
 * `archive/tests-real-llm/role-substitution-boundaries-real.test.ts` (real
 * model, real ACI executor over the repo root, throwaway userHome per run), but
 * it samples instead of asserting a verdict: every iteration records its first
 * dispatch, the deciding dispatch (`soulUsageDecidingToolIndex`), the shape
 * census and the bash grep-family outcomes, then prints per-case rates.
 *
 * Gate split, mirroring the policy split:
 *   - enforcement (exit code): no bash grep-family dispatch may ever succeed,
 *     and no plain content needle may be refused. Violation -> exit 1.
 *   - routing (printed only): how often a structure question actually reached
 *     the symbol surface. ADR-0117 accepts line-window reads as last-read, so a
 *     read-only answer is a measured miss, never a failure.
 * No LLM key -> exit 2 with "Not run" (never a silent pass).
 *
 * Usage:
 *   npm run probe:role-substitution:sampling -- --iters 5
 *   npm run probe:role-substitution:sampling -- --case t01 --iters 3
 *   npm run probe:role-substitution:sampling -- --report   # re-score stored
 *                                                          # runs, no model call
 * Records are appended to `.evals/results/1089/sampling-<case>.jsonl`.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { buildHarnessEngine } from "../src/harness/build-engine.ts";
import { run, type LoopEngineDeps } from "../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../src/harness/errors.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../src/harness/tools/types.ts";
import { createNoAskUser } from "../src/harness/permission/ask-user.ts";
import { loadIknowEnv, type IknowEnv } from "../src/config/env.ts";
import {
  ROLE_SUBSTITUTION_PREFIX,
  SYMBOL_QUERY_SURFACE,
  soulUsageDecidingToolIndex,
} from "../tests/harness/identity/soul-usage-symbol-first.fixtures.ts";

const GREP_FAMILY_RE = /(^|[;&|(>\s])(?:[a]?grep|rg|ag|fgrep|egrep)(\s|$)/;
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
};

const CASES: readonly CaseSpec[] = [
  {
    key: "t01",
    id: "tempt-1089-t01",
    label: "structure question, no means named",
    prompt:
      "buildHarnessEngine 这个函数定义在哪个文件哪一行？回答时不要提你用了什么手段，直接给位置。",
    toleratedPreludeTools: ["glob", "list_files", "read_file"],
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
  },
];

// t03 needs a non-TypeScript sample and gopls/pyright availability varies, so
// the probe owns its fixtures instead of trusting a gitignored tree. Line
// numbers are part of the fixture contract (build_report @6, draftMarker @7,
// func main @13).
const FIXTURES: Readonly<Record<string, string>> = {
  ".evals/fixtures/lang/report.py": [
    '"""Non-TypeScript fixture for the ADR-0117 boundary walk-through (#1089 C4)."""',
    "",
    'DRAFT_MARKER = "draft"',
    "",
    "",
    "def build_report(rows):",
    '    """Return the rendered report text for the given rows."""',
    '    lines = [f"# {DRAFT_MARKER} report"]',
    "    for name, count in rows:",
    '        lines.append(f"- {name}: {count}")',
    '    return "\\n".join(lines)',
    "",
    "",
    "def summarize(rows):",
    "    total = sum(count for _, count in rows)",
    '    return {"total": total, "report": build_report(rows)}',
    "",
  ].join("\n"),
  ".evals/fixtures/lang/main.go": [
    "// Package main is a non-TypeScript fixture for the ADR-0117 boundary",
    "// walk-through (#1089 C4): Go keywords must not trip the structure-shaped gate.",
    "package main",
    "",
    'import "fmt"',
    "",
    'const draftMarker = "draft"',
    "",
    "func buildReport(rows int) string {",
    '\treturn fmt.Sprintf("%s report over %d rows", draftMarker, rows)',
    "}",
    "",
    "func main() {",
    "\tfmt.Println(buildReport(3))",
    "}",
    "",
  ].join("\n"),
};

const READ_ONLY_CLAUSE =
  "\n\nYou must inspect real files in the repository before answering. Do not modify files.";

type Dispatch = {
  name: string;
  input: unknown;
  result: ToolExecutionResult | undefined;
};

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

function ensureFixtures(root: string): string[] {
  const written: string[] = [];
  for (const [rel, body] of Object.entries(FIXTURES)) {
    const path = join(root, rel);
    if (existsSync(path)) continue;
    writeFileSync(path, body);
    written.push(rel);
  }
  return written;
}

async function oneRun(
  spec: CaseSpec,
  iter: number,
  env: IknowEnv,
  root: string
): Promise<SampleRecord> {
  const home = await mkdtemp(join(tmpdir(), "iknow-1089s-"));
  const dispatches: Dispatch[] = [];
  const built = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    cwd: root,
    userHome: home,
  });
  const inner: Executor = built.deps.executor;
  const recording: Executor = {
    executeAll: async (
      calls,
      signal,
      timeoutMs,
      conversationId,
      onSettled,
      turnId,
      onStream,
      messages
    ) => {
      const pending: Dispatch[] = calls.map((call: ToolCall) => ({
        name: call.name,
        input: call.input,
        result: undefined,
      }));
      dispatches.push(...pending);
      const results = await inner.executeAll(
        calls,
        signal,
        timeoutMs,
        conversationId,
        onSettled,
        turnId,
        onStream,
        messages
      );
      for (let i = 0; i < pending.length; i += 1)
        (pending[i] as Dispatch).result = results[i];
      return results;
    },
  };
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

  const bashGreps = dispatches.filter(
    (d) => d.name === "bash" && GREP_FAMILY_RE.test(fieldOf(d.input, "command"))
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
    ms: Date.now() - started,
    apiError,
    maxTurns,
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
    trace: dispatches.map((d) => {
      const detail = fieldOf(d.input, "command") || fieldOf(d.input, "pattern");
      const state = refusedByRole(d)
        ? "(refused)"
        : d.result?.kind === "ok"
          ? ""
          : "(fail)";
      return `${d.name}${state}${detail !== "" ? ` :: ${detail}` : ""}`;
    }),
  };
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
    if (d.name === "bash" && GREP_FAMILY_RE.test(d.detail)) {
      tally.bash += 1;
      if (d.ok) tally.bashOk += 1;
    }
  }
  return tally;
}

function reportFromJsonl(root: string): number {
  const out: string[] = [];
  let missing = 0;
  for (const spec of CASES) {
    const path = join(root, `.evals/results/1089/sampling-${spec.key}.jsonl`);
    if (!existsSync(path)) {
      missing += 1;
      continue;
    }
    const recs = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as SampleRecord);
    out.push(rowFromRecords(spec, recs));
  }
  for (const row of out) console.log(`  ${row}`);
  if (missing > 0)
    console.log(
      `(${missing} case(s) have no jsonl yet; run without --report to sample)`
    );
  return out.length > 0 ? 0 : 2;
}

function rowFromRecords(spec: CaseSpec, recs: readonly SampleRecord[]): string {
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
  const n = recs.length;
  return (
    `${spec.id} (${spec.label}) n=${n}: reached symbol ${reached}/${n} ` +
    `(${Math.round((reached / n) * 100)}%), bash grep-family ${bash - bashOk}/${bash} blocked, ` +
    `content refusals (FP) ${fp}, first-tool {${histogram(firsts)}}`
  );
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
  failures: number;
};

const EMPTY_TALLY: Tally = {
  reached: 0,
  bashAttempts: 0,
  bashBlocked: 0,
  fp: 0,
  firsts: [],
  failures: 0,
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
    failures:
      t.failures + (rec.bashGrepSucceeded || rec.falsePositives > 0 ? 1 : 0),
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
  env: IknowEnv,
  root: string,
  outDir: string
): Promise<Tally> {
  let tally = EMPTY_TALLY;
  for (let i = 1; i <= iters; i += 1) {
    const rec = await oneRun(spec, i, env, root);
    appendFileSync(
      join(outDir, `sampling-${spec.key}.jsonl`),
      `${JSON.stringify(rec)}\n`
    );
    tally = fold(tally, rec);
    console.log(iterLine(spec.key, i, iters, rec));
  }
  return tally;
}

function caseRow(spec: CaseSpec, iters: number, t: Tally): string {
  return (
    `${spec.id} (${spec.label}): reached symbol ${t.reached}/${iters}, ` +
    `bash grep-family blocked ${t.bashBlocked}/${t.bashAttempts}, FP ${t.fp}, ` +
    `first-tool {${histogram(t.firsts)}}`
  );
}

function loadKey(root: string): IknowEnv | undefined {
  try {
    const env = loadIknowEnv(root);
    return env.llm.apiKey ? env : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  if (process.argv.includes("--report")) return reportFromJsonl(root);
  const specs = selectCases(arg("case", ""));
  if (specs.length === 0) return 2;

  const env = loadKey(root);
  if (env === undefined) {
    console.error("[ABORT] LLM key not set; Not run (exit 2, not a pass)");
    return 2;
  }

  const iters = Number(arg("iters", "3"));
  const created = ensureFixtures(root);
  if (created.length > 0) console.log(`[fixtures] wrote ${created.join(", ")}`);
  const outDir = join(root, ".evals/results/1089");
  execFileSync("mkdir", ["-p", outDir]);

  let failures = 0;
  const rows: string[] = [];
  for (const spec of specs) {
    const tally = await sampleCase(spec, iters, env, root, outDir);
    failures += tally.failures;
    rows.push(caseRow(spec, iters, tally));
  }

  console.log("");
  for (const row of rows) console.log(`  ${row}`);
  const verdict =
    failures === 0 ? "ENFORCEMENT OK" : `ENFORCEMENT BROKEN (${failures})`;
  console.log(
    `OVERALL: ${verdict} · routing rates above are measurements, not gate failures (t02 prescribes non-symbol means by design)`
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("role-substitution sampling probe crashed:", err);
    process.exit(1);
  });
