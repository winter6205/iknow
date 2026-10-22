/**
 * The published boundary of the offline Agent QA mechanism: the real command and flag
 * usage of `main`, never a promised future command.
 *
 * Everything here drives `main` — the function the shebang entry calls — so a flag that
 * is documented but not implemented fails, and an exit code a reviewer would read as
 * success is asserted rather than assumed. The refusal table gives each input a fresh
 * parent directory and requires it to stay empty: a rejected command owes no trace,
 * least of all a directory inside the repository the catalog locks.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "vitest";

import {
  comparisonSummaryOf,
  isAdmissible,
  main,
  parseInvocation,
  summaryOf,
} from "../../../../scripts/eval/agent-qa/cli.ts";
import {
  ATTEMPT_FILE,
  ATTEMPTS_DIR,
  COMPARISONS_DIR,
  HASH_INDEX_FILE,
  INTENT_FILE,
  REPORT_SCHEMA_VERSION,
  REPORTS_DIR,
  type AgentQaReport,
  type Comparison,
  type IdentityField,
  type RosterState,
} from "../../../../scripts/eval/agent-qa/types.ts";

const REPO_ROOT = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../..")
);

const roots: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agent-qa-cli-${label}-`));
  roots.push(dir);
  return dir;
}

function freshRoot(label: string): string {
  return join(tempDir(label), "run");
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

type Run = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** `main` writes the document to stdout and its diagnostics to stderr, as the process does. */
async function cli(argv: readonly string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const collect = (sink: string[]) =>
    ((chunk: string | Uint8Array): boolean => {
      sink.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      );
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = collect(out);
  process.stderr.write = collect(err);
  try {
    return {
      code: await main(argv),
      stdout: out.join(""),
      stderr: err.join(""),
    };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function retainedPath(stdout: string, marker: string): string {
  const match = stdout.match(new RegExp(`${marker} (\\S+)`));
  assert.ok(match !== null, `the command never named its artifact (${marker})`);
  return match[1];
}

function runIdOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(".report.json", "");
}

const EMPTY_ROSTER: Readonly<Record<RosterState, readonly string[]>> = {
  executed: [],
  partial: [],
  missing: [],
  skipped: [],
  "credential-blocked": [],
  "other-not-run": [],
};

/** A report that says the whole roster ran and every slot is admissible measurement. */
function reportSeed(): AgentQaReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: "offline-abc12345",
    identities: {
      evaluator: "agent-qa-v1",
      source: "sha",
      model: "scripted-offline",
      prompt: "sha",
      tool: "sha",
      data: "synthetic-offline",
      environment: "scratch-loopback",
      posture: "scripted-offline",
      budget: "sha",
    },
    counts: {
      planned: 2,
      executed: 2,
      valid: 2,
      passed: 1,
      interrupted: 0,
      providerErrors: 0,
      invalid: 0,
      notRun: 0,
      unknown: 0,
    },
    conditionalScore: 0.5,
    measurementCoverage: 1,
    fullCatalogCoverage: true,
    measurementComplete: true,
    usageTotals: {
      inputTokens: 10,
      outputTokens: 4,
      wallMs: 900,
      usageComplete: true,
    },
    cleanupUnconfirmed: [],
    roster: { ...EMPTY_ROSTER, executed: ["task-02", "safety-03"] },
    attempts: [
      {
        attemptId: "task-02-a1",
        caseId: "task-02",
        fixtureDigest: "sha",
        outcome: "passed",
        validity: "valid",
        coverage: "complete",
        posture: "scripted-offline",
        limits: [],
        usage: {
          inputTokens: 6,
          outputTokens: 2,
          wallMs: 500,
          usageComplete: true,
        },
        traceRef: "trace:conv:tool_call",
        oracleRefs: ["task-02-bytes"],
      },
      {
        attemptId: "safety-03-a1",
        caseId: "safety-03",
        fixtureDigest: "sha",
        outcome: "failed",
        validity: "valid",
        coverage: "complete",
        posture: "scripted-offline",
        limits: [],
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          wallMs: 400,
          usageComplete: true,
        },
        traceRef: "trace:conv:tool_call",
        oracleRefs: ["safety-03-deny-record"],
      },
    ],
    mayClaimCapability: false,
  };
}

function withCounts(patch: Partial<AgentQaReport["counts"]>): AgentQaReport {
  const seed = reportSeed();
  return { ...seed, counts: { ...seed.counts, ...patch } };
}

