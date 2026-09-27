/**
 * The `ok` payload's segmentation view, part C: `operators[]`, `quotedSpans`,
 * and the bare newline / carriage-return offsets — the parse-derived list
 * structure the Stage-4a consumers re-home onto (SC-S4-1's background-`&`
 * denial, SC-S4-2's newline / CR keep, SC-S4-3's superset separators).
 *
 * Two claims run through every case. First, a separator fact exists only
 * where the GRAMMAR tokenized a separator at a statement scope: a `;` inside
 * quotes, an `&` inside `$((...))`, a `|` alternating case patterns, and the
 * `;;` closing a case item all keep the list silent — the fact abstains
 * rather than inventing a boundary. Second, every span and offset is read as
 * a JS string index into the verbatim `text`, the sibling fact files' rule.
 *
 * The parity of this view against the current segmentation is the sibling
 * `shell-parse-segmentation-parity.test.ts`; verdict arms other than `ok`
 * carry no facts at all and are declared in
 * `docs/shell-parse-non-ok-consumer-contracts.md`.
 */

import { describe, it, expect } from "vitest";

import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
import type {
  CommandFact,
  OperatorFact,
  SecurityParseOk,
} from "../../../src/harness/permission/shell-parse.js";

function okPayload(command: string): SecurityParseOk {
  const result = parseForSecurity(command);
  if (result.kind !== "ok") {
    throw new Error(
      `expected the ok arm for ${JSON.stringify(command)}, got ${JSON.stringify(result)}`
    );
  }
  return result;
}

function operatorsOf(ok: SecurityParseOk): readonly OperatorFact[] {
  const facts: readonly OperatorFact[] | undefined = ok.operators;
  expect(Array.isArray(facts), "the ok payload carries operators[]").toBe(true);
  return facts ?? [];
}

/**
 * One operator read back out of the verbatim text: the token slice must be
 * the separator's own characters, so a fact that stored byte offsets or a
 * re-derived span fails here instead of passing on a lucky index.
 */
function expectOperator(
  ok: SecurityParseOk,
  index: number,
  expected: {
    kind: OperatorFact["kind"];
    token: string;
    depth: number;
    left: number | null;
    right: number | null;
  }
): OperatorFact {
  const fact = operatorsOf(ok)[index];
  expect(fact, `operators[${index}] exists`).toBeDefined();
  expect(fact!.kind).toBe(expected.kind);
  expect(ok.text.slice(fact!.span.start, fact!.span.end)).toBe(expected.token);
  expect(fact!.depth).toBe(expected.depth);
  expect(fact!.leftCommandIndex).toBe(expected.left);
  expect(fact!.rightCommandIndex).toBe(expected.right);
  return fact!;
}

function commandsOf(ok: SecurityParseOk): readonly CommandFact[] {
  return ok.commands;
}

