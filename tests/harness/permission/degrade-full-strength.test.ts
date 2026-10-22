/**
 * SC-GATES-4 — the degrade path answers at full strength, and the substring
 * scan is measurably gone from the parsed path.
 *
 * Two claims, pinned as one contrast:
 *
 *   (a) the destructive quote-blind substring scan has left the parsed path —
 *       shapes the AST rules legitimately relax answer `null` on a real
 *       parse, and
 *   (b) with Stage 0's binding seam forced to its terminal `UNAVAILABLE`
 *       state (a test-local stub, not a product flag) those very shapes deny
 *       from the legacy scan, and the four shapes the criterion names by
 *       heart still end in a deny through the public seam.
 *
 * Same command, two graphs, opposite answers: that is what makes the
 * degrade path's guarantee checkable rather than aspirational — the degraded
 * answer is today's answer for exactly the shapes the AST path relaxes, and
 * nothing besides whether the parser loaded moves it. Two of the four named
 * shapes deny from the sensitive-path wall behind a `legacy-clean` seam arm,
 * so the arm's sequential `commandContainsSensitivePath` check is pinned too:
 * an arm that skipped it would newly allow `echo a > '/etc/passwd'` on a
 * machine whose parser never loaded.
 *
 * The wall, parse and seam modules are imported per case and never at the
 * top: the stub flips a module-level terminal state, and a shared module
 * instance would leak it into every other case — in this file and in every
 * other file of the suite. `afterEach` hands the loader back, and one case
 * measures the restoration instead of assuming it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type {
  DangerousPatternHit,
  DangerousPatternId,
} from "../../../src/harness/permission/hard-walls.js";
import type {
  ParseBindingLoader,
  ParseFoundationState,
  SecurityParseResult,
} from "../../../src/harness/permission/shell-parse.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";

const HARD_WALLS_MODULE = "../../../src/harness/permission/hard-walls.js";
const SHELL_PARSE_MODULE = "../../../src/harness/permission/shell-parse.js";
const ACI_PERMISSION_MODULE = "../../../src/harness/aci/permission.js";

/** Named so the escape spellings below read as shapes rather than byte soup. */
const LF = String.fromCharCode(0x0a);

type HardWallsModule =
  typeof import("../../../src/harness/permission/hard-walls.js");
type ShellParseModule =
  typeof import("../../../src/harness/permission/shell-parse.js");
type AciPermissionModule =
  typeof import("../../../src/harness/aci/permission.js");

interface AnswerGraph {
  readonly findDangerousPattern: (
    command: string
  ) => DangerousPatternHit | null;
  readonly commandContainsSensitivePath: (command: string) => boolean;
  /** The seam arm `findDangerousPattern` itself takes for this command. */
  readonly scanArmFor: (command: string) => string;
  readonly parseFoundationState: () => ParseFoundationState;
  /** The public parse entry, so a case can name the arm, not only the seam. */
  readonly parseVerdict: (command: string) => SecurityParseResult;
  readonly bashOutcome: (command: string) => {
    readonly decision: string;
    readonly reason: string;
  };
}

/**
 * The seam loader this file injected, kept so `afterEach` can hand the module
 * back its production binding; Stage 0's seam table makes `null` that restore
 * call. Without it every later case — here and in the rest of the suite —
 * would measure the stub instead of the parse.
 */
let injectedLoader: ((loader: ParseBindingLoader | null) => void) | null = null;

afterEach(() => {
  injectedLoader?.(null);
  injectedLoader = null;
  vi.doUnmock(SHELL_PARSE_MODULE);
  vi.resetModules();
});

/**
 * The bash-shaped tool the public seam sees, built the way the golden-reason
 * table builds one: a frozen `execute` definition whose only relevant input
 * is `command`.
 */
const bashTool: AciToolDef = Object.freeze({
  name: "bash",
  description: "degrade full-strength probe",
  inputSchema: { type: "object", additionalProperties: false },
  handler: async () => "ok",
  aci: {
    category: "execute" as const,
    isConcurrencySafe: false,
    interruptBehavior: "cancel" as const,
    timeoutTier: "default" as const,
  },
});

