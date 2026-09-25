/**
 * Seam pins for `scanWithLegacyDegrade` — the one entry Stage 1+ calls, whose
 * return type `SecurityScanOutcome` carries ADR-0124 §6's only degrade path: a
 * parser that never loaded answers from the legacy text scan, and nothing else
 * may degrade.
 *
 * Every case here takes a **fresh module instance** (`vi.resetModules()` plus a
 * dynamic import). The reason is the state machine, not taste: a load that
 * never succeeded is process-terminal and `parseFoundationState()` is read-only
 * (the declared test-seam list is closed at four, so no reset exists), which
 * means
 *  - a terminal case would destroy the READY cases that follow it in the same
 *    instance, and a READY case would make the terminal state unreachable; and
 *  - the two pins this file owns — "the load is attempted exactly once" and
 *    "exactly one log line marks the transition" — are only meaningful on an
 *    instance whose transition has not already happened.
 * `docs/adr/0124-parse-verdict-contract.md:19` is the terminal rule; the
 * per-instance reload is a test-side technique, not part of the contract.
 *
 * `DangerousPatternHit` is deliberately never referenced by name: the hit values
 * below are structural `{ id, pattern }` literals, and the only things imported
 * from the module are its own types.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  LegacyDangerScan,
  ParseBindingLoader,
  ParseFoundationState,
  SecurityParseResult,
  SecurityScanOutcome,
  TreeBuilderSpy,
} from "../../../src/harness/permission/shell-parse.js";

type ShellParseModule =
  typeof import("../../../src/harness/permission/shell-parse.js");

type Seam = (
  command: string,
  legacyScan: LegacyDangerScan
) => SecurityScanOutcome;

const BACKSTOP_PREFIX = "旧扫描器自身异常，硬拒该条命令（兜底）：";
const ARM_KINDS = [
  "parsed",
  "legacy-hit",
  "legacy-clean",
  "legacy-threw",
] as const;

/** Two hits from the closed id roster, declared structurally (see file header). */
const RM_HIT = { id: "destructive-rm", pattern: "rm -rf" } as const;
const FIND_HIT = { id: "root-find-walk", pattern: "find /" } as const;

async function freshShellParse(): Promise<ShellParseModule> {
  vi.resetModules();
  return await import("../../../src/harness/permission/shell-parse.js");
}

/** A missing export is reported as such, rather than as a TypeError mid-assertion. */
function seamOf(mod: ShellParseModule): Seam {
  const candidate: unknown = (
    mod as unknown as Readonly<Record<string, unknown>>
  ).scanWithLegacyDegrade;
  if (typeof candidate !== "function") {
    throw new Error(
      "shell-parse.ts exports no scanWithLegacyDegrade function to test"
    );
  }
  return candidate as Seam;
}

function armName(outcome: SecurityScanOutcome): string {
  switch (outcome.kind) {
    case "parsed":
      return "parsed";
    case "legacy-hit":
      return "legacy-hit";
    case "legacy-clean":
      return "legacy-clean";
    case "legacy-threw":
      return "legacy-threw";
    default: {
      const unhandled: never = outcome;
      throw new Error(`unmodelled seam arm: ${String(unhandled)}`);
    }
  }
}

type ScanAnswer = typeof RM_HIT | typeof FIND_HIT | null;

interface ScanProbe {
  readonly scan: LegacyDangerScan;
  /** Every command the seam handed the scanner, in call order. */
  readonly commands: string[];
}

/** Answers from a queue, repeating the last entry so any number of calls works. */
function probeReturning(answers: readonly ScanAnswer[]): ScanProbe {
  const commands: string[] = [];
  let calls = 0;
  const scan: LegacyDangerScan = (command: string) => {
    commands.push(command);
    const answer = answers[Math.min(calls, answers.length - 1)] ?? null;
    calls += 1;
    return answer;
  };
  return { scan, commands };
}

