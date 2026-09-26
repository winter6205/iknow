/**
 * READY-path pins for `shell-parse.ts`: the closed verdict set, the pinned
 * resource numbers, the memo policy, and the pre-parse veto roster.
 *
 * Every case here needs a parser that loaded successfully, so no case may
 * drive the process-terminal `UNAVAILABLE` state — a load failure is terminal
 * for the process and would destroy the READY pins in any file that shared it,
 * which is why those cases live in `shell-parse-terminal.test.ts`.
 *
 * Two observables carry most of the weight, both declared seams:
 * `parserConstructionCountForTest()` is monotonic for the process, so it is
 * always read as a same-test delta; `cacheEntryCountForTest()` is a gauge that
 * saturates at 64, so it is read absolutely.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import {
  cacheEntryCountForTest,
  parseForSecurity,
  parseForSecurityWithBudget,
  parseFoundationState,
  parserConstructionCountForTest,
  setBindingLoaderForTest,
  setTreeBuilderSpyForTest,
} from "../../../src/harness/permission/shell-parse.js";
import type {
  ParseFoundationState,
  SecurityParseResult,
  SecurityParseVerdict,
  TreeBuilderSpy,
  VetoClass,
} from "../../../src/harness/permission/shell-parse.js";

const CAP_BYTES = 65_536;
const FROZEN_BUDGET_MICROS = 200_000;
const SMALL_BUDGET_MICROS = 5_000;
const SOURCE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src"
);

/**
 * One of the two recorded adversarial shapes: an 80 000-stage pipeline,
 * 708 892 bytes — over the cap even with every word collapsed to one byte,
 * so no input of this shape can ever stand as the timeout proof.
 */
const WIDE_PIPELINE =
  "echo " +
  Array.from({ length: 80_000 }, (_, index) => `c${index}`).join(" | ");

/**
 * The other: a 20 000-deep substitution, 60 006 bytes — 5 530 bytes under the
 * cap, so it must reach the parser before the budget can cancel it.
 */
const DEEP_SUBSTITUTION =
  "echo " + "$(".repeat(20_000) + "x" + ")".repeat(20_000);

const MODULE_PATH = join(SOURCE_ROOT, "harness/permission/shell-parse.ts");
const MODULE_SOURCE = readFileSync(MODULE_PATH, "utf8");

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function constructionsAcross(call: () => void): number {
  const before = parserConstructionCountForTest();
  call();
  return parserConstructionCountForTest() - before;
}

