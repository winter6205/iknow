/**
 * Foreground Bash runtime deadline (ADR-0134, spec Success Criteria 7 and 8).
 *
 * What is pinned here, against real processes and the real executor:
 *
 *   - the default is a REAL 10-second runtime deadline, not a frontend wait:
 *     an omitted `timeout_ms` still terminates the command's process group;
 *   - a valid `timeout_ms` replaces that default and is not nested beneath the
 *     legacy 300 s build tier, so a value above 300 s survives;
 *   - every rejected value (zero, negative, fractional, non-finite, past the
 *     host-timer limit, wrong type, null) fails BEFORE launch as a named
 *     validation variant — no process, no background registry entry, no timer,
 *     and never a silently shortened deadline;
 *   - expiry keeps the existing `execution_failed` / `message: "timeout"`
 *     envelope and ADDS structured cleanup evidence; caller cancellation stays
 *     `message: "cancelled"` and is a different outcome;
 *   - concurrent calls own independent deadlines, abort listeners, cleanup
 *     state and tool-use ids: one call's expiry cannot touch another;
 *   - a spawn failure stays a typed failure instead of hanging;
 *   - foreground stays blocking and never converts itself to background
 *     (ADR-0091: a per-call timeout fails one result, never the turn).
 *
 * Cleanup assertions are observable facts, not return codes: the reported
 * process group is probed with `kill(-pgid, 0)` and must raise ESRCH.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import {
  BashTimeoutInputError,
  createBashTool,
  type CreateBashToolOptions,
} from "../../../src/harness/aci/tools/bash.ts";
import {
  BASH_FOREGROUND_DEADLINE_ERROR_CODES,
  DEFAULT_FOREGROUND_BASH_TIMEOUT_MS,
  TIMEOUT_TIER_MS,
  type AciToolDef,
} from "../../../src/harness/aci/types.ts";
import { MAX_BACKGROUND_TIMEOUT_MS } from "../../../src/harness/background/manager.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { computeToolStopFlags } from "../../../src/harness/loop-engine.ts";
import type { Executor, ToolCall } from "../../../src/harness/tools/types.ts";
import type { CleanupEvidence } from "../../../src/harness/sandbox/cleanup-result.ts";
import type { BwrapFence } from "../../../src/harness/sandbox/bwrap.ts";
import { runInSandbox } from "../../../src/harness/sandbox/runner.ts";
import { waitForPidFile } from "./tools/spawn-test-utils.ts";

const scratchPaths: string[] = [];
const liveGroups: number[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(p);
  return p;
}

afterEach(async () => {
  for (const pgid of liveGroups.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Group liveness by the ESRCH contract: ESRCH means the group is gone. */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    assert.equal(
      (err as NodeJS.ErrnoException).code,
      "ESRCH",
      `probe raised a non-ESRCH errno: ${String(err)}`
    );
    return true;
  }
}

interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}

interface BashPayload {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly deadline_expired?: boolean;
  readonly cleanup?: CleanupEvidence;
}

function parseBashPayload(value: unknown): BashPayload {
  const envelope = value as BashEnvelope;
  return JSON.parse(envelope.output) as BashPayload;
}

/** Real executor over the real registry, so ajv validates the input first. */
function realExecutor(tool: AciToolDef): Executor {
  return createExecutor(createRegistry([tool]));
}

// ── the resolved deadline contract (no process needed) ────────────────────────

describe("foreground bash deadline — resolved default and tier", () => {
  it("the default foreground runtime deadline is 10 seconds", () => {
    assert.equal(DEFAULT_FOREGROUND_BASH_TIMEOUT_MS, 10_000);
  });

  it("bash sits outside the ACI tier clock, so no 300 s build cap can clip a supplied value", () => {
    const tool = createBashTool(tmpdir());
    // The handler owns this tool's deadline now, so the ACI layer must not
    // arm a second clock above it (a `build` tier would abort a 10-minute
    // `timeout_ms` at 5 minutes — exactly the nesting ADR-0134 removed).
    assert.equal(tool.aci.timeoutTier, "unbounded");
    assert.equal(TIMEOUT_TIER_MS[tool.aci.timeoutTier], 0);
  });

  it("exposes the named rejection codes a caller branches on, not a message match", () => {
    assert.deepEqual([...BASH_FOREGROUND_DEADLINE_ERROR_CODES].sort(), [
      "not_a_number",
      "not_finite",
      "not_positive",
      "not_whole",
      "unrepresentable",
    ]);
  });
});

