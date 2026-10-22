/**
 * tests/harness/permission/backslash-whitespace-consumers.test.ts
 *
 * SC4 / SC5 consumer battery for the #1188 backslash-whitespace repair
 * (`specs/backslash-whitespace-veto-repair.md`).
 *
 * `shell-parse.ts` now DEFERS the two spellings it can settle — an
 * odd-parity backslash run escaping U+0020, and an unquoted LF used as a
 * word separator (a space on each side) — and admits them only on an `ok`
 * parse whose facts settle every site. The consequence every consumer has to
 * agree with is in the bullet: a `vetoed` verdict that survives deferral
 * (`vetoed / backslash-whitespace`) must keep the answer its non-`ok` contract
 * already gave it, and an admitted spelling must reach the `ok` arm.
 *
 * The five consumers named by SC4 are graded here through their real
 * entries, never through a replica:
 *   - `isAllowedCommand` — `ok` → `isAllowedFromParse`, else the text fold
 *   - declarative matching — `compileDeclarativePermissions`, i.e. the real
 *     `splitCommandSegments` derivation
 *   - `validateReadonlyCommand` — `ok` → facts, else the text path
 *   - `extractSingleReadPath` — `ok` only, no splitter fallback
 *   - `detectBashGrepSubstitution` — `ok` only, no splitter fallback
 *
 * Nothing here executes a command. Every shape is inspected through the
 * parse and the inspect-only consumers; the SC5 operator rows carry
 * destructive / redirect / substitution text purely as parse input.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseForSecurity } from "../../../src/harness/permission/shell-parse.ts";
import type { SecurityParseOk } from "../../../src/harness/permission/shell-parse.ts";
import { isAllowedCommand } from "../../../src/harness/permission/hard-walls.ts";
import { compileDeclarativePermissions } from "../../../src/harness/permission/declarative.ts";
import {
  ReadonlyViolationError,
  validateReadonlyCommand,
} from "../../../src/harness/aci/tools/bash-readonly.ts";
import { extractSingleReadPath } from "../../../src/harness/aci/tools/bash-read-extract.ts";
import { detectBashGrepSubstitution } from "../../../src/harness/aci/tools/role-substitution.ts";

/** BS / LF / TAB spelled out so the roster rows read as the bytes they are. */
const BS = "\\";
const LF = "\n";
const TAB = "\t";

/** The real declarative allow rule for `Bash(<specifier>)`. */
function bashRule(specifier: string): (command: string) => boolean {
  const rules = compileDeclarativePermissions(
    { allow: [`Bash(${specifier})`] },
    { workRoot: "/w" }
  );
  return (command) =>
    rules[0]!.match({ tool: "bash", input: { command } });
}

/**
 * "ALLOW", or "DENY: <reason>". The reason is the message up to the
 * `Command: …` echo, which restates the spelling and would make two
 * spellings of one decision compare unequal.
 */
function readonlyAnswer(command: string): string {
  try {
    validateReadonlyCommand(command);
    return "ALLOW";
  } catch (error) {
    assert.ok(
      error instanceof ReadonlyViolationError,
      `expected ReadonlyViolationError for ${JSON.stringify(command)}, got ${error}`
    );
    const echo = error.message.indexOf(" Command: ");
    return `DENY: ${echo === -1 ? error.message : error.message.slice(0, echo)}`;
  }
}

/** Assert the parse carried the admitted spelling through as `ok`. */
function assertOkWords(
  command: string,
  values: readonly (string | undefined)[]
): SecurityParseOk {
  const parsed = parseForSecurity(command);
  assert.equal(
    parsed.kind,
    "ok",
    `${JSON.stringify(command)} must parse ok, got ${parsed.kind}`
  );
  assert.deepEqual(
    parsed.words.map((word) => word.value),
    values,
    `${JSON.stringify(command)} word static values`
  );
  return parsed;
}

/** Assert the parse kept the fidelity denial, class included. */
function assertRetained(command: string): void {
  const parsed = parseForSecurity(command);
  assert.equal(
    parsed.kind,
    "vetoed",
    `${JSON.stringify(command)} must stay vetoed, got ${parsed.kind}`
  );
  assert.equal(
    parsed.class,
    "backslash-whitespace",
    `${JSON.stringify(command)} veto class`
  );
}

/**
 * Every consumer's answer for one command, as a comparable record. Used to
 * state an admitted spelling's answer and its plain-spelling equivalent side
 * by side without hand-transcribing five separate call sites.
 */
interface ConsumerAnswers {
  readonly isAllowedCommand: boolean;
  readonly declarative: boolean;
  readonly extract: string | undefined;
  readonly role: string | undefined;
  readonly readonly: string;
}

