/**
 * hard-wall: `bare-metachar` means "no command word", not "not allowlisted".
 *
 * Invariant pinned here (ADR-0068: the hard-wall is a spawn-time intent
 * filter, not a syntax blacklist simulating the fence): the `bare-metachar`
 * id fires only when the command has no command body at all —
 * `splitForDangerousScan` produced zero segments (`;`, `&&`, `|`, `;;`), or
 * every produced segment leads with operator / redirect punctuation
 * (`>`, `>>`, `2>`, `<`, `>/tmp/x`). Whether the first token sits on the
 * Unix-toy allowlist must NOT gate this branch: an interpreter word such as
 * `python3` whose own argv carries `;` / `>` / `&&` inside a quoted heredoc
 * or `-c` source has a command word, so the raw-string metachar scan must
 * not deny it at spawn (it falls through to the mode / category default).
 *
 * The per-segment rules keep first claim and are re-pinned at this
 * boundary: `destructive-*` substring hits, `command-substitution`
 * (`$(` / `${` / backtick / `<(`), and the ordered `root-find-walk` fold
 * (a `cd /` still arms the later `find`).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  findDangerousPattern,
  isDangerousCommand,
} from "../../../src/harness/permission/hard-walls.js";
import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/aci/permission.js";
import type {
  AciToolDef,
  AciCategory,
} from "../../../src/harness/aci/types.js";
import type { DangerousPatternId } from "../../../src/harness/permission/hard-walls.js";

function patternId(command: string): DangerousPatternId | undefined {
  return findDangerousPattern(command)?.id;
}

function makeTool(name: string, category: AciCategory): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "build" as const,
    }),
  });
}

/** Command shapes that must NOT be hard-walled (interpreter payloads). */
const NO_HIT: ReadonlyArray<string> = [
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "python3 - <<'EOF'\nprint('</svg>')\nEOF",
  'python3 -c "import sys; print(1)"',
  'python3 -c "print(1)"',
  "python3 script.py && rm script.py",
  "python3 script.py && echo done",
  "python3 script.py | head",
  "node - <<'EOF'\nconsole.log(1 > 0)\nEOF",
  "cat <<'EOF'\nhello\nEOF",
  "node server.js &",
  "python3 -m http.server 8000 >/tmp/log 2>&1 &",
  // a separator with an empty right side still leaves a command-word segment
  "foo;",
  // group punctuation is transparent to the command-word scan: the body
  // inside a subshell / brace group is still a command word
  "(echo hi > /tmp/x)",
  "{ echo hi; } > /tmp/x",
];

/** Empty body around separators keeps the hit only when NO segment has a word. */
const BARE_HIT: ReadonlyArray<string> = [
  ";",
  ";;",
  "&&",
  "|",
  "||",
  "&",
  ">",
  ">>",
  "<",
  "> /tmp/x",
  ">> /tmp/x",
  "2> /tmp/x",
];

describe("hard-wall: bare-metachar — no-hit shapes (interpreter payload is a command body)", () => {
  for (const command of NO_HIT) {
    it(`does not deny ${JSON.stringify(command)}`, () => {
      assert.equal(
        patternId(command),
        undefined,
        `unexpected hit for ${command}: ${JSON.stringify(findDangerousPattern(command))}`
      );
      assert.equal(isDangerousCommand(command), false);
    });
  }
});

describe("hard-wall: bare-metachar — purely metachar bodies still deny", () => {
  for (const command of BARE_HIT) {
    it(`denies ${JSON.stringify(command)} as bare-metachar`, () => {
      assert.equal(patternId(command), "bare-metachar");
      assert.equal(isDangerousCommand(command), true);
    });
  }
});