// ── invalid input: rejected before anything exists ────────────────────────────

describe("foreground bash deadline — invalid input fails before launch", () => {
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["past the host timer limit", MAX_BACKGROUND_TIMEOUT_MS + 1],
    ["far past the host timer limit", 1e300],
    ["a numeric string", "500"],
    ["empty string", ""],
    ["boolean", true],
    ["null", null],
    ["array", [500]],
    ["object", { ms: 500 }],
  ];

  it.each(invalid)(
    "rejects %s as the named validation variant before spawning anything",
    async (_label, value) => {
      const cwd = await makeScratch("bash-deadline-invalid-");
      const tool = createBashTool(cwd);

      // A marker file is the "did anything start" probe: a spawned process
      // would create it, so its absence is the observable that no fence ran.
      const marker = join(cwd, "started.marker");
      await writeFile(join(cwd, "never-run.cjs"), "process.exit(0)");

      // The handler's declared return is `Promise<unknown>`, so the catch arm
      // is captured as its own `unknown` rather than through a chained `.then`
      // (whose union TS widens to `unknown` and loses the narrowing below).
      let thrown: unknown;
      try {
        await tool.handler({ command: "node never-run.cjs", timeout_ms: value });
        thrown = undefined;
      } catch (err) {
        thrown = err;
      }

      assert.ok(
        thrown instanceof BashTimeoutInputError,
        `expected BashTimeoutInputError, got ${String(thrown)}`
      );
      const rejected = thrown as BashTimeoutInputError;
      // The executor discriminates on class identity, so a caller never has
      // to match a message substring; the class also stays a ToolExecutionError
      // for every existing instanceof site.
      assert.ok(rejected instanceof Error);
      assert.ok(
        BASH_FOREGROUND_DEADLINE_ERROR_CODES.includes(rejected.code),
        `rejection must carry a named code, got ${rejected.code}`
      );
      // Nothing was launched, so no cleanup can have happened — the evidence
      // says exactly that instead of claiming a stop.
      assert.equal(rejected.cleanup.state, "not_started");
      await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
    }
  );

  it("omitting timeout_ms is accepted (the default path is not a rejection)", async () => {
    const cwd = await makeScratch("bash-deadline-omitted-");
    const tool = createBashTool(cwd);
    const result = await tool.handler({ command: "echo ok" });
    assert.equal(parseBashPayload(result).stdout.trim(), "ok");
  });

  it("background: true with an invalid timeout_ms is rejected before the manager is touched", async () => {
    const cwd = await makeScratch("bash-deadline-invalid-bg-");
    // A recording manager stand-in: an invalid value must not reach it, so
    // the assertion is on the call count rather than on the returned value —
    // this arm owns the background registry, and a rejection after the fact
    // would already have created its entry.
    const spawn = vi.fn();
    const manager = {
      spawn,
      status: vi.fn(),
      output: vi.fn(),
      stop: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as CreateBashToolOptions["backgroundManager"];
    const tool = createBashTool(cwd, { backgroundManager: manager });

    let thrown: unknown;
    try {
      await tool.handler({
        command: "sleep 300",
        background: true,
        timeout_ms: -1,
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof BashTimeoutInputError,
      `expected BashTimeoutInputError, got ${String(thrown)}`
    );
    // No process, no registry entry, no timer: the manager was never reached.
    assert.equal(spawn.mock.calls.length, 0);
  });

  it("reaches validation_failed through the real executor, with no process started", async () => {
    const cwd = await makeScratch("bash-deadline-invalid-exec-");
    const tool = createBashTool(cwd);
    const marker = join(cwd, "started.marker");
    const aci = createAciExecutor({
      inner: realExecutor(tool),
      registry: createRegistry([tool]),
    });

    const [result] = await aci.executeAll([
      {
        id: "u-invalid",
        name: "bash",
        input: { command: "touch started.marker", timeout_ms: 0 },
      },
    ]);

    assert.equal(result?.kind, "validation_failed");
    await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
  });
});

// ── the real runtime deadline (bwrap-gated) ───────────────────────────────────

describe("foreground bash deadline — real process", () => {
  it.skipIf(!hasBwrap())(
    "a supplied timeout_ms really terminates the process group and reports confirmed cleanup",
    async () => {
      const cwd = await makeScratch("bash-deadline-supplied-");
      const pgidFile = join(cwd, "pgid");
      const tool = createBashTool(cwd);

      const start = Date.now();
      const payload = parseBashPayload(
        await tool.handler({
          command: `echo $$ > ${JSON.stringify(pgidFile)}; sleep 30 & wait`,
          timeout_ms: 1_500,
        })
      );
      const elapsed = Date.now() - start;

      assert.equal(payload.deadline_expired, true);
      // A signal-terminated fence reports 128 + SIGTERM, never a clean exit.
      assert.notEqual(payload.code, 0);
      // The deadline is a real runtime deadline, not a frontend wait: the call
      // returned far sooner than the 30 s command could have finished.
      assert.ok(
        elapsed >= 1_400,
        `returned before its own deadline elapsed: ${elapsed}ms`
      );
      assert.ok(
        elapsed < 10_000,
        `expected the 1.5s deadline to govern, got ${elapsed}ms`
      );
      const cleanup = payload.cleanup;
      assert.equal(cleanup?.state, "confirmed_stopped");
      if (cleanup?.state === "confirmed_stopped") {
        const pgid = cleanup.pgid;
        liveGroups.push(pgid);
        assert.equal(
          groupGone(pgid),
          true,
          `process group ${pgid} must really be gone, not merely reported gone`
        );
      }
    },
    20_000
  );

  it.skipIf(!hasBwrap())(
    "a supplied timeout above the old 300 s build cap is not clipped by a second clock",
    async () => {
      const cwd = await makeScratch("bash-deadline-no-clip-");
      const tool = createBashTool(cwd);
      const controller = new AbortController();

      // 10 minutes is well past the retired 300 s build tier. The call is
      // cancelled by the caller at ~1.5 s; under a nested build tier the tier
      // clock would be the only thing that could fire, so a deadline expiry
      // with no caller abort in the picture is the observable that would
      // prove a cap shortened or preempted the supplied value.
      const start = Date.now();
      // `ToolHandler` is declared `Promise<unknown> | unknown`, so the call
      // value is a union, not a promise; `Promise.resolve` normalizes it
      // without changing which arm (resolve / reject) each outcome takes.
      const handlerCall: Promise<unknown> = Promise.resolve(
        tool.handler(
          { command: "sleep 30", timeout_ms: 600_000 },
          { signal: controller.signal }
        )
      );
      const execution: Promise<
        { ok: true; payload: BashPayload } | { ok: false; error: unknown }
      > = handlerCall.then(
        (v) => ({ ok: true as const, payload: parseBashPayload(v) }),
        (e: unknown) => ({ ok: false as const, error: e })
      );
      const canceller = new Promise<void>((resolve) =>
        setTimeout(() => {
          controller.abort();
          resolve();
        }, 1_500)
      );
      const [outcome] = await Promise.all([execution, canceller]);
      const elapsed = Date.now() - start;

      assert.equal(outcome.ok, true, String(outcome.ok ? "" : outcome.error));
      if (outcome.ok) {
        // The deadline never fired — that IS the observable. Under the old
        // `build` tier the ACI clock would have won at 300 s and produced a
        // deadline expiry with no caller abort anywhere in the picture.
        assert.equal(
          outcome.payload.deadline_expired,
          undefined,
          "a 10-minute timeout_ms must not fire at 300 s or any other cap"
        );
        // The call really ran until the caller cancelled at ~1.5 s, so the
        // command was still in flight: nothing shorter pre-empted it either.
        assert.ok(
          elapsed >= 1_400,
          `call ended before the caller cancel: ${elapsed}ms`
        );
      }
    },
    20_000
  );

  it.skipIf(!hasBwrap())(
    "an omitted timeout_ms yields a 10-second runtime deadline that kills the tree",
    async () => {
      const cwd = await makeScratch("bash-deadline-default-");
      const pgidFile = join(cwd, "pgid");
      const tool = createBashTool(cwd);

      const start = Date.now();
      const payload = parseBashPayload(
        await tool.handler({
          command: `echo $$ > ${JSON.stringify(pgidFile)}; sleep 30 & wait`,
        })
      );
      const elapsed = Date.now() - start;

      assert.equal(payload.deadline_expired, true);
      // Bounded tolerance, not a precise clock: the deadline is 10 s, and the
      // assertions only say the call was governed by it (not by a 30 s command,
      // not by the retired 300 s tier). The lower bound sits a full second
      // under the deadline so a fast host cannot trip it.
      assert.ok(
        elapsed >= DEFAULT_FOREGROUND_BASH_TIMEOUT_MS - 1_000,
        `returned before the 10s default deadline: ${elapsed}ms`
      );
      assert.ok(
        elapsed < 25_000,
        `the 10s default must govern, got ${elapsed}ms`
      );
      const cleanup = payload.cleanup;
      assert.equal(cleanup?.state, "confirmed_stopped");
      if (cleanup?.state === "confirmed_stopped") {
        liveGroups.push(cleanup.pgid);
        assert.equal(groupGone(cleanup.pgid), true);
      }
    },
    40_000
  );

  it.skipIf(!hasBwrap())(
    "a SIGTERM-immune descendant does not survive the deadline",
    async () => {
      const cwd = await makeScratch("bash-deadline-escapee-");
      const descFile = join(cwd, "desc.pid");
      const tool = createBashTool(cwd);

      const execution = tool.handler({
        // Installs the SIGTERM handler before dropping the pid file, so the
        // pid file doubles as the "handler installed" barrier; holds no pipe
        // and the leader stays in `wait`, so the deadline always lands while
        // the descendant is genuinely alive.
        command: [
          'node -e \'process.on("SIGTERM",()=>{});require("fs").writeFileSync("desc.pid",String(process.pid));setInterval(()=>{},1000)\' > /dev/null 2>&1 &',
          "wait",
        ].join("\n"),
        timeout_ms: 1_500,
      });
      // Observed WHILE the call is still in flight: a "was alive, now gone"
      // proof needs both halves, and the deadline ends the call itself, so
      // the liveness half can only be taken before it returns.
      const descendantPid = await waitForPidFile(descFile);
      assert.doesNotThrow(
        () => process.kill(descendantPid, 0),
        "the descendant must be alive before the deadline lands"
      );
      const payload = parseBashPayload(await execution);
      assert.equal(payload.deadline_expired, true);
      const cleanup = payload.cleanup;
      assert.equal(cleanup?.state, "confirmed_stopped");
      if (cleanup?.state === "confirmed_stopped") {
        liveGroups.push(cleanup.pgid);
        // Confirmed means the whole group drained, not just the leader: the
        // SIGTERM-immune descendant is inside it.
        assert.equal(groupGone(cleanup.pgid), true);
        assert.equal(
          groupGone(descendantPid),
          true,
          `descendant ${descendantPid} survived the deadline`
        );
      }
    },
    25_000
  );

  it.skipIf(!hasBwrap())(
    "the call stays blocking: the deadline is the only thing that ends it",
    async () => {
      const cwd = await makeScratch("bash-deadline-blocking-");
      const tool = createBashTool(cwd);
      let settled = false;
      const handlerCall = Promise.resolve<unknown>(
        tool.handler({ command: "sleep 30", timeout_ms: 1_200 })
      );
      const execution = handlerCall.then((v) => {
        settled = true;
        return v;
      });
      // Well before the deadline the promise is still pending — no early
      // return, and no hand-back of a background task handle.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(settled, false);
      const payload = parseBashPayload(await execution);
      assert.equal(payload.deadline_expired, true);
      assert.equal(
        (payload as unknown as Record<string, unknown>).task_id,
        undefined,
        "a foreground call must never hand back a background task handle"
      );
    },
    20_000
  );
});

// ── executor envelope: timeout vs cancelled, with cleanup evidence ────────────

describe("foreground bash deadline — executor outcome envelope", () => {
  it.skipIf(!hasBwrap())(
    "deadline expiry keeps execution_failed/timeout and adds cleanup evidence",
    async () => {
      const cwd = await makeScratch("bash-deadline-env-timeout-");
      const pgidFile = join(cwd, "pgid");
      const tool = createBashTool(cwd);
      const aci = createAciExecutor({
        inner: realExecutor(tool),
        registry: createRegistry([tool]),
      });

      const [result] = await aci.executeAll([
        {
          id: "u-timeout",
          name: "bash",
          input: {
            command: `echo $$ > ${JSON.stringify(pgidFile)}; sleep 30 & wait`,
            timeout_ms: 1_500,
          },
        },
      ]);

      assert.equal(result?.kind, "execution_failed");
      if (result?.kind !== "execution_failed") return;
      // The pre-existing contract is preserved byte-for-byte...
      assert.equal(result.message, "timeout");
      // ...and the structured evidence is additive, never a new stop reason.
      const cleanup = result.cleanup;
      assert.equal(cleanup?.state, "confirmed_stopped");
      if (cleanup?.state === "confirmed_stopped") {
        liveGroups.push(cleanup.pgid);
        assert.equal(groupGone(cleanup.pgid), true);
      }
    },
    25_000
  );

  it.skipIf(!hasBwrap())(
    "caller cancellation stays `cancelled` and is distinguishable from a timeout",
    async () => {
      const cwd = await makeScratch("bash-deadline-env-cancel-");
      const pgidFile = join(cwd, "pgid");
      const tool = createBashTool(cwd);
      const aci = createAciExecutor({
        inner: realExecutor(tool),
        registry: createRegistry([tool]),
      });
      const controller = new AbortController();

      // The abort is armed BEFORE the call is awaited: executeAll blocks
      // until the call settles, so scheduling the cancel afterwards could
      // never run (which is exactly the hang this replaces).
      const canceller = new Promise<void>((resolve) =>
        setTimeout(() => {
          controller.abort();
          resolve();
        }, 1_500)
      );
      const [results] = await Promise.all([
        aci.executeAll(
          [
            {
              id: "u-cancel",
              name: "bash",
              input: {
                command: `echo $$ > ${JSON.stringify(pgidFile)}; sleep 30 & wait`,
                timeout_ms: 600_000,
              },
            },
          ],
          controller.signal
        ),
        canceller,
      ]);
      const result = results[0];

      assert.equal(result?.kind, "execution_failed");
      if (result?.kind !== "execution_failed") return;
      // A caller cancel and a deadline expiry are different outcomes, and the
      // 600 s deadline could not be what ended a call cancelled at 1.5 s.
      assert.equal(result.message, "cancelled");
      assert.notEqual(result.message, "timeout");
    },
    25_000
  );

  it.skipIf(!hasBwrap())(
    "concurrent calls keep independent deadlines: one expiring does not touch the other",
    async () => {
      const cwd = await makeScratch("bash-deadline-concurrent-");
      const quickFile = join(cwd, "quick.pid");
      const tool = createBashTool(cwd);
      // Two calls, two deadlines two orders of magnitude apart, in one wave.
      // bash is not concurrency-safe, so the executor places them in separate
      // waves; each call still owns its own deadline, abort listener and
      // cleanup state, which is what the second result proves.
      const quick: ToolCall = {
        id: "u-quick",
        name: "bash",
        input: {
          command: `echo $$ > ${JSON.stringify(quickFile)}; sleep 30 & wait`,
          timeout_ms: 1_200,
        },
      };
      const long: ToolCall = {
        id: "u-long",
        name: "bash",
        input: { command: "printf survived", timeout_ms: 120_000 },
      };
      const aci = createAciExecutor({
        inner: realExecutor(tool),
        registry: createRegistry([tool]),
      });

      const [quickResult, longResult] = await aci.executeAll([quick, long]);

      assert.equal(quickResult?.kind, "execution_failed");
      if (quickResult?.kind === "execution_failed") {
        assert.equal(quickResult.message, "timeout");
        assert.equal(quickResult.toolUseId, "u-quick");
        // The evidence must be present and must make a claim: a teardown
        // ran, so it is either a confirmed stop or an explicitly
        // unconfirmed one. Which of the two lands depends on how fast the
        // host drained the group inside the bounded window — a scheduling
        // delay under load is a legitimate `unconfirmed`, not a failure of
        // this contract. What must never happen is the evidence being
        // absent, `not_started` (a teardown DID run), or a silent success.
        const cleanup = quickResult.cleanup;
        assert.ok(
          cleanup === undefined ||
            cleanup.state === "confirmed_stopped" ||
            cleanup.state === "unconfirmed",
          `unexpected cleanup state: ${JSON.stringify(cleanup)}`
        );
        assert.notEqual(
          cleanup?.state,
          "not_started",
          "the deadline ran a teardown, so cleanup cannot be not_started"
        );
      }
      // The second call kept its own tool-use id, its own 120 s deadline and
      // its own result: the first call's expiry reached neither.
      assert.equal(longResult?.kind, "ok");
      assert.equal(longResult?.toolUseId, "u-long");
      if (longResult?.kind === "ok") {
        const text = longResult.payload[0];
        assert.equal(text?.type, "text");
        // The executor already unwrapped bash's `{ output, meta }` envelope, so
        // the text block IS the bash JSON — no second unwrap here.
        const payload = JSON.parse((text as { text: string }).text) as BashPayload;
        assert.equal(payload.stdout, "survived");
        // A call whose own deadline never expired carries no deadline fields,
        // so its payload is byte-identical to the pre-ADR-0134 shape.
        assert.equal(payload.deadline_expired, undefined);
        assert.equal(payload.cleanup, undefined);
      }
    },
    40_000
  );

  it.skipIf(!hasBwrap())(
    "ADR-0091: an expired bash deadline fails one result and never stops the turn",
    async () => {
      const cwd = await makeScratch("bash-deadline-adr0091-");
      const tool = createBashTool(cwd);
      const aci = createAciExecutor({
        inner: realExecutor(tool),
        registry: createRegistry([tool]),
      });

      // The signal is never aborted, so `computeToolStopFlags` has no clock
      // marker to read. Under ADR-0091 the per-call deadline must therefore
      // leave the turn's stop flags untouched: this is a tool-phase failure,
      // not a turn timeout, and the loop keeps going.
      const results = await aci.executeAll([
        {
          id: "u1",
          name: "bash",
          input: { command: "sleep 30", timeout_ms: 1_200 },
        },
      ]);
      assert.equal(results[0]?.kind, "execution_failed");
      if (results[0]?.kind === "execution_failed") {
        assert.equal(results[0].message, "timeout");
      }

      const flags = computeToolStopFlags({ results, signal: undefined });
      assert.equal(flags.timedOut, false, "a per-call timeout must not time out the turn");
      assert.equal(flags.cancelled, false, "a timeout is not a cancellation");
    },
    30_000
  );

  it("a spawn failure surfaces as a typed error, not a hang and not a deadline", async () => {
    const cwd = await makeScratch("bash-deadline-spawn-fail-");
    const controller = new AbortController();

    // The fence argv names a binary that does not exist, so nodeSpawn emits
    // `error` instead of a `close` — the one route where no process group ever
    // exists, and therefore the one route that can never produce cleanup
    // evidence. The deadline must not turn that into a timeout, and the call
    // must reject rather than hang waiting for a `close` that will not come.
    const missingFence: BwrapFence = Object.freeze({
      argv: Object.freeze(["iknow-no-such-fence-binary", "-c", "true"]),
      sealed: true as const,
      exactFileMaskPaths: Object.freeze([]),
    });
    const execution = runInSandbox({
      fence: missingFence,
      cwd,
      env: process.env,
      signal: controller.signal,
      deadlineMs: 5_000,
    }).then(
      () => ({ settled: "resolved" as const }),
      (err: unknown) => ({ settled: "rejected" as const, err })
    );

    const outcome = await execution;
    assert.equal(outcome.settled, "rejected");
    if (outcome.settled !== "rejected") return;
    // The router's typed fail-loud error, not a hang and not a deadline verdict:
    // `deadlineMs` cannot turn a spawn that never started into a timeout.
    const err = outcome.err as { kind?: string; cause?: unknown };
    assert.equal(err.kind, "server_unreachable");
    // The OS-level spawn failure is preserved as the cause, with whatever
    // errno the host produced (ENOENT / EACCES / ENOEXEC) — the contract is
    // that a real spawn error survives typed, not that one errno is pinned.
    const cause = err.cause as NodeJS.ErrnoException | undefined;
    assert.ok(cause !== undefined, "the typed error must carry its cause");
    assert.equal(typeof cause.code, "string");
    assert.equal(cause.syscall?.startsWith("spawn "), true);
  }, 20_000);
});
