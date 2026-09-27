/**
 * Hard-wall: the root-find walk judged on the PARSED path (SC-S3-2).
 *
 * CONTEXT **root-find-walk** (ADR-0068, migrated by ADR-0125's Stage 3). The
 * sibling file `root-find-hard-wall.test.ts` pins the wall's answers; this one
 * pins the carrier those answers are now computed from: the ordered cd-fold and
 * the search-root judgment walk the parse's command nodes and operand words
 * instead of `splitShellSegments`' segments.
 *
 * The contract is that the ANSWER does not move. Every row is asserted to carry
 * `parseForSecurity(...).kind === "ok"` first, so a green row cannot be passing
 * on the parser-unavailable degrade scan by accident; the row's `why` then names
 * the reason the tree could answer it without moving today's verdict, or marks
 * the two rows whose verdict the migration does license itself (the splitter
 * having read a word the tree attributes to another node entirely).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findDangerousPattern,
  isDangerousCommand,
} from "../../../src/harness/permission/hard-walls.js";
import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";

describe("hard-wall: root find — SC-S3-2 parsed-path carrier", () => {
  const PARSED_PATH_ROWS: ReadonlyArray<{
    readonly command: string;
    readonly deny: boolean;
    readonly why: string;
  }> = [
    // ABSTAIN — pipeline negation: `!` is a counted token with no word fact, so
    // the tree cannot say which node it led; the splitter's answer is kept.
    { command: "! find /", deny: false, why: "ABSTAIN negation" },
    { command: "! cd / && find .", deny: false, why: "ABSTAIN negation" },
    { command: "cd / && ! find .", deny: false, why: "ABSTAIN negation" },
    // ABSTAIN — background `&`: bash runs `cd /` in a subshell, so no cwd ever
    // moved; the fold keeps the segment carrier, which cannot act on it either.
    { command: "cd / & find .", deny: false, why: "ABSTAIN background" },
    { command: "cd / & find /", deny: false, why: "ABSTAIN background" },
    {
      command: "cd /tmp && cd / & find ..",
      deny: false,
      why: "ABSTAIN background",
    },
    // ABSTAIN — a node whose span is led by something other than its command
    // word: the segment scan named a different command there (`X=1` is not
    // argv; a leading redirect is not a word at all).
    { command: "X=1 find /", deny: false, why: "ABSTAIN prefix word" },
    { command: "2>/dev/null find /", deny: false, why: "ABSTAIN prefix word" },
    // ABSTAIN of the bare-`find`-at-cwd rule only: a redirect is a word bash
    // passes nothing to, so `find` here is not provably operand-less.
    { command: "cd / && find > /dev/null", deny: false, why: "ABSTAIN bare" },
    // A trailing redirect does not blind the operands that ARE words.
    {
      command: "cd / && find . > /",
      deny: true,
      why: "operand before redirect",
    },
    { command: "cd / && find / > /dev/null", deny: true, why: "explicit root" },
    {
      command: "cd / && find . | wc -l",
      deny: true,
      why: "pipeline keeps order",
    },
    {
      command: "cd / && timeout 5 find .",
      deny: true,
      why: "wrapper fold on argv",
    },
    { command: "cd /\nf\\ind .", deny: true, why: "strip re-armed on argv" },
    { command: "f\\ind /", deny: true, why: "strip re-armed on argv" },
    // RELAXATION (licensed) — the splitter read the redirect TARGET as a search
    // root; the tree knows `/` belongs to `>`, not to `find`.
    {
      command: "find . > /",
      deny: false,
      why: "RELAXATION redirect target",
    },
    // RELAXATION (licensed) — the splitter split INSIDE a double-quoted
    // string and fabricated a `cd /` bash never ran.
    {
      command: 'echo "x; cd /" && find ..',
      deny: false,
      why: "RELAXATION quote-blind split",
    },
    // SPLICE — body lines join the fold at their own offset.
    {
      command: "bash <<'EOF'\ncd /\nfind .\nEOF",
      deny: true,
      why: "SPLICE shell-code body",
    },
    {
      command: "cd / && bash <<'EOF'\nfind .\nEOF",
      deny: true,
      why: "SPLICE body after folded cd",
    },
    {
      command: "cat <<'EOF'\ncd /\nEOF\nfind ..",
      deny: true,
      why: "SPLICE body line then real walk",
    },
    // Depth: the fold orders the nodes ONE script runs in sequence. A node
    // inside a subshell, a group, an `if` arm or a `$( … )` body is reached only
    // by its own execution context, which the segment scan never joined either.
    { command: "cd / && (find .)", deny: false, why: "subshell body" },
    { command: "(cd /); find .", deny: false, why: "cd lost in subshell" },
    { command: "cd / && { find .; }", deny: false, why: "group body" },
    {
      command: "cd / && echo $(find .)",
      deny: false,
      why: "substitution body",
    },
    {
      command: "if true; then cd /; find .; fi",
      deny: false,
      why: "if arm",
    },
    {
      command: "cd / && for d in .; do find $d; done",
      deny: false,
      why: "loop body, unexpanded operand",
    },
  ];

  for (const row of PARSED_PATH_ROWS) {
    it(`${row.command.replace(/\n/g, "\\n")} — ${row.deny ? "denied" : "allowed"} (${row.why})`, () => {
      const parsed = parseForSecurity(row.command);
      assert.equal(
        parsed.kind,
        "ok",
        "row must travel the parsed path, not the degrade scan",
      );
      const hit = findDangerousPattern(row.command);
      if (row.deny) {
        assert.deepEqual(hit, { id: "root-find-walk", pattern: "find" });
        assert.equal(isDangerousCommand(row.command), true);
      } else {
        assert.equal(hit, null, `unexpected deny: ${JSON.stringify(hit)}`);
      }
    });
  }
});
