/**
 * Stage 0 bullet T3: the `ok` payload's redirect / heredoc / inert fact lists,
 * the `nodeTypes` histogram, and the shape of the two arms that carry no facts
 * (`unknown-syntax`, `malformed`).
 *
 * Contract source: `specs/shell-parse-foundation.md`, Boundaries → `ok` payload
 * bullets for `redirects[]` / `heredocs[]` / `inert[]` / `nodeTypes`, the
 * `SecurityParseUnknownSyntax` arm, and criterion SC16 — its (α) population
 * clause, (i) the quoted/unquoted pair, (ii) one-owner-per-number, (iii) span
 * units, (β) the unknown-syntax pair. The arm table in Assumption 4 is what the
 * malformed twin pins here.
 *
 * SC16(α) is honoured literally: every fact gets an assertion on an input that
 * CAN populate it, so no `length === 0` pin stands in for coverage. Where an
 * empty-list assertion does appear it is the other side of a discriminating
 * pair — the same field is populated by the paired input a few lines away —
 * never that field's only read. Every span is checked by slicing `text` and
 * comparing the substring, so a byte-offset implementation cannot pass by
 * accident.
 *
 * STATE OF THIS FILE: red by construction. `shell-parse.ts` today declares the
 * ok arm as `{ kind, text, nodeTypes }` only, so each fact read below fails on
 * the "the payload carries redirects[]" assertion before it can fail on any
 * value. That is the deliverable — a separate worker turns it green.
 */

import { describe, expect, it } from "vitest";

import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
import type {
  HeredocFact,
  InertFact,
  RedirectFact,
  SecurityParseOk,
  WordFact,
} from "../../../src/harness/permission/shell-parse.js";

/** A payload span is `{ start, end }` in JS string indices (SC16's containment predicate). */
interface SpanLike {
  readonly start: number;
  readonly end: number;
}

/**
 * One quoted-delimiter body reused by three cases (`cat`, `python3`, non-ASCII
 * receiver) so the only thing that varies between them is the receiver word.
 * `$(whoami)` and `${HOME}` are data inside a quoted body — which is why SC16
 * names this body. Plain strings: nothing here interpolates.
 */
const DATA_BODY = "$(whoami)\n${HOME}\n";
const QUOTED_CAT = `cat <<'EOF'\n${DATA_BODY}EOF`;
const UNQUOTED_CAT = `cat <<EOF\n${DATA_BODY}EOF`;
const QUOTED_PY = `python3 <<'EOF'\n${DATA_BODY}EOF`;
/** SC16 (iii)'s span-unit input: the receiver is 2 characters / 4 UTF-8 bytes. */
const NON_ASCII_QUOTED = `echo 名前 <<'EOF'\n${DATA_BODY}EOF`;

/**
 * The input whose parse lands on the unknown-syntax arm, found by probing the
 * installed grammar rather than by guessing: `[[ =~ ]]` yields `regex` and
 * `[[ == @(a|b) ]]` yields `extglob_pattern`, the two types the frozen roster
 * in `shell-parse.ts` deliberately excludes. Each appears twice in one clean
 * parse, so the input tests dedup and sorting as well as membership.
 * `time ls` was rejected (it parses to plain `word` nodes, no exotic type) and
 * `function x((a)) { :; }` was rejected (it carries an ERROR node, so it is a
 * malformed case, not an unknown-syntax one).
 */
const EXOTIC_COMMAND =
  "[[ $a =~ ^x-[0-9]+$ || $b =~ ^y-[0-9]+$ ]] " +
  "&& [[ $c == @(p|q) || $d == @(r|s) ]]";

/** Every heredoc shape the two-views-agree sweep walks. */
const HEREDOC_SHAPES: readonly string[] = [
  QUOTED_CAT,
  UNQUOTED_CAT,
  QUOTED_PY,
  NON_ASCII_QUOTED,
  "cat <<-EOF\n\tbody\n\tEOF",
  "while read x; do : ; done <<EOF\nb\nEOF",
  "cat <<'A'\nfirst\nA\ngrep <<'B'\nsecond\nB",
];

function okPayload(command: string): SecurityParseOk {
  const result = parseForSecurity(command);
  if (result.kind !== "ok") {
    throw new Error(
      `expected the ok arm for ${JSON.stringify(command)}, got ${JSON.stringify(result)}`
    );
  }
  return result;
}