describe("operators[] names every statement separator the grammar tokenized", () => {
  it("publishes the sequence boundary of `;`", () => {
    const ok = okPayload("ls; pwd");
    expectOperator(ok, 0, {
      kind: "sequence",
      token: ";",
      depth: 0,
      left: 0,
      right: 1,
    });
    expect(operatorsOf(ok)).toHaveLength(1);
  });

  it("publishes the and / or boundaries of `&&` and `||`", () => {
    expectOperator(okPayload("ls && pwd"), 0, {
      kind: "and",
      token: "&&",
      depth: 0,
      left: 0,
      right: 1,
    });
    expectOperator(okPayload("ls || pwd"), 0, {
      kind: "or",
      token: "||",
      depth: 0,
      left: 0,
      right: 1,
    });
  });

  it("separates the background `&` from the and-`&&`", () => {
    const ok = okPayload("ls & pwd");
    expectOperator(ok, 0, {
      kind: "background",
      token: "&",
      depth: 0,
      left: 0,
      right: 1,
    });
    // SC-S4-1 (1c) needs the terminating-`&` shape with no trailing command.
    expectOperator(okPayload("ls &"), 0, {
      kind: "background",
      token: "&",
      depth: 0,
      left: 0,
      right: null,
    });
    expect(operatorsOf(okPayload("ls && pwd"))
      .filter((o) => o.kind === "background")).toHaveLength(0);
  });

  it("publishes the pipeline joins of `|` and `|&`", () => {
    expectOperator(okPayload("cat f | grep x"), 0, {
      kind: "pipe",
      token: "|",
      depth: 0,
      left: 0,
      right: 1,
    });
    expectOperator(okPayload("a |& b"), 0, {
      kind: "pipe-both",
      token: "|&",
      depth: 0,
      left: 0,
      right: 1,
    });
  });

  it("chains a flat list and a flat pipeline through adjacent commands", () => {
    const chain = okPayload("a && b && c");
    expectOperator(chain, 0, { kind: "and", token: "&&", depth: 0, left: 0, right: 1 });
    // The left-recursive grammar nests the inner `a && b`; the second `&&`
    // still resolves its left neighbour to `b`.
    expectOperator(chain, 1, { kind: "and", token: "&&", depth: 0, left: 1, right: 2 });
    const pipeline = okPayload("cat f | grep x | wc -l");
    expectOperator(pipeline, 0, { kind: "pipe", token: "|", depth: 0, left: 0, right: 1 });
    expectOperator(pipeline, 1, { kind: "pipe", token: "|", depth: 0, left: 1, right: 2 });
  });

  it("reports the depth of its statement scope, matching the commands it joins", () => {
    const nested = okPayload("echo $(ls | pwd)");
    expectOperator(nested, 0, {
      kind: "pipe",
      token: "|",
      depth: 1,
      left: 1,
      right: 2,
    });
    for (const command of commandsOf(nested)) {
      if (command.index === 1 || command.index === 2) {
        expect(command.depth).toBe(1);
      }
    }
    const subshell = okPayload("(ls; pwd)");
    expectOperator(subshell, 0, {
      kind: "sequence",
      token: ";",
      depth: 1,
      left: 0,
      right: 1,
    });
  });

  it("keeps scope-internal statement separators as facts of that scope", () => {
    const braces = okPayload("{ ls; pwd; }");
    expectOperator(braces, 0, { kind: "sequence", token: ";", depth: 1, left: 0, right: 1 });
    expectOperator(braces, 1, { kind: "sequence", token: ";", depth: 1, left: 1, right: null });
    const loop = okPayload("for i in 1; do ls; done");
    // The header `;` borders a `number` and a `do_group`: boundaries exist,
    // attribution abstains. The body `;` resolves left to `ls`, right to the
    // `done` keyword, which is not a statement.
    expectOperator(loop, 0, { kind: "sequence", token: ";", depth: 1, left: null, right: null });
    expectOperator(loop, 1, { kind: "sequence", token: ";", depth: 1, left: 0, right: null });
    const branch = okPayload("if ls; then pwd; fi");
    expectOperator(branch, 0, { kind: "sequence", token: ";", depth: 1, left: 0, right: 1 });
    expectOperator(branch, 1, { kind: "sequence", token: ";", depth: 1, left: 1, right: null });
  });

  it("resolves attribution through one redirected_statement wrapper", () => {
    // SC-S4-1 (1c) must see `sleep 5 > log &` as backgrounded even though the
    // `&` borders the wrapper, not the bare command node.
    expectOperator(okPayload("sleep 5 > log &"), 0, {
      kind: "background",
      token: "&",
      depth: 0,
      left: 0,
      right: null,
    });
  });

  it("sorts operators by span start", () => {
    const ok = okPayload("{ ls; pwd; }; cd /; ls");
    const starts = operatorsOf(ok).map((fact) => fact.span.start);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
  });

  it("keeps the `&>` redirect out of the background operators", () => {
    expect(operatorsOf(okPayload("ls &>/dev/null"))).toHaveLength(0);
    expect(operatorsOf(okPayload("ls 2>&1"))).toHaveLength(0);
  });
});

describe("operators[] abstains where the grammar says the character is not a separator", () => {
  it("stays silent for separators inside quoted content", () => {
    for (const command of [
      "echo 'a; b'",
      "echo \"a && b\"",
      "echo 'a & b'",
      "echo 'a | b'",
    ]) {
      expect(operatorsOf(okPayload(command)), command).toHaveLength(0);
    }
  });

  it("stays silent for the escaped separator literal", () => {
    // `find . \;`-style spellings keep the separator inside one word; the
    // splitter's `\;` literal rule (SC-S3-3's retired pin) re-derives here.
    expect(operatorsOf(okPayload("ls\\; pwd"))).toHaveLength(0);
  });

  it("stays silent for bitwise `&` and `|` inside arithmetic", () => {
    expect(operatorsOf(okPayload("echo $((1 & 2))"))).toHaveLength(0);
    expect(operatorsOf(okPayload("echo $((1 | 2))"))).toHaveLength(0);
  });

  it("stays silent for the case-item separator and pattern alternation", () => {
    const ok = okPayload("case x in a) ls;; esac");
    expect(operatorsOf(ok)).toHaveLength(0);
    expect(commandsOf(ok)).toHaveLength(1);
    // An unquoted `a|b` pattern reaches the grammar's rejected extglob type
    // and never gets as far as the fact view — the roster is not widened for
    // it (verdict contract, SC-S3-1's dependency note).
    expect(parseForSecurity("case x in a|b) ls;; esac").kind).toBe(
      "unknown-syntax"
    );
  });

  it("stays empty for the bare-operator carve-out trees", () => {
    // The commandless bodies the verdict contract grades `ok` with an ERROR
    // wrapper: no list exists, so no boundary is claimable; the zero-command
    // count is what the consumers answer with (SC-S4-1 rule (2)).
    for (const command of [";", "&&", "|", "&", ">>"]) {
      const ok = okPayload(command);
      expect(operatorsOf(ok), command).toHaveLength(0);
      expect(commandsOf(ok), command).toHaveLength(0);
    }
  });
});

