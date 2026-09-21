import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  ReadonlyViolationError,
  validateReadonlyCommand,
} from "../../../../src/harness/aci/tools/bash-readonly.ts";
import { createBashTool } from "../../../../src/harness/aci/tools/bash.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** Asserts that the command is rejected with a ReadonlyViolationError whose
 * message contains `reasonPart` (when given) and the required alternative-tool
 * guidance text. Also validates the typed `context` fields. */
function expectReject(command: string, reasonPart?: string): void {
  try {
    validateReadonlyCommand(command);
  } catch (error) {
    assert.ok(
      error instanceof ReadonlyViolationError,
      `expected ReadonlyViolationError, got ${error} for ${JSON.stringify(command)}`
    );
    if (reasonPart !== undefined) {
      assert.ok(
        error.message.includes(reasonPart),
        `expected ${JSON.stringify(reasonPart)} in message: ${error.message}`
      );
    }
    assert.equal(error.context.command, command);
    assert.ok(error.context.reason.length > 0);
    assert.ok(
      /read_file|grep|glob|lsp_/.test(error.message),
      `expected alternative-tool guidance in message: ${error.message}`
    );
    return;
  }
  assert.fail(`expected ReadonlyViolationError for ${JSON.stringify(command)}`);
}

function expectAllow(command: string): void {
  validateReadonlyCommand(command);
}

describe("validateReadonlyCommand — boundary cases (deny-by-default)", () => {
  it("(a) rejects empty and whitespace-only commands", () => {
    for (const cmd of ["", "   ", "\t", "\n", "  \t\n  "])
      expectReject(cmd, "empty");
  });

  it("(b) rejects bare & segments", () => {
    for (const cmd of ["ls &", "ls & pwd", "cat f.txt &", "&"])
      expectReject(cmd, "&");
  });

  it("(c) rejects output redirections", () => {
    for (const cmd of ["ls > file.txt", "ls >> f", "cat a > b", "echo hi > o"])
      expectReject(cmd, "redirection");
    // &> contains & so the & strictening fires first; a bare ">" segment has
    // no policy token and is rejected deny-by-default. Both are rejections.
    expectReject("ls &> out.txt");
    expectReject(">");
  });
});

describe("validateReadonlyCommand — class 1 forbidden commands", () => {
  it("rejects env / xargs / time / nohup / timeout", () => {
    for (const cmd of [
      "env",
      "env FOO=bar ls",
      "xargs ls",
      "time ls",
      "nohup ls",
      "timeout 5 ls",
    ])
      expectReject(cmd, "execution agent");
  });
});

describe("validateReadonlyCommand — class 2 find flag-level deny", () => {
  it("rejects find -delete/-exec/-execdir/-ok/-okdir", () => {
    for (const cmd of [
      "find . -delete",
      "find . -exec rm {} \\;",
      "find . -execdir rm {} \\;",
      "find . -ok rm {} \\;",
      "find . -okdir rm {} \\;",
    ])
      expectReject(cmd, "find flag");
  });

  it("allows find with non-denied flags (name / type / print)", () => {
    for (const cmd of [
      'find . -name "*.ts"',
      "find . -type f -print",
      "find . -maxdepth 2",
    ])
      expectAllow(cmd);
  });
});

describe("validateReadonlyCommand — class 2 sort flag-level deny", () => {
  it("rejects sort -o and --output (= file write)", () => {
    for (const cmd of [
      "sort -o out.txt file.txt",
      "sort --output out.txt file.txt",
      "sort --output=out.txt file.txt",
    ])
      expectReject(cmd, "sort flag");
  });

  it("allows sort without output flags", () => {
    for (const cmd of ["sort file.txt", "sort -r f", "sort -n -u f"])
      expectAllow(cmd);
  });
});