function liveLines(pattern: RegExp): string[] {
  return MODULE_SOURCE.split("\n")
    .filter((line) => pattern.test(line))
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

interface RecorderSpy extends TreeBuilderSpy {
  readonly budgets: number[];
  parses: number;
  armed: Error | null;
}

/**
 * The spy decorates the per-command parse call: it records each instance-level
 * budget and parse call and may arm one throw, so a post-READY fault is
 * observed as a verdict while every other call still runs the real parser.
 */
function recorderSpy(): RecorderSpy {
  const spy: RecorderSpy = {
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

afterEach(() => {
  setBindingLoaderForTest(null);
  setTreeBuilderSpyForTest(null);
});

describe("lazy synchronous load", () => {
  it("imports without loading the binding", () => {
    expect(parseFoundationState()).toEqual<ParseFoundationState>(
      "UNINITIALIZED"
    );
  });

  it("reaches READY on the first parse, synchronously, and stays there", () => {
    expect(constructionsAcross(() => parseForSecurity("echo lazy-load"))).toBe(
      1
    );
    expect(parseFoundationState()).toEqual<ParseFoundationState>("READY");
    expect(parseForSecurity("echo lazy-load").kind).toBe("ok");
  });
});

describe("the verdict set is closed and the veto is not a verdict", () => {
  function verdictTagName(verdict: SecurityParseVerdict): string {
    switch (verdict) {
      case "ok":
        return "ok";
      case "unknown-syntax":
        return "unknown-syntax";
      case "malformed":
        return "malformed";
      case "aborted":
        return "aborted";
      case "over-cap":
        return "over-cap";
      case "parser-unavailable":
        return "parser-unavailable";
      default: {
        const unhandled: never = verdict;
        throw new Error(`unmodelled verdict: ${String(unhandled)}`);
      }
    }
  }

  function armName(result: SecurityParseResult): string {
    switch (result.kind) {
      case "ok":
        return "ok";
      case "unknown-syntax":
        return "unknown-syntax";
      case "malformed":
        return "malformed";
      case "aborted":
        return "aborted";
      case "over-cap":
        return "over-cap";
      case "parser-unavailable":
        return "parser-unavailable";
      case "vetoed":
        return "vetoed";
      default: {
        const unhandled: never = result;
        throw new Error(`unmodelled arm: ${String(unhandled)}`);
      }
    }
  }

  // @ts-expect-error a seventh verdict tag is not assignable to the closed union
  const seventhVerdict: SecurityParseVerdict = "syntax-warning";
  // @ts-expect-error the veto arm is not a seventh verdict
  const vetoIsNotAVerdict: SecurityParseVerdict = "vetoed";

  it("walks all six verdict tags", () => {
    const tags: SecurityParseVerdict[] = [
      "ok",
      "unknown-syntax",
      "malformed",
      "aborted",
      "over-cap",
      "parser-unavailable",
    ];
    expect(tags.map(verdictTagName)).toEqual(tags);
    expect(seventhVerdict).toBe("syntax-warning");
    expect(vetoIsNotAVerdict).toBe("vetoed");
  });

  it("names the arm of every verdict the READY path can produce", () => {
    const arms: SecurityParseResult[] = [
      parseForSecurity("echo names-arms"),
      parseForSecurity("echo 'unclosed-arms"),
      parseForSecurity("[[ $y =~ ^names-arms-[0-9]+$ ]]"),
      parseForSecurityWithBudget(DEEP_SUBSTITUTION, SMALL_BUDGET_MICROS),
      parseForSecurity(WIDE_PIPELINE),
      parseForSecurity("echo\tarms\u0007"),
    ];
    expect(arms.map(armName)).toEqual([
      "ok",
      "malformed",
      "unknown-syntax",
      "aborted",
      "over-cap",
      "vetoed",
    ]);
  });
});

describe("over-cap is decided before the parser is constructed", () => {
  it("refuses the wide pipeline-shaped hostile without entering the parser", () => {
    expect(byteLength(WIDE_PIPELINE)).toBe(708_892);
    const spy = recorderSpy();
    setTreeBuilderSpyForTest(spy);
    let verdict: SecurityParseResult | undefined;
    expect(
      constructionsAcross(() => {
        verdict = parseForSecurity(WIDE_PIPELINE);
      })
    ).toBe(0);
    expect(verdict?.kind).toBe("over-cap");
    if (verdict?.kind !== "over-cap") {
      throw new Error(`expected over-cap, got ${String(verdict?.kind)}`);
    }
    expect(verdict.reason).toContain("过长无法分析");
    expect(spy.budgets).toEqual([]);
    expect(spy.parses).toBe(0);
  });

  it("splits the cap on UTF-8 bytes, not on character count", () => {
    const wideInChars = "echo " + "名".repeat(30_000);
    expect(wideInChars.length).toBeLessThan(CAP_BYTES);
    expect(byteLength(wideInChars)).toBe(90_005);
    expect(parseForSecurity(wideInChars).kind).toBe("over-cap");

    const atCap = "echo " + "x".repeat(CAP_BYTES - "echo ".length);
    expect(byteLength(atCap)).toBe(CAP_BYTES);
    expect(constructionsAcross(() => parseForSecurity(atCap))).toBe(1);
    expect(parseForSecurity(atCap).kind).toBe("ok");

    const oneOverCap = `${atCap}x`;
    expect(byteLength(oneOverCap)).toBe(CAP_BYTES + 1);
    expect(constructionsAcross(() => parseForSecurity(oneOverCap))).toBe(0);
    expect(parseForSecurity(oneOverCap).kind).toBe("over-cap");
  });
});

describe("the sub-cap hostile reaches the parser and aborts at the budget seam", () => {
  it("aborts at a smaller budget after entering the parser", () => {
    expect(byteLength(DEEP_SUBSTITUTION)).toBe(60_006);
    expect(CAP_BYTES - byteLength(DEEP_SUBSTITUTION)).toBe(5_530);
    const spy = recorderSpy();
    setTreeBuilderSpyForTest(spy);
    let verdict: SecurityParseResult | undefined;
    expect(
      constructionsAcross(() => {
        verdict = parseForSecurityWithBudget(
          DEEP_SUBSTITUTION,
          SMALL_BUDGET_MICROS
        );
      })
    ).toBe(1);
    expect(verdict?.kind).toBe("aborted");
    if (verdict?.kind !== "aborted") {
      throw new Error(`expected aborted, got ${String(verdict?.kind)}`);
    }
    expect(verdict.reason.length).toBeGreaterThan(0);
    expect(spy.budgets).toEqual([SMALL_BUDGET_MICROS]);
    expect(spy.parses).toBe(1);
  });

  it("hands the parser the frozen budget through the public entry", () => {
    const spy = recorderSpy();
    setTreeBuilderSpyForTest(spy);
    expect(() => parseForSecurity(DEEP_SUBSTITUTION)).not.toThrow();
    expect(spy.budgets).toEqual([FROZEN_BUDGET_MICROS]);
    expect(spy.parses).toBe(1);
  });

  it("reports a post-READY fault as the aborted arm instead of throwing", () => {
    const spy = recorderSpy();
    spy.armNextParseThrow(new RangeError("stack exhausted"));
    setTreeBuilderSpyForTest(spy);
    let verdict: SecurityParseResult | undefined;
    expect(
      constructionsAcross(() => {
        verdict = parseForSecurity("echo armed-fault");
      })
    ).toBe(1);
    expect(verdict?.kind).toBe("aborted");
    if (verdict?.kind !== "aborted") {
      throw new Error(`expected aborted, got ${String(verdict?.kind)}`);
    }
    expect(verdict.reason).toContain("RangeError");
    expect(spy.parses).toBe(1);
    expect(spy.budgets).toEqual([FROZEN_BUDGET_MICROS]);
    // One armed fault, not a standing one: the next command parses normally.
    expect(parseForSecurity("echo after-armed-fault").kind).toBe("ok");
  });
});

describe("the READY-path verdicts classify", () => {
  it("carries the verbatim text and the node-type histogram for a clean command", () => {
    const result = parseForSecurity("echo hi");
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.kind}`);
    }
    expect(result.text).toBe("echo hi");
    expect(result.nodeTypes).toMatchObject({
      program: 1,
      command: 1,
      command_name: 1,
      word: 2,
    });
  });

  it("classifies an empty command as ok", () => {
    const result = parseForSecurity("");
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got ${result.kind}`);
    }
    expect(result.text).toBe("");
    expect(result.nodeTypes).toMatchObject({ program: 1 });
  });

  it("classifies an unclosed quote as malformed and says so", () => {
    const result = parseForSecurity('echo "unclosed-classification');
    if (result.kind !== "malformed") {
      throw new Error(`expected malformed, got ${result.kind}`);
    }
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("records the offending node type instead of denying out-of-roster syntax", () => {
    const command = "[[ $x =~ ^class-[0-9]+$ ]]";
    const result = parseForSecurity(command);
    if (result.kind !== "unknown-syntax") {
      throw new Error(`expected unknown-syntax, got ${result.kind}`);
    }
    expect(result.text).toBe(command);
    expect(result.unmodelled).toContain("regex");
    expect(result.unmodelled).toEqual([...result.unmodelled].sort());
    expect(result.nodeTypes["regex"]).toBe(1);
  });
});

describe("the memo cache follows the per-arm table", () => {
  it("answers a stored ok verdict with one construction and the same object", () => {
    const command = "echo memo-shared-parse";
    const first = parseForSecurity(command);
    expect(constructionsAcross(() => parseForSecurity(command))).toBe(0);
    expect(parseForSecurity(command)).toBe(first);
  });

  it("stores malformed and unknown-syntax as well", () => {
    const malformedCommand = "echo 'unclosed-memo-pair";
    const firstMalformed = parseForSecurity(malformedCommand);
    expect(firstMalformed.kind).toBe("malformed");
    expect(constructionsAcross(() => parseForSecurity(malformedCommand))).toBe(
      0
    );
    expect(parseForSecurity(malformedCommand)).toBe(firstMalformed);

    const unknownCommand = "[[ $y =~ ^memo-pair-[0-9]+$ ]]";
    const firstUnknown = parseForSecurity(unknownCommand);
    expect(firstUnknown.kind).toBe("unknown-syntax");
    expect(constructionsAcross(() => parseForSecurity(unknownCommand))).toBe(0);
    expect(parseForSecurity(unknownCommand)).toBe(firstUnknown);
  });

  it("stores nothing for the arms that do not come from a parse", () => {
    const unstored: readonly [() => SecurityParseResult, number][] = [
      [() => parseForSecurity(WIDE_PIPELINE), 0],
      [() => parseForSecurity("echo\tnot-stored\u0007"), 0],
      [
        () =>
          parseForSecurityWithBudget(DEEP_SUBSTITUTION, SMALL_BUDGET_MICROS),
        2,
      ],
    ];
    for (const [call, expectedConstructions] of unstored) {
      const entriesBefore = cacheEntryCountForTest();
      expect(
        constructionsAcross(() => {
          call();
          call();
        })
      ).toBe(expectedConstructions);
      expect(cacheEntryCountForTest()).toBe(entriesBefore);
    }
  });

  it("never answers a smaller-budget call out of the frozen-budget memo", () => {
    parseForSecurity(DEEP_SUBSTITUTION);
    const spy = recorderSpy();
    setTreeBuilderSpyForTest(spy);
    const entriesBefore = cacheEntryCountForTest();
    expect(
      constructionsAcross(() => {
        parseForSecurityWithBudget(DEEP_SUBSTITUTION, SMALL_BUDGET_MICROS);
        parseForSecurityWithBudget(DEEP_SUBSTITUTION, SMALL_BUDGET_MICROS);
      })
    ).toBe(2);
    expect(spy.budgets).toEqual([SMALL_BUDGET_MICROS, SMALL_BUDGET_MICROS]);
    expect(cacheEntryCountForTest()).toBe(entriesBefore);
  });

  it("evicts the least-recently-used entry at 64", () => {
    const sweep = Array.from(
      { length: 65 },
      (_, index) => `echo eviction-${index}`
    );
    for (const command of sweep.slice(0, 64)) {
      parseForSecurity(command);
    }
    expect(cacheEntryCountForTest()).toBe(64);
    parseForSecurity(sweep[64]);
    expect(cacheEntryCountForTest()).toBe(64);
    expect(constructionsAcross(() => parseForSecurity(sweep[0]))).toBe(1);
    expect(constructionsAcross(() => parseForSecurity(sweep[64] ?? ""))).toBe(
      0
    );
  });

  it("concurrent: 两条不同命令交错调用互不污染", () => {
    const clean = "> /tmp/f";
    const divergent = "echo\\ test";
    for (const order of [
      [clean, divergent],
      [divergent, clean],
    ]) {
      for (const command of order) {
        const result = parseForSecurity(command);
        expect(result.kind).toBe(command === clean ? "ok" : "vetoed");
        if (result.kind === "ok") {
          expect(result.text).toBe("> /tmp/f");
        }
      }
    }

    const own = Array.from(
      { length: 64 },
      (_, index) => `echo interleave-sweep-${index}`
    );
    for (const command of own) {
      parseForSecurity(command);
    }
    parseForSecurity("echo interleave-sweep-sixty-fifth");
    expect(cacheEntryCountForTest()).toBe(64);
    for (const command of [clean, divergent, clean]) {
      expect(parseForSecurity(command).kind).toBe(
        command === clean ? "ok" : "vetoed"
      );
    }
  });
});

describe("the pre-parse veto roster", () => {
  const nails: Readonly<
    Record<VetoClass, { readonly command: string; readonly marker: string }>
  > = {
    "control-character": {
      command: "echo\u0007 divergent-bell",
      marker: "控制字符",
    },
    "unicode-whitespace-or-zero-width": {
      command: "echo\u00a0divergent-nbsp",
      marker: "Unicode 空白/零宽",
    },
    "backslash-whitespace": {
      command: "echo\\ divergent-backslash",
      marker: "引号",
    },
  };

  it("answers each registered class with the veto arm, naming it", () => {
    for (const [vetoClass, nail] of Object.entries(nails)) {
      const spy = recorderSpy();
      setTreeBuilderSpyForTest(spy);
      let verdict: SecurityParseResult | undefined;
      expect(
        constructionsAcross(() => {
          verdict = parseForSecurity(nail.command);
        })
      ).toBe(0);
      expect(verdict?.kind).toBe("vetoed");
      if (verdict?.kind !== "vetoed") {
        throw new Error(`expected vetoed, got ${String(verdict?.kind)}`);
      }
      expect(verdict.class).toBe(vetoClass);
      expect(verdict.reason).toContain(vetoClass);
      expect(verdict.reason).toContain(nail.marker);
      expect(spy.budgets).toEqual([]);
      expect(spy.parses).toBe(0);
    }
  });

  it("carries the rewrite hint to the quoted form for echo\\ test", () => {
    const verdict = parseForSecurity("echo\\ test");
    if (verdict.kind !== "vetoed") {
      throw new Error(`expected vetoed, got ${verdict.kind}`);
    }
    expect(verdict.class).toBe("backslash-whitespace");
    expect(verdict.reason).toContain("引号");
    expect(verdict.reason).toContain('echo "test"');
  });

  it("names zero-width, BOM and non-ASCII whitespace as one registered class", () => {
    for (const command of [
      "echo\u200bhi",
      "\ufeffecho bom-led",
      "echo\u3000hi",
      "echo\u2028hi",
      "echo\u1680hi",
      "echo\u2066hi",
    ]) {
      const verdict = parseForSecurity(command);
      expect(verdict.kind).toBe("vetoed");
      if (verdict.kind === "vetoed") {
        expect(verdict.class).toBe("unicode-whitespace-or-zero-width");
      }
    }
  });

  it("exempts tab, newline and carriage return", () => {
    for (const command of ["echo\thi", "echo hi\nls", "echo a\r\nls"]) {
      let verdict: SecurityParseResult | undefined;
      const constructions = constructionsAcross(() => {
        verdict = parseForSecurity(command);
      });
      expect(verdict?.kind).not.toBe("vetoed");
      // Not vetoed and not refused either: the exempt characters reach the
      // parser, which is the whole content of the exemption.
      expect(constructions).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves backslashes that are not followed by whitespace alone", () => {
    for (const command of ["r\\m -rf /tmp/x", "echo a\\\\", "echo\\"]) {
      expect(parseForSecurity(command).kind).not.toBe("vetoed");
    }
  });

  it("registers exactly one entry per class, and no more", () => {
    expect(Object.keys(nails)).toHaveLength(3);
    const observed = new Set<VetoClass>();
    for (const command of [
      "echo\u001b[0m colour-alias",
      "echo\u200dhi",
      "echo\\ hi",
      "echo\u0000nul",
      "echo\u0085next-line",
    ]) {
      const verdict = parseForSecurity(command);
      if (verdict.kind === "vetoed") {
        observed.add(verdict.class);
      }
    }
    expect([...observed].sort()).toEqual([
      "backslash-whitespace",
      "control-character",
      "unicode-whitespace-or-zero-width",
    ]);
  });

  it("never memoizes a veto", () => {
    const command = "echo\u0007 memo-check";
    const before = cacheEntryCountForTest();
    parseForSecurity(command);
    parseForSecurity(command);
    expect(cacheEntryCountForTest()).toBe(before);
  });
});

describe("the entries are total", () => {
  const ARM_TAGS = [
    "ok",
    "unknown-syntax",
    "malformed",
    "aborted",
    "over-cap",
    "parser-unavailable",
    "vetoed",
  ];

  it("returns an arm instead of throwing for every hostile shape", () => {
    const probes = [
      "",
      " ",
      "\u0000",
      "\ud800",
      "echo \\",
      `echo ${"(".repeat(5_000)}`,
      "echo `unclosed",
      "echo $" + "\\x01".repeat(50),
      `cat <<'EOF'\n${"body\n".repeat(2_000)}EOF`,
      "echo\u0007\u00a0\\\u00a0",
      WIDE_PIPELINE,
      DEEP_SUBSTITUTION,
    ];
    for (const probe of probes) {
      for (const run of [
        () => parseForSecurity(probe),
        () => parseForSecurityWithBudget(probe, SMALL_BUDGET_MICROS),
      ]) {
        let verdict: SecurityParseResult | undefined;
        expect(() => {
          verdict = run();
        }).not.toThrow();
        expect(ARM_TAGS).toContain(String(verdict?.kind));
      }
    }
  });
});

describe("no knob in the module", () => {
  it("loads the binding lazily inside a function and builds one per command", () => {
    expect(liveLines(/\bnew [A-Za-z_.]*Parser\b/)).toHaveLength(1);
    expect(
      liveLines(/createRequire\(import\.meta\.url\)/).length
    ).toBeGreaterThanOrEqual(1);
    expect(MODULE_SOURCE).not.toMatch(/\bawait\b/);
    expect(MODULE_SOURCE).not.toMatch(/\bimport\s[^\n]*["']tree-sitter/);
    expect(MODULE_SOURCE).not.toMatch(/import\(["']tree-sitter/);
    expect(MODULE_SOURCE).not.toMatch(/\.reset\(/);
    for (const line of MODULE_SOURCE.split("\n")) {
      if (line.includes('requireBinding("tree-sitter')) {
        expect(line).toMatch(/^\s{4,}\S/);
      }
    }
  });

  it("closes the test-seam list at four and reads no process-level input", () => {
    expect(liveLines(/^export (function|const) \w+ForTest\b/)).toHaveLength(4);
    expect(MODULE_SOURCE).not.toMatch(/process\.env/);
    expect(MODULE_SOURCE).not.toMatch(/readFileSync|node:fs/);
  });

  it("reaches the budget seam from the public entry alone", () => {
    expect(liveLines(/parseForSecurityWithBudget/)).toHaveLength(2);
    const callers = sourceFiles(SOURCE_ROOT).filter(
      (path) =>
        path !== MODULE_PATH &&
        readFileSync(path, "utf8").includes("parseForSecurityWithBudget")
    );
    expect(callers).toEqual([]);
  });
});
