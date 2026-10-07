/**
 * The real-docker implementation of `RunnerPort`: the reward path and the container env.
 *
 * Why this file exists (issue 1219, found only by a real Docker smoke run):
 *
 *   1. `grade()` extracted the reward with `/reward=(\S+)/` over the grader's STDOUT, but
 *      every terminal-bench-2.1 `test.sh` writes `/logs/verifier/reward.txt` and echoes
 *      nothing. Measured on all three graded tasks, the port returned `null` while the HOST
 *      file held a real `0`. Because `preflight.ts`'s `judgeMeasurement` gates on
 *      `oracleReward === "1"`, EVERY task was recorded `EXCLUDE:oracle-or-grader` — including
 *      a task whose oracle genuinely passes. A green-looking exclusion caused by a broken
 *      measurement path is exactly the defect class this issue exists to repair, so the
 *      reward must come from the retained HOST artifact, and an unreadable reward must read
 *      as `null` rather than be invented as `0`.
 *
 *   2. `ensureContainer` passed no proxy env, so on a host that reaches the network only
 *      through a proxy the real attempt path could not `apt-get install curl` at all. The
 *      proxy must be an explicit operator-supplied option — never a machine-specific default
 *      baked into the instrument — and an unset option must leave the argv untouched.
 *
 *   3. `provision` dropped the probe's exit status and published `ABSENT` for every missing
 *      ceiling, so a probe that never RAN — no `bash`, a blocked exec, a full tmpfs, a daemon
 *      error, a dead container — became a library exclusion. That is the same mis-attribution
 *      the smoke path already stopped making (`smoke-tasks.ts` `imageGlibcxx`): a HARNESS
 *      fault charged to the TASK. A failed probe is `PROBE_FAILED`, the smoke's own word.
 *
 * All three are driven through a fake `ExecFn` here: no unit test has to own a container, and
 * the real Docker path stays the exclusive business of the disposable smoke run.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  createDockerRunner,
  ImageDigestUnusableError,
  InstructionMissingError,
  MODEL_UNRESOLVED,
  OracleFailedError,
  OracleNotApplicableError,
  retainedHostReward,
  UNREADABLE_STOP_REASON,
  type AgentDispatchObservation,
  type DockerRunnerOptions,
  type ExecFn,
} from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import type { ProvisionSpec } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import { PROBE_FAILED } from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";
import {
  cleanupTempRoots,
  identityFor,
  makeAttemptDir,
  tempRoot,
} from "./fixtures.ts";

afterAll(cleanupTempRoots);

/** A real registry content digest: `sha256:` followed by 64 lowercase hex characters. */
const REAL_IMAGE_DIGEST = `sha256:${"3f".repeat(32)}`;

/** One recorded `exec` invocation: everything the runner built for the docker command line. */
interface RecordedCall {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

interface Answer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

type Responder = (args: ReadonlyArray<string>) => Answer;

/** A recording `ExecFn`: captures every argv and answers from a caller-supplied responder. */
function fakeExec(respond?: Responder): {
  readonly exec: ExecFn;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    const answer = respond?.(args) ?? {};
    return {
      stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "",
      code: answer.code ?? 0,
    };
  };
  return { exec, calls };
}

/** The spec fields `grade()` uses are `outDir` and the identity; the rest is written for realism. */
function specFor(outDir: string): ProvisionSpec {
  const root = join(outDir, "..", "inputs");
  mkdirSync(root, { recursive: true });
  const bundlePath = join(root, "bundle.tgz");
  const nodeArchivePath = join(root, "node.tar.gz");
  const settingsPath = join(root, "settings.json");
  writeFileSync(bundlePath, "bundle bytes");
  writeFileSync(nodeArchivePath, "node dist bytes");
  writeFileSync(
    settingsPath,
    '{\n  "_note": "issue-1219 docker.test placeholder; no credentials"\n}\n'
  );
  return {
    identity: identityFor(),
    taskDir: join(root, "dataset/tasks/db-wal-recovery"),
    outDir,
    bundlePath,
    nodeArchivePath,
    settingsPath,
  };
}

/** The stdout a real terminal-bench-2.1 grader emits: a real result line, no `reward=`. */
const GRADER_STDOUT =
  "grader_exit=0\n=============== 7 passed, 1 skipped in 12.41s ===============\n";

function answerGrade(args: ReadonlyArray<string>): Answer {
  return args[0] === "exec"
    ? { stdout: GRADER_STDOUT }
    : { stdout: "", code: 0 };
}

/** The `docker run -d` line, i.e. the provisioning call the env option must reach. */
function runLine(calls: ReadonlyArray<RecordedCall>): ReadonlyArray<string> {
  const call = calls.find(
    (item) =>
      item.file === "docker" &&
      item.args[0] === "run" &&
      item.args.includes("-d")
  );
  assert.ok(
    call !== undefined,
    `expected a docker run -d line; got: ${JSON.stringify(calls)}`
  );
  return call.args;
}

async function gradeOnce(
  outDir: string,
  respond: Responder = answerGrade,
  options: DockerRunnerOptions = {}
): Promise<ReadonlyArray<string>> {
  const { exec } = fakeExec(respond);
  const observation = await createDockerRunner(exec, 1_000, options).grade(
    specFor(outDir),
    60
  );
  return [observation.reward === null ? "<null>" : observation.reward];
}