function observe(command: string, rule = bashRule("cat:*")): ConsumerAnswers {
  return {
    isAllowedCommand: isAllowedCommand(command),
    declarative: rule(command),
    extract: extractSingleReadPath(command),
    role: detectBashGrepSubstitution(command),
    readonly: readonlyAnswer(command),
  };
}

describe("#1188 admitted escaped-space spellings reach the `ok` arm (SC4)", () => {
  it("`cat\\ foo bar` folds the escape INTO the operand and the ledger books it", () => {
    const shape = `cat foo${BS} bar.ts`;
    assertOkWords(shape, ["cat", "foo bar.ts"]);
    // The recorded path is the FOLDED static value, not the raw spelling.
    assert.equal(extractSingleReadPath(shape), "foo bar.ts");
    assert.equal(isAllowedCommand(shape), true);
    assert.equal(bashRule("cat:*")(shape), true);
    assert.equal(readonlyAnswer(shape), "ALLOW");
    assert.equal(detectBashGrepSubstitution(shape), undefined);
  });

  it("an escaped space never invents a second operand", () => {
    // The escaped space belongs to ONE word, so the file count stays at two
    // and the single-file contract abstains — the same answer the plain
    // two-operand spelling gives.
    const twoOperands = `cat foo${BS} bar.ts baz.ts`;
    assertOkWords(twoOperands, ["cat", "foo bar.ts", "baz.ts"]);
    assert.equal(extractSingleReadPath(twoOperands), undefined);
    assert.equal(extractSingleReadPath("cat foo bar.ts baz.ts"), undefined);
  });

  it("`cat\\ a.ts` is ONE word — the escape is inside the command word, not a separator", () => {
    const shape = `cat${BS} a.ts`;
    const parsed = assertOkWords(shape, ["cat a.ts"]);
    assert.equal(parsed.commands.length, 1);
    assert.deepEqual(
      parsed.commands[0]!.argv.map((word) => word.text),
      [`cat${BS} a.ts`],
      "one argv word, whose raw text is the whole command"
    );
    // Bash agrees: with no separator before the escape, the command NAME is
    // `cat a.ts`. So the extractor records nothing and the readonly gate
    // refuses — the same direction as any other unknown command name.
    assert.equal(extractSingleReadPath(shape), undefined);
    assert.equal(isAllowedCommand(shape), false);
    assert.equal(bashRule("cat:*")(shape), false);
    assert.match(readonlyAnswer(shape), /^DENY: /);
    // The control that separates the two readings: a real separator.
    assertOkWords("cat a.ts", ["cat", "a.ts"]);
    assert.equal(extractSingleReadPath("cat a.ts"), "a.ts");
  });

  it("`grep x\\ f` keeps one pattern word and the substitution gate now FIRES", () => {
    const shape = `grep x${BS} f`;
    assertOkWords(shape, ["grep", "x f"]);
    assert.equal(detectBashGrepSubstitution(shape), "grep");
    assert.equal(bashRule("grep:*")(shape), true);
    assert.equal(readonlyAnswer(shape), "ALLOW");
    // The pattern consumed the only operand, so there is no file to book —
    // the same abstention the plain spelling makes.
    assert.equal(extractSingleReadPath(shape), undefined);
    assert.equal(extractSingleReadPath(`grep x${BS} f y`), "y");
    assert.equal(isAllowedCommand(shape), false);
  });

  it("the spec's `ls --time-style` spelling admits with a complete static value", () => {
    const shape = `ls -lt --time-style=+%m-%d${BS} %H:%M docs/evidence`;
    assertOkWords(shape, [
      "ls",
      "-lt",
      "--time-style=+%m-%d %H:%M",
      "docs/evidence",
    ]);
    assert.equal(isAllowedCommand(shape), true);
    assert.equal(readonlyAnswer(shape), "ALLOW");
  });
});