// Stage 3 (T20) proof pins: the wall's new driving fact, stated separately
// from the deny it produces, so a wrong predicate fails here even when the
// rendered deny still rides the retained text answer.
describe("AST fact behind the bare branch — the parsed path reads the tree", () => {
  it("every BARE_HIT shape parses ok with ZERO command nodes (the 12-row table's AST column)", () => {
    for (const command of BARE_HIT) {
      const parsed = parseForSecurity(command);
      assert.equal(parsed.kind, "ok", command);
      assert.equal(
        parsed.kind === "ok" ? parsed.commands.length : -1,
        0,
        `expected zero command nodes for ${command}`
      );
    }
  });

  it("every NO_HIT shape that parses ok has a command node — the zero-command fact keeps it allowed", () => {
    for (const command of NO_HIT) {
      const parsed = parseForSecurity(command);
      if (parsed.kind !== "ok") continue;
      assert.ok(
        parsed.commands.length > 0,
        `expected at least one command node for ${command}`
      );
    }
  });

  it("divergence (recorded): a redirect-lead real command leaves the bare branch — the tree's command node wins", () => {
    // `> /dev/null rm` has ONE command node, but the quote-blind splitter
    // calls the body operator-pure (the first token `> /dev/null` is an
    // operator lead) and the pre-Stage-3 text gate denied it as
    // bare-metachar ">". The migrated rule is the iff on the tree fact: a
    // command has started, so the bare branch does not fire and the shape
    // falls through to the mode / category default like a plain `rm`. The
    // roster is not lost there — `2> rm -rf` and
    // `>/dev/null dd if=/dev/zero of=/dev/sda` still deny from the AST
    // destructive arms, not from the retired text fall-through.
    const parsed = parseForSecurity("> /dev/null rm");
    assert.equal(parsed.kind, "ok");
    assert.equal(parsed.kind === "ok" ? parsed.commands.length : -1, 1);
    assert.equal(findDangerousPattern("> /dev/null rm"), null);
    assert.equal(patternId("2> rm -rf"), "destructive-rm");
    assert.equal(
      patternId("> /dev/null dd if=/dev/zero of=/dev/sda"),
      "destructive-disk"
    );
  });

  it("corpus disagreement priced by the ledger: zero command nodes with a text command word does NOT fire bare", () => {
    // `FOO=1 <<'EOF'…`: the assignment is not a command node, so the tree
    // says zero — but the text scan says the body carries a command word,
    // and the floor's rule is that the text behavior wins: the shape keeps
    // its security-review answer (no pattern hit) instead of newly denying
    // bare `<` on the AST fact alone.
    const command = "FOO=1 <<'EOF'\nrm -rf /tmp/x\nEOF";
    const parsed = parseForSecurity(command);
    assert.equal(parsed.kind, "ok");
    assert.equal(parsed.kind === "ok" ? parsed.commands.length : -1, 0);
    assert.equal(findDangerousPattern(command), null);
  });

  it("the malformed-tree rescue keeps bare-metachar for a quote-contaminated operator body", () => {
    // `' ;` is malformed (unclosed quote), not an ok tree, so the zero-command
    // AST rule does not speak for it; the rescue in front of the `unparseable`
    // routing keeps its ADR-0068 id.
    const parsed = parseForSecurity("' ;");
    assert.equal(parsed.kind, "malformed");
    assert.deepEqual(findDangerousPattern("' ;"), {
      id: "bare-metachar",
      pattern: ";",
    });
  });
});

describe("hard-wall: per-segment rules keep first claim over the bare branch", () => {
  it("command-substitution inside an interpreter payload still hits", () => {
    assert.equal(patternId("echo $(rm -rf /)"), "command-substitution");
    assert.equal(
      patternId("python3 - <<'EOF'\nprint($(rm -rf /))\nEOF"),
      "command-substitution"
    );
  });

  it("destructive substring in a -c source still hits destructive-rm", () => {
    assert.equal(
      patternId(`python3 -c "import os; os.system('rm -rf /tmp/z')"`),
      "destructive-rm"
    );
    assert.equal(patternId("rm -rf /tmp/x"), "destructive-rm");
    // a non-allowlisted first segment must not rescue a dangerous later one
    assert.equal(
      patternId("python3 script.py && rm -rf /tmp/x"),
      "destructive-rm"
    );
  });

  it("the root-find fold runs before the bare branch", () => {
    // The precedence being pinned is the ORDER, so the representative is a
    // mutating root search: spec SC6 stopped denying read-only root searches
    // outright, and an allow would make this assert nothing about order. The
    // read-only rows' own answers live in `root-find-readonly-allowance.test.ts`.
    assert.equal(patternId("find / -delete"), "root-find-walk");
    assert.equal(patternId("cd / && find . -delete"), "root-find-walk");
  });

  it("empty string returns null", () => {
    assert.equal(findDangerousPattern(""), null);
  });
});

describe("checkPermission seam — non-allowlisted payload falls through to ask", () => {
  const policy = createPermissionPolicy();
  const bash = makeTool("bash", "execute");

  it("python3 quoted heredoc → ask (category default, not hard_wall)", () => {
    const out = checkPermission({
      def: bash,
      input: { command: "python3 - <<'EOF'\nprint(1)\nEOF" },
      policy,
    });
    assert.equal(out.decision, "ask");
  });

  it("bare `;` still denies with [hard_wall] + the bare-metachar id", () => {
    const out = checkPermission({
      def: bash,
      input: { command: ";" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("[hard_wall]"), out.reason);
    assert.ok(out.reason.includes("bare-metachar"), out.reason);
  });
});