describe("grade() reads the reward from the retained HOST artifact", () => {
  it("reports the reward the grader wrote to host reward.txt even when stdout carries none", async () => {
    const dir = makeAttemptDir(tempRoot("docker-reward-host"), {
      reward: "1\n",
    });

    assert.ok(
      !GRADER_STDOUT.includes("reward="),
      "the test is only meaningful while the grader stdout has no reward= to scrape"
    );
    const [reward] = await gradeOnce(dir);

    assert.equal(
      reward,
      "1",
      "the reward is in the host reward.txt, so grade() must report it; judgeMeasurement gates on it"
    );
  });

  it("reports null — never 0 — when the reward file is absent", async () => {
    const dir = makeAttemptDir(tempRoot("docker-reward-missing"), {
      ctrfBytes: 2878,
    });

    assert.equal(
      retainedHostReward(dir),
      null,
      "an unreadable reward must be absent, not invented as 0"
    );
    const [reward] = await gradeOnce(dir);

    assert.equal(
      reward,
      "<null>",
      "a missing reward.txt must read as null; 0 is a real grader verdict and must not be fabricated"
    );
  });

  it("reports null for an empty or whitespace-only reward file", async () => {
    const dir = makeAttemptDir(tempRoot("docker-reward-blank"), {
      reward: "   \n\n",
    });

    const [reward] = await gradeOnce(dir);

    assert.equal(
      reward,
      "<null>",
      "a blank reward file carries no verdict, so it must read as null rather than as 0"
    );
  });

  it("does not fall back to scraping reward= out of stdout", async () => {
    const dir = makeAttemptDir(tempRoot("docker-reward-stdout-only"), {});
    const noisy = (args: ReadonlyArray<string>): Answer =>
      args[0] === "exec"
        ? { stdout: `${GRADER_STDOUT}reward=1\n` }
        : { stdout: "", code: 0 };

    const [reward] = await gradeOnce(dir, noisy);

    assert.equal(
      reward,
      "<null>",
      "stdout is not the reward channel; honouring it would hide a missing retained artifact"
    );
  });

  it("still reports the grader exit, result line and retained CTRF from the same run", async () => {
    const dir = makeAttemptDir(tempRoot("docker-grade-rest"), {
      reward: "0",
      ctrfBytes: 2878,
    });
    const { exec } = fakeExec(answerGrade);

    const observation = await createDockerRunner(exec, 1_000).grade(
      specFor(dir),
      60
    );

    assert.equal(
      observation.exitCode,
      0,
      `grader_exit= must be read; got: ${observation.exitCode}`
    );
    assert.equal(
      observation.resultLine,
      "7 passed",
      `the real result line must survive the reward fix; got: ${JSON.stringify(observation.resultLine)}`
    );
    assert.equal(
      observation.ctrfBytes,
      2878,
      "the retained host CTRF must stay measurable"
    );
    assert.equal(
      observation.reward,
      "0",
      "a retained 0 is a real verdict and must be reported as 0"
    );
  });
});

describe("container env reaches docker run as an explicit option", () => {
  it("forwards every containerEnv entry as one -e flag on the docker run line", async () => {
    const { exec, calls } = fakeExec();
    const spec = specFor(tempRoot("docker-env-on"));

    await createDockerRunner(exec, 1_000, {
      containerEnv: {
        HTTP_PROXY: "http://proxy.invalid:7890",
        HTTPS_PROXY: "http://proxy.invalid:7890",
        NO_PROXY: "localhost,127.0.0.1",
      },
    }).provision(spec);

    const args = runLine(calls);
    for (const [name, value] of Object.entries({
      HTTP_PROXY: "http://proxy.invalid:7890",
      HTTPS_PROXY: "http://proxy.invalid:7890",
      NO_PROXY: "localhost,127.0.0.1",
    })) {
      assert.ok(
        args.includes(`${name}=${value}`),
        `expected -e ${name}=${value} on the run line; got: ${JSON.stringify(args)}`
      );
    }
  });

  it("emits no -e flag at all when the option is unset", async () => {
    const { exec, calls } = fakeExec();

    await createDockerRunner(exec, 1_000).provision(
      specFor(tempRoot("docker-env-off"))
    );

    const args = runLine(calls);
    assert.equal(
      args.filter((arg) => arg === "-e").length,
      0,
      `an unset proxy must leave the argv exactly as it was; got: ${JSON.stringify(args)}`
    );
  });

  it("emits no -e flag for an empty containerEnv, and never inherits the host env", async () => {
    const { exec, calls } = fakeExec();

    await createDockerRunner(exec, 1_000, { containerEnv: {} }).provision(
      specFor(tempRoot("docker-env-empty"))
    );

    assert.equal(
      runLine(calls).filter((arg) => arg === "-e").length,
      0,
      `only an explicit option may add -e; got: ${JSON.stringify(runLine(calls))}`
    );
  });

  it("places every -e flag before the image so docker accepts the line", async () => {
    const { exec, calls } = fakeExec();

    await createDockerRunner(exec, 1_000, {
      containerEnv: { HTTP_PROXY: "http://proxy.invalid:7890" },
    }).provision(specFor(tempRoot("docker-env-order")));

    const args = runLine(calls);
    const imageAt = args.indexOf(specForImage());
    assert.ok(
      imageAt > 0,
      `the image must appear on the run line; got: ${JSON.stringify(args)}`
    );
    assert.ok(
      args.indexOf("-e") < imageAt &&
        args.indexOf("HTTP_PROXY=http://proxy.invalid:7890") < imageAt,
      `docker run rejects options after the image; got: ${JSON.stringify(args)}`
    );
  });

  it("keeps a proxy value containing = and a space inside one argv element", async () => {
    const { exec, calls } = fakeExec();
    const value = "http://user:p=a ss@proxy.invalid:7890";

    await createDockerRunner(exec, 1_000, {
      containerEnv: { HTTP_PROXY: value },
    }).provision(specFor(tempRoot("docker-env-split")));

    assert.ok(
      runLine(calls).includes(`HTTP_PROXY=${value}`),
      `the value must arrive unsplit; got: ${JSON.stringify(runLine(calls))}`
    );
  });
});

/** The image of the fixture identity, read from the spec the runner was given. */
function specForImage(): string {
  return identityFor().image;
}

/** True for the `docker exec <name> bash -c <script>` line the phase scripts run on. */
function isBashExec(args: ReadonlyArray<string>): boolean {
  return args[0] === "exec" && args[3] === "-c";
}