describe("validateReadonlyCommand — class 2 git subcommand whitelist", () => {
  it("rejects git subcommands not in the read-only whitelist", () => {
    for (const cmd of [
      "git push",
      "git pull",
      "git commit -m msg",
      "git checkout main",
      "git branch -d main",
      "git reset --hard",
      "git stash",
      "git add .",
      "git init",
    ])
      expectReject(cmd, "git subcommand");
  });

  it("rejects git with --output flag (global write redirect)", () => {
    expectReject("git --output=out.txt status", "git --output");
    expectReject("git status --output out.txt", "git --output");
  });

  it("allows git read-only subcommands", () => {
    for (const cmd of [
      "git status",
      "git log --oneline",
      "git diff",
      "git show HEAD",
      "git rev-parse HEAD",
      "git ls-files",
      "git ls-tree HEAD",
      "git describe",
      "git blame file.txt",
      "git reflog",
    ])
      expectAllow(cmd);
  });

  it("allows git global flags that take arguments (positional rules)", () => {
    for (const cmd of [
      "git -C /tmp status",
      "git --git-dir=/tmp/.git log",
      "git --work-tree /tmp status --short",
    ])
      expectAllow(cmd);
  });

  it("rejects bare `git` (no subcommand)", () => {
    expectReject("git", "no subcommand");
    expectReject("git --version", "no subcommand");
  });
});

describe("validateReadonlyCommand — class 3 allowed command families", () => {
  it("allows every read-only command family", () => {
    for (const cmd of [
      "ls -la",
      "cat file.txt",
      "grep pattern file.txt",
      "wc -l file.txt",
      "stat file.txt",
      "du -sh .",
      "df -h",
      "ps aux",
      "diff a.txt b.txt",
      "sha256sum file.txt",
      "md5sum file.txt",
      "jq . file.json",
      "head -10 file.txt",
      "tail -20 file.txt",
      "printenv",
      "rg pattern file.txt",
      "file foo.txt",
      "which ls",
      "uname -a",
      "pwd",
      "echo hello",
      "printf '%s' hi",
      "true",
      "false",
      "date",
      "id",
    ])
      expectAllow(cmd);
  });

  it("allows unknown flags on allowed commands (don't punish new flags)", () => {
    for (const cmd of [
      "ls --some-future-flag",
      "cat --unknown-flag file.txt",
      "grep --new-opt pattern file.txt",
    ])
      expectAllow(cmd);
  });
});

describe("validateReadonlyCommand — deny-by-default", () => {
  it("rejects commands not in any policy entry", () => {
    for (const cmd of [
      "rm file.txt",
      "curl http://example.com",
      "python script.py",
      "node app.js",
      "npm install",
      "make build",
      "unknown-command",
      "sh -c 'ls'",
      "bash -c 'ls'",
      "touch newfile",
      "mkdir dir",
      "cp src dst",
      "mv src dst",
      "chmod 755 file",
    ])
      expectReject(cmd, "not in the readonly command policy");
  });

  it("allows compound commands of allowed tokens", () => {
    for (const cmd of [
      "ls && pwd",
      "ls; pwd",
      "ls | head -5",
      "echo a; echo b; echo c",
      "git status; ls",
    ])
      expectAllow(cmd);
  });

  it("rejects compound commands if any segment is out of policy", () => {
    for (const cmd of [
      "ls; rm file",
      "ls && rm file",
      "cat f | rm f",
      "ls; touch f",
    ])
      expectReject(cmd);
  });

  it("rejects compound commands if any segment has a redirect or bare &", () => {
    for (const cmd of [
      "ls; echo done > log",
      "ls && echo done > log",
      "ls & pwd",
    ])
      expectReject(cmd);
  });
});

describe("ReadonlyViolationError — typed error shape", () => {
  it("extends ToolExecutionError so executor catches it via existing path", () => {
    const err = new ReadonlyViolationError({
      command: "touch x",
      reason: "not allowed",
    });
    assert.ok(err instanceof ReadonlyViolationError);
    assert.ok(err instanceof ToolExecutionError);
    assert.equal(err.context.command, "touch x");
    assert.equal(err.context.reason, "not allowed");
    assert.ok(err.message.includes("touch x"));
    assert.ok(err.message.includes("not allowed"));
  });
});