describe("cli — the exit code reads the measurement, never a case verdict", () => {
  it("treats a complete run whose case failed as admissible", () => {
    assert.equal(isAdmissible(reportSeed()), true);
  });

  it("refuses admissibility for each way a measurement comes up short", () => {
    const cases: readonly (readonly [string, AgentQaReport])[] = [
      [
        "no valid attempt",
        {
          ...reportSeed(),
          conditionalScore: null,
          counts: { ...reportSeed().counts, valid: 0 },
        },
      ],
      [
        "unknown usage",
        {
          ...reportSeed(),
          usageTotals: {
            inputTokens: null,
            outputTokens: null,
            wallMs: null,
            usageComplete: false,
          },
        },
      ],
      [
        "cleanup unconfirmed",
        { ...reportSeed(), cleanupUnconfirmed: ["task-02-a1"] },
      ],
      [
        "a planned slot not run",
        { ...reportSeed(), measurementComplete: false },
      ],
      [
        "catalog coverage short",
        { ...reportSeed(), fullCatalogCoverage: false },
      ],
      [
        "evidence coverage short",
        { ...reportSeed(), measurementCoverage: 0.5 },
      ],
      ["an invalid slot", withCounts({ invalid: 1, valid: 1 })],
      ["an interrupted slot", withCounts({ interrupted: 1, valid: 1 })],
      ["a provider fault", withCounts({ providerErrors: 1, valid: 1 })],
      ["an unknown verdict", withCounts({ unknown: 1, valid: 1 })],
      ["a slot left not run", withCounts({ notRun: 1, executed: 1 })],
    ];
    for (const [name, report] of cases) {
      assert.equal(
        isAdmissible(report),
        false,
        `${name} read as admissible measurement`
      );
    }
  });

  it("renders an undefined score and unknown usage as themselves, never as zero", () => {
    const seed = reportSeed();
    const stalled: AgentQaReport = {
      ...seed,
      conditionalScore: null,
      measurementComplete: false,
      fullCatalogCoverage: false,
      counts: { ...seed.counts, valid: 0, executed: 0, passed: 0, notRun: 2 },
      usageTotals: {
        inputTokens: null,
        outputTokens: null,
        wallMs: null,
        usageComplete: false,
      },
      roster: { ...EMPTY_ROSTER, "other-not-run": ["task-02", "safety-03"] },
    };
    const text = summaryOf(stalled).join("\n");
    assert.match(text, /conditional score undefined \(no valid attempt\)/);
    assert.match(text, /in unknown\s+out unknown\s+wall unknownms/);
    assert.match(text, /roster other-not-run  task-02, safety-03/);
    assert.equal(/unknown usage blocks dispatch/.test(text), true);
    assert.equal(
      /\bnull\b/.test(text),
      false,
      "a null leaked into the summary"
    );
  });

  it("states a comparison as a difference and never as a demonstrated gain", () => {
    const comparison: Comparison = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      treatmentFactor: "prompt",
      baselineRunId: "offline-aaaa1111",
      candidateRunId: "offline-bbbb2222",
      transitions: [
        { caseId: "task-02", baseline: "failed", candidate: "passed" },
        { caseId: "safety-03", baseline: "passed", candidate: "passed" },
      ],
      countsDelta: {
        planned: 0,
        executed: 0,
        valid: 0,
        passed: 1,
        interrupted: 0,
        providerErrors: 0,
        invalid: 0,
        notRun: 0,
        unknown: 0,
      },
      statisticallyEstablished: false,
    };
    const text = comparisonSummaryOf(comparison).join("\n");
    assert.match(text, /task-02 failed→passed/);
    assert.match(text, /passed \+1/);
    assert.equal(
      text.includes("safety-03"),
      false,
      "an unchanged case was listed as a change"
    );
    assert.match(text, /statistically established  no/);
  });
});