/** Provision through a fake whose single `bash -c` line answers with `exitCode`/`output`. */
async function provisionOnce(
  exitCode: number,
  output: string
): Promise<{ readonly glibcxxMeasured: string }> {
  const { exec } = fakeExec((args) =>
    isBashExec(args) ? { code: exitCode, stdout: output } : { code: 0 }
  );
  return createDockerRunner(exec, 1_000).provision(
    specFor(tempRoot("docker-probe"))
  );
}

/** Answer each `bash -c` line by which marker its script carries; default is a silent 0. */
function scriptResponder(table: ReadonlyArray<[string, Answer]>): Responder {
  return (args) => {
    if (!isBashExec(args)) return { code: 0 };
    const script = args[4] ?? "";
    const hit = table.find(([needle]) => script.includes(needle));
    return hit === undefined ? { code: 0 } : hit[1];
  };
}

/** Index of the first recorded call whose argv mentions `needle`; -1 when absent. */
function firstCall(calls: ReadonlyArray<RecordedCall>, needle: string): number {
  return calls.findIndex((call) =>
    call.args.some((arg) => arg.includes(needle))
  );
}

/** The instruction a real terminal-bench-2.1 task keeps at its ROOT, not under `tests/`. */
const TASK_INSTRUCTION =
  "Recover the corrupted SQLite WAL and re-attach it read-only.\n";

/** A spec whose task directory carries the dataset's instruction, as a real task directory does. */
function specWithInstruction(
  outDir: string,
  instruction: string | null = TASK_INSTRUCTION
): ProvisionSpec {
  const spec = specWithPinnedImage(outDir);
  mkdirSync(spec.taskDir, { recursive: true });
  if (instruction !== null) {
    writeFileSync(join(spec.taskDir, "instruction.md"), instruction);
  }
  return spec;
}

/** A spec whose identity carries a REAL content digest, so the image reference can be pinned. */
function specWithPinnedImage(outDir: string): ProvisionSpec {
  const spec = specFor(outDir);
  return {
    ...spec,
    identity: identityFor({
      image: "alexgshaw/db-wal-recovery:20251031",
      imageDigest: REAL_IMAGE_DIGEST,
    }),
  };
}

/**
 * The agent's OWN output contract, as the product actually writes it.
 *
 * These are the producer's documents, not a convenient summary. `ask` writes exactly ONE
 * JSON document per invocation, and `dispatchPhase` has to read THAT:
 *
 *   - success: `formatRunJson` (src/cli/format.ts:350-369) pretty-prints
 *     `{ finalText, stopReason, turnCount, lastUsage?, trace, runState? }` to STDOUT with
 *     `JSON.stringify(..., null, 2)`. `lastUsage` and `runState` are DROPPED when null/undefined.
 *   - max turns: `maxTurnsEnvelope` (src/cli/max-turns.ts:39-59) writes ONE COMPACT line
 *     `{ error, turnsRan, reason, message, stopSummary? }` to STDERR and sets exitCode 1.
 *
 * `EVAL_STATE_NOTICE` (src/harness/sandbox/eval-state.ts:116) is written to stderr FIRST on
 * every `ask --eval-state` run, so the captured output of a real dispatch always carries it.
 */
const EVAL_STATE_NOTICE =
  "eval_state: ADR-0130 eval state — bwrap fence retired on the foreground bash " +
  "route, egress seam off, permission full_auto, fs mode global. Not " +
  "guardrail-free: the hard-wall still intercepts before full_auto, and writes " +
  "still resolve against the live taskRoot. Scoped to what this entry mounts: " +
  "the ask entry has no background manager, no subagent worker and no verify " +
  "sandbox-run, so this run measures none of those three. Nothing is " +
  "persisted for this invocation; any number this run publishes must name " +
  "this state.\n";

/** The `TokenUsage` the adapter reports (src/harness/model-adapter/types.ts:171-176). */
const TOKEN_USAGE = {
  inputTokens: 18244,
  outputTokens: 731,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 16384,
} as const;

/** The `LoopTrace` the success envelope carries: structural metadata, and NO model key. */
const LOOP_TRACE = {
  turns: [
    {
      turnIndex: 1,
      supplierStop: "success",
      toolCalls: [{ toolUseId: "toolu_01", toolName: "Bash", kind: "ok" }],
      durationMs: 4210,
      cancelKind: "none",
    },
  ],
  totals: {
    totalDurationMs: 21044,
    cancelKindCounts: {
      none: 6,
      callerAbort: 0,
      timerTimeout: 0,
      hostCancel: 0,
    },
    toolErrorTotals: {
      ok: 5,
      validation_failed: 0,
      tool_not_found: 0,
      execution_failed: 0,
    },
  },
} as const;

/** STDOUT of a completed `ask --eval-state` run, byte-for-byte the shape ask publishes. */
const SUCCESS_ENVELOPE = `${JSON.stringify(
  {
    finalText: "Recovered the WAL; the database re-attaches read-only.",
    stopReason: "completed",
    turnCount: 6,
    lastUsage: TOKEN_USAGE,
    trace: LOOP_TRACE,
    runState: "eval_state",
  },
  null,
  2
)}\n`;

/**
 * The same envelope from a run whose first model call failed: `lastUsage` is null, and
 * `JSON.stringify` DROPS the key entirely, so "no token spend" is an ABSENT key on the wire.
 */
const SUCCESS_ENVELOPE_WITHOUT_USAGE = `${JSON.stringify(
  {
    finalText: null,
    stopReason: "protocolError",
    turnCount: 0,
    trace: LOOP_TRACE,
    runState: "eval_state",
  },
  null,
  2
)}\n`;

/** STDERR of a run that hit `--max-turns`: compact, single line, process exit code 1. */
const MAX_TURNS_ENVELOPE = `${JSON.stringify({
  error: "max_turns_exceeded",
  turnsRan: 40,
  reason: "maxTurns",
  message: "已达 maxTurns=40 轮上限（maxTurns），终止",
  stopSummary: "Recreated the -wal sidecar; the re-attach is unverified.",
})}\n`;

