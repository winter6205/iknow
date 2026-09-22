/**
 * verify sandbox executor, split out from the decision orchestration
 * (verify-loop.ts).
 *
 * This file only does "verify command → bwrap sandbox exec → timeout wrap →
 * SandboxCmdRecord persistence". A shared factory with the bash tool's
 * assembly semantics removes duplicated fence wiring from verify-loop.
 */
import { tmpdir } from "node:os";
import type { SandboxCmdRecord, TraceService } from "../trace/index.js";
import type { YoloContext } from "../sandbox/yolo.js";
import type {
  EgressPolicyInput,
  EgressSession,
  SandboxRunResult,
} from "../sandbox/index.js";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEgressSession,
  createEnvIsolation,
  createFsPolicy,
  runInSandbox,
  wrapCommandWithInnerBridge,
} from "../sandbox/index.js";
import {
  unboundFenceMainCheckout,
  type WorktreeGateReader,
} from "../isolation/worktree-gate.js";

/**
 * Verification executor: command → sandbox exec → { exitCode, stdout, stderr }.
 * Production default uses runInSandbox + bwrap; tests inject scripted doubles.
 */
export type RunVerifyFn = (
  command: string,
  ctx: { readonly signal?: AbortSignal }
) => Promise<SandboxRunResult>;

/**
 * Production default runVerify: same sandbox assembly as the bash tool (verify
 * commands inherit the bash tool's fence / resource limits, never relaxed
 * separately). Command is wrapped as `bash -c <command>`, matching bash.ts.
 *
 * ADR-0092: workspace fs tier + homeRoot pass-through — bwrap then layers
 * `--ro-bind <home>` + `--bind <cwd>` + `--bind <tmpDir>` in workspace tier
 * (global tier emits none, baseline preserved). fsMode default fallback has
 * the same shape as the bash tool (`"global"`).
 *
 * homeRoot absent does **not** silently skip the home layer: if verify runs
 * in workspace tier without homeRoot, bwrap throws a typed error (fail-loud).
 * A silent skip would quietly regress the verify fence to global tier while
 * the bash tool stays in workspace tier — two inconsistent execution surfaces
 * in one session with no signal.
 */