function graphOf(
  walls: HardWallsModule,
  parseMod: ShellParseModule,
  aci: AciPermissionModule
): AnswerGraph {
  return {
    findDangerousPattern: walls.findDangerousPattern,
    commandContainsSensitivePath: walls.commandContainsSensitivePath,
    // The seam called exactly the way the wall calls it, so the arm a pin
    // names is the arm the wall took.
    scanArmFor: (command) =>
      parseMod.scanWithLegacyDegrade(command, walls.legacyFindDangerousPattern)
        .kind,
    parseFoundationState: parseMod.parseFoundationState,
    parseVerdict: parseMod.parseForSecurity,
    bashOutcome: (command) => {
      const policy = aci.createPermissionPolicy();
      const out = aci.checkPermission({
        def: bashTool,
        input: { command },
        policy,
      });
      return { decision: out.decision, reason: out.reason };
    },
  };
}

/** A fresh production graph: the real binding, no injected loader, no mock. */
async function freshGraph(): Promise<AnswerGraph> {
  vi.doUnmock(SHELL_PARSE_MODULE);
  vi.resetModules();
  const [walls, parseMod, aci] = await Promise.all([
    import(HARD_WALLS_MODULE),
    import(SHELL_PARSE_MODULE),
    import(ACI_PERMISSION_MODULE),
  ]);
  return graphOf(walls, parseMod, aci);
}

/**
 * Forces the foundation terminal, so the seam answers from the legacy scan.
 * The stub is only real once the load has been attempted and failed, so the
 * terminal state is measured here before any caller reads an answer from it.
 */
async function unavailableGraph(): Promise<AnswerGraph> {
  vi.doUnmock(SHELL_PARSE_MODULE);
  vi.resetModules();
  const parseMod = await import(SHELL_PARSE_MODULE);
  injectedLoader = parseMod.setBindingLoaderForTest;
  parseMod.setBindingLoaderForTest(() => {
    throw new Error("forced UNAVAILABLE");
  });
  const [walls, aci] = await Promise.all([
    import(HARD_WALLS_MODULE),
    import(ACI_PERMISSION_MODULE),
  ]);
  const graph = graphOf(walls, parseMod, aci);
  expect(graph.scanArmFor("echo hi")).toBe("legacy-clean");
  expect(graph.parseFoundationState()).toBe("UNAVAILABLE");
  return graph;
}

/**
 * Shapes the AST rules legitimately relax: the literal sits in a quoted
 * operand, a comment, or the operands of a non-destructive command word, so
 * the parsed path must be silent on all four — and the quote-blind scan still
 * sees `rm -rf` in the raw text, so the degrade path must deny all four.
 */
const RELAXED_SHAPES: readonly string[] = [
  'echo "rm -rf /"',
  "echo 'rm -rf /'",
  "echo hi # rm -rf /",
  "printf 'rm -rf /'",
];

interface Gates4Row {
  readonly command: string;
  /**
   * The `findDangerousPattern` id standing in front of the deny; `null` is
   * itself a pin — the deny then comes from the sequential sensitive-path
   * check, and "it still denies" without this half would not say from where.
   */
  readonly hitId: DangerousPatternId | null;
  readonly reason: string;
}

/** The four shapes SC-GATES-4 names verbatim, each with its own wall. */
const GATES4_ROWS: readonly Gates4Row[] = [
  {
    command: "echo 'cat ~/.ssh/id_rsa'",
    hitId: null,
    // ADR-0131: the sensitive sentence now names the matched roster entry and
    // the site. On the DEGRADE path there is no parse, so the site is the
    // whole-text fallback this wall reports for a non-`ok` verdict.
    reason:
      "[hard_wall] dangerous command: sensitive path targeted by command (matched `.ssh/` at the code-region)",
  },
  {
    command: 'echo "rm -rf /"',
    hitId: "destructive-rm",
    reason:
      '[hard_wall] dangerous command pattern matched (id=destructive-rm, pattern="rm -rf")',
  },
  {
    command: "echo a > '/etc/passwd'",
    hitId: null,
    reason:
      "[hard_wall] dangerous command: sensitive path targeted by command (matched `/etc/passwd` at the code-region)",
  },
  {
    command: "find / -delete",
    hitId: "root-find-walk",
    reason:
      '[hard_wall] dangerous command pattern matched (id=root-find-walk, pattern="find")',
  },
];