/** The model route a real settings file names, and the key the harness copies into the container. */
const SETTINGS_MODEL_ROUTE = "deepseek/deepseek-chat";

/** Dispatch one spec through a recording exec; the caller asserts on the argv it produced. */
async function dispatchOnce(
  spec: ProvisionSpec
): Promise<{ readonly exec: ExecFn; readonly calls: RecordedCall[] }> {
  const fake = fakeExec((args) =>
    isBashExec(args)
      ? { stdout: SUCCESS_ENVELOPE, stderr: EVAL_STATE_NOTICE, code: 0 }
      : { code: 0 }
  );
  await createDockerRunner(fake.exec, 1_000).dispatch(spec, {
    maxTurns: 40,
    agentWallSec: 60,
    graderGraceSec: 15,
  });
  return fake;
}

describe("the task instruction is delivered to the agent, or the run refuses", () => {
  it("materializes the task's real instruction where the container reads it", async () => {
    const dir = makeAttemptDir(tempRoot("docker-instruction-present"));
    const spec = specWithInstruction(dir);

    await dispatchOnce(spec);

    const target = join(dir, "meta/instruction.md");
    assert.ok(
      existsSync(target),
      `the container reads /artifacts/meta/instruction.md, which is ${target} on the host; ` +
        'nothing else writes it, so without this the agent is invoked as `ask ""`'
    );
    assert.equal(
      readFileSync(target, "utf8"),
      TASK_INSTRUCTION,
      "the delivered prompt must be the task's own instruction text, byte for byte"
    );
  });

  it("writes the instruction BEFORE the agent runs, not after it", async () => {
    const dir = makeAttemptDir(tempRoot("docker-instruction-order"));
    const { exec, calls } = fakeExec();
    const spec = specWithInstruction(dir);

    await createDockerRunner(exec, 1_000).dispatch(spec, {
      maxTurns: 40,
      agentWallSec: 60,
      graderGraceSec: 15,
    });

    const target = join(dir, "meta/instruction.md");
    assert.ok(
      existsSync(target),
      `the prompt must exist before the dispatch exec reads it; got: ${JSON.stringify(calls)}`
    );
  });

  it("refuses before dispatch when the task ships no instruction at all", async () => {
    const dir = makeAttemptDir(tempRoot("docker-instruction-absent"));
    const { exec, calls } = fakeExec();
    const spec = specWithPinnedImage(dir); // a task directory with no instruction.md

    await assert.rejects(
      () =>
        createDockerRunner(exec, 1_000).dispatch(spec, {
          maxTurns: 40,
          agentWallSec: 60,
          graderGraceSec: 15,
        }),
      (error: unknown) =>
        error instanceof InstructionMissingError &&
        error.expectedPath.endsWith("meta/instruction.md")
    );
    assert.equal(
      calls.length,
      0,
      `an empty prompt must never reach a model: the refusal happens before any exec; got: ${JSON.stringify(calls)}`
    );
  });

  it("refuses an empty instruction rather than dispatching a blank prompt", async () => {
    const dir = makeAttemptDir(tempRoot("docker-instruction-blank"));
    const { exec, calls } = fakeExec();
    const spec = specWithInstruction(dir, "   \n\n");

    await assert.rejects(
      () =>
        createDockerRunner(exec, 1_000).dispatch(spec, {
          maxTurns: 40,
          agentWallSec: 60,
          graderGraceSec: 15,
        }),
      (error: unknown) => error instanceof InstructionMissingError
    );
    assert.equal(
      firstCall(calls, "cli.js ask"),
      -1,
      "a blank instruction carries no task, so no agent may be invoked with it"
    );
  });

  it("keeps the oracle separation: the dispatch path still cannot reach solve.sh", async () => {
    const dir = makeAttemptDir(tempRoot("docker-instruction-oracle"));
    const spec = specWithInstruction(dir);
    mkdirSync(join(spec.taskDir, "solution"), { recursive: true });
    writeFileSync(
      join(spec.taskDir, "solution/solve.sh"),
      "#!/bin/bash\ntrue\n"
    );
    const { exec, calls } = fakeExec();

    await createDockerRunner(exec, 1_000).dispatch(spec, {
      maxTurns: 40,
      agentWallSec: 60,
      graderGraceSec: 15,
    });

    assert.equal(
      firstCall(calls, "solve.sh"),
      -1,
      "materializing the instruction must not weaken the oracle separation"
    );
    assert.equal(
      firstCall(calls, "/opt/oracle"),
      -1,
      "the agent path must not name the oracle directory at all"
    );
  });
});

