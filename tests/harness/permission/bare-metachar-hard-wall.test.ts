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
    assert.equal(patternId("find /"), "root-find-walk");
    assert.equal(patternId("cd / && find ."), "root-find-walk");
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