describe("SC-GATES-4 (a) — the substring scan has left the parsed path", () => {
  it("answers one command twice with opposite results: null on the real parse, destructive-rm once the parser never loaded", async () => {
    for (const command of RELAXED_SHAPES) {
      const parsed = await freshGraph();
      expect(parsed.findDangerousPattern(command), command).toBeNull();
      const degraded = await unavailableGraph();
      const hit = degraded.findDangerousPattern(command);
      expect(hit, command).not.toBeNull();
      expect(hit?.id, command).toBe("destructive-rm");
    }
  });
});

describe("SC-GATES-4 (b) — the degrade path denies the four named shapes", () => {
  it("denies every Gates-4 shape through checkPermission, each from the wall that owns it", async () => {
    const graph = await unavailableGraph();
    for (const row of GATES4_ROWS) {
      const hit = graph.findDangerousPattern(row.command);
      expect(hit?.id ?? null, row.command).toBe(row.hitId);
      const out = graph.bashOutcome(row.command);
      expect(out.decision, row.command).toBe("deny");
      expect(out.reason, row.command).toBe(row.reason);
    }
  });

  it("runs commandContainsSensitivePath on the raw text behind the legacy-clean arm", async () => {
    // The regression the criterion names: a `legacy-clean` arm that skipped
    // the sensitive-path check would newly allow these two commands on a
    // machine whose parser never loaded. All four facts, per command: the
    // arm IS legacy-clean, the pattern wall IS silent, the raw-text check
    // IS true, and the public seam DOES deny.
    const graph = await unavailableGraph();
    for (const row of GATES4_ROWS.filter((entry) => entry.hitId === null)) {
      expect(graph.scanArmFor(row.command), row.command).toBe("legacy-clean");
      expect(graph.findDangerousPattern(row.command), row.command).toBeNull();
      expect(graph.commandContainsSensitivePath(row.command), row.command).toBe(
        true
      );
      expect(graph.bashOutcome(row.command).decision, row.command).toBe("deny");
    }
  });
});