describe("the recorded image identity constrains what actually runs", () => {
  it("starts the container by digest reference, so a moved tag cannot change the image", async () => {
    const { exec, calls } = fakeExec();
    const spec = specWithPinnedImage(tempRoot("docker-pinned-image"));

    await createDockerRunner(exec, 1_000).provision(spec);

    const args = runLine(calls);
    assert.ok(
      args.includes(`${spec.identity.image}@${REAL_IMAGE_DIGEST}`),
      `docker run must be given image@digest, not the mutable tag; got: ${JSON.stringify(args)}`
    );
    assert.ok(
      !args.includes(spec.identity.image),
      `the bare tag must not reach the command line at all; got: ${JSON.stringify(args)}`
    );
  });

  it("refuses to dispatch a model against a mutable tag", async () => {
    const dir = makeAttemptDir(tempRoot("docker-unpinned-dispatch"));
    const { exec, calls } = fakeExec();
    // A real instruction, but the fixture identity: a short digest string that pins nothing.
    const spec = { ...specWithInstruction(dir), identity: identityFor() };

    await assert.rejects(
      () =>
        createDockerRunner(exec, 1_000).dispatch(spec, {
          maxTurns: 40,
          agentWallSec: 60,
          graderGraceSec: 15,
        }),
      (error: unknown) =>
        error instanceof ImageDigestUnusableError &&
        error.image === spec.identity.image
    );
    assert.equal(
      calls.length,
      0,
      `no model may be dispatched on an image the identity cannot pin; got: ${JSON.stringify(calls)}`
    );
  });

  it("refuses a digest that declares its own gap, rather than trusting it", async () => {
    const dir = makeAttemptDir(tempRoot("docker-declared-gap"));
    const spec = specWithInstruction(dir);
    const { exec, calls } = fakeExec();

    await assert.rejects(
      () =>
        createDockerRunner(exec, 1_000).dispatch(
          {
            ...spec,
            identity: identityFor({
              imageDigest:
                "sha256:unresolved-local-tag:alexgshaw/db-wal-recovery:20251031",
            }),
          },
          { maxTurns: 40, agentWallSec: 60, graderGraceSec: 15 }
        ),
      (error: unknown) => error instanceof ImageDigestUnusableError
    );
    assert.equal(
      calls.length,
      0,
      "a self-declared gap is not an identity; the run fails closed rather than publishing one"
    );
  });

  it("dispatches once the identity pins the image exactly", async () => {
    const dir = makeAttemptDir(tempRoot("docker-pinned-dispatch"));
    const { calls } = await dispatchOnce(specWithInstruction(dir));

    assert.ok(
      firstCall(calls, "cli.js ask") >= 0,
      `a pinned image plus a real instruction is a dispatchable attempt; got: ${JSON.stringify(calls)}`
    );
  });
});

/** A spec whose task directory carries the dataset's own reference solution. */
function specWithSolveScript(outDir: string): ProvisionSpec {
  // Contract-valid: a real task directory ships its instruction, and a real run identity pins
  // its image. Without both, `dispatch()` refuses before it reaches anything these tests assert.
  const spec = specWithInstruction(outDir);
  mkdirSync(join(spec.taskDir, "solution"), { recursive: true });
  writeFileSync(
    join(spec.taskDir, "solution", "solve.sh"),
    "#!/bin/bash\nsqlite3 'file:/app/main.db?mode=ro' 'SELECT 1;'\n"
  );
  return spec;
}

/**
 * A successful oracle run followed by the real grader, as the two scripts report it.
 *
 * The oracle stdout carries the marker the real `ORACLE_SCRIPT` echoes itself, so the retained
 * oracle output is what a real run leaves behind rather than a convenient summary.
 */
function oracleThenGrader(graderStdout = GRADER_STDOUT): Responder {
  return scriptResponder([
    [
      "--- applying oracle ---",
      {
        stdout: "--- applying oracle ---\n=== Recovered ===\noracle_exit=0\n",
      },
    ],
    ["grader_exit=", { stdout: graderStdout }],
  ]);
}

describe("a failed library probe is PROBE_FAILED, never an absent library", () => {
  it("publishes PROBE_FAILED when the in-container probe exits nonzero", async () => {
    // The exact class of harness fault the finding names: the probe never ran, so the
    // ceiling is unknown. `ABSENT` would charge a task with a library exclusion for it.
    const observation = await provisionOnce(
      1,
      "logs-mount-writable\nv20.11.0\niknow --version\n"
    );

    assert.equal(
      observation.glibcxxMeasured,
      PROBE_FAILED,
      "a probe that exited nonzero never measured a ceiling, so it must never read as the " +
        `absent library ABSENT would exclude the task for; got: ${JSON.stringify(observation.glibcxxMeasured)}`
    );
  });

  it("reports a nonzero exit as PROBE_FAILED even when the output names a ceiling", async () => {
    // A ceiling in the output of a run that did not exit cleanly is not a measurement:
    // a half-finished provisioning script can flush any earlier line to stdout.
    const observation = await provisionOnce(
      137,
      "GLIBCXX_3.4.33\npartial output\n"
    );

    assert.equal(
      observation.glibcxxMeasured,
      PROBE_FAILED,
      "a truncated or killed provisioning run must not publish a ceiling it cannot stand behind"
    );
  });

  it("keeps a genuinely absent library as ABSENT when the probe exited zero", async () => {
    const observation = await provisionOnce(
      0,
      "logs-mount-writable\nv20.11.0\n"
    );

    assert.equal(
      observation.glibcxxMeasured,
      "ABSENT",
      "the probe ran and its pipeline ended in `tail -1`; no match on exit 0 IS an absent library"
    );
  });

  it("still reports the measured ceiling on a clean provisioning run", async () => {
    const observation = await provisionOnce(
      0,
      "GLIBCXX_3.4.33\nlogs-mount-writable\niknow-native-ok\n"
    );

    assert.equal(
      observation.glibcxxMeasured,
      "GLIBCXX_3.4.33",
      "the real measured ceiling must survive the probe-status fix"
    );
  });
});

