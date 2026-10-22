import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { isReadonlyBashConcurrencySafe } from "../../../../src/harness/aci/tools/bash-concurrency.ts";

/** The predicate takes the RAW tool input (the wave splitter calls it before
 * schema validation), so the tests drive it through the raw shape. */
function inputFor(command: unknown, extra?: Record<string, unknown>): unknown {
  return { command, ...(extra ?? {}) };
}

describe("isReadonlyBashConcurrencySafe — provably read-only calls are safe", () => {
  it("accepts a plain read-only command", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("ls")), true);
  });

  it("accepts cat of a file", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("cat file.txt")), true);
  });

  it("accepts git status", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("git status")), true);
  });

  it("accepts git log with flags", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("git log --oneline -5")),
      true
    );
  });

  it("accepts grep -o, where -o means --only-matching and not a file output", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("grep -o pat file")),
      true
    );
  });

  it("accepts an fd duplication (2>&1) — it copies a descriptor, not a file", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("ls 2>&1")), true);
  });

  it("accepts pwd", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("pwd")), true);
  });

  it("accepts a read-only command with no `$` and no output form", () => {
    // The expansion rule must not over-reject ordinary reads: a command
    // that names no expansion at all, and whose only `-o` is grep's
    // `--only-matching`, stays safe.
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("grep -o pat file")),
      true
    );
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("head -n 5 file.txt")),
      true
    );
  });
});

describe("isReadonlyBashConcurrencySafe — literal cd read-only chains", () => {
  it("accepts a literal cd path followed by one read-only command", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("cd /tmp && ls")),
      true
    );
  });

  it("accepts a quoted path with spaces and validates the read-only suffix", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(
        inputFor("cd '/tmp/space path' && git status")
      ),
      true
    );
  });

  it("accepts quoted tilde and glob characters as literal path data", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor('cd "~/repo" && ls')),
      true
    );
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("cd '*.txt' && ls")),
      true
    );
  });

  it("accepts a chain of read-only commands and scopes output flags per command", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(
        inputFor("cd /tmp && grep -o pattern file && git status")
      ),
      true
    );
  });

  it("rejects cd forms whose path or shell structure is not literal and complete", () => {
    for (const command of [
      "cd - && ls",
      "cd $PWD && ls",
      "cd ${PWD} && ls",
      "cd $(pwd) && ls",
      "cd `pwd` && ls",
      "cd /tmp && (ls)",
      "cd /tmp && for item in one; do ls; done",
      "cd /tmp && ls\ntouch x",
      'cd "/tmp && ls',
      "cd /tmp && ls |",
    ]) {
      assert.equal(
        isReadonlyBashConcurrencySafe(inputFor(command)),
        false,
        `expected serial execution for ${JSON.stringify(command)}`
      );
    }
  });

  it("rejects unquoted tilde and pathname expansion in the cd path", () => {
    for (const command of [
      "cd ~ && ls",
      "cd ~/repo && ls",
      "cd *.txt && ls",
      "cd /tmp/[ab] && ls",
      "cd {one,two} && ls",
    ]) {
      assert.equal(
        isReadonlyBashConcurrencySafe(inputFor(command)),
        false,
        `expected serial execution for ${JSON.stringify(command)}`
      );
    }
  });

  it("rejects non-and separators, redirects, and writes anywhere in a cd chain", () => {
    for (const command of [
      "cd /tmp; ls",
      "cd /tmp || ls",
      "cd /tmp & ls",
      "cd /tmp && ls > output.txt",
      "cd /tmp && ls < input.txt",
      "cd /tmp && ls 2>&1",
      "cd /tmp && touch output.txt",
      "cd -- /tmp && ls",
      "cd -P /tmp && ls",
      "cd / && find . -delete",
    ]) {
      assert.equal(
        isReadonlyBashConcurrencySafe(inputFor(command)),
        false,
        `expected serial execution for ${JSON.stringify(command)}`
      );
    }
  });
});