/** A scanner that faults — the shape ADR-0124 §6's backstop clause is for. */
function probeThrowing(fault: unknown): ScanProbe {
  const commands: string[] = [];
  const scan: LegacyDangerScan = (command: string) => {
    commands.push(command);
    throw fault;
  };
  return { scan, commands };
}

/** The loader seam doubles as the attempt counter, so no fifth seam is needed. */
interface FailingLoader {
  readonly loader: ParseBindingLoader;
  attempts(): number;
}

function failingLoader(): FailingLoader {
  let attempts = 0;
  return {
    attempts: () => attempts,
    loader: () => {
      attempts += 1;
      throw new Error("no prebuild for this host");
    },
  };
}

interface FaultSpy extends TreeBuilderSpy {
  readonly budgets: number[];
  parses: number;
  armed: Error | null;
}

/** Records the instance-level calls of the real binding and may arm one throw. */
function faultSpy(): FaultSpy {
  const spy: FaultSpy = {
    budgets: [],
    parses: 0,
    armed: null,
    onSetTimeoutMicros(budgetMicros: number): void {
      spy.budgets.push(budgetMicros);
    },
    onParse(): void {
      spy.parses += 1;
      if (spy.armed !== null) {
        const fault = spy.armed;
        spy.armed = null;
        throw fault;
      }
    },
    armNextParseThrow(error: Error): void {
      spy.armed = error;
    },
  };
  return spy;
}

/**
 * The one-shot transition log line has no injectable sink: the seam list is
 * closed at four and the module may read neither env nor a flag. What stays
 * observable without a fifth seam is the process output itself — both
 * `console.*` and a direct `process.stderr.write` land in these two hooks — so
 * the number of lines a call emitted is countable even though its wording is
 * not pinned by the contract.
 */