describe("the oracle path applies the task's own reference solution before grading", () => {
  it("copies solution/solve.sh into the container and runs it before the original grader", async () => {
    const { exec, calls } = fakeExec(oracleThenGrader());
    const spec = specWithSolveScript(
      makeAttemptDir(tempRoot("docker-oracle-order"), {
        reward: "1\n",
        ctrfBytes: 6556,
      })
    );

    await createDockerRunner(exec, 1_000).gradeOracle(spec, 60);

    const copies = calls.filter((call) => call.args[0] === "cp");
    assert.equal(
      copies.length,
      1,
      `the oracle step must copy exactly one file; got: ${JSON.stringify(copies)}`
    );
    assert.ok(
      copies[0].args.some((arg) => arg.endsWith("solution/solve.sh")),
      `the task's own solve.sh must be the file copied; got: ${JSON.stringify(copies[0].args)}`
    );
    assert.ok(
      copies[0].args.some((arg) => arg.endsWith(":/opt/oracle/solve.sh")),
      `the copy target must be inside the container; got: ${JSON.stringify(copies[0].args)}`
    );
    const oracleAt = firstCall(calls, "--- applying oracle ---");
    const graderAt = firstCall(calls, "grader_exit=");
    assert.ok(
      oracleAt >= 0 && graderAt > oracleAt,
      `the oracle must run BEFORE the grader; oracle=${oracleAt} grader=${graderAt}`
    );
  });

  it("reports the oracle as applied so an oracle measurement is never read as pristine", async () => {
    const { exec } = fakeExec(oracleThenGrader());
    const spec = specWithSolveScript(
      makeAttemptDir(tempRoot("docker-oracle-applied"), {
        reward: "1\n",
        ctrfBytes: 6556,
      })
    );

    const observation = await createDockerRunner(exec, 1_000).gradeOracle(
      spec,
      60
    );

    assert.equal(
      observation.oracle.state,
      "applied",
      "the observation must state that the reference solution ran"
    );
    assert.ok(
      observation.oracle.solvePath?.endsWith("solution/solve.sh") === true,
      `the applied solution must be named; got: ${JSON.stringify(observation.oracle)}`
    );
    assert.equal(
      observation.oracle.exitCode,
      0,
      `the oracle's own exit status must be retained; got: ${JSON.stringify(observation.oracle)}`
    );
    assert.ok(
      observation.oracle.stdout.includes("--- applying oracle ---"),
      `the oracle's retained output must prove the step ran; got: ${observation.oracle.stdout}`
    );
  });

  it("reads the oracle's reward from the retained host artifact, never from stdout", async () => {
    const { exec } = fakeExec(oracleThenGrader());
    const dir = makeAttemptDir(tempRoot("docker-oracle-reward"), {
      reward: "1\n",
      ctrfBytes: 6556,
    });

    const observation = await createDockerRunner(exec, 1_000).gradeOracle(
      specWithSolveScript(dir),
      60
    );

    assert.equal(
      observation.reward,
      "1",
      "the oracle reward must come from host reward.txt, exactly as a real attempt's does"
    );
    assert.equal(
      observation.resultLine,
      "7 passed",
      `a real result line must be retained; got: ${JSON.stringify(observation.resultLine)}`
    );
    assert.equal(
      observation.ctrfBytes,
      6556,
      "the retained host CTRF must stay measurable through the oracle path"
    );
  });

  it("never copies or runs the reference solution on the agent dispatch path", async () => {
    const { exec, calls } = fakeExec();
    const spec = specWithSolveScript(tempRoot("docker-oracle-dispatch"));
    const runner = createDockerRunner(exec, 1_000);

    await runner.provision(spec);
    await runner.dispatch(spec, {
      maxTurns: 40,
      agentWallSec: 60,
      graderGraceSec: 15,
    });

    assert.equal(
      firstCall(calls, "solve.sh"),
      -1,
      `solve.sh is the ORACLE's reference solution and must never reach an agent attempt; got: ${JSON.stringify(calls)}`
    );
    assert.equal(
      firstCall(calls, "/opt/oracle"),
      -1,
      "the agent path must not even name the oracle directory"
    );
  });

  it("keeps grade() a pristine measurement that never applies the oracle", async () => {
    const { exec, calls } = fakeExec(
      scriptResponder([["grader_exit=", { stdout: GRADER_STDOUT }]])
    );
    const spec = specWithSolveScript(
      makeAttemptDir(tempRoot("docker-oracle-pristine"), { reward: "0\n" })
    );

    await createDockerRunner(exec, 1_000).grade(spec, 60);

    assert.equal(
      firstCall(calls, "solve.sh"),
      -1,
      "grade() measures whatever the workspace holds; it must not apply the oracle"
    );
    assert.ok(
      firstCall(calls, "grader_exit=") >= 0,
      `grade() must still run the original grader; got: ${JSON.stringify(calls)}`
    );
  });

  it("refuses an oracle measurement for a task with no reference solution", async () => {
    const { exec, calls } = fakeExec();
    const spec = specFor(
      makeAttemptDir(tempRoot("docker-oracle-absent"), { reward: "0\n" })
    );

    await assert.rejects(
      () => createDockerRunner(exec, 1_000).gradeOracle(spec, 60),
      (error: unknown) =>
        error instanceof OracleNotApplicableError &&
        error.message.includes("solve.sh")
    );
    assert.equal(
      firstCall(calls, "grader_exit="),
      -1,
      "an untouched workspace must never be graded and reported as a failed oracle"
    );
  });

  it("refuses to grade when the reference solution itself fails", async () => {
    const { exec, calls } = fakeExec(
      scriptResponder([
        ["--- applying oracle ---", { stdout: "oracle_exit=1\n" }],
      ])
    );
    const spec = specWithSolveScript(
      makeAttemptDir(tempRoot("docker-oracle-failed"), { reward: "0\n" })
    );

    await assert.rejects(
      () => createDockerRunner(exec, 1_000).gradeOracle(spec, 60),
      (error: unknown) =>
        error instanceof OracleFailedError && error.exitCode === 1
    );
    assert.equal(
      firstCall(calls, "grader_exit="),
      -1,
      "a broken reference solution must not be graded into a fake oracle verdict"
    );
  });
});

/* ==========================================================================================
 * The dispatch observation is read off the agent's OWN JSON document.
 *
 * The defect this covers: `dispatchPhase` scraped `/model=([^\s]+)/` and `/reason=([^\s]+)/`
 * out of the dispatch output and defaulted both to "unknown". Neither regex can match what the
 * product prints — the values are JSON string fields (`"stopReason": "…"`, `"reason": "…"`),
 * and the success envelope carries NO model field at all. So `stopReason` was "unknown" on
 * every real attempt, and `model` was a constant that read like a measurement.
 * ========================================================================================== */

