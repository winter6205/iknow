/**
 * tests/harness/permission/command-roster.test.ts
 *
 * SC-S4-4 permanent artifact (Stage 4b): the roster must reproduce the four
 * pre-4b command-name sets membership-for-membership (two-sided set
 * equality against the literals as they stood at Stage 4a), and the
 * `flag_policy` key → table wiring inside bash-readonly.ts must hold table
 * identity, probed through `validateReadonlyCommand` with members unique to
 * each table.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ReadonlyViolationError,
  validateReadonlyCommand,
} from "../../../src/harness/aci/tools/bash-readonly.ts";
import {
  ALLOWED_COMMAND_TOKENS,
  COMMAND_ROSTER,
  FORBIDDEN_COMMANDS,
  INTERPRETER_COMMAND_NAMES,
  READONLY_ALLOWED,
  commandFlagPolicy,
  commandRosterEntry,
} from "../../../src/harness/permission/command-roster.ts";

/* The pre-4b literals, verbatim (git show <Stage 4a tip> of the two files). */
const PRE_4B_ALLOWED_COMMAND_TOKENS = [
  "mkdir",
  "cp",
  "mv",
  "touch",
  "tee",
  "sed",
  "chmod",
  "chown",
  "diff",
  "file",
  "base64",
  "jq",
  "curl",
  "env",
  "export",
  "unset",
  "true",
  "false",
  "echo",
  "pwd",
  "printf",
  "wc",
  "cat",
  "head",
  "tail",
  "ls",
  "node",
  "npm",
  "git",
  "dir",
  "type",
  "where",
];

const PRE_4B_FORBIDDEN_COMMANDS = [
  "env",
  "xargs",
  "time",
  "nohup",
  "timeout",
];

const PRE_4B_READONLY_ALLOWED = [
  "ls",
  "cat",
  "grep",
  "wc",
  "stat",
  "du",
  "df",
  "ps",
  "diff",
  "sha256sum",
  "md5sum",
  "jq",
  "head",
  "tail",
  "printenv",
  "rg",
  "file",
  "which",
  "whereis",
  "uname",
  "hostname",
  "id",
  "whoami",
  "date",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "column",
  "nl",
  "fold",
  "od",
  "xxd",
  "hexdump",
  "strings",
];

const PRE_4B_INTERPRETER_COMMAND_NAMES = [
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "python",
  "python2",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
];

function assertSetEquals(actual: ReadonlySet<string>, expected: string[]) {
  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();
  // Two-sided: neither direction may hold a member the other lacks.
  assert.deepEqual(sortedActual.filter((n) => !sortedExpected.includes(n)), []);
  assert.deepEqual(sortedExpected.filter((n) => !sortedActual.includes(n)), []);
  assert.equal(sortedActual.length, sortedExpected.length);
}

describe("command roster membership (SC-S4-4, zero-behavior)", () => {
  it("projects ALLOWED_COMMAND_TOKENS exactly", () => {
    assertSetEquals(ALLOWED_COMMAND_TOKENS, PRE_4B_ALLOWED_COMMAND_TOKENS);
    assertSetEquals(
      new Set(
        Object.entries(COMMAND_ROSTER)
          .filter(([, entry]) => entry.allowlisted)
          .map(([name]) => name)
      ),
      PRE_4B_ALLOWED_COMMAND_TOKENS
    );
  });

  it("projects FORBIDDEN_COMMANDS (execution agents) exactly", () => {
    assertSetEquals(FORBIDDEN_COMMANDS, PRE_4B_FORBIDDEN_COMMANDS);
  });

  it("projects READONLY_ALLOWED exactly", () => {
    assertSetEquals(READONLY_ALLOWED, PRE_4B_READONLY_ALLOWED);
  });

  it("projects INTERPRETER_COMMAND_NAMES exactly", () => {
    assertSetEquals(
      INTERPRETER_COMMAND_NAMES,
      PRE_4B_INTERPRETER_COMMAND_NAMES
    );
  });

  it("carries a flag_policy key for exactly find / sort / git", () => {
    assert.equal(commandFlagPolicy("find"), "find");
    assert.equal(commandFlagPolicy("sort"), "sort");
    assert.equal(commandFlagPolicy("git"), "git");
    for (const name of Object.keys(COMMAND_ROSTER)) {
      if (name === "find" || name === "sort" || name === "git") continue;
      assert.equal(commandFlagPolicy(name), null, name);
    }
    assert.equal(commandFlagPolicy("toString"), null);
    assert.equal(commandFlagPolicy("constructor"), null);
    assert.equal(commandRosterEntry("__proto__"), undefined);
  });
});

describe("flag_policy table identity (SC-S4-4 probes)", () => {
  it("routes find to FIND_DENIED_FLAGS (member unique to that table)", () => {
    assert.throws(
      () => validateReadonlyCommand("find . -delete"),
      ReadonlyViolationError
    );
    // A sort/find swap would lose the `-delete` denial AND leak the sort
    // denial below; keep the allow side pinned too.
    assert.doesNotThrow(() => validateReadonlyCommand("find . -name x"));
  });

  it("routes sort to SORT_DENIED_FLAGS", () => {
    assert.throws(
      () => validateReadonlyCommand("sort -o out.txt in.txt"),
      ReadonlyViolationError
    );
    assert.doesNotThrow(() => validateReadonlyCommand("sort in.txt"));
  });

  it("routes git to GIT_ALLOWED_SUBCOMMANDS", () => {
    assert.doesNotThrow(() => validateReadonlyCommand("git status"));
    // A git/* swap would let validateGitSubcommand be skipped and
    // `git commit` pass the routed flag scan — pin the deny side.
    assert.throws(
      () => validateReadonlyCommand("git commit -m msg"),
      ReadonlyViolationError
    );
  });
});