describe("SC5a — the #1188 exemption gate is closed when the parser never loaded", () => {
  /**
   * The same contrast this file already draws, applied to the newly admitted
   * surface. The admission is settled against parse facts that a machine
   * without a parser cannot produce, so a row that is `ok` on a real parse
   * becomes `vetoed` once the binding failed. The rows are synthetic and
   * harmless — the split destructive flag and the split sensitive path stand in
   * for the two shapes the criterion names, and nothing here is executed; the
   * verdict and the seam arm are the only things that run.
   */
  const ADMITTED_ROWS: readonly {
    readonly command: string;
    readonly note: string;
  }[] = [
    {
      command: "ls -lt --time-style=+%m-%d\\ %H:%M docs/evidence",
      note: "harmless incident spelling 1",
    },
    {
      command: `gh issue view 1188 --json number,title \\${LF} -q '.title'`,
      note: "harmless incident spelling 2",
    },
    { command: "echo a\\ b", note: "harmless escaped space" },
    { command: `a \\${LF} b`, note: "harmless continuation" },
    {
      command: "rm -r\\ f /tmp/iknow-1188-probe",
      note: "split destructive flag",
    },
    {
      command: "echo /etc/pas\\ swd",
      note: "split sensitive operand",
    },
  ];

  /**
   * The same split sensitive path in a REDIRECT TARGET is a different lexical
   * site: the target is a redirect fact rather than an argv word, so no
   * complete static value exists to settle the escape and the row is retained
   * whether or not the parser loaded. Kept apart from `ADMITTED_ROWS` so the
   * gate is never credited with a denial the parse already owns.
   */
  const RETAINED_ON_BOTH_PATHS: readonly {
    readonly command: string;
    readonly note: string;
  }[] = [
    { command: "echo > /etc/pas\\ swd", note: "split sensitive redirect target" },
  ];

  it("answers every admitted row `ok` when READY", async () => {
    for (const row of ADMITTED_ROWS) {
      const parsed = await freshGraph();
      // The load is lazy, so the state is read AFTER the first parse — which
      // is the parse being measured.
      expect(parsed.parseVerdict(row.command).kind, row.note).toBe("ok");
      expect(parsed.parseFoundationState(), row.note).toBe("READY");
      // A READY parse is not a degrade, so the seam stays on the parsed arm.
      expect(parsed.scanArmFor(row.command), row.note).toBe("parsed");
    }
  });

  it("refuses them at the PARSE arm on the degrade path, not at the legacy scan", async () => {
    const degraded = await unavailableGraph();
    for (const row of ADMITTED_ROWS) {
      const verdict = degraded.parseVerdict(row.command);
      expect(verdict.kind, row.note).toBe("vetoed");
      if (verdict.kind !== "vetoed") {
        throw new Error(`expected vetoed, got ${verdict.kind}`);
      }
      expect(verdict.class, row.note).toBe("backslash-whitespace");
      // The seam arm is the load-bearing half: `legacy-clean` here would mean
      // the refusal came from the legacy text scan, which is exactly the
      // unproven route the gate exists to avoid.
      expect(degraded.scanArmFor(row.command), row.note).toBe("parsed");
    }
  });

  it("denies the split sensitive redirect target on BOTH paths, so the gate is not what protects it", async () => {
    for (const row of RETAINED_ON_BOTH_PATHS) {
      const parsed = await freshGraph();
      const ready = parsed.parseVerdict(row.command);
      expect(ready.kind, `${row.note} READY`).toBe("vetoed");
      if (ready.kind !== "vetoed") {
        throw new Error(`expected vetoed, got ${ready.kind}`);
      }
      expect(ready.class, `${row.note} READY`).toBe("backslash-whitespace");

      const degraded = await unavailableGraph();
      const gated = degraded.parseVerdict(row.command);
      expect(gated.kind, `${row.note} UNAVAILABLE`).toBe("vetoed");
      expect(degraded.scanArmFor(row.command), row.note).toBe("parsed");
    }
  });

  it("keeps the legacy route for an ordinary command outside the exemption surface", async () => {
    const command = "echo iknow-1188-ordinary";
    const degraded = await unavailableGraph();
    expect(degraded.parseFoundationState()).toBe("UNAVAILABLE");
    expect(degraded.parseVerdict(command).kind).toBe("parser-unavailable");
    expect(degraded.scanArmFor(command)).toBe("legacy-clean");
  });
});

describe("no product flag — the answer moves only with the load", () => {
  it("reports READY in a fresh graph, denies degraded, and answers from the parse again once the seam is handed back", async () => {
    // SC-GATES-4's other binary half — "rg for a new permission-mode/AST
    // boolean returns nothing" — is a reviewer check over the diff, not a
    // test. What a test can prove is the behavioral face: no flag is
    // observable, because the ONLY thing that flips these answers is whether
    // Stage 0's binding loaded.
    const command = 'echo "rm -rf /"';
    const parsed = await freshGraph();
    expect(parsed.findDangerousPattern(command)).toBeNull();
    expect(parsed.parseFoundationState()).toBe("READY");
    const degraded = await unavailableGraph();
    expect(degraded.findDangerousPattern(command)?.id).toBe("destructive-rm");
    // Restoration measured, not assumed: the next case must find the real
    // parse again, so the stub is provably confined to this file's graphs.
    injectedLoader?.(null);
    injectedLoader = null;
    const restored = await freshGraph();
    expect(restored.findDangerousPattern(command)).toBeNull();
    expect(restored.parseFoundationState()).toBe("READY");
  });
});
