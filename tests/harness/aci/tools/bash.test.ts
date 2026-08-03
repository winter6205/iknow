import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createBashTool } from "../../../../src/harness/aci/tools/bash.ts";
import { waitForPidFile, waitForProcessExit } from "./spawn-test-utils.ts";

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

describe("createBashTool — schema and metadata", () => {
  it("exposes only the required command input without a model-facing timeout", async () => {
    const cwd = await makeScratch("bash-schema-");
    const tool = createBashTool(cwd);
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
      additionalProperties: boolean;
    };

    assert.equal(tool.name, "bash");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.properties, { command: { type: "string" } });
    assert.deepEqual(schema.required, ["command"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal("timeout" in schema.properties, false);
    assert.deepEqual(tool.aci, {
      category: "execute",
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      interruptBehavior: "cancel",
    });
  });
});

describe("bash — execution", () => {
  it("returns the structured code/stdout/stderr result for a successful command", async () => {
    const cwd = await makeScratch("bash-success-");
    const result = await runBash(cwd, "echo hello");

    assert.deepEqual(result, { code: 0, stdout: "hello\n", stderr: "" });
  });

  it("returns a non-zero exit code as data rather than throwing", async () => {
    const cwd = await makeScratch("bash-nonzero-");
    const result = await runBash(cwd, "git definitely-not-a-command");

    assert.notEqual(result.code, 0);
    assert.equal(typeof result.stdout, "string");
    assert.equal(typeof result.stderr, "string");
  });

  it("captures stderr separately", async () => {
    const cwd = await makeScratch("bash-stderr-");
    const result = await runBash(cwd, "cat missing-file.txt");

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /missing-file\.txt/);
  });

  it("runs with the factory cwd", async () => {
    const cwd = await makeScratch("bash-cwd-");
    const result = await runBash(cwd, "pwd");

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), cwd);
  });
});

describe("bash — permission gates", () => {
  it("rejects a command outside the transitional allowlist", async () => {
    const cwd = await makeScratch("bash-allowlist-");
    const tool = createBashTool(cwd);

    await assert.rejects(
      tool.handler({ command: "sh -c true" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("bash: command not in allowlist")
    );
  });

  it("rejects a dangerous command through the blacklist defense", async () => {
    const cwd = await makeScratch("bash-dangerous-");
    const tool = createBashTool(cwd);

    await assert.rejects(
      tool.handler({ command: "echo rm -rf /" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("bash: dangerous command rejected")
    );
  });
});

describe("bash — output limits", () => {
  it("truncates stdout to 12000 characters", async () => {
    const cwd = await makeScratch("bash-truncate-");
    await writeFile(join(cwd, "long.txt"), "x".repeat(12_001));

    const result = await runBash(cwd, "cat long.txt");

    assert.equal(result.stdout.length, 12_000);
    assert.equal(result.stdout, "x".repeat(12_000));
  });

  it("truncates by code point without splitting an emoji surrogate pair", async () => {
    const cwd = await makeScratch("bash-codepoint-");
    await writeFile(join(cwd, "unicode.txt"), `${"x".repeat(11_999)}😀tail`);

    const result = await runBash(cwd, "cat unicode.txt");

    assert.equal(Array.from(result.stdout).length, 12_000);
    assert.equal(result.stdout.endsWith("😀"), true);
    assert.equal(result.stdout.includes("�"), false);
  });
});

describe("bash — cancellation", () => {
  it("kills the detached command process tree when the execution signal aborts", async () => {
    const cwd = await makeScratch("bash-cancel-");
    const pidFile = join(cwd, "child.pid");
    await writeFile(
      join(cwd, "tree.cjs"),
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn("sleep", ["30"], { stdio: "ignore" });',
        'writeFileSync("child.pid", String(child.pid));',
        'child.once("exit", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
      ].join("\n")
    );
    const controller = new AbortController();
    const tool = createBashTool(cwd);
    const execution = tool.handler(
      { command: "node tree.cjs" },
      { signal: controller.signal }
    );
    const childPid = await waitForPidFile(pidFile);
    assert.doesNotThrow(() => process.kill(childPid, 0));

    controller.abort();
    await execution;

    await waitForProcessExit(childPid);
  }, 5_000);
});

interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBash(cwd: string, command: string): Promise<BashResult> {
  const tool = createBashTool(cwd);
  return (await tool.handler({ command })) as BashResult;
}