function sliceOf(ok: SecurityParseOk, span: SpanLike): string {
  return ok.text.slice(span.start, span.end);
}

/**
 * A payload list, read behind a presence assertion: a missing field has to fail
 * as "the ok payload carries no redirects[]" rather than as a TypeError or —
 * worse — as a silently empty list that lets a length pin pass.
 */
function asList<T>(
  ok: SecurityParseOk,
  field: string,
  list: readonly T[] | undefined
): readonly T[] {
  expect(
    Array.isArray(list),
    `${field}[] is a list on the ok payload of ${JSON.stringify(ok.text)}`
  ).toBe(true);
  return list ?? [];
}

function redirectsOf(ok: SecurityParseOk): readonly RedirectFact[] {
  return asList(ok, "redirects", ok.redirects);
}

function heredocsOf(ok: SecurityParseOk): readonly HeredocFact[] {
  return asList(ok, "heredocs", ok.heredocs);
}

function inertOf(ok: SecurityParseOk): readonly InertFact[] {
  return asList(ok, "inert", ok.inert);
}

function wordsOf(ok: SecurityParseOk): readonly WordFact[] {
  return asList(ok, "words", ok.words);
}

/** `<<` and `<<-` are the heredoc-redirect ops; `<<<` (a here-string) is not one. */
function isHeredocOp(op: string): boolean {
  return op.startsWith("<<") && op !== "<<<";
}

function sameSpan(a: SpanLike | undefined, b: SpanLike | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.start === b.start && a.end === b.end;
}

/**
 * The command word an owner / receiver index points at, resolved through
 * `commands[]`'s own `index` field — the numbering both `heredocs[]` and
 * `redirects[]` promise their nullable index shares with it.
 */
function commandWordAt(ok: SecurityParseOk, index: number): string {
  const commands = asList(ok, "commands", ok.commands);
  const owner = commands.find((command) => command.index === index);
  expect(
    owner,
    `commands[] carries an entry whose index is ${index} in ${JSON.stringify(ok.text)}`
  ).toBeDefined();
  const head: WordFact | undefined = owner?.argv[0];
  expect(head, "the owning command node has a command word").toBeDefined();
  return head?.text ?? "";
}

function ownerWord(
  ok: SecurityParseOk,
  index: number | null | undefined
): string | null {
  return index === null || index === undefined
    ? null
    : commandWordAt(ok, index);
}

function oneRedirect(ok: SecurityParseOk, op: string): RedirectFact {
  const matches = redirectsOf(ok).filter((entry) => entry.op === op);
  expect(
    matches,
    `exactly one ${op} redirect in ${JSON.stringify(ok.text)}`
  ).toHaveLength(1);
  return matches[0];
}

function oneHeredoc(ok: SecurityParseOk): HeredocFact {
  const heredocs = heredocsOf(ok);
  expect(
    heredocs,
    `exactly one heredoc in ${JSON.stringify(ok.text)}`
  ).toHaveLength(1);
  return heredocs[0];
}

function inertBodies(ok: SecurityParseOk): readonly InertFact[] {
  return inertOf(ok).filter((entry) => entry.why === "heredoc-body");
}

function soleWhy(
  ok: SecurityParseOk,
  why: InertFact["why"]
): readonly InertFact[] {
  return inertOf(ok).filter((entry) => entry.why === why);
}