describe("bare newline / carriage-return offsets answer the quoted-outside question", () => {
  it("records a bare newline with no separator token", () => {
    const ok = okPayload("echo a\nls");
    expect(ok.bareNewlineOffsets).toEqual([6]);
    expect(ok.text[6]).toBe("\n");
    expect(ok.bareCarriageReturnOffsets).toEqual([]);
  });

  it("records a bare carriage return", () => {
    const ok = okPayload("echo a\rb");
    expect(ok.bareCarriageReturnOffsets).toEqual([6]);
    expect(ok.text[6]).toBe("\r");
    expect(ok.bareNewlineOffsets).toEqual([]);
  });

  it("records both halves of a CRLF pair", () => {
    const ok = okPayload("echo a\r\nb");
    expect(ok.bareCarriageReturnOffsets).toEqual([6]);
    expect(ok.bareNewlineOffsets).toEqual([7]);
  });

  it("exempts line breaks inside every quoted spelling", () => {
    for (const command of [
      "echo \"a\nb\"",
      "echo 'a\nb'",
      "echo $'a\nb'",
    ]) {
      const ok = okPayload(command);
      expect(ok.bareNewlineOffsets, command).toEqual([]);
      expect(ok.bareCarriageReturnOffsets, command).toEqual([]);
    }
  });

  it("exempts heredoc bodies but not the line ending the opener", () => {
    const quoted = okPayload("cat <<'EOF'\nx\nEOF");
    const body = quoted.heredocs[0];
    expect(body).toBeDefined();
    // The body starts at the `x` (offset 12) and carries the newline at 13 —
    // protected — while the opener line's own break at 11 stays bare.
    expect(body!.bodySpan.start).toBe(12);
    expect(quoted.text[13]).toBe("\n");
    expect(quoted.bareNewlineOffsets).toEqual([11]);
  });

  it("counts newlines inside unquoted statement groupings as bare", () => {
    const ok = okPayload("(echo a\nls)");
    expect(ok.bareNewlineOffsets).toEqual([7]);
  });

  it("reports a break that also separates — with the operator facts side by side", () => {
    const ok = okPayload("echo a\nls && pwd");
    expect(ok.bareNewlineOffsets).toEqual([6]);
    expect(operatorsOf(ok).map((fact) => fact.kind)).toEqual(["and"]);
  });
});

describe("quotedSpans publishes the quote state of every quoted site", () => {
  it("covers argv words with the raw text and quote kind kept", () => {
    // SC-S4-1 rule (3): the readonly flag tables compare RAW token text, so
    // `find . -name "-delete"` must stay answerable — the quotes are visible
    // in the fact and the folded value is a separate field.
    const ok = okPayload('find . -name "-delete"');
    const word = ok.commands[0]!.argv.at(-1);
    expect(word!.text).toBe('"-delete"');
    expect(word!.quoteKind).toBe("double");
    expect(word!.value).toBe("-delete");
    const span = ok.quotedSpans[0];
    expect(ok.text.slice(span!.start, span!.end)).toBe('"-delete"');
  });

  it("covers quoted sites the argv view does not carry", () => {
    const ok = okPayload("case x in 'a|b') ls;; esac");
    const covered = ok.quotedSpans.some(
      (span) => ok.text.slice(span.start, span.end) === "'a|b'"
    );
    expect(covered).toBe(true);
    expect(operatorsOf(ok)).toHaveLength(0);
  });

  it("sorts by span start", () => {
    const ok = okPayload('echo "a" && ls "b"');
    const starts = ok.quotedSpans.map((span) => span.start);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
  });
});

describe("substitution boundaries name the inner command for the silent-body scope", () => {
  it("marks a command-substitution body with depth and owner", () => {
    const ok = okPayload("echo $(grep x f)");
    expect(ok.substitutions).toHaveLength(1);
    const site = ok.substitutions[0]!;
    expect(site.kind).toBe("dollar-paren");
    const inner = ok.commands[site.innerCommandIndex!];
    expect(inner!.argv.map((word) => word.text)).toEqual(["grep", "x", "f"]);
    expect(inner!.depth).toBeGreaterThan(0);
    expect(inner!.parentId).toBe(site.ownerCommandIndex);
    expect(ok.commands[site.ownerCommandIndex!]!.argv[0]!.text).toBe("echo");
  });

  it("does not treat a pipeline part as a substitution body", () => {
    const ok = okPayload("cat f | grep x");
    expect(ok.substitutions).toHaveLength(0);
    for (const command of ok.commands) {
      expect(command.depth).toBe(0);
    }
  });
});