// Handler wiring tests call createBashTool → requireBwrap(), so they depend on
// bwrap being present at construction time. They run locally (bwrap 0.11.1);
// CI excludes this file (SSOT: vitest.ci-excludes.ts).
describe("bash handler — readonly mode wiring", () => {
  it("bashMode='readonly' rejects a write command with ReadonlyViolationError", async () => {
    const cwd = await makeScratch("bash-ro-reject-");
    const tool = createBashTool(cwd, { bashMode: "readonly" });
    await assert.rejects(
      tool.handler({ command: "touch newfile.txt" }),
      (error: unknown) =>
        error instanceof ReadonlyViolationError &&
        error.message.includes("not in the readonly command policy")
    );
  });

  it("bashMode='readonly' rejects env (class 1 forbidden)", async () => {
    const cwd = await makeScratch("bash-ro-env-");
    const tool = createBashTool(cwd, { bashMode: "readonly" });
    await assert.rejects(
      tool.handler({ command: "env" }),
      (error: unknown) =>
        error instanceof ReadonlyViolationError &&
        error.message.includes("execution agent")
    );
  });

  it("bashMode='readonly' rejects find -exec both terminators (reaches validator)", async () => {
    // `find . -delete` is caught upstream by isDangerousCommand (` -delete`
    // substring); the `\;` and `+` terminators are both answered by the
    // readonly find-flag table.
    const cwd = await makeScratch("bash-ro-find-");
    const tool = createBashTool(cwd, { bashMode: "readonly" });
    for (const terminator of ["+", "\\;"]) {
      await assert.rejects(
        tool.handler({ command: `find . -exec rm {} ${terminator}` }),
        (error: unknown) =>
          error instanceof ReadonlyViolationError &&
          error.message.includes("find flag")
      );
    }
  });

  it("bashMode='readonly' rejects output redirect", async () => {
    const cwd = await makeScratch("bash-ro-redirect-");
    const tool = createBashTool(cwd, { bashMode: "readonly" });
    await assert.rejects(
      tool.handler({ command: "ls > file.txt" }),
      (error: unknown) =>
        error instanceof ReadonlyViolationError &&
        error.message.includes("redirection")
    );
  });

  it("bashMode='readonly' allows a read command (ls executes successfully)", async () => {
    const cwd = await makeScratch("bash-ro-allow-");
    const tool = createBashTool(cwd, { bashMode: "readonly" });
    // The handler returns an envelope `{ output, meta? }`; parse output to
    // keep the original { code, stdout, stderr } contract fully asserted.
    const envelope = (await tool.handler({ command: "ls" })) as {
      output: string;
    };
    const result = JSON.parse(envelope.output) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.equal(result.code, 0);
    assert.equal(typeof result.stdout, "string");
  });

  it("bashMode absent (default 'any') does NOT apply readonly check (V1 baseline)", async () => {
    const cwd = await makeScratch("bash-any-");
    const tool = createBashTool(cwd); // no bashMode → "any"
    // 'touch' is rejected by validateReadonlyCommand but allowed in 'any' mode.
    try {
      const result = await tool.handler({ command: "touch newfile.txt" });
      assert.equal(
        (result as { code: number }).code,
        0,
        "touch should succeed in 'any' mode (V1 baseline)"
      );
    } catch (error) {
      assert.ok(
        !(error instanceof ReadonlyViolationError),
        `bashMode absent must NOT throw ReadonlyViolationError, got: ${error}`
      );
    }
  });

  it("bashMode='any' explicit is identical to absent", async () => {
    const cwd = await makeScratch("bash-any-explicit-");
    const tool = createBashTool(cwd, { bashMode: "any" });
    try {
      await tool.handler({ command: "touch newfile.txt" });
    } catch (error) {
      assert.ok(
        !(error instanceof ReadonlyViolationError),
        `bashMode='any' must NOT throw ReadonlyViolationError, got: ${error}`
      );
    }
  });
});