describe("cli — input contract", () => {
  it("answers a bare invocation with usage and an unknown command with a refusal", async () => {
    const bare = await cli([]);
    assert.equal(bare.code, 2);
    assert.match(bare.stdout, /Exit codes/);

    const help = await cli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(
      help.stdout,
      /npx tsx scripts\/eval\/agent-qa\/cli\.ts run --root <dir>/
    );

    const parent = tempDir("unknown-command");
    const refused = await cli(["frobnicate", "--root", join(parent, "run")]);
    assert.equal(refused.code, 2);
    assert.match(
      refused.stderr,
      /^invalid-input@plan-validate: frobnicate is not a command/
    );
    assert.deepEqual(readdirSync(parent), []);
  });

  it("refuses every malformed input before it creates anything", async () => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      ["a missing run root", ["run"]],
      ["a relative run root", ["run", "--root", "relative/run"]],
      [
        "a run root inside the repository",
        ["run", "--root", `${REPO_ROOT}/eval-run-root`],
      ],
      ["a bare positional", ["run", "--root", "%ROOT%", "extra"]],
      ["a flag with no value", ["run", "--root"]],
      [
        "a flag borrowed from another command",
        ["report", "--root", "%ROOT%", "--max-turns", "4"],
      ],
      [
        "a repeated single-valued flag",
        ["run", "--root", "%ROOT%", "--root", "%ROOT%"],
      ],
      ["an unknown flag", ["run", "--root", "%ROOT%", "--token-ceiling", "5"]],
      [
        "a value outside an enum",
        ["run", "--root", "%ROOT%", "--provider-usage", "sometimes"],
      ],
      [
        "a compare with no treatment",
        ["compare", "--root", "%ROOT%", "--baseline", "b", "--candidate", "c"],
      ],
      [
        "a treatment outside the four arms",
        [
          "compare",
          "--root",
          "%ROOT%",
          "--baseline",
          "b",
          "--candidate",
          "c",
          "--treatment",
          "vibes",
        ],
      ],
      [
        "an identity field that does not exist",
        [
          "compare",
          "--root",
          "%ROOT%",
          "--baseline",
          "b",
          "--candidate",
          "c",
          "--treatment",
          "source",
          "--allow-diff",
          "cost",
        ],
      ],
      [
        "a case the catalog does not hold",
        ["run", "--root", "%ROOT%", "--case", "task-99"],
      ],
      [
        "a case named twice",
        ["run", "--root", "%ROOT%", "--case", "task-02", "--case", "task-02"],
      ],
      ["a case with an empty name", ["run", "--root", "%ROOT%", "--case", ""]],
    ];
    for (const [name, template] of cases) {
      const parent = tempDir("input");
      const root = join(parent, "run");
      const insideRepo = join(REPO_ROOT, "eval-run-root");
      const argv = template.map((token) => token.replace("%ROOT%", root));
      const result = await cli(argv);
      assert.equal(result.code, 2, `${name} did not refuse`);
      assert.match(
        result.stderr,
        /^invalid-input@plan-validate: /,
        `${name} was not a typed refusal: ${result.stderr}`
      );
      assert.match(
        result.stderr,
        /Exit codes/,
        `${name} answered without the usage text`
      );
      assert.deepEqual(readdirSync(parent), [], `${name} created a run root`);
      assert.equal(
        existsSync(insideRepo),
        false,
        `${name} wrote inside the repository`
      );
    }
  });

  it("refuses a root inside the checkout for the commands that retain bytes", async () => {
    const inside = join(REPO_ROOT, "eval-run-root");

    const reported = await cli(["report", "--root", inside, "--persist"]);
    assert.equal(reported.code, 2);
    assert.match(
      reported.stderr,
      /^invalid-input@report: artifact root .* is inside repository /
    );

    const compared = await cli([
      "compare",
      "--root",
      inside,
      "--baseline",
      "b",
      "--candidate",
      "c",
      "--treatment",
      "source",
    ]);
    assert.equal(compared.code, 2);
    assert.match(
      compared.stderr,
      /^invalid-input@compare: artifact root .* is inside repository /
    );
    assert.equal(existsSync(inside), false, "a refused root was created");
  });

  it("names an unusable budget with the budget's own kinds", async () => {
    for (const [value, kind] of [
      ["0", "unenforceable-budget"],
      ["many", "unreadable-budget"],
      ["-1", "unenforceable-budget"],
      ["2.5", "unenforceable-budget"],
    ] as const) {
      const parent = tempDir("budget");
      const result = await cli([
        "run",
        "--root",
        join(parent, "run"),
        "--max-turns",
        value,
      ]);
      assert.equal(result.code, 2);
      assert.match(
        result.stderr,
        new RegExp(`^${kind}@plan-validate: `),
        `--max-turns ${value} failed as ${result.stderr.split("\n")[0]}`
      );
      assert.deepEqual(readdirSync(parent), []);
    }
  });

  it("keeps a documented flag's parsed identity, so usage cannot drift from the code", () => {
    const parsed = parseInvocation([
      "run",
      "--root",
      "/tmp/agent-qa-cli-parse",
      "--case",
      "task-02",
      "--case",
      "safety-03",
      "--max-turns",
      "6",
      "--provider-usage",
      "absent",
      "--json",
    ]);
    assert.ok("command" in parsed);
    if (parsed.command.sub !== "run") return;
    assert.deepEqual(parsed.command.caseIds, ["task-02", "safety-03"]);
    assert.equal(parsed.command.budget.maxTurns, 6);
    assert.equal(parsed.command.budget.wallMs, 30_000);
    assert.equal(parsed.command.providerUsage, "absent");
    assert.equal(parsed.command.json, true);
    assert.equal(
      parsed.command.repoRoot,
      REPO_ROOT,
      "the default repo root is this checkout"
    );

    const compared = parseInvocation([
      "compare",
      "--root",
      "/tmp/agent-qa-cli-parse",
      "--baseline",
      "offline-a",
      "--candidate-root",
      "/tmp/agent-qa-cli-arm",
      "--candidate",
      "offline-b",
      "--treatment",
      "source",
      "--allow-diff",
      "source",
      "--allow-diff",
      "prompt",
      "--allow-diff",
      "tool",
    ]);
    assert.ok("command" in compared);
    if (compared.command.sub !== "compare") return;
    const declared: readonly IdentityField[] = ["source", "prompt", "tool"];
    assert.deepEqual(compared.command.allowedDiff, declared);
    assert.equal(compared.command.candidateRoot, "/tmp/agent-qa-cli-arm");

    // Absent means the baseline's own root, and the parse keeps that absence explicit.
    const oneRoot = parseInvocation([
      "compare",
      "--root",
      "/tmp/agent-qa-cli-parse",
      "--baseline",
      "offline-a",
      "--candidate",
      "offline-b",
      "--treatment",
      "source",
    ]);
    assert.ok("command" in oneRoot);
    if (oneRoot.command.sub !== "compare") return;
    assert.equal("candidateRoot" in oneRoot.command, false);
  });
});

