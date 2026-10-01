import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createBashTool } from "../../../../src/harness/aci/tools/bash.ts";
import { createSecretRegistry } from "../../../../src/harness/secret-roundtrip/index.ts";
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
  it("exposes command + background + the ADR-0134 model-facing timeout_ms", async () => {
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
    // ADR-0097: egress goes through a dedicated seam, no per-call opt-in field.
    // ADR-0134 supersedes ADR-0004 Decision 1 ("Bash timeout is not exposed to
    // the model"): timeout_ms is now part of the model-facing input surface,
    // and this snapshot pins it byte-for-byte alongside the other two.
    assert.deepEqual(schema.properties, {
      command: { type: "string" },
      // background?: boolean (default false = foreground, behavior unchanged)
      background: {
        type: "boolean",
        description:
          "When true, run the command in the background: returns {task_id, log_path} immediately and the process keeps running after the call, managed by the task registry. Use for long-lived servers or daemons; pair with bash_output (read the log) and bash_stop (terminate). Add timeout_ms to give the background job a finite runtime budget measured from launch; leave it out to keep a task running until you stop it. Defaults to false (foreground).",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        description:
          "Runtime budget for this call, in whole milliseconds (positive). Foreground: how long the command may run before it is terminated; omit it for the 10-second default. Background: the job's deadline, measured from launch and not extended by reading the log or polling status; omit it for a task that runs until bash_stop. A value that is zero, negative, fractional, or too large for a host timer is rejected before anything starts.",
      },
    });
    assert.deepEqual(schema.required, ["command"]);
    assert.equal(schema.additionalProperties, false);
    // The pre-ADR-0134 generic `timeout` key stays absent: the field is
    // named, typed and bounded, not an open-ended passthrough.
    assert.equal("timeout" in schema.properties, false);
    assert.deepEqual(tool.aci, {
      category: "execute",
      isConcurrencySafe: false,
      interruptBehavior: "cancel",
      // ADR-0134 moved Bash's clock from the ACI tier into the handler: the
      // validated `timeout_ms` (or the 10 s default) is enforced in the
      // process plane. `unbounded` is the honest declaration that the ACI
      // layer arms no second timer above it — a `build` tier would abort a
      // 10-minute `timeout_ms` at 5 minutes, which is the nesting this
      // replaced. `TIMEOUT_TIER_MS.build` itself is unchanged for the tools
      // that still use it.
      timeoutTier: "unbounded",
    });
  });

  it("不带输出闸豁免声明（ADR-0083：只有内建 skill 装配期落值）", async () => {
    const cwd = await makeScratch("bash-schema-");
    const tool = createBashTool(cwd);

    assert.equal(tool.exemptFromOutputCap, undefined);
  });

  // ADR-0092: the bash description is two sentences — writes into the project go to
  // taskRoot; scratch that need not enter the repo goes to the session tmp dir ($TMPDIR, lives as long as the current identity, not a delivery destination).
  it("description documents project writes at taskRoot and the session tmp dir ($TMPDIR)", async () => {
    const cwd = await makeScratch("bash-desc-tmp-");
    const tool = createBashTool(cwd);
    assert.match(tool.description, /write into the project at taskRoot/i);
    assert.match(tool.description, /session tmp dir \(\$TMPDIR/i);
    assert.match(tool.description, /not a delivery destination/);
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
  it("no longer rejects non-allowlist commands at handler level (ask flow + bwrap)", async () => {
    // The allowlist was downgraded to an ask flow: the handler no longer blocks non-allowlisted commands; bwrap enforces the boundary at execution time.
    const cwd = await makeScratch("bash-allowlist-");
    const result = await runBash(cwd, "sh -c true");
    assert.equal(result.code, 0);
  });

  it("rejects a dangerous command through the blacklist defense", async () => {
    const cwd = await makeScratch("bash-dangerous-");
    const tool = createBashTool(cwd);

    // A real destructive argv: the wall answers nothing for an inert
    // `echo rm -rf /` anymore. The target does not exist, so a wall that
    // stopped rejecting could still not destroy anything from this scratch dir.
    await assert.rejects(
      tool.handler({ command: "rm -rf ./bash-dangerous-nonexistent" }),
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

  /**
   * Pinned invariant: a pipe-free, SIGTERM-immune descendant must not survive a cancelled call.
   *
   * Why: `close` fires when the direct child and its stdio pipes close, not when the
   * process group empties. If a descendant holds no pipe (`> /dev/null` / stdio:"ignore")
   * and ignores SIGTERM (`trap '' TERM`, its own handler, uninterruptible syscall),
   * `close` arrives the moment the direct child exits while group descendants keep
   * running. So the assertion face must be "the descendant process itself disappears
   * after the call returns", not "the direct child disappears" — the latter holds
   * trivially in this shape and cannot pin the invariant.
   *
   * Determinism: the shell blocks in `wait` and cannot exit while the descendant lives,
   * so the abort always lands while the call is genuinely in flight; the descendant
   * installs its SIGTERM handler before writing the pid file, so waitForPidFile doubles
   * as the "handler installed" barrier (no fixed sleep).
   */
  it("leaves no surviving descendant after an abort, when the descendant ignores SIGTERM and holds no pipe", async () => {
    const cwd = await makeScratch("bash-cancel-escapee-");
    const pidFile = join(cwd, "desc.pid");
    const controller = new AbortController();
    const tool = createBashTool(cwd);
    const execution = tool.handler(
      {
        command: [
          // SIGTERM-immune + holds no stdio pipe + installs handler before writing the pid file.
          'node -e \'process.on("SIGTERM",()=>{});require("fs").writeFileSync("desc.pid",String(process.pid));setInterval(()=>{},1000)\' > /dev/null 2>&1 &',
          "wait",
        ].join("\n"),
      },
      { signal: controller.signal }
    );
    const descendantPid = await waitForPidFile(pidFile);
    assert.equal(
      await descendantRunning(descendantPid),
      true,
      "fixture must have a live, SIGTERM-immune descendant before the abort"
    );

    controller.abort();
    await execution;

    // The call has returned — the descendant must be gone (or on its way). Still alive at the polling cap fails;
    // Z (zombie: killed by the kernel, awaiting reap) counts as dead.
    assert.equal(
      await waitForDescendantGone(descendantPid),
      true,
      `descendant ${descendantPid} survived the cancelled call`
    );
  }, 15_000);
});

/** Liveness check: Z (zombie) and ESRCH / missing /proc entry all count as "not running". */
async function descendantRunning(pid: number): Promise<boolean> {
  const state = readProcState(pid);
  return state !== undefined && state !== "Z";
}

/**
 * Bounded polling for descendant disappearance (every 20ms, capped at 5s). No fixed sleep:
 * process-group signalling and reaping are async, so a fixed wait is either falsely green
 * (too long) or flaky (too short).
 */
async function waitForDescendantGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await descendantRunning(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** state field of /proc/<pid>/stat (3rd field; comm may contain spaces, so skip past the closing paren first). */
function readProcState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Since the envelope change the bash handler returns `{ output, meta? }`; the model only
 *  sees code/stdout/stderr JSON-stringified inside `output` (shape unchanged). This test
 *  file keeps the "interface = legacy BashResult" contract by doing one extra parse in the
 *  helper layer — business assertions are unaffected by the envelope wrapper. */
interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}

function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

async function runBash(cwd: string, command: string): Promise<BashResult> {
  const tool = createBashTool(cwd);
  const envelope = (await tool.handler({ command })) as BashEnvelope;
  return parseBashEnvelope(envelope);
}

// ---------------------------------------------------------------------------
// bash placeholder-restore layer (restore runs before spawn)
// ---------------------------------------------------------------------------
// bwrap 0.11.1 is available in this test environment (the execution describe above really spawns).
// Registered secret + command containing <<<SECRET_1>>> → restored, then spawned → stdout sees the real value (later masked).
// Command containing an unregistered <<<SECRET_MISSING>>> → passed to bash verbatim without
//    throwing; bash echoes the literal as a missing command name to stderr (command not found) → graceful.
describe("#406 T3 — bash 占位符还原层", () => {
  it("A1：注册值还原 —— stdout 不含占位符（restore 命中）", async () => {
    const cwd = await makeScratch("bash-restore-");
    const registry = createSecretRegistry();
    registry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_1>>>"',
      })) as BashEnvelope
    );

    // Note: the M1 output mask runs after restore, so stdout already shows *** (real value hidden).
    // This case asserts restore hit (placeholder gone + real value replaced by the mask); it
    // does not re-test M1 semantics.
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes("<<<SECRET_1>>>"),
      false,
      `stdout 不应再含占位符（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(
      result.stdout.includes("sk-aaaaaaaaaaaaaaaaaaaa"),
      false,
      `stdout 不应含原 secret 值（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(result.stdout, "***\n");
  });

  it("A1：多占位符命令完整还原后执行", async () => {
    const cwd = await makeScratch("bash-restore-multi-");
    const registry = createSecretRegistry();
    registry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    registry.register("AKIA1234567890ABCDEF");
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_1>>> <<<SECRET_2>>>"',
      })) as BashEnvelope
    );

    // Same as above: after restore the mask collapses them to `*** ***`; this case only asserts
    // both placeholders were restored (stdout contains no placeholder literal).
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes("<<<SECRET_1>>>") ||
        result.stdout.includes("<<<SECRET_2>>>"),
      false,
      `stdout 不应含任何占位符（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(result.stdout.includes("sk-aaaaaaaaaaaaaaaaaaaa"), false);
    assert.equal(result.stdout.includes("AKIA1234567890ABCDEF"), false);
    assert.equal(result.stdout, "*** ***\n");
  });

  it("A2：未注册占位符原样透传 bash，不抛错（graceful degradation）", async () => {
    const cwd = await makeScratch("bash-restore-missing-");
    const registry = createSecretRegistry();
    const tool = createBashTool(cwd, { secretRegistry: registry });

    // The placeholder sits inside quotes so bash does not treat it as a here-string redirect; restore only
    // replaces registered placeholders, and the unregistered <<<SECRET_MISSING>>> enters bash verbatim and is echoed to stdout.
    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_MISSING>>>"',
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      "<<<SECRET_MISSING>>>\n",
      `未注册占位符应原样透传（实际=${JSON.stringify(result.stdout)}）`
    );
  });

  it("A2：空 registry 命令不还原，原样透传", async () => {
    const cwd = await makeScratch("bash-restore-empty-");
    const tool = createBashTool(cwd, {
      secretRegistry: createSecretRegistry(),
    });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: "echo keep",
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
  });
});

// ---------------------------------------------------------------------------
// bash output mask (applied before the handler returns)
// ---------------------------------------------------------------------------
// Constraints:
//   - the mask is built fresh inside each handler call (registry values can change across turns; no module-level cache)
//   - absent secretRegistry → no mask, no crash
//   - envelope shape: exactly { output: string, meta?: { stdout?, stderr? } } at the top level;
//     output holds JSON-stringified code/stdout/stderr (model-visible bytes unchanged),
//     meta is an observability side channel (for the TUI tail window, not in the model tool_result)
//   - registry present but empty → identity mask, output unchanged
describe("#406 T3 — bash 输出遮罩（output-mask on stdout/stderr）", () => {
  it("M1：registry 在场 + 命令经占位符还原路径 → stdout 真值被遮罩为 ***", async () => {
    const cwd = await makeScratch("bash-mask-stdout-");
    const registry = createSecretRegistry();
    const secret = "sk-live-超密值-aaaaaaaaaaaa";
    registry.register(secret);
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_1>>>"',
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes(secret),
      false,
      `stdout 不应含原 secret 值（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(
      result.stdout.includes("***"),
      true,
      `stdout 应含遮罩符 ***（实际=${JSON.stringify(result.stdout)}）`
    );
  });

  it("M1：registry 在场 + stderr 真值同样被遮罩", async () => {
    const cwd = await makeScratch("bash-mask-stderr-");
    const registry = createSecretRegistry();
    const secret = "AKIA1234567890ABCDEF-leak";
    registry.register(secret);
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: `printf '%s' "<<<SECRET_1>>>" >&2; exit 0`,
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.includes(secret),
      false,
      `stderr 不应含原 secret 值（实际=${JSON.stringify(result.stderr)}）`
    );
    assert.equal(
      result.stderr.includes("***"),
      true,
      `stderr 应含遮罩符 ***（实际=${JSON.stringify(result.stderr)}）`
    );
  });

  it("M2：缺席 secretRegistry → 输出原样、不 crash", async () => {
    const cwd = await makeScratch("bash-mask-absent-");
    const tool = createBashTool(cwd); // no secretRegistry passed
    const secret = "sk-live-超密值-no-mask";

    const result = parseBashEnvelope(
      (await tool.handler({
        command: `echo "${secret}"`,
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes(secret),
      true,
      `缺席 registry 时 stdout 应原样含真值（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(result.stdout.includes("***"), false);
  });

  it("M3：返回形状是 envelope —— 顶层恰 { output: string, meta?: { stdout?, stderr? } }", async () => {
    const cwd = await makeScratch("bash-mask-shape-");
    const registry = createSecretRegistry();
    registry.register("sk-shape-probe-aaaaaaaaaa");
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = (await tool.handler({
      command: 'echo "<<<SECRET_1>>>"',
    })) as BashEnvelope;

    // Top level: must contain `output` (the model-visible string); `meta` is the observability side channel
    // (stdout/stderr live there, not in the model tool_result); code/stdout/stderr no longer sit at the top level.
    assert.deepEqual(Object.keys(result).sort(), ["meta", "output"]);
    assert.equal(typeof result.output, "string");
    assert.equal(typeof result.meta, "object");

    // Parsing the envelope-embedded code/stdout/stderr preserves the original M3 semantics (shape unchanged,
    // assertion strength not reduced): code=0, stdout="***\n", stderr="", and the stdout/stderr inside the
    // envelope are masked in sync (the output mask cannot be bypassed).
    const parsed = parseBashEnvelope(result);
    assert.deepEqual(parsed, {
      code: 0,
      stdout: "***\n",
      stderr: "",
    });
    // meta.stdout / meta.stderr are the output side channel, byte-identical to the fields inside
    // envelope.output (the mask covers both sides so the model/tool/UI views never drift apart).
    assert.equal(result.meta?.stdout, parsed.stdout);
    assert.equal(result.meta?.stderr, parsed.stderr);
  });

  it("M4：registry 在场但值为空（边界） → mask identity，输出原样不 crash", async () => {
    const cwd = await makeScratch("bash-mask-empty-registry-");
    const tool = createBashTool(cwd, {
      secretRegistry: createSecretRegistry(), // empty registry
    });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: "echo keep",
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
    assert.equal(result.stderr, "");
  });

  it("M4：注册空串（边界） → mask identity，输出原样不 crash", async () => {
    const cwd = await makeScratch("bash-mask-empty-string-");
    const registry = createSecretRegistry();
    registry.register(""); // empty-string registered
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: "echo keep",
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
    assert.equal(result.stderr, "");
  });
});