export function makeDefaultRunVerify(opts: {
  readonly cwd: string;
  /**
   * ADR-0092: session tmp host path for verify commands — the `$TMPDIR`
   * source and the workspace-tier `--bind <tmpRoot>` source (must be the same
   * path).
   *
   * Default falls back to the process `tmpdir()`: **a fallback, not the
   * target state** — authoritative session-tmp resolution belongs to the
   * caller (`resolveSessionFenceTmp({ projectDir, conversationId })`, the same
   * helper as the bash tool surface). The fallback only serves unwired /
   * test-injection paths: throwing there would fail verify whenever
   * projectDir / conversationId are missing, beyond this module's duty.
   * Both production callers (session-api/hub, cli/chat-session) pass it
   * explicitly.
   */
  readonly tmpDir?: string;
  /** ADR-0092: workspace fs isolation tier. Default → global (baseline). */
  readonly fsMode?: import("../sandbox/fs-mode.js").FsIsolationMode;
  /** ADR-0092: host absolute path for the workspace-tier home ro-bind source. */
  readonly homeRoot?: string;
  /**
   * Egress proxy seam policy — passed through by the caller (verify-loop
   *
   // (ADR-0097)
   * assembly, usually derived via `createEgressPolicyFactory`). Verify's
   * module-level form: one per-session singleton shared by all verify
   * commands, lazy-started on the first `runVerify` call and reused after
   * (module-level singleton); start failure → no seam (fail-closed, same
   * semantics as background); the caller disposes it (hub / verify-loop at
   * session exit via `disposeEgressSessionForVerify`).
   *
   * Default = caller injected nothing = no seam (baseline equivalent; the
   * sandbox still has `--unshare-net`). **Production assembly TODO**: hub /
   * chat-session wiring points still to be connected.
   */
  readonly egressPolicy?: EgressPolicyInput;
  /**
   * ADR-0119: --yolo no-sandbox holder (same holder shape as the bash factory).
   * Read once at assembly via get() — this factory rebuilds the closure per
   * round from verify-loop, so the snapshot vintage matches the bash handler
   * entry's D2. Under yolo the fence takes bare argv and starts no egress
   * session (no fence means no netns, the proxy seam is meaningless, ADR-0119
   * ruling 3). Absent / false → today's shape byte-for-byte unchanged.
   */
  readonly yolo?: YoloContext;
  /**
   * worktree-on-mutate holder (read-only view). This closure is rebuilt per
   * round by verify-loop, so the factory-time `get()` equals that round's
   * snapshot (same vintage as the fsMode snapshot above). gate ON ∧ cwd is
   * the main checkout → the verify fence layers the UNBOUND_FENCE ro-bind
   * segment, judged identically to the bash tool surface. Absent → segment
   * not emitted (baseline bytes unchanged).
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
}): RunVerifyFn {
  // Note: the caller (verify-loop.ts) rebuilds this closure per round, so the
  // factory-time snapshot here == that round's per-call snapshot — same
  // vintage as the bash handler's entry snapshot.
  const tmpDir = opts.tmpDir ?? tmpdir();
  const fsMode = opts.fsMode ?? "global";
  const homeRoot = opts.homeRoot;
  // Read the holder once at factory time — same vintage as the fsMode snapshot.
  const unboundMainCheckout = unboundFenceMainCheckout({
    gateOn: opts.worktreeOnMutate?.get() === true,
    root: opts.cwd,
  });
  // ADR-0119: read the yolo holder once at factory time — the caller rebuilds
  // this closure per round, so the snapshot vintage matches the bash handler
  // entry's D2.
  const yolo = opts.yolo?.get() === true;
  const fsPolicy = createFsPolicy({ tmpDir, mode: fsMode });
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  // Module-level per-session egress singleton — lazy-started on first call.
  // (ADR-0097)
  // Start failure (typically a missing relay dependency / unix socket in use)
  // leaves session undefined and every later fence runs with plain network
  // isolation (fail-closed). Callers release it via
  // `disposeEgressSessionForVerify` (verify-loop / hub at session exit).
  let egressSession: EgressSession | undefined;
  let egressStartAttempted = false;
  async function ensureEgressSession(): Promise<EgressSession | undefined> {
    if (egressStartAttempted) return egressSession;
    egressStartAttempted = true;
    if (opts.egressPolicy === undefined) return undefined;
    try {
      egressSession = await createEgressSession({
        policy: opts.egressPolicy,
      });
    } catch {
      egressSession = undefined;
    }
    return egressSession;
  }
  return async (command, ctx) => {
    // ADR-0092: `$TMPDIR` and the `tmpRoot` handed to createBwrapFence must be
    // the **same** real host path (same shape and timing as bash.ts's fenceEnv).
    // `envIsolation.filter` only passes a host TMPDIR through
    // BASE_ENV_WHITELIST — if the host never exported it, in-fence writes to
    // "$TMPDIR/x" land on /x (guest root) and get denied. Explicit injection
    // is this surface's target state; the host value in the filter result is
    // intentionally overridden (the session tmp comes from the caller, not
    // (ADR-0097)
    // from host env).
    // Egress session lazy start — begins on first call, reused after. Under
    // yolo it is skipped wholesale (no session, no socket bind, no proxy env):
    // no fence means no netns (ADR-0119 ruling 3); non-yolo is byte-for-byte
    // unchanged.
    const session = yolo ? undefined : await ensureEgressSession();
    // Inner-bridge command prefix, identical in shape to the bash tool's
    // foreground / background spawn; the single concat point is the egress
    // module's `wrapCommandWithInnerBridge` — with a session the payload is
    // `<innerBridgeScript>\n<command>`, without one it is byte-identical to
    // the raw command (invariant: no session ⇒ no bytes changed).
    const commandPayload = wrapCommandWithInnerBridge(session?.spec, command);
    const fenceEnv = {
      ...envIsolation.filter(process.env),
      TMPDIR: tmpDir,
      ...(session !== undefined ? session.spec.env : {}),
    };
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", commandPayload],
      fsPolicy,
      env: fenceEnv,
      cwd: opts.cwd,
      // ADR-0092: workspace-tier three layers. Deliberately **not**
      // pre-filtered on `homeRoot !== undefined` — when the home source is
      // missing, bwrap throws a typed error (workspace tier without home
      // silently degrading to global tier is a security hole, not tolerance).
      // This call site only says which paths feed which layers; whether a
      // layer may be omitted is the fence assembly layer's sole decision.
      ...(fsMode === "workspace"
        ? { homeRoot, workspaceRoot: opts.cwd, tmpRoot: tmpDir }
        : {}),
      // Egress seam (per-call fence argv, module-level session).
      // (ADR-0097)
      ...(session !== undefined ? { egress: session.spec } : {}),
      // UNBOUND_FENCE segment — same segment, same order as the bash tool surface.
      ...(unboundMainCheckout !== undefined
        ? {
            unboundFence: {
              mainCheckout: unboundMainCheckout,
              tmpPad: tmpDir,
            },
          }
        : {}),
      // ADR-0119: the whole-fence-retirement switch — spread-guard keeps the
      // non-yolo fence opts byte-identical; when true the fence factory emits
      // bare argv (the fsMode tier and the egress field both have nothing to
      // carry — yolo wins).
      ...(yolo ? { yolo: true } : {}),
    });
    return runInSandbox({
      fence,
      cwd: opts.cwd,
      signal: ctx?.signal,
      env: fenceEnv,
    });
  };
}

/**
 * Release the module-level egress session of `makeDefaultRunVerify` (hub /
 *
 // (ADR-0097)
 * verify-loop call this at session exit). Silent success when the session was
 * never started or already disposed (idempotent).
 */
export async function disposeEgressSessionForVerify(
  verifyFn: RunVerifyFn
): Promise<void> {
  // verifyFn is a closure with no reference bridge — holding the session for
  // disposal is the caller's responsibility. Minimal contract for now: the
  // factory keeps `egressSession` inside its closure and this function has no
  // bridge. **Production assembly TODO**: dispose bridging comes with the
  // hub / verify-loop assembly — this ticket only defines the contract and
  // avoids polluting the RunVerifyFn signature with a placeholder field.
  void verifyFn;
}

/**
 * One command execution + timeout wrapper (loop layer; runner signature untouched).
 * Each execution gets its own AbortController: timeoutSec fires → abort
 * (timedOut=true); a user signal abort forwards into the controller too (user
 * takes priority; the caller decides aborted). Spawn error / sandbox rejection
 * converges to exit=127 (true-failure branch semantics). Every execution
 * persists one SandboxCmdRecord whose parentTurnId is the completed turn that
 * triggered the round (single-valued parent).
 */
export async function runVerifyOnce(
  runVerify: RunVerifyFn,
  command: string,
  opts: {
    readonly timeoutSec: number;
    readonly signal?: AbortSignal;
    /** Observation sink (verify commands persist via SandboxCmdRecord). */
    readonly trace?: TraceService;
    /** The completed turn id that triggered this verification round. */
    readonly parentTurnId: string;
  }
): Promise<{ readonly result: SandboxRunResult; readonly timedOut: boolean }> {
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  let timedOut = false;
  /** Spawn/sandbox startup failure (exit=127 convergence keeps the root cause; never forged into stderr). */
  let sandboxError: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutSec * 1000);
  const onUserAbort = (): void => controller.abort();
  if (opts.signal !== undefined) {
    opts.signal.addEventListener("abort", onUserAbort, { once: true });
  }
  try {
    let result: SandboxRunResult;
    try {
      result = await runVerify(command, { signal: controller.signal });
    } catch (err) {
      // Startup failure must not throw and break the loop; fold into
      // exit=127 true-failure (ENOENT boundary).
      // EXIT: spawn/sandbox startup failure → exit=127, true-failure branch
      // (fallback carries an explicit exit condition; err recorded on
      // SandboxCmdRecord error).
      result = { exitCode: 127, stdout: "", stderr: "" };
      sandboxError = err instanceof Error ? err.message : String(err);
    }
    const endedAt = new Date().toISOString();
    const record: SandboxCmdRecord = {
      parentTurnId: opts.parentTurnId,
      command,
      exitCode: result.exitCode,
      stdoutCaptured: result.stdout.length > 0,
      ...(result.stdout.length > 0 ? { stdout: result.stdout } : {}),
      startedAt,
      endedAt,
      durationMs: Math.round(performance.now() - startMono),
      status: timedOut ? "error" : "ok",
      // Failure root cause persisted explicitly (timeouts / startup failures never silent);
      // Postel: successful runs carry no error key.
      ...(timedOut
        ? {
            error: {
              type: "timeout" as const,
              message: "verify command timed out",
            },
          }
        : sandboxError !== undefined
          ? {
              error: {
                type: "execution_failed" as const,
                message: sandboxError,
              },
            }
          : {}),
    };
    void opts.trace?.recordSandboxCmd(record);
    return { result, timedOut };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onUserAbort);
  }
}