describe("isReadonlyBashConcurrencySafe — writes are never safe", () => {
  it("rejects an output redirect", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("echo x > /tmp/a")),
      false
    );
  });

  it("rejects a tee in the command", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("cat a | tee b")),
      false
    );
  });

  it("rejects an output argument (curl -o), which is not readonly-safe either", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("curl -o f URL")),
      false
    );
  });

  it("rejects a chained write", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("git status && touch x")),
      false
    );
  });

  it("rejects a write hidden in a command substitution", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("cat $(touch x) f")),
      false
    );
  });

  it("rejects a write hidden in a backtick substitution", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("echo `touch x`")),
      false
    );
  });

  it("rejects a newline statement separator", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("ls\ntouch x")), false);
  });

  it("rejects a braced parameter expansion", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("cat ${HOME}/x")),
      false
    );
  });

  it("rejects an unbraced parameter expansion — the rule is any `$`", () => {
    // The expansion family is refused in every shape: an unbraced `$NAME`
    // is as unknowable at judgment time as a braced `${NAME}`, and the
    // readonly validator passes both (`cat $HOME/x` PASSES
    // validateReadonlyCommand and findDangerousPattern returns null for
    // it), so no other conjunct closes this hole.
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("cat $HOME/x")), false);
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("echo x $REDIR")),
      false
    );
  });

  it("rejects a literal `$` inside a file name — the rule is any `$`", () => {
    // `cat file$.txt` names no variable, but the rule cannot tell a literal
    // `$` from the start of an expansion without parsing the shell, so the
    // call is refused. A false positive here costs concurrency only.
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("cat file$.txt")),
      false
    );
  });

  it("rejects a sort output flag", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("sort -o out.txt in.txt")),
      false
    );
  });

  it("rejects a git --output flag", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("git log --output=x")),
      false
    );
  });

  it("rejects a dangerous pattern", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("rm -rf /tmp/x")),
      false
    );
  });
});

describe("isReadonlyBashConcurrencySafe — output-form token scan", () => {
  it("rejects a standalone -o output flag", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("sort -o out.txt in.txt")),
      false
    );
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("curl -o f URL")),
      false
    );
  });

  it("rejects an --output token and an --output=… token", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("git log --output=x")),
      false
    );
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("git log --output x")),
      false
    );
  });

  it("rejects a tee command word wherever it appears", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("cat a | tee b")),
      false
    );
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("tee a b")), false);
  });

  it("keeps the -o exemption for grep and rg, whose -o is --only-matching", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("grep -o pat file")),
      true
    );
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("rg -o pat file")),
      true
    );
  });

  it("refuses the output form even where the readonly policy ACCEPTS the command", () => {
    // These are the LIVE cases of the scan. Each of them PASSES
    // `validateReadonlyCommand` and `findDangerousPattern` returns null for
    // it, so NO other conjunct refuses them — the output-form scan is the
    // only thing that does. Deleting the `!hasOutputForm` conjunct turns
    // this case RED; the cases above it (tee / --output / `sort -o`) stay
    // green without it, because an earlier conjunct already refuses them.
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("ls -o")), false);
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("od -o")), false);
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("find . -name tee")),
      false
    );
  });
});

describe("isReadonlyBashConcurrencySafe — undecidable input is never safe", () => {
  it("rejects a non-object input", () => {
    assert.equal(isReadonlyBashConcurrencySafe(null), false);
    assert.equal(isReadonlyBashConcurrencySafe(undefined), false);
    assert.equal(isReadonlyBashConcurrencySafe(42), false);
    assert.equal(isReadonlyBashConcurrencySafe("ls"), false);
  });

  it("rejects an input with no command", () => {
    assert.equal(isReadonlyBashConcurrencySafe({}), false);
  });

  it("rejects a non-string command", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor({})), false);
    assert.equal(isReadonlyBashConcurrencySafe(inputFor(42)), false);
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("")), false);
  });

  it("rejects a background call", () => {
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("ls", { background: true })),
      false
    );
  });

  it("rejects a command the readonly validator rejects for another reason", () => {
    // `touch` is outside the readonly command policy — the validator throws
    // a ReadonlyViolationError, so the call is not provably read-only.
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor("touch newfile")),
      false
    );
  });

  it("rejects a malformed command the wall cannot judge", () => {
    assert.equal(isReadonlyBashConcurrencySafe(inputFor("ls |")), false);
    assert.equal(
      isReadonlyBashConcurrencySafe(inputFor('cat "unclosed')),
      false
    );
  });
});

describe("isReadonlyBashConcurrencySafe — never throws", () => {
  it("answers false for garbage input instead of throwing", () => {
    for (const garbage of [
      null,
      undefined,
      42,
      "ls",
      true,
      [],
      {},
      { command: {} },
      { command: [] },
      { command: null },
      { command: 1 },
      { command: "" },
      { background: true },
    ]) {
      assert.doesNotThrow(() => isReadonlyBashConcurrencySafe(garbage));
      assert.equal(
        isReadonlyBashConcurrencySafe(garbage),
        false,
        `expected false for ${JSON.stringify(garbage)}`
      );
    }
  });

  it("does not throw for an input whose background flag is not the boolean true", () => {
    // The background rule is `background === true` — the same strictness the
    // bash handler uses to pick its background arm. A non-boolean value is
    // not a background call, so a read-only command stays safe; the point of
    // the case is that the predicate answers instead of throwing.
    for (const garbage of [
      { command: "ls", background: "true" },
      { command: "ls", background: 1 },
      { command: "ls", background: false },
    ]) {
      assert.doesNotThrow(() => isReadonlyBashConcurrencySafe(garbage));
    }
    assert.equal(
      isReadonlyBashConcurrencySafe({ command: "ls", background: false }),
      true
    );
  });
});