/** The settings file this harness copies into the container, carrying only what a run needs. */
function settingsWithModel(model: string): string {
  return `${JSON.stringify(
    {
      llm: {
        model,
        apiKey: "${ANTHROPIC_AUTH_TOKEN}",
        providers: [
          {
            id: "deepseek",
            baseUrl: "https://api.deepseek.com",
            models: [{ id: "deepseek-chat" }],
          },
        ],
      },
    },
    null,
    2
  )}\n`;
}

/** A dispatchable spec whose settings file names `model` as the route the container will run. */
function specWithSettings(
  outDir: string,
  contents: string = settingsWithModel(SETTINGS_MODEL_ROUTE)
): ProvisionSpec {
  const spec = specWithInstruction(outDir);
  writeFileSync(spec.settingsPath, contents);
  return spec;
}

/** Dispatch one spec and hand back the observation, answering the ask line with `answer`. */
async function dispatchObservation(
  spec: ProvisionSpec,
  answer: Answer
): Promise<AgentDispatchObservation> {
  const { exec } = fakeExec((args) =>
    isBashExec(args) && args[4]?.includes("cli.js ask") === true
      ? answer
      : { code: 0 }
  );
  return createDockerRunner(exec, 1_000).dispatch(spec, {
    maxTurns: 40,
    agentWallSec: 60,
    graderGraceSec: 15,
  });
}

describe("dispatch reads the agent's own JSON document", () => {
  it("takes the stop reason from the success envelope ask writes to stdout", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-success"));

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: SUCCESS_ENVELOPE,
      stderr: EVAL_STATE_NOTICE,
      code: 0,
    });

    assert.equal(
      observation.stopReason,
      "completed",
      `ask publishes "stopReason": "completed" in its success envelope; the observation must ` +
        `report it, not a scraped constant; got: ${JSON.stringify(observation.stopReason)}`
    );
    assert.deepEqual(
      observation.parsedStopReason,
      { source: "success-envelope", value: "completed" },
      "the stop reason must be typed WITH the envelope it came from, so a reader can tell a " +
        "producer value from a harness failure"
    );
    assert.equal(
      observation.exitCode,
      0,
      "the container's exit status is the observation's, unchanged by the parse"
    );
  });

  it("takes the stop reason from the max-turns envelope ask writes to stderr", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-max-turns"));

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: "",
      stderr: `${EVAL_STATE_NOTICE}${MAX_TURNS_ENVELOPE}`,
      code: 1,
    });

    assert.equal(
      observation.stopReason,
      "maxTurns",
      `the max-turns envelope carries the stop reason as its "reason" field; got: ` +
        `${JSON.stringify(observation.stopReason)}`
    );
    assert.deepEqual(
      observation.parsedStopReason,
      { source: "max-turns-envelope", value: "maxTurns" },
      "a max-turns stop and a normal stop are different envelopes, so they stay distinguishable"
    );
  });

  it("never scrapes a reason= out of the prose the envelope happens to carry", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-prose"));
    // A real finalText can contain anything — including the very token the old regex hunted.
    const prose = SUCCESS_ENVELOPE.replace(
      "Recovered the WAL; the database re-attaches read-only.",
      "I read model=some/other-model from the docs, reason=not-what-happened."
    );

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: prose,
      stderr: EVAL_STATE_NOTICE,
      code: 0,
    });

    assert.equal(
      observation.stopReason,
      "completed",
      "the answer text is agent prose, not a channel; a regex over it reads the model's " +
        "story instead of its outcome"
    );
  });

  it("reports the token spend the success envelope declares", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-usage"));

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: SUCCESS_ENVELOPE,
      stderr: EVAL_STATE_NOTICE,
      code: 0,
    });

    assert.deepEqual(
      observation.usage,
      { state: "reported", tokens: TOKEN_USAGE },
      "lastUsage is the producer's own usage source; the observation must keep it verbatim"
    );
  });

  it("keeps a dropped lastUsage an explicit absence, never zero tokens", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-usage-dropped"));
    assert.ok(
      !("lastUsage" in JSON.parse(SUCCESS_ENVELOPE_WITHOUT_USAGE)),
      "formatRunJson DROPS a null lastUsage, so the wire document has no key at all"
    );

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: SUCCESS_ENVELOPE_WITHOUT_USAGE,
      stderr: EVAL_STATE_NOTICE,
      code: 1,
    });

    assert.deepEqual(
      observation.usage,
      { state: "absent", because: "dropped-null-last-usage" },
      "an absent lastUsage is UNKNOWN spend; reading it as zero tokens would make a run " +
        "that never reached a model look like a free one"
    );
    assert.equal(
      observation.stopReason,
      "protocolError",
      "the stop reason still parses when usage was dropped"
    );
  });

  it("reports a lastUsage that is not the TokenUsage shape as malformed, not as zero", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-usage-malformed"));
    const shapeChanged = SUCCESS_ENVELOPE.replace(
      `"lastUsage": ${JSON.stringify(TOKEN_USAGE, null, 2).split("\n").join("\n  ")}`,
      '"lastUsage": { "promptTokens": 18244 }'
    );

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: shapeChanged,
      stderr: EVAL_STATE_NOTICE,
      code: 0,
    });

    assert.deepEqual(
      observation.usage,
      { state: "absent", because: "malformed" },
      "a producer that changed its usage shape must not be read as free tokens or as none"
    );
    assert.equal(
      observation.stopReason,
      "completed",
      "a malformed usage block must not cost us the stop reason, which is still readable"
    );
  });

  it("reports an unreadable agent document as unreadable instead of a plausible value", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-unreadable"));

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: "node:internal/modules/cjs/loader:1392\n      throw err;\n",
      stderr: EVAL_STATE_NOTICE,
      code: 1,
    });

    assert.equal(
      observation.stopReason,
      UNREADABLE_STOP_REASON,
      `"unknown" is what the producer says when IT knows nothing; here WE failed to read it. ` +
        `A sentinel that names the harness failure keeps the two apart; got: ${JSON.stringify(observation.stopReason)}`
    );
    assert.deepEqual(
      observation.parsedStopReason,
      { source: "unreadable", value: null },
      "an unknown that is genuinely unknown must be typed as such"
    );
    assert.deepEqual(
      observation.usage,
      { state: "absent", because: "no-envelope" },
      "no readable envelope means no usage reading, which is not the same as zero"
    );
  });

  it("retains the raw agent output on the host so the parse can be audited", async () => {
    const dir = makeAttemptDir(tempRoot("docker-parse-retained"));
    const { exec } = fakeExec((args) =>
      isBashExec(args) && args[4]?.includes("cli.js ask") === true
        ? { stdout: SUCCESS_ENVELOPE, stderr: EVAL_STATE_NOTICE, code: 0 }
        : { code: 0 }
    );

    const observation = await createDockerRunner(exec, 1_000).dispatch(
      specWithSettings(dir),
      { maxTurns: 40, agentWallSec: 60, graderGraceSec: 15 }
    );

    assert.equal(
      readFileSync(join(dir, "process/ask.stdout"), "utf8"),
      SUCCESS_ENVELOPE,
      "the document the parse consumed must survive on the host, exactly as the agent wrote it"
    );
    assert.equal(
      readFileSync(join(dir, "process/ask.stderr"), "utf8"),
      EVAL_STATE_NOTICE,
      "stderr is part of the same dispatch evidence, and on a max-turns stop it carries the envelope"
    );
    assert.equal(
      observation.agentOutput,
      `${SUCCESS_ENVELOPE}${EVAL_STATE_NOTICE}`,
      "the observation itself must carry what it parsed, so a caller can audit instead of trusting"
    );
  });
});