describe("redirects[] — operator, fd arm and quote-aware target", () => {
  it("records a bare > with no fd, an unquoted target and its command owner", () => {
    const ok = okPayload("echo a > out.txt");
    const redirect = oneRedirect(ok, ">");
    expect(redirect.op).toBe(">");
    expect(redirect.fd).toBeUndefined();
    expect(redirectsOf(ok)).toHaveLength(1);
    // `delimiterQuoted` belongs to heredoc / here-string entries only.
    expect(redirect.delimiterQuoted).toBeUndefined();
    expect(redirect.bodySpan).toBeUndefined();

    const target: WordFact = redirect.target;
    expect(target.text).toBe("out.txt");
    expect(target.quoteKind).toBe("none");
    expect(target.value).toBe("out.txt");
    expect(sliceOf(ok, target.span)).toBe("out.txt");

    const site = sliceOf(ok, redirect.span);
    expect(site).toContain(redirect.op);
    expect(site).toContain(target.text);
    expect(ownerWord(ok, redirect.ownerCommandIndex)).toBe("echo");
  });

  it("carries the fd when the redirect names one", () => {
    const ok = okPayload("echo a 2> err.log");
    const redirect = oneRedirect(ok, ">");
    expect(redirect.fd).toBeDefined();
    // The payload bullet declares `fd?` without fixing string-vs-number, so the
    // pin reads the descriptor's characters whichever way the field lands.
    expect(String(redirect.fd)).toBe("2");
    expect(sliceOf(ok, redirect.target.span)).toBe("err.log");
    expect(redirect.target.text).toBe("err.log");
    expect(redirect.target.quoteKind).toBe("none");
    expect(ownerWord(ok, redirect.ownerCommandIndex)).toBe("echo");
  });

  it("records < as a redirect whose target is the stdin source", () => {
    const ok = okPayload("cat < in.txt");
    const redirect = oneRedirect(ok, "<");
    expect(redirect.op).toBe("<");
    expect(redirect.fd).toBeUndefined();
    expect(redirect.delimiterQuoted).toBeUndefined();
    expect(redirect.target.text).toBe("in.txt");
    expect(sliceOf(ok, redirect.target.span)).toBe("in.txt");
    expect(ownerWord(ok, redirect.ownerCommandIndex)).toBe("cat");
  });

  it("keeps >> distinct from >", () => {
    const ok = okPayload("echo x >> y");
    const redirect = oneRedirect(ok, ">>");
    expect(redirect.op).toBe(">>");
    expect(sliceOf(ok, redirect.target.span)).toBe("y");
    expect(ownerWord(ok, redirect.ownerCommandIndex)).toBe("echo");
  });

  it("keeps <<- distinct from << and lists it as an unquoted heredoc", () => {
    const ok = okPayload("cat <<-EOF\n\tbody\n\tEOF");
    const redirect = oneRedirect(ok, "<<-");
    expect(redirect.delimiterQuoted).toBe(false);
    expect(redirect.ownerCommandIndex).not.toBeNull();
    expect(ownerWord(ok, redirect.ownerCommandIndex)).toBe("cat");

    const heredoc = oneHeredoc(ok);
    expect(heredoc.delimiterQuoted).toBe(false);
    expect(heredoc.receiverCommandIndex).toBe(redirect.ownerCommandIndex);
    expect(redirect.bodySpan).toEqual(heredoc.bodySpan);
    // (8b): bodySpan is verbatim text, so the slice is a substring of `text`
    // and the tabs bash would strip at run time are still in it for Stage 1.
    const body = sliceOf(ok, heredoc.bodySpan);
    expect(body).toContain("body");
    expect(body).toContain("\n");
    expect(inertBodies(ok)).toEqual([]);
  });

  it("records a <<< here-string as a redirect, and not as a heredoc", () => {
    const ok = okPayload(": <<< here");
    const redirect = oneRedirect(ok, "<<<");
    expect(redirect.target.text).toBe("here");
    expect(redirect.target.quoteKind).toBe("none");
    expect(sliceOf(ok, redirect.target.span)).toBe("here");
    expect(redirect.delimiterQuoted).toBe(false);
    // `:` is itself a command node, so this owner is non-null.
    expect(ownerWord(ok, redirect.ownerCommandIndex)).toBe(":");
    // The discrimination, not the coverage: a here-string is not a heredoc,
    // while every shape in HEREDOC_SHAPES populates the list.
    expect(heredocsOf(ok)).toHaveLength(0);
  });

  it("keeps the quotes in the target text and folds them in its value", () => {
    const ok = okPayload("echo a > 'out file.txt'");
    const target = oneRedirect(ok, ">").target;
    expect(target.quoteKind).toBe("single");
    expect(target.text).toBe("'out file.txt'");
    expect(target.value).toBe("out file.txt");
    expect(sliceOf(ok, target.span)).toBe("'out file.txt'");
  });

  it("answers a double-quoted target and leaves its value undefined under an expansion", () => {
    const ok = okPayload('echo x > "$HOME/f"');
    const target = oneRedirect(ok, ">").target;
    expect(target.quoteKind).toBe("double");
    expect(target.text).toBe('"$HOME/f"');
    // WordFact.value is the statically-known literal only; this word carries an
    // expansion, so folding it here would be a false claim about run time.
    expect(target.value).toBeUndefined();
    expect(sliceOf(ok, target.span)).toBe('"$HOME/f"');
  });
});