function linesWrittenBy(call: () => void): string[] {
  const captured: string[] = [];
  const hook = ((chunk: string | Uint8Array): boolean => {
    captured.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    );
    return true;
  }) as unknown as typeof process.stdout.write;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  try {
    process.stdout.write = hook;
    process.stderr.write = hook as unknown as typeof process.stderr.write;
    call();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return captured
    .flatMap((chunk) => chunk.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("the seam is total", () => {
  it("answers one of exactly four arms and never throws for any input shape", async () => {
    const hostiles = [
      "",
      " ",
      "\u0000",
      "\ud800",
      "echo \\",
      "echo\u0007\u00a0\u200b",
      "echo " + "名".repeat(30_000),
      "echo " + "(".repeat(5_000),
      `cat <<'EOF'\n${"body\n".repeat(2_000)}EOF`,
      "rm -rf /tmp/seam-hostile",
    ];

    const ready = await freshShellParse();
    const readySeam = seamOf(ready);
    for (const command of hostiles) {
      let outcome: SecurityScanOutcome | undefined;
      expect(() => {
        outcome = readySeam(command, probeReturning([RM_HIT]).scan);
      }).not.toThrow();
      expect(ARM_KINDS).toContain(String(outcome?.kind));
      expect(typeof outcome?.degraded).toBe("boolean");
    }
    expect(ready.parseFoundationState()).toEqual<ParseFoundationState>("READY");

    const degraded = await freshShellParse();
    degraded.setBindingLoaderForTest(failingLoader().loader);
    const degradedSeam = seamOf(degraded);
    for (const command of hostiles) {
      let outcome: SecurityScanOutcome | undefined;
      expect(() => {
        outcome = degradedSeam(command, probeReturning([null]).scan);
      }).not.toThrow();
      expect(ARM_KINDS).toContain(String(outcome?.kind));
      expect(typeof outcome?.degraded).toBe("boolean");
    }

    const faulting = await freshShellParse();
    faulting.setBindingLoaderForTest(failingLoader().loader);
    const faultingSeam = seamOf(faulting);
    for (const command of hostiles) {
      let outcome: SecurityScanOutcome | undefined;
      expect(() => {
        outcome = faultingSeam(
          command,
          probeThrowing(new Error("scanner died")).scan
        );
      }).not.toThrow();
      expect(ARM_KINDS).toContain(String(outcome?.kind));
      expect(typeof outcome?.degraded).toBe("boolean");
    }
  });

  it("answers every arm by name through an exhaustive switch", async () => {
    const ready = await freshShellParse();
    const parsed = seamOf(ready)("echo seam-arms", probeReturning([null]).scan);

    const degraded = await freshShellParse();
    degraded.setBindingLoaderForTest(failingLoader().loader);
    const degradedSeam = seamOf(degraded);
    const arms: SecurityScanOutcome[] = [
      parsed,
      degradedSeam("rm -rf /tmp/seam-hit", probeReturning([RM_HIT]).scan),
      degradedSeam("echo seam-clean", probeReturning([null]).scan),
      degradedSeam("echo seam-threw", probeThrowing(new Error("died")).scan),
    ];
    expect(arms.map(armName)).toEqual([...ARM_KINDS]);
    expect(arms.map((arm) => arm.degraded)).toEqual([false, true, true, true]);
  });
});

describe("the parsed arm", () => {
  it("answers parsed with degraded false once the binding has loaded, and never mentions the text scan", async () => {
    const mod = await freshShellParse();
    expect(mod.parseFoundationState()).toEqual<ParseFoundationState>(
      "UNINITIALIZED"
    );
    const probe = probeReturning([RM_HIT]);

    const outcome = seamOf(mod)("echo seam-ready", probe.scan);

    expect(outcome.kind).toBe("parsed");
    expect(outcome.degraded).toBe(false);
    if (outcome.kind !== "parsed") {
      throw new Error(`expected parsed, got ${outcome.kind}`);
    }
    const result: SecurityParseResult = outcome.result;
    expect(result.kind).toBe("ok");
    // The arm carries the foundation's own verdict object, not a copy of it.
    expect(outcome.result).toBe(mod.parseForSecurity("echo seam-ready"));
    // A READY caller never learns that a legacy scan exists.
    expect(probe.commands).toEqual([]);
    expect(mod.parseFoundationState()).toEqual<ParseFoundationState>("READY");
  });

  it("hands the pre-parse veto through the parsed arm instead of the text scan", async () => {
    const mod = await freshShellParse();
    const probe = probeReturning([RM_HIT]);

    const outcome = seamOf(mod)("echo\\ seam-veto", probe.scan);

    expect(outcome.kind).toBe("parsed");
    expect(outcome.degraded).toBe(false);
    if (outcome.kind !== "parsed") {
      throw new Error(`expected parsed, got ${outcome.kind}`);
    }
    expect(outcome.result.kind).toBe("vetoed");
    expect(probe.commands).toEqual([]);
  });

  it("routes a post-ready parse fault to the parsed arm with the aborted verdict, and provably never consults the scanner", async () => {
    const mod = await freshShellParse();
    const spy = faultSpy();
    spy.armNextParseThrow(new RangeError("stack exhausted"));
    mod.setTreeBuilderSpyForTest(spy);
    const probe = probeReturning([RM_HIT]);

    const outcome = seamOf(mod)("echo seam-fault", probe.scan);

    expect(outcome.kind).toBe("parsed");
    expect(outcome.degraded).toBe(false);
    if (outcome.kind !== "parsed") {
      throw new Error(`expected parsed, got ${outcome.kind}`);
    }
    expect(outcome.result.kind).toBe("aborted");
    if (outcome.result.kind !== "aborted") {
      throw new Error(`expected aborted, got ${outcome.result.kind}`);
    }
    expect(outcome.result.reason).toContain("RangeError");
    expect(spy.parses).toBe(1);
    // One armed fault, not a standing one: the next command parses normally.
    expect(seamOf(mod)("echo seam-after-fault", probe.scan).kind).toBe(
      "parsed"
    );
    // A post-READY fault is a hard denial, never a degrade: the scanner was not
    // reached and the state never left READY.
    expect(probe.commands).toEqual([]);
    expect(mod.parseFoundationState()).toEqual<ParseFoundationState>("READY");
    expect(spy.budgets).toEqual([200_000, 200_000]);
  });
});

describe("the legacy arms on a load that never succeeded", () => {
  it("answers legacy-hit with exactly kind, degraded and the scanner's own object", async () => {
    const mod = await freshShellParse();
    mod.setBindingLoaderForTest(failingLoader().loader);
    const probe = probeReturning([RM_HIT]);

    const outcome = seamOf(mod)("rm -rf /tmp/seam-hit", probe.scan);

    expect(mod.parseFoundationState()).toEqual<ParseFoundationState>(
      "UNAVAILABLE"
    );
    expect(outcome.kind).toBe("legacy-hit");
    expect(outcome.degraded).toBe(true);
    // The seam renders no text: `hit` and nothing else.
    expect(outcome).toEqual({
      kind: "legacy-hit",
      degraded: true,
      hit: RM_HIT,
    });
    expect(Object.keys(outcome).sort()).toEqual(["degraded", "hit", "kind"]);
    if (outcome.kind !== "legacy-hit") {
      throw new Error(`expected legacy-hit, got ${outcome.kind}`);
    }
    // The scanner's own object, passed through untouched.
    expect(outcome.hit).toBe(RM_HIT);
    expect(outcome.hit).not.toHaveProperty("reason");
    expect(probe.commands).toEqual(["rm -rf /tmp/seam-hit"]);
  });

  it("answers legacy-clean with nothing beyond kind and degraded", async () => {
    const mod = await freshShellParse();
    mod.setBindingLoaderForTest(failingLoader().loader);
    const probe = probeReturning([null]);

    const outcome = seamOf(mod)("echo seam-clean", probe.scan);

    expect(outcome.kind).toBe("legacy-clean");
    expect(outcome.degraded).toBe(true);
    expect(Object.keys(outcome).sort()).toEqual(["degraded", "kind"]);
    expect(outcome).not.toHaveProperty("hit");
    expect(outcome).not.toHaveProperty("reason");
    expect(probe.commands).toEqual(["echo seam-clean"]);
  });

  it("answers legacy-threw with the pinned backstop sentence and never rethrows the scanner's error", async () => {
    const mod = await freshShellParse();
    mod.setBindingLoaderForTest(failingLoader().loader);
    const probe = probeThrowing(new Error("scanner exploded"));

    let outcome: SecurityScanOutcome | undefined;
    expect(() => {
      outcome = seamOf(mod)("echo seam-threw", probe.scan);
    }).not.toThrow();

    expect(outcome?.kind).toBe("legacy-threw");
    if (outcome?.kind !== "legacy-threw") {
      throw new Error(`expected legacy-threw, got ${String(outcome?.kind)}`);
    }
    expect(outcome.degraded).toBe(true);
    expect(outcome.errorName).toBe("Error");
    expect(outcome.reason).toBe(`${BACKSTOP_PREFIX}Error`);
    // The backstop is a hard deny — never an allow, i.e. never the clean arm —
    // and it carries no hit for a caller to render.
    expect(outcome.kind).not.toBe("legacy-clean");
    expect(outcome).not.toHaveProperty("hit");
  });

  it("answers legacy-threw for a scanner that throws a non-Error value", async () => {
    const mod = await freshShellParse();
    mod.setBindingLoaderForTest(failingLoader().loader);
    const probe = probeThrowing("bare string fault");

    let outcome: SecurityScanOutcome | undefined;
    expect(() => {
      outcome = seamOf(mod)("echo seam-threw-nonerror", probe.scan);
    }).not.toThrow();

    if (outcome?.kind !== "legacy-threw") {
      throw new Error(`expected legacy-threw, got ${String(outcome?.kind)}`);
    }
    expect(outcome.errorName.length).toBeGreaterThan(0);
    expect(outcome.reason).toBe(`${BACKSTOP_PREFIX}${outcome.errorName}`);
  });

  it("attempts the load exactly once across repeated seam calls and keeps answering from the injected scan", async () => {
    const mod = await freshShellParse();
    const loader = failingLoader();
    mod.setBindingLoaderForTest(loader.loader);
    const seam = seamOf(mod);

    const first = seam("rm -rf /tmp/seam-once", probeReturning([RM_HIT]).scan);
    const second = seam("find /seam-once", probeReturning([FIND_HIT]).scan);
    const third = seam("echo seam-once", probeReturning([null]).scan);

    expect(first.kind).toBe("legacy-hit");
    expect(second.kind).toBe("legacy-hit");
    expect(third.kind).toBe("legacy-clean");
    if (first.kind !== "legacy-hit" || second.kind !== "legacy-hit") {
      throw new Error("expected both dangerous answers on the legacy-hit arm");
    }
    // Each call answers with its own scanner object, not a cached one.
    expect(first.hit).toBe(RM_HIT);
    expect(second.hit).toBe(FIND_HIT);
    expect(loader.attempts()).toBe(1);

    // The parse entry shares the terminal state and retries the load either way.
    expect(seam("echo seam-once-again", probeReturning([null]).scan).kind).toBe(
      "legacy-clean"
    );
    expect(mod.parseForSecurity("echo seam-once-again").kind).toBe(
      "parser-unavailable"
    );
    expect(loader.attempts()).toBe(1);
    expect(mod.parseFoundationState()).toEqual<ParseFoundationState>(
      "UNAVAILABLE"
    );
  });

  it("writes exactly one process log line on the transition into unavailable and none afterwards", async () => {
    const mod = await freshShellParse();
    mod.setBindingLoaderForTest(failingLoader().loader);
    const seam = seamOf(mod);

    const transition = linesWrittenBy(() => {
      seam("echo seam-log-first", probeReturning([null]).scan);
    });
    expect(transition).toHaveLength(1);
    expect(transition[0].length).toBeGreaterThan(0);

    const later = linesWrittenBy(() => {
      seam("echo seam-log-second", probeReturning([null]).scan);
      seam("echo seam-log-third", probeReturning([null]).scan);
    });
    expect(later).toEqual([]);
  });

  it("logs no line while the answer comes from the foundation", async () => {
    const mod = await freshShellParse();
    const seam = seamOf(mod);
    // Warm the lazy load outside the capture: the binding package's own
    // install-time chatter is not this seam's log line.
    seam("echo seam-log-warmup", probeReturning([null]).scan);

    const lines = linesWrittenBy(() => {
      seam("echo seam-log-second", probeReturning([RM_HIT]).scan);
      seam("echo\tseam-log-veto", probeReturning([RM_HIT]).scan);
    });

    expect(mod.parseFoundationState()).toEqual<ParseFoundationState>("READY");
    expect(lines).toEqual([]);
  });
});

describe("the outcome union is closed at compile time", () => {
  it("refuses a fifth arm, a degrade flag on parsed, and a rendered reason on legacy-hit", async () => {
    const mod = await freshShellParse();
    const okResult: SecurityParseResult =
      mod.parseForSecurity("echo seam-shapes");

    const fifthArm: SecurityScanOutcome = {
      // @ts-expect-error a fifth arm is not assignable to the four-arm union
      kind: "legacy-shrugged",
      degraded: true,
    };
    // @ts-expect-error a parsed answer came from the foundation, so its degraded flag is the literal false
    const parsedFlaggedDegraded: SecurityScanOutcome = {
      kind: "parsed",
      degraded: true,
      result: okResult,
    };
    const hitWithRenderedReason: SecurityScanOutcome = {
      kind: "legacy-hit",
      degraded: true,
      hit: RM_HIT,
      // @ts-expect-error the seam renders no text: legacy-hit carries hit and no reason field
      reason: "旧扫描命中",
    };

    expect(fifthArm.kind).toBe("legacy-shrugged");
    expect(parsedFlaggedDegraded.kind).toBe("parsed");
    expect(hitWithRenderedReason.kind).toBe("legacy-hit");
  });
});