describe("the model identity comes from the settings the harness copied in", () => {
  it("names the route the container's own settings file declares", async () => {
    const dir = makeAttemptDir(tempRoot("docker-model-settings"));

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: SUCCESS_ENVELOPE,
      stderr: EVAL_STATE_NOTICE,
      code: 0,
    });

    assert.equal(
      observation.model,
      SETTINGS_MODEL_ROUTE,
      "settings.llm.model is the ONLY source of the model route (src/config/env.ts:6-8, 1193-1195) " +
        `and the same file is docker cp'd to /root/.iknow/settings.json; got: ${JSON.stringify(observation.model)}`
    );
    assert.deepEqual(
      observation.parsedModel,
      { source: "settings", route: SETTINGS_MODEL_ROUTE },
      "the observation must say WHERE the model identity came from, so a reader can judge it"
    );
  });

  it("takes the model from settings, not from the agent output, which carries none", async () => {
    const dir = makeAttemptDir(tempRoot("docker-model-absent-in-output"));
    assert.ok(
      !SUCCESS_ENVELOPE.includes("model"),
      "the success envelope has no model key at all; the trace inside it carries none either"
    );

    const observation = await dispatchObservation(specWithSettings(dir), {
      stdout: SUCCESS_ENVELOPE,
      stderr: EVAL_STATE_NOTICE,
      code: 0,
    });

    assert.equal(
      observation.model,
      SETTINGS_MODEL_ROUTE,
      "the agent publishes nothing to scrape, so the settings file is the only honest source"
    );
  });

  it("says the model is unavailable — and names why — rather than inventing one", async () => {
    const dir = makeAttemptDir(tempRoot("docker-model-missing"));

    const observation = await dispatchObservation(
      // A real settings file that declares no route: env loading fails fast on this.
      specWithSettings(
        dir,
        `${JSON.stringify({ llm: { apiKey: "${ANTHROPIC_AUTH_TOKEN}" } }, null, 2)}\n`
      ),
      { stdout: SUCCESS_ENVELOPE, stderr: EVAL_STATE_NOTICE, code: 0 }
    );

    assert.equal(
      observation.model,
      MODEL_UNRESOLVED,
      "a fabricated model route is a lie about what ran; an explicit sentinel is auditable"
    );
    assert.equal(
      observation.parsedModel.source,
      "unavailable",
      "the unavailable state must be typed, not inferred from a string"
    );
    assert.equal(
      observation.parsedModel.route,
      null,
      "no route was found, so none may be published"
    );
  });

  it("never retains a byte of the settings file beyond the model route", async () => {
    const dir = makeAttemptDir(tempRoot("docker-model-secret"));
    const apiKey = "sk-live-DO-NOT-LEAK-0123456789";

    const observation = await dispatchObservation(
      specWithSettings(
        dir,
        `${JSON.stringify({ llm: { model: SETTINGS_MODEL_ROUTE, apiKey } }, null, 2)}\n`
      ),
      { stdout: SUCCESS_ENVELOPE, stderr: EVAL_STATE_NOTICE, code: 0 }
    );

    assert.ok(
      !JSON.stringify(observation).includes(apiKey),
      `the settings file carries a credential and is hashed on the host for exactly this reason; got: ${JSON.stringify(observation)}`
    );
  });

  it("keeps an unparsable settings file out of the observation too", async () => {
    const dir = makeAttemptDir(tempRoot("docker-model-bad-json"));
    // A `JSON.parse` failure message quotes the offending text; it must never reach a record.
    const halfWritten = `{\n  "llm": {\n    "model": "${SETTINGS_MODEL_ROUTE}",\n    "apiKey": "sk-live-HALF-WRITTEN-9876543210"\n`;

    const observation = await dispatchObservation(
      specWithSettings(dir, halfWritten),
      {
        stdout: SUCCESS_ENVELOPE,
        stderr: EVAL_STATE_NOTICE,
        code: 0,
      }
    );

    assert.equal(
      observation.parsedModel.source,
      "unavailable",
      "a half-written settings file names no route, so the observation must not claim one"
    );
    assert.ok(
      !JSON.stringify(observation).includes("HALF-WRITTEN"),
      `a parse error message quotes its input; the reason must not carry it; got: ${JSON.stringify(observation)}`
    );
  });
});