describe("redirects[].ownerCommandIndex — null is a declared arm", () => {
  it("reports no owner for a bare redirect that is the whole input", () => {
    // SC16 (ii)(c) pins the null shape as its own case. Two ways to fail it:
    // invent an owner (index the target word, or scan `text`), or answer
    // `malformed` — which the ok narrowing in okPayload() already refuses.
    const command = "> /tmp/f";
    const ok = okPayload(command);
    expect(ok.text).toBe(command);
    const redirects = redirectsOf(ok);
    expect(redirects).toHaveLength(1);
    expect(redirects[0].ownerCommandIndex).toBeNull();
    expect(redirects[0].target.text).toBe("/tmp/f");
    expect(redirects[0].target.quoteKind).toBe("none");
  });

  it("attributes the redirect to the command word it sits on inside an && list", () => {
    const ok = okPayload("cd /tmp < f && x");
    const commands = asList(ok, "commands", ok.commands);
    // Two command words exist, so naming the wrong one is a reachable failure.
    expect(commands.length).toBeGreaterThanOrEqual(2);
    const redirect = oneRedirect(ok, "<");
    expect(redirect.ownerCommandIndex).not.toBeNull();
    expect(ownerWord(ok, redirect.ownerCommandIndex)).toBe("cd");
  });

  it("never attributes a list-hoisted redirect to the list's first word", () => {
    // tree-sitter-bash hoists `< f` out of the list in this shape, so the
    // redirect's owner is either the `x` command or nothing at all — both arms
    // the payload declares. What it must never be is `cd`, which is what
    // scanning `text` backwards from the operator would produce.
    const ok = okPayload("cd /tmp && x < f");
    const owner = oneRedirect(ok, "<").ownerCommandIndex;
    // The claim that has to fail is the backwards scan: `cd` is not the owner.
    expect(ownerWord(ok, owner)).not.toBe("cd");
    expect(owner === null || ownerWord(ok, owner) === "x").toBe(true);
  });
});