describe("#1188 admitted separator continuations keep the words separate (SC4)", () => {
  it("the two words either side of `\\`+LF stay two words", () => {
    const shape = `cat -n ${BS}${LF} b.ts`;
    const parsed = assertOkWords(shape, ["cat", "-n", "b.ts"]);
    // The escaped break is content, not a statement separator: it is absent
    // from `bareNewlineOffsets`, so the facts arm derives no cut from it.
    assert.deepEqual(parsed.bareNewlineOffsets, []);
    assert.deepEqual(parsed.operators, []);
    assert.equal(bashRule("cat:*")(shape), true);
    assert.equal(readonlyAnswer(shape), "ALLOW");
    assert.equal(detectBashGrepSubstitution(shape), undefined);
  });

  it("the gate recognizes a grep led across an admitted continuation", () => {
    const shape = `grep x ${BS}${LF} f`;
    assertOkWords(shape, ["grep", "x", "f"]);
    assert.equal(detectBashGrepSubstitution(shape), "grep");
    assert.equal(bashRule("grep:*")(shape), true);
    assert.equal(readonlyAnswer(shape), "ALLOW");
  });

  it("the spec's `gh issue view` continuation admits with both sides intact", () => {
    const shape = `gh issue view 1188 --json number,title ${BS}${LF} -q '.title'`;
    assertOkWords(shape, [
      "gh",
      "issue",
      "view",
      "1188",
      "--json",
      "number,title",
      "-q",
      ".title",
    ]);
    // `gh` is neither an allowed wall token nor a readonly policy command, so
    // the ordinary permission direction is unchanged by the admission.
    assert.equal(isAllowedCommand(shape), false);
    assert.match(readonlyAnswer(shape), /^DENY: /);
  });

  it("KNOWN DISAGREEMENT: `isAllowedCommand` still reads the raw LF in the unit", () => {
    const shape = `cat -n ${BS}${LF} b.ts`;
    const plain = "cat -n b.ts";
    // The admitted parse publishes no newline fact, so `parseBoundedUnits`
    // keeps the whole command as ONE unit — raw text and the escaped LF in
    // it. `isSegmentAllowed`'s metachar list still refuses a unit carrying
    // `\n`, so the wall gate denies the continuation while allowing its
    // plain-spelling equivalent. Fail-closed, and unchanged by #1188: the
    // text fold denied it too while the shape was vetoed.
    assert.equal(isAllowedCommand(shape), false);
    assert.equal(isAllowedCommand(plain), true);
  });

  it("the read ledger now books the same path as the plain spelling (SC4)", () => {
    // `bash-read-extract.ts#stepEscape` used to append the escaped byte, so a
    // continuation contributed a literal LF token the argv facts do not have and
    // operand placement shifted. Bash drops both bytes of a backslash-newline and
    // keeps the token building, so the extractor now resolves the continuation
    // and the single-file contract agrees with the admitted semantics. An even
    // run still leaves the byte after the pair as an ordinary literal/separator.
    assert.equal(extractSingleReadPath(`cat -n ${BS}${LF} b.ts`), "b.ts");
    assert.equal(extractSingleReadPath("cat -n b.ts"), "b.ts");
    assert.equal(extractSingleReadPath(`grep -n ${BS}${LF} x f`), "f");
    assert.equal(extractSingleReadPath("grep -n x f"), "f");
  });

  it("the escaped-SPACE spelling has no such disagreement", () => {
    // Control for the two rows above: the escaped space folds into a
    // character, never a token, so every consumer agrees with the plain
    // spelling on all five entries.
    assert.deepEqual(observe(`cat foo${BS} bar.ts`), {
      isAllowedCommand: true,
      declarative: true,
      extract: "foo bar.ts",
      role: undefined,
      readonly: "ALLOW",
    });
  });
});