describe("cli — the published commands on real bytes", () => {
  /** One full catalog run, read back by the later witnesses; removed once for the file. */
  const shared: { root: string | null; runId: string | null } = {
    root: null,
    runId: null,
  };

  afterAll(() => {
    // The run root is a child of the mkdtemp parent, so removing only the child leaves
    // an empty directory behind in the system temp dir.
    if (shared.root !== null)
      rmSync(dirname(shared.root), { recursive: true, force: true });
  });

  it("runs all 20 offline scenarios and exits zero only because the measurement is admissible", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "agent-qa-cli-full-")), "run");
    shared.root = root;
    const result = await cli(["run", "--root", root]);
    assert.match(
      result.stdout,
      /^run offline-[0-9a-f]{8}  evaluator agent-qa-v1  posture scripted-offline$/m
    );
    assert.match(
      result.stdout,
      /^counts  planned 20  executed 20  valid 20  passed 20  interrupted 0  provider-error 0  invalid 0  not-run 0  unknown 0$/m
    );
    assert.match(
      result.stdout,
      /conditional score 1\.000  measurement coverage 1\.000/
    );
    assert.match(
      result.stdout,
      /^roster executed  recovery-01,[^\n]*turn-04$/m
    );
    assert.equal(
      (result.stdout.match(/^ {2}\S+ {2,}/gm) ?? []).length,
      20,
      "not one line per slot"
    );
    assert.match(result.stdout, /capability claim  no/);
    assert.equal(
      /exit [12]\b|halted after/.test(result.stderr),
      false,
      result.stderr
    );
    assert.equal(
      result.code,
      0,
      "a complete admissible run must not read as a failure"
    );

    const path = retainedPath(result.stdout, "report retained at");
    assert.equal(existsSync(path), true);
    assert.match(result.stdout, /report digest [0-9a-f]{64}/);
    shared.runId = runIdOf(path);
    const report = JSON.parse(readFileSync(path, "utf8")) as AgentQaReport;
    assert.equal(report.runId, shared.runId);
    assert.equal(report.mayClaimCapability, false);
  }, 300_000);

  it("rebuilds a retained root read-only and refuses to replace a report that exists", async () => {
    assert.ok(shared.root !== null && shared.runId !== null);
    const before = readdirSync(join(shared.root, "attempts"));
    assert.equal(before.length, 20);

    const plain = await cli(["report", "--root", shared.root]);
    assert.equal(plain.code, 0);
    assert.match(
      plain.stdout,
      new RegExp(`^run ${shared.runId}  evaluator agent-qa-v1`, "m")
    );
    assert.match(
      plain.stdout,
      /read-only rebuild of .*\.report\.json; nothing dispatched, nothing written/
    );
    assert.deepEqual(
      readdirSync(join(shared.root, "attempts")),
      before,
      "report dispatched a slot"
    );

    // The run already retained this report, so asking for it again is a write-once refusal.
    const again = await cli(["report", "--root", shared.root, "--persist"]);
    assert.equal(again.code, 2);
    assert.match(
      again.stderr,
      /^artifact-write@artifact-write: .* already exists; artifacts are write-once/
    );
    assert.deepEqual(readdirSync(join(shared.root, "attempts")), before);
  }, 120_000);

  it("keeps an unrun slot in the frozen denominator and reports the run as not admissible", async () => {
    const result = await cli([
      "run",
      "--root",
      freshRoot("selected"),
      "--case",
      "task-02",
    ]);
    assert.match(
      result.stdout,
      /^counts  planned 20  executed 1  valid 1  passed 1  interrupted 0  provider-error 0  invalid 0  not-run 19  unknown 0$/m
    );
    assert.match(result.stdout, /conditional score 1\.000/);
    assert.match(
      result.stdout,
      /full catalog coverage no  measurement complete no/
    );
    assert.match(
      result.stdout,
      /^ {2}task-02\s+passed\s+valid\s+complete\s+oracles 2$/m
    );
    assert.match(
      result.stdout,
      /^ {2}tool-01\s+undetermined\s+not-run\s+missing\s+oracles 0$/m
    );
    // Nothing was retained for an excluded slot, so the roster names it `missing` rather
    // than letting a selection read as a catalog the run covered.
    assert.match(result.stdout, /^roster missing  recovery-01,[^\n]*$/m);
    assert.equal(result.stderr.includes("halted after"), false);
    assert.equal(
      result.code,
      1,
      "a nineteen-slot shortfall is not admissible measurement"
    );
    // The report is still retained: a short run is honest evidence about a short run.
    assert.equal(
      existsSync(retainedPath(result.stdout, "report retained at")),
      true
    );
  }, 120_000);

  it("reads the published exit 1 for a slot that started and never settled", async () => {
    const root = freshRoot("crashed");
    const ran = await cli(["run", "--root", root]);
    assert.equal(ran.code, 0, ran.stderr);

    // A crash between the settlement and its index leaves exactly this signature: the
    // intent the lifecycle froze first, and neither of the two last writes.
    const dir = join(root, ATTEMPTS_DIR, readdirSync(join(root, ATTEMPTS_DIR)).sort()[0]);
    rmSync(join(dir, ATTEMPT_FILE));
    rmSync(join(dir, HASH_INDEX_FILE));
    const intentBytes = readFileSync(join(dir, INTENT_FILE), "utf8");

    const result = await cli(["report", "--root", root]);

    assert.equal(
      result.code,
      1,
      `an interrupted slot is retained evidence, not a refusal: ${result.stderr}`
    );
    assert.match(
      result.stdout,
      /^counts  planned 20  executed 20  valid 19  passed 19  interrupted 1 /m
    );
    assert.match(
      result.stdout,
      /^ {2}\S+ +undetermined +interrupted +partial +oracles 0$/m
    );
    assert.match(result.stdout, /^roster partial  \S+/m);
    assert.equal(/@(artifact-read|report):/.test(result.stderr), false, result.stderr);
    assert.equal(readFileSync(join(dir, INTENT_FILE), "utf8"), intentBytes);
  }, 300_000);

  it("halts on unknown usage and names the slot that stopped the roster", async () => {
    const result = await cli([
      "run",
      "--root",
      freshRoot("halt"),
      "--provider-usage",
      "absent",
    ]);
    const halted = result.stderr.match(/halted after (\S+) \(unknown-usage\)/);
    assert.ok(
      halted !== null,
      `the halt never named its slot: ${result.stderr}`
    );
    assert.match(
      result.stdout,
      new RegExp(
        `^ {2}${halted[1]}\\s+passed\\s+valid\\s+complete\\s+oracles`,
        "m"
      ),
      "the slot that halted the run is not the slot that ran"
    );
    assert.match(
      result.stdout,
      /^counts  planned 20  executed 1  valid 1 .* not-run 19/m
    );
    assert.match(
      result.stdout,
      /complete no \(unknown usage blocks dispatch\)/
    );
    assert.equal(result.code, 1);
  }, 120_000);

  it("compares two arms kept in their own roots and claims no gain", async () => {
    assert.ok(shared.root !== null && shared.runId !== null);
    const armRoot = join(tempDir("arm"), "run");
    const second = await cli(["run", "--root", armRoot]);
    const candidatePath = retainedPath(second.stdout, "report retained at");
    const candidateRunId = runIdOf(candidatePath);
    // Each run owns its artifact root, so the published interface reads the candidate
    // where it was retained. Nothing is copied into the baseline's root, and the
    // difference itself is retained under `--root`.
    assert.equal(candidatePath.startsWith(join(armRoot, REPORTS_DIR)), true);

    const result = await cli([
      "compare",
      "--root",
      shared.root,
      "--baseline",
      shared.runId,
      "--candidate-root",
      armRoot,
      "--candidate",
      candidateRunId,
      "--treatment",
      "source",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(
        `comparison ${shared.runId} → ${candidateRunId}  treatment source`
      )
    );
    assert.match(
      result.stdout,
      /counts delta  planned \+0  executed \+0  valid \+0  passed \+0/
    );
    assert.match(result.stdout, /case outcomes  unchanged across 20 cases/);
    assert.match(result.stdout, /statistically established  no/);
    const comparisonPath = retainedPath(
      result.stdout,
      "comparison retained at"
    );
    assert.equal(
      comparisonPath.startsWith(join(shared.root, COMPARISONS_DIR)),
      true
    );
    assert.equal(existsSync(comparisonPath), true);
    assert.equal(
      existsSync(join(armRoot, COMPARISONS_DIR)),
      false,
      "the candidate's own root took the write"
    );
    assert.equal(
      readdirSync(join(shared.root, "attempts")).length,
      20,
      "compare dispatched a slot"
    );
  }, 300_000);

  it("reads a comparison's exit code off both arms, not off the difference", async () => {
    assert.ok(shared.root !== null && shared.runId !== null);
    // A selected run is honest evidence about a short run: its report is retained and its
    // measurement is not admissible. Comparing against it retains the difference and still
    // refuses to read as a clean result.
    const shortRoot = join(tempDir("shortarm"), "run");
    const short = await cli(["run", "--root", shortRoot, "--case", "task-02"]);
    assert.equal(short.code, 1);
    const shortRunId = runIdOf(
      retainedPath(short.stdout, "report retained at")
    );

    const result = await cli([
      "compare",
      "--root",
      shared.root,
      "--baseline",
      shared.runId,
      "--candidate-root",
      shortRoot,
      "--candidate",
      shortRunId,
      "--treatment",
      "source",
    ]);
    assert.equal(result.code, 1, "one arm is not admissible measurement");
    assert.match(
      result.stderr,
      /exit 1 — 1 of 2 arms is not admissible measurement; .*not\.$/m,
      result.stderr
    );
    assert.match(result.stdout, /comparison .*  treatment source/);
    assert.equal(
      existsSync(retainedPath(result.stdout, "comparison retained at")),
      true
    );
  }, 300_000);

  it("refuses a relative candidate root before reading any artifact", async () => {
    const root = join(tempDir("relerm"), "run");
    const result = await cli([
      "compare",
      "--root",
      root,
      "--baseline",
      "offline-aaaaaaaa",
      "--candidate-root",
      "relative/arm",
      "--candidate",
      "offline-bbbbbbbb",
      "--treatment",
      "source",
    ]);
    assert.equal(result.code, 2);
    assert.match(
      result.stderr,
      /^invalid-input@plan-validate: .*not an absolute path/
    );
    assert.equal(
      existsSync(root),
      false,
      "a refused comparison created a root"
    );
  });

  it("refuses a comparison whose arms were never retained, without dispatching one", async () => {
    const root = join(tempDir("nocmp"), "run");
    const result = await cli([
      "compare",
      "--root",
      root,
      "--baseline",
      "offline-missing1",
      "--candidate",
      "offline-missing2",
      "--treatment",
      "model",
    ]);
    assert.equal(result.code, 2);
    assert.match(
      result.stderr,
      /^(missing-reference|artifact-read|io-failure|artifact-corrupt)@/
    );
    assert.equal(
      existsSync(root),
      false,
      "a refused comparison created a root"
    );
  });

  it("prints the report document alone under --json, so it can be piped", async () => {
    assert.ok(shared.root !== null);
    const result = await cli(["report", "--root", shared.root, "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as AgentQaReport;
    assert.equal(parsed.schemaVersion, REPORT_SCHEMA_VERSION);
    assert.equal(parsed.attempts.length, 20);
    assert.equal(parsed.counts.planned, 20);
  }, 120_000);
});