describe("heredocs[] and inert[] — one pair, quoted vs unquoted delimiter", () => {
  it("lists a quoted-delimiter heredoc in all three views with one body span", () => {
    const ok = okPayload(QUOTED_CAT);
    const heredoc = oneHeredoc(ok);
    expect(heredoc.delimiterQuoted).toBe(true);
    expect(heredoc.receiverCommandIndex).not.toBeNull();
    expect(ownerWord(ok, heredoc.receiverCommandIndex)).toBe("cat");
    expect(sliceOf(ok, heredoc.bodySpan)).toBe(DATA_BODY);

    const redirects = redirectsOf(ok).filter((entry) => isHeredocOp(entry.op));
    expect(redirects).toHaveLength(1);
    const redirect = redirects[0];
    expect(redirect.op).toBe("<<");
    expect(redirect.delimiterQuoted).toBe(true);
    // Two views, one number (SC16 (ii)).
    expect(redirect.bodySpan).toEqual(heredoc.bodySpan);
    expect(redirect.ownerCommandIndex).toBe(heredoc.receiverCommandIndex);

    const bodies = inertBodies(ok);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].why).toBe("heredoc-body");
    // Round 7: Stage 1's inertness test reads the flag on the inert entry.
    expect(bodies[0].delimiterQuoted).toBe(true);
    expect(bodies[0].ownerCommandIndex).toBe(heredoc.receiverCommandIndex);
    expect(sliceOf(ok, bodies[0].span)).toBe(DATA_BODY);
  });

  it("lists the same body under an unquoted delimiter but claims no inert text", () => {
    const ok = okPayload(UNQUOTED_CAT);
    const heredoc = oneHeredoc(ok);
    expect(heredoc.delimiterQuoted).toBe(false);
    expect(ownerWord(ok, heredoc.receiverCommandIndex)).toBe("cat");
    expect(sliceOf(ok, heredoc.bodySpan)).toBe(DATA_BODY);
    // The other side of SC16(i): the body's expansions run at run time, so
    // calling it inert would be a false syntactic claim.
    expect(inertBodies(ok)).toEqual([]);

    const redirect = oneRedirect(ok, "<<");
    expect(redirect.delimiterQuoted).toBe(false);
    expect(redirect.bodySpan).toEqual(heredoc.bodySpan);
    expect(redirect.ownerCommandIndex).toBe(heredoc.receiverCommandIndex);
  });

  it("gives an interpreter receiver the identical fact shape, word aside", () => {
    // Listing, not judging: `python3 <<'EOF'` differs from `cat <<'EOF'` in the
    // receiver word and in nothing else. Stage 1's receiver rule is what turns
    // this body into code, so any shape difference here would be Stage 0
    // smuggling a verdict into a fact list.
    expect(heredocFactShape(QUOTED_PY, "python3")).toEqual(
      heredocFactShape(QUOTED_CAT, "cat")
    );
  });

  it("still lists an interpreter heredoc whose body is not inert", () => {
    // `python3 <<EOF` is the case ADR-0125 §5 most needs to read and the one
    // that had no field pointing at it before `heredocs[]` existed: listed,
    // unquoted, and not inert.
    const ok = okPayload("python3 <<EOF\nimport os\n$(whoami)\nEOF");
    const heredoc = oneHeredoc(ok);
    expect(heredoc.delimiterQuoted).toBe(false);
    expect(ownerWord(ok, heredoc.receiverCommandIndex)).toBe("python3");
    expect(sliceOf(ok, heredoc.bodySpan)).toBe("import os\n$(whoami)\n");
    expect(inertBodies(ok)).toEqual([]);
  });

  it("lists one entry per heredoc and keeps the two bodies apart", () => {
    const ok = okPayload("cat <<'A'\nfirst\nA\ngrep <<'B'\nsecond\nB");
    const heredocs = heredocsOf(ok);
    expect(heredocs).toHaveLength(2);
    expect(heredocs.map((entry) => sliceOf(ok, entry.bodySpan))).toEqual([
      "first\n",
      "second\n",
    ]);
    expect(heredocs.map((entry) => entry.delimiterQuoted)).toEqual([
      true,
      true,
    ]);
    expect(
      heredocs.map((entry) => ownerWord(ok, entry.receiverCommandIndex))
    ).toEqual(["cat", "grep"]);
    expect(inertBodies(ok)).toHaveLength(2);
  });

  it("indexes body spans with JS string indices, not UTF-8 bytes", () => {
    // SC16 (iii): 名前 is 2 characters and 4 bytes, so a byte-offset
    // implementation lands on 20 / 38 here while every ASCII pin above passes.
    const ok = okPayload(NON_ASCII_QUOTED);
    const heredoc = oneHeredoc(ok);
    expect(heredoc.bodySpan.start).toBe(16);
    expect(heredoc.bodySpan.end).toBe(34);
    expect(sliceOf(ok, heredoc.bodySpan)).toBe(DATA_BODY);
    expect(heredoc.delimiterQuoted).toBe(true);
    expect(ownerWord(ok, heredoc.receiverCommandIndex)).toBe("echo");
    const bodies = inertBodies(ok);
    expect(bodies).toHaveLength(1);
    expect(sliceOf(ok, bodies[0].span)).toBe(DATA_BODY);
  });

  it("agrees between the heredocs[] and redirects[] views for every shape", () => {
    for (const shape of HEREDOC_SHAPES) {
      const ok = okPayload(shape);
      const heredocs = heredocsOf(ok);
      expect(heredocs.length, shape).toBeGreaterThan(0);
      const redirects = redirectsOf(ok).filter((entry) =>
        isHeredocOp(entry.op)
      );
      expect(redirects.length, shape).toBe(heredocs.length);
      for (const heredoc of heredocs) {
        expect(heredoc.bodySpan, shape).toBeDefined();
        const matches = redirects.filter((entry) => {
          expect(entry.bodySpan, shape).toBeDefined();
          return sameSpan(entry.bodySpan, heredoc.bodySpan);
        });
        expect(matches.length, shape).toBe(1);
        const redirect = matches[0];
        // One owner per number: (a) equal where both are non-null, (b) null in
        // both directions. The compound-receiver shape is pinned no further
        // than that agreement, which is what (ii)(d) allows.
        expect(redirect.ownerCommandIndex === null, shape).toBe(
          heredoc.receiverCommandIndex === null
        );
        if (
          redirect.ownerCommandIndex !== null &&
          heredoc.receiverCommandIndex !== null
        ) {
          expect(redirect.ownerCommandIndex, shape).toBe(
            heredoc.receiverCommandIndex
          );
        }
        expect(redirect.delimiterQuoted, shape).toBe(heredoc.delimiterQuoted);
      }
    }
  });
});

