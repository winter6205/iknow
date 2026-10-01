/**
 * The review requirement's `span` must point at the fragment that raised it.
 *
 * `sensitiveFragmentAt` has always computed the real `{start, end}` of the
 * roster match inside the text it scanned, but the `unresolved` fallback in
 * `classifySensitivePathEvidence` threw those offsets away and substituted
 * `{start: 0, end: command.length}` — the WHOLE command. ADR-0127's per-call
 * review then asked a human to adjudicate a region that was not the one in
 * question: the operator is shown a span covering the interpreter, the flag,
 * the quoting and the program, and must work out on their own which few
 * characters of it are the actual path-shaped token.
 *
 * A span that names the wrong region is not a cosmetic defect on this layer.
 * The review requirement IS the artifact the operator acts on, and its whole
 * purpose is to localize an unresolved question. Pointing it at the enclosing
 * command is a fabricated fact about where the problem is.
 *
 * The offset is checked against the command text itself rather than against a
 * hardcoded number, so a rule that moved the fragment cannot make this pass by
 * accident: the assertion is "the span names exactly the matched fragment", and
 * that is recomputed here from the same roster the classifier used.
 */

import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
  analyzeSecurityReview,
  classifySensitivePathEvidence,
} from "../../../src/harness/permission/hard-walls.js";

/**
 * The exact text the classification says matched, taken from its own
 * `fragment` field. A producer that names a fragment but a span covering
 * something else is the defect; deriving the expectation from the fragment
 * keeps the assertion honest about WHICH text must be inside the span.
 */
function expectSpanNamesFragment(
  command: string,
  fragment: string,
  span: { readonly start: number; readonly end: number }
): void {
  assert.equal(
    command.slice(span.start, span.end),
    fragment,
    `span [${span.start}, ${span.end}) must cover exactly the matched fragment ${JSON.stringify(
      fragment
    )} in ${JSON.stringify(command)}`
  );
}

/** The `unresolved` classification of a command, or a test failure. */
function unresolvedOf(command: string) {
  const evidence = classifySensitivePathEvidence(command);
  assert.equal(
    evidence.class,
    "unresolved",
    `${command} was expected to classify as unresolved, got ${evidence.class}`
  );
  return evidence as Extract<typeof evidence, { class: "unresolved" }>;
}

describe("the unresolved evidence span names the fragment, not the whole command", () => {
  // These are the commands that reach the `unresolved` FALLBACK — the arm that
  // used to answer `{start: 0, end: command.length}`. They are the shapes the
  // parse could match a roster entry against but could not place into any
  // command node, so `classifyOnParse` returns null and this arm is what
  // classifies them.
  //
  // Commands whose match DOES land in a node (an interpreter operand, a
  // redirect target, an argv operand) never reach here: `classifyOnParse`
  // answers them from the parse's own word span, which was always correct.
  // Including such a case in this table would assert nothing about the
  // fallback and would pass both before and after the fix.
  const unresolved: ReadonlyArray<readonly [string, string]> = [
    ["an environment assignment in front of a path", `FOO=bar /etc/passwd`],
    ["several assignments in front of a path", `A=1 B=2 /etc/passwd`],
    ["a path after a `cd &&` segment", `cd /tmp && /etc/passwd`],
    ["a bare path", `/etc/passwd`],
  ];

  for (const [why, command] of unresolved) {
    it(`carries the fragment's own offsets — ${why}`, () => {
      const evidence = unresolvedOf(command);
      expectSpanNamesFragment(command, evidence.fragment, evidence.span);
      // A strict descendant of the whole command wherever the two could
      // coincide: for these, the enclosing command is strictly longer.
      if (command.length > evidence.fragment.length) {
        expect(
          evidence.span.end - evidence.span.start,
          "the span must be narrower than the whole command"
        ).toBeLessThan(command.length);
      }
    });
  }

  it("the review requirement the operator is shown carries the same span", () => {
    // The classification is not the only consumer: `analyzeSecurityReview`
    // turns the `unresolved` evidence into the ADR-0127 requirement, and THAT
    // is the object rendered to a human. A correct classification feeding a
    // re-widened span would leave the defect in place.
    const command = `cd /tmp && /etc/passwd`;
    const scan = analyzeSecurityReview(command);
    assert.equal(scan.verdict, "review", "this command must reach review");
    if (scan.verdict !== "review") return;
    const evidence = unresolvedOf(command);
    expectSpanNamesFragment(
      command,
      evidence.fragment,
      scan.requirement.span
    );
  });

  it("a confirmed path target still carries ITS site span, not the fragment", () => {
    // The fragment arm and the site arm answer different questions and must
    // not be collapsed into one: a confirmed verdict points at the redirect
    // target or operand the parse established, which is generally a different
    // (larger) region than the roster fragment that matched inside it. This
    // test pins that the confirmed arm is unchanged by the unresolved fix.
    const command = `cat /etc/shadow`;
    const evidence = classifySensitivePathEvidence(command);
    assert.equal(evidence.class, "confirmed");
    if (evidence.class !== "confirmed") return;
    assert.equal(
      command.slice(evidence.span.start, evidence.span.end),
      "/etc/shadow",
      "the confirmed arm addresses the established path target"
    );
  });
});