describe("#1188 retained fidelity spellings keep their non-`ok` contracts (SC4)", () => {
  it("a mid-word LF join stays `vetoed` and records nothing / stays silent", () => {
    const midWord = `a${BS}${LF}b`;
    const inOperand = `cat a${BS}${LF}b.ts`;
    for (const shape of [midWord, inOperand]) {
      assertRetained(shape);
      assert.equal(extractSingleReadPath(shape), undefined);
      assert.equal(detectBashGrepSubstitution(shape), undefined);
    }
  });

  it("a double-quoted LF continuation stays `vetoed`", () => {
    const shape = `echo "x${BS}${LF}y"`;
    assertRetained(shape);
    assert.equal(extractSingleReadPath(shape), undefined);
    assert.equal(detectBashGrepSubstitution(shape), undefined);
  });

  it("backslash+TAB, backslash+CRLF and an even-parity run stay `vetoed`", () => {
    for (const shape of [
      `cat a${BS}${TAB}b.ts`,
      `cat a${BS}\r${LF}b.ts`,
      `cat a${BS}${BS} b.ts`,
    ]) {
      assertRetained(shape);
      assert.equal(extractSingleReadPath(shape), undefined);
      assert.equal(detectBashGrepSubstitution(shape), undefined);
    }
  });

  it("a leading or word-adjacent continuation with no space on the far side stays `vetoed`", () => {
    // The settle predicate requires a space on BOTH sides of the backslash/LF
    // pair. `cat a\`+LF+`b.ts` is a mid-word join, not a separator; the
    // leading form has nothing before the run at all.
    for (const shape of [`cat a${BS}${LF}b.ts`, `${BS}${LF}cat a.ts`]) {
      assertRetained(shape);
      assert.equal(extractSingleReadPath(shape), undefined);
      assert.equal(detectBashGrepSubstitution(shape), undefined);
    }
  });

  it("an affected word whose static value is incomplete stays `vetoed`", () => {
    // `$TMPDIR/a\ b.cjs` is one word holding an expansion, so its static
    // value is undefined and the site is not settled (SC2a). The control
    // moves the expansion into a DIFFERENT word: the affected word is then
    // complete and the same escape admits — which is what makes the
    // retention reason the incomplete word rather than the mere presence of
    // an expansion.
    const affected = `rm -f $TMPDIR/a${BS} b.cjs`;
    const elsewhere = `rm -f $TMPDIR /tmp/a${BS} b.cjs`;
    assertRetained(affected);
    assertOkWords(elsewhere, ["rm", "-f", undefined, "/tmp/a b.cjs"]);
    for (const shape of [affected, elsewhere]) {
      assert.equal(extractSingleReadPath(shape), undefined);
      assert.equal(detectBashGrepSubstitution(shape), undefined);
      assert.match(readonlyAnswer(shape), /^DENY: /);
    }
  });

  it("each retained row answers through the non-`ok` arm, not the `ok` one", () => {
    // `ok` consumers stay silent / record nothing on the strength of the
    // verdict alone. `isAllowedCommand` and declarative matching declare a
    // text-fold answer for the whole non-`ok` set, so the rows pin that
    // answer rather than pretending the shape is simply unknown.
    const retainedTab = `cat a${BS}${TAB}b.ts`;
    assertRetained(retainedTab);
    // Text fold: one segment, no redirect stripped, no metachar → allowed.
    assert.equal(isAllowedCommand(retainedTab), true);
    // Declarative: the quote-blind char arm sees no `;`/`&`/`|`/`\n`/`\r`
    // cut (the LF is preceded by the backslash the arm consumes), so the
    // one segment matches `cat:*`.
    assert.equal(bashRule("cat:*")(retainedTab), true);
  });
});

describe("#1188 operator-adjacent continuations are retained and no looser (SC5)", () => {
  it("continuation before `&&` a destructive command: retained, and not looser", () => {
    const plain = "ls && rm -rf /tmp/x";
    const continued = `ls ${BS}${LF}&& rm -rf /tmp/x`;
    assert.equal(parseForSecurity(plain).kind, "ok");
    assertRetained(continued);
    // Every consumer answer matches the plain spelling, so the retained
    // shape is not a way around the destructive tail.
    assert.deepEqual(observe(continued), observe(plain));
    assert.equal(isAllowedCommand(continued), isAllowedCommand(plain));
  });

  it("continuation before a pipeline operator: retained, and not looser", () => {
    const plain = "ls | cat b";
    const continued = `ls ${BS}${LF}| cat b`;
    assert.equal(parseForSecurity(plain).kind, "ok");
    assertRetained(continued);
    assert.deepEqual(observe(continued), observe(plain));
  });

  it("continuation before a redirect: retained, and strictly stricter", () => {
    const plain = "cat a > /tmp/out";
    const continued = `cat a ${BS}${LF}> /tmp/out`;
    assert.equal(parseForSecurity(plain).kind, "ok");
    assertRetained(continued);
    // Readonly refuses both on the output redirect, and the ledger stays
    // silent for both. The wall gate is the one row that tightens: on the
    // text fold the `>` is not a cut, so the unit still carries the LF and
    // is refused. Stricter is the safe direction and is asserted, not
    // excused.
    assert.equal(readonlyAnswer(continued), readonlyAnswer(plain));
    assert.equal(extractSingleReadPath(continued), extractSingleReadPath(plain));
    assert.equal(isAllowedCommand(continued), false);
    assert.equal(isAllowedCommand(plain), true);
  });

  it("continuation before a nested substitution: retained, and not looser", () => {
    const plain = "ls $(echo x)";
    const continued = `ls ${BS}${LF}$(echo x)`;
    assert.equal(parseForSecurity(plain).kind, "ok");
    assertRetained(continued);
    assert.deepEqual(observe(continued), observe(plain));
  });

  it("a continuation INSIDE one command's words stays admitted and unchanged", () => {
    // The contrast for the four rows above: the admitted position is
    // word-to-word, where a space exists on both sides of the pair.
    assertOkWords(`cat a.ts ${BS}${LF} b.ts`, ["cat", "a.ts", "b.ts"]);
    assertRetained(`cat a.ts ${BS}${LF}&& rm -rf /tmp/x`);
  });
});