describe("inert[] — every data span names its why", () => {
  it("marks a single-quoted word inert over the word's own span", () => {
    const ok = okPayload("echo 'a $(whoami) b'");
    const quoted: WordFact | undefined = wordsOf(ok)[1];
    expect(quoted, "the quoted word is words[1]").toBeDefined();
    expect(quoted?.quoteKind).toBe("single");
    expect(quoted?.text).toBe("'a $(whoami) b'");
    expect(quoted?.value).toBe("a $(whoami) b");

    const entries = soleWhy(ok, "single-quoted");
    expect(entries).toHaveLength(1);
    // "over that span": SC16 binds the inert span to the word span, and a word
    // keeps its quoting in `text` — so the quotes are inside the span.
    expect(sliceOf(ok, entries[0].span)).toBe("'a $(whoami) b'");
    expect(entries[0].span).toEqual(quoted?.span);
    expect(entries[0].ownerCommandIndex).not.toBeNull();
    expect(ownerWord(ok, entries[0].ownerCommandIndex)).toBe("echo");
    expect(entries[0].delimiterQuoted).toBeUndefined();
  });

  it("marks every single-quoted word, not just the first", () => {
    const ok = okPayload("printf 'x' 'y'");
    expect(
      soleWhy(ok, "single-quoted").map((entry) => sliceOf(ok, entry.span))
    ).toEqual(["'x'", "'y'"]);
  });

  it("marks a comment inert, expansion syntax and all", () => {
    const ok = okPayload("echo hi # $(whoami)");
    const entries = soleWhy(ok, "comment");
    expect(entries).toHaveLength(1);
    expect(sliceOf(ok, entries[0].span)).toBe("# $(whoami)");
    expect(entries[0].delimiterQuoted).toBeUndefined();
  });

  it("claims no single-quoted inertness for a double-quoted target", () => {
    // The other side of the quote-state pair: a double-quoted word with an
    // expansion is live syntax, so `why: "single-quoted"` must not reach for it.
    const ok = okPayload('echo x > "$HOME/f"');
    expect(soleWhy(ok, "single-quoted")).toEqual([]);
  });
});

describe("nodeTypes on the ok arm", () => {
  it("counts the nodes a redirected command actually has", () => {
    const ok = okPayload("echo a > out.txt");
    expect(ok.nodeTypes["program"]).toBe(1);
    expect(ok.nodeTypes["redirected_statement"]).toBe(1);
    expect(ok.nodeTypes["file_redirect"]).toBe(1);
    expect(ok.nodeTypes["command"]).toBe(1);
    expect(ok.nodeTypes["word"]).toBe(3);
  });

  it("sums to at least the command and word counts of the same result", () => {
    // SC16 (α-node): the floor is read off the same object, so it travels with
    // the implementation instead of with a hand-counted literal — and an empty
    // or stub histogram fails outright.
    const ok = okPayload(QUOTED_CAT);
    const total = Object.values(ok.nodeTypes).reduce(
      (sum, count) => sum + count,
      0
    );
    const commands = asList(ok, "commands", ok.commands);
    expect(total).toBeGreaterThanOrEqual(commands.length + wordsOf(ok).length);
    expect(commands.length).toBeGreaterThan(0);
    expect(wordsOf(ok).length).toBeGreaterThan(0);
  });

  it("keeps unmodelled off the ok arm at the type level", () => {
    const ok = okPayload("echo a > out.txt");
    // @ts-expect-error `unmodelled` is produced only by the unknown-syntax arm
    expect(ok.unmodelled).toBeUndefined();
  });
});

describe("the unknown-syntax arm is an ask, never a deny", () => {
  it("names each out-of-roster type once, sorted", () => {
    const result = parseForSecurity(EXOTIC_COMMAND);
    if (result.kind !== "unknown-syntax") {
      throw new Error(`expected unknown-syntax, got ${result.kind}`);
    }
    expect(result.text).toBe(EXOTIC_COMMAND);
    expect(result.unmodelled).toEqual(["extglob_pattern", "regex"]);
    // Sorted and deduped are separate claims: four offending nodes, two names.
    expect(result.unmodelled).toEqual([...result.unmodelled].sort());
    expect(new Set(result.unmodelled).size).toBe(result.unmodelled.length);
    expect(result.nodeTypes["regex"]).toBe(2);
    expect(result.nodeTypes["extglob_pattern"]).toBe(2);
  });

  it("carries the histogram but none of the payload fact lists", () => {
    const result = parseForSecurity(EXOTIC_COMMAND);
    if (result.kind !== "unknown-syntax") {
      throw new Error(`expected unknown-syntax, got ${result.kind}`);
    }
    // "each arm carrying only the fields that arm can honor", so the shape is
    // closed rather than an optional-field soup.
    expect(Object.keys(result).sort()).toEqual([
      "kind",
      "nodeTypes",
      "text",
      "unmodelled",
    ]);
    for (const field of [
      "words",
      "commands",
      "substitutions",
      "expansions",
      "redirects",
      "heredocs",
      "inert",
    ]) {
      expect(result).not.toHaveProperty(field);
    }
    // (β)'s second half: the histogram rides along, so the ask can explain
    // itself without a re-parse.
    expect(Object.keys(result.nodeTypes).length).toBeGreaterThan(0);
  });

  it("widens the ask instead of denying", () => {
    // A grammar upgrade that adds a node type must not mass-deny, so the
    // out-of-roster arm has to stay distinguishable from every hard-deny arm.
    const result = parseForSecurity(EXOTIC_COMMAND);
    expect(result.kind).not.toBe("malformed");
    expect(result.kind).not.toBe("aborted");
    expect(result.kind).toBe("unknown-syntax");
  });
});

describe("the malformed arm keeps its tree-carrying rule", () => {
  it("classifies an unclosed quote as malformed and carries only a reason", () => {
    const result = parseForSecurity('echo "abc');
    if (result.kind !== "malformed") {
      throw new Error(`expected malformed, got ${result.kind}`);
    }
    expect(result.reason.length).toBeGreaterThan(0);
    expect(Object.keys(result).sort()).toEqual(["kind", "reason"]);
  });

  it("refuses the fact lists to a heredoc whose closing delimiter is missing", () => {
    // The twin of the quoted-delimiter pins above: the same opening, truncated.
    // tree-sitter-bash emits MISSING heredoc_end here, so there is no complete
    // body span to report — an `ok` answer would hand Stage 1 a half-read
    // heredoc and a body slice that runs to end of input.
    const result = parseForSecurity("cat <<'EOF'\n$(whoami)\n");
    if (result.kind !== "malformed") {
      throw new Error(`expected malformed, got ${result.kind}`);
    }
    expect(result).not.toHaveProperty("heredocs");
    expect(result).not.toHaveProperty("redirects");
    expect(result).not.toHaveProperty("inert");
  });
});

/**
 * The receiver-normalised shape of a heredoc's facts: every span becomes its
 * slice (spans legitimately shift with the receiver's length), and the two
 * receiver-bearing indices become the receiver's word. Two inputs whose shapes
 * match differ in nothing but that word, which is the whole content of
 * "listing, not judging".
 */
function heredocFactShape(
  command: string,
  expectedReceiver: string
): Record<string, unknown> {
  const ok = okPayload(command);
  const heredoc = oneHeredoc(ok);
  const redirect = oneRedirect(ok, "<<");
  const bodies = inertBodies(ok);

  expect(heredoc.receiverCommandIndex, command).not.toBeNull();
  expect(redirect.ownerCommandIndex, command).not.toBeNull();
  expect(ownerWord(ok, heredoc.receiverCommandIndex), command).toBe(
    expectedReceiver
  );
  expect(ownerWord(ok, redirect.ownerCommandIndex), command).toBe(
    expectedReceiver
  );
  expect(bodies.length, command).toBe(1);

  return {
    receiver: "<receiver>",
    owner: "<receiver>",
    op: redirect.op,
    redirectDelimiterQuoted: redirect.delimiterQuoted,
    heredocDelimiterQuoted: heredoc.delimiterQuoted,
    body: sliceOf(ok, heredoc.bodySpan),
    redirectBody:
      redirect.bodySpan === undefined ? null : sliceOf(ok, redirect.bodySpan),
    inertWhy: bodies[0].why,
    inertDelimiterQuoted: bodies[0].delimiterQuoted,
    inertBody: sliceOf(ok, bodies[0].span),
    inertOwner: "<receiver>",
  };
}
