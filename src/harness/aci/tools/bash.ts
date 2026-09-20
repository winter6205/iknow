import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { isDangerousCommand } from "../permission.js";
import { commandContainsSensitivePath } from "../../permission/hard-walls.js";
import { validateReadonlyCommand } from "./bash-readonly.js";
import {
  BASE_ENV_WHITELIST,
  applyCwdReadonlyFenceEnv,
  createBwrapFence,
  createEgressApprovalGate,
  createEgressSession,
  createEnvIsolation,
  createFsPolicy,
  createOutputMask,
  currentSecretValues,
  renderEgressFailureMessage,
  sshHostKeyFailureGuidance,
  wrapCommandWithInnerBridge,
  EgressRelayUnavailableError,
  type AskApproval,
  type BwrapFenceOptions,
  type EgressApprovalGate,
  type EgressPolicyInput,
  type EgressSession,
  type EgressViolation,
} from "../../sandbox/index.js";
import {
  FS_ISOLATION_MODE_DEFAULT,
  type FsIsolationMode,
  type FsModeContext,
} from "../../sandbox/fs-mode.js";
import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  requireBwrap,
  runInSandbox,
} from "../../sandbox/runner.js";
import { restore, type SecretRegistry } from "../../secret-roundtrip/index.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";
import {
  unboundFenceErofsGuidance,
  unboundFenceBackgroundNotice,
  unboundFenceMainCheckout,
  type WorktreeGateReader,
} from "../../isolation/worktree-gate.js";
import { FENCE_WRITE_GUIDANCE, resolveWithinRoot } from "./helpers.js";
import { extractSingleReadPath } from "./bash-read-extract.js";
import { assertNoBashGrepSubstitution } from "./role-substitution.js";
import type { LastReadLedgerHost } from "../last-read-ledger.js";

interface BashInput {
  readonly command?: unknown;
  /** background?: boolean — defaults to false (foreground, existing path). */
  readonly background?: unknown;
}

export interface CreateBashToolOptions {
  /** Per-engine secret registry. When present, the handler restores
   *  placeholders (`<<<SECRET_N>>>` → real values) before building the
   *  bwrap fence; absent → the command passes through unchanged. */
  readonly secretRegistry?: SecretRegistry;
  /** Background task manager. When present, the `background: true` branch
   *  works — the handler calls manager.spawn, returns {task_id, log_path}
   *  immediately without blocking or occupying the tier timer (millisecond
   *  return ⇒ the executor tier never governs background daemons). Absent →
   *  `background: true` throws ToolExecutionError (fail-fast, no silent
   *  degradation to foreground — a long-lived process demoted to foreground
   *  would be killed by the build tier); the foreground path is unaffected.
   *  Production assembly (build-engine) injects createBackgroundTaskManager
   *  + defaultBackgroundSpawn. */
  readonly backgroundManager?: BackgroundTaskManager;
  /** Bash mode — "readonly" makes the handler call
   *  validateReadonlyCommand after isDangerousCommand and before
   *  commandContainsSensitivePath; out-of-policy commands throw
   *  ReadonlyViolationError (extends ToolExecutionError). Default "any" =
   *  the original path byte-for-byte unchanged (regression baseline). */
  readonly bashMode?: "any" | "readonly";
  /** Fence-level cwd read-only control — when true the fence binds cwd as
   *  --ro-bind and injects GIT_OPTIONAL_LOCKS=0 into the fence env (git
   *  ≥2.14, prevents `git status` from rewriting the index).
   *  Default / false = the existing writable cwd. */
  readonly cwdReadonly?: boolean;
  /** Per-call live root cell. When present, the handler reads it once at
   *  entry and freezes it as waveRoot (batch snapshot), shared by the
   *  foreground and background paths. Absent → fall back to the
   *  factory-captured cwd. */
  readonly liveTaskRoot?: LiveTaskRoot;
  /**
   * ADR-0092: this identity's session tmp host path. Tests inject
   * `<sessionFolder>/fence-tmp`. When omitted, per-call resolution uses
   * `projectDir` + `conversationId`, else a factory-lifetime fallback tmp.
   * It feeds `$TMPDIR` — it is never a bind target for guest `/tmp`.
   *
   * ADR-0084 asymmetry (legacy direct-factory shape only): when neither
   * `tmpDir` nor `projectDir` is given, bash allocates a fresh
   * `mkdtempSync` pad here, while `write_file`'s `resolveSessionFenceTmp`
   * returns `undefined` for the same inputs. A ledger key recorded for
   * `cat /tmp/x` therefore names a path `write_file` never resolves —
   * a dead key, so the later non-empty overwrite is refused (fail-closed,
   * the safe direction). Production assembly passes both tools the same
   * `tmpDir` / `projectDir` values, which is why this is not plumbed here;
   * tests that need the shared pad must inject `tmpDir` explicitly on both
   * sides.
   */
  readonly tmpDir?: string;
  /**
   * Session project dir (`resolveProjectSessionDir` output). With
   * `ctx.conversationId`, bash uses `<sessionFolder>/fence-tmp` as `$TMPDIR`.
   */
  readonly projectDir?: string;
  /**
   * ADR-0084: last-read ledger host. Present → a foreground command that
   * is exactly one whitelisted single-file read (exit 0) records the resolved
   * canonical path, so a later non-empty `write_file` on it passes the
   * freshness gate. Absent → nothing is recorded (legacy callers); reads stay
   * executable either way — only the ledger entry is optional.
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /**
   * ADR-0092: fs isolation-mode holder (see `sandbox/fs-mode.ts`). The
   * handler reads `fsMode?.get() ?? "global"` once per call — same batch
   * snapshot discipline as `liveTaskRoot`; the foreground fence and the
   * background spawn share the same frozen value. Absent → global mode
   * (V1 baseline unchanged).
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0092: workspace-mode home ro-bind source host absolute path.
   * Default `homedir()` — same injection shape as `tmpDir` (testable).
   * Production assembly passes it through (build-engine: userHome;
   * worker: the matching sessionRoots field).
   */
  readonly homeRoot?: string;
  /**
   * Worktree-on-mutate live toggle holder (read-only view, same discipline
   * as the gate's `enabled`). The handler reads it once at entry alongside
   * waveRoot and freezes it for the UNBOUND_FENCE decision — gate ON ∧
   * waveRoot is the main checkout → the foreground fence / background spawn
   * adds the `--ro-bind <main>` physical segment and, on EROFS feedback,
   * renders actionable guidance. Absent = never emits the segment (bound /
   * gate-OFF argv byte-identical).
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * ADR-0097: egress proxy seam assembly — the caller injects the policy
   * input factory (read from settings `isolation.network`); the handler
   * starts a per-call egress session during fence assembly and releases it
   * in `finally`. **Absent** = no egress session (fence still runs with
   * `--unshare-net`, i.e. plain network isolation). Production assembly
   * injects it at the build-engine layer; tests may inject fake factories.
   *
   * Factory shape rather than a session instance: per-call assembly, the
   * handler builds the session itself, then `finally { await
   * session.dispose() }`. A start failure (EgressRelayUnavailableError
   * etc.) is handled fail-closed without silent degradation: this call
   * runs with no egress seam (no proxy env inside the sandbox,
   * `--unshare-net` still in place, i.e. plain isolation) plus a typed
   * failure visible to the model / TUI.
   */
  readonly egressPolicyFactory?: () => EgressPolicyInput | undefined;
  /**
   * Test seam: inject the `createEgressSession` factory so end-to-end tests
   * can simulate "violation recorded → drain → typed failure" without
   * actually starting a relay / proxy. Production assembly does **not**
   * pass it (uses the default createEgressSession).
   *
   * Why it's needed: the bash handler imports the real
   * `createEgressSession` directly, and the real http-proxy needs unix
   * socket resources and listen permissions that CI may not have. With a
   * stub session the test records one violation and exercises the whole
   * drain → typed failure pipeline, verifying that the message flows from
   * handler to categorizeResult without false greens.
   */
  readonly createEgressSessionFactory?: typeof createEgressSession;
  /**
   * First-seen domain approval flow: ask inlet — wraps the existing
   * `AskUser` into `(host) => Promise<boolean>`; during the bash tool
   * factory closure it builds one `EgressApprovalGate` shared across
   * calls (session-level allowed/denied sets + in-flight merge table).
   *
   * Absent = no ask surface; a first-seen domain is recorded as a
   * `no-approval-inlet` violation (fail-closed for non-interactive
   * entries).
   *
   * Assembly chain: build-engine holds the existing `AskUser`, wraps it
   * into `askApproval` at createBashTool, and passes it through here.
   * Tests may inject a fake `(host) => Boolean`.
   */
  readonly askApproval?: AskApproval;
}

/**
 * ADR-0092: read the fs isolation-mode holder and homeRoot once at handler
 * entry and freeze them — foreground fence and background spawn share the
 * same snapshot, so a later holder flip inside the handler cannot leak into
 * the current call (same discipline as `liveTaskRoot`'s batch snapshot).
 *
 * Holder absent → global mode (V1 baseline unchanged); homeRoot absent →
 * `homedir()` (same injectable shape as opts). Landing on a non-empty
 * default is deliberate: under workspace mode an empty homeRoot is a typed
 * fail-loud at the bwrap layer (it must not silently degrade to global
 * mode), so this default matches the production value and the guard only
 * fires when assembly genuinely drops the input.
 */
function snapshotFenceInputs(opts: CreateBashToolOptions | undefined): {
  readonly mode: FsIsolationMode;
  readonly homeRoot: string;
} {
  return {
    mode: opts?.fsMode?.get() ?? FS_ISOLATION_MODE_DEFAULT,
    homeRoot: opts?.homeRoot ?? homedir(),
  };
}

/**
 * Batch-snapshotted fence inputs (frozen at handler entry): fs mode holder
 * / homeRoot / tmpDir share one vintage — foreground fence and background
 * spawn use the same snapshot; later holder or cell flips cannot leak into
 * the current call.
 */
interface FenceSnapshot {
  readonly mode: FsIsolationMode;
  readonly homeRoot: string;
  readonly tmpDir: string;
  /** UNBOUND_FENCE main checkout frozen at entry (absent = no segment). */
  readonly unboundMainCheckout: string | undefined;
}

/**
 * ADR-0092: source absolute paths for the workspace-mode fence's three
 * layers (home ro-bind + two write whitelists). Global mode returns an
 * empty spread — bwrap emits none of the layers, argv byte-identical to
 * the V1 baseline.
 */
function fenceWorkspaceMounts(
  mode: FsIsolationMode,
  homeRoot: string,
  workspaceRoot: string,
  tmpRoot: string
): Pick<BwrapFenceOptions, "homeRoot" | "workspaceRoot" | "tmpRoot"> {
  return mode === "workspace" ? { homeRoot, workspaceRoot, tmpRoot } : {};
}

/**
 * The whole foreground bash flow — egress assembly + fence build + sandbox
 * run + feedback (extracted to keep the handler under the S5 complexity
 * gate). Order is the contract "start bridge → bind → inject → finalize":
 * start the per-call session before fence assembly; dispose in `finally`
 * (exception paths and normal paths share one release channel); the
 * violation drain goes through the typed-failure path.
 *
 * When the drain is non-empty or egressStartError is present → throw
 * `ToolExecutionError(message)` (typed) instead of ok + stderr bypass;
 * the executor wraps it via `buildFailureResult` into
 * `kind: "execution_failed"`, and `message` hits the `[network_denied]`
 * prefix in `categorizeResult` → mid tier (violation-handling.ts needs no
 * change; its hook wires up automatically). Empty drain and no startError
 * → the original ok shape (byte-identical to before this upgrade).
 */
async function runForegroundBash(
  args: RunForegroundBashArgs
): Promise<unknown> {
  const {
    finalCommand,
    command,
    waveRoot,
    fsMode,
    homeRoot,
    tmpDir,
    unboundMainCheckout,
    fsPolicy,
    fenceEnv,
    fenceIsReadonly,
    effectiveEgressPolicyFactory,
    toolOpts: opts,
    ctx,
  } = args;
  // start session → build fence → run sandbox → install mask → record
  // ledger → finalize: 6 steps, each an extracted sub-function; this
  // function only orchestrates them in order.
  const egress = await startEgressSessionForCall(
    effectiveEgressPolicyFactory,
    opts?.createEgressSessionFactory
  );
  const fence = buildForegroundFence({
    finalCommand,
    fsPolicy,
    fenceEnv,
    waveRoot,
    fenceIsReadonly,
    fsMode,
    homeRoot,
    tmpDir,
    unboundMainCheckout,
    egressSession: egress.session,
  });
  const result = await runSandboxDisposingEgress(
    {
      fence,
      cwd: waveRoot,
      signal: ctx?.signal,
      env: fenceEnv,
      maxOutputCodePoints: DEFAULT_MAX_OUTPUT_CODE_POINTS,
    },
    egress.session
  );
  const mask = buildOutputMask(opts);
  await recordForegroundRead(opts, ctx, {
    command,
    exitCode: result.exitCode,
    waveRoot,
    tmpDir,
  });
  const finalPath = await finalizeEgressPath({
    egressSession: egress.session,
    egressStartError: egress.startError,
    egressInfraHint: egress.infraHint,
    egressPolicyInput: egress.policyInput,
    result,
    mask,
    unboundMainCheckout,
  });
  if (finalPath.kind === "throw") throw finalPath.throwError;
  return finalPath.envelope;
}

/**
 * Parameter type for `runForegroundBash` (split out to keep that function
 * under 60 lines — S5 soft gate).
 */
interface RunForegroundBashArgs {
  finalCommand: string;
  command: string;
  waveRoot: string;
  fsMode: FsIsolationMode;
  homeRoot: string;
  tmpDir: string;
  /** UNBOUND_FENCE main checkout frozen at entry (undefined = no segment). */
  unboundMainCheckout: string | undefined;
  fsPolicy: ReturnType<typeof createFsPolicy>;
  fenceEnv: Record<string, string>;
  fenceIsReadonly: boolean;
  /**
   * Factory-closure-wrapped `egressPolicyFactory` (auto-injects
   * `approvalGate` and falls back allowlistSource to "session").
   * Absent → the handler starts no session; V1 baseline unchanged.
   */
  effectiveEgressPolicyFactory:
    (() => EgressPolicyInput | undefined) | undefined;
  // Pass opts through whole (recording surfaces like lastReadLedger are
  // consumed inside runForegroundBash) — kept together so new recording
  // surfaces don't require field-by-field plumbing here.
  toolOpts: CreateBashToolOptions | undefined;
  ctx?: ToolExecutionContext;
}

/**
 * Build the foreground bwrap fence — assembles `bash -c finalCommand` +
 * fs policy + env + cwd + workspace mounts + optional egress spec into one
 * fence.
 *
 * Extracted to keep `runForegroundBash` complexity under the S5 gate.
 * WorkspaceMounts and egress field population rules are documented at
 * their sources; this function only composes, no logic.
 *
 * ADR-0107 relayout: when egress is present the command chain is prefixed
 * with `spec.innerBridgeScript` (an in-sandbox node relay listening on
 * 127.0.0.1:3128 → unix socket + trap cleanup; shape in session.ts
 * `buildInnerBridgeScript`) — the proxy env points at this in-sandbox
 * listener; without the prefix the seam would only have its host half.
 * No egress = payload byte-identical (regression baseline: no seam = no
 * bridge).
 */
function buildForegroundFence(args: {
  readonly finalCommand: string;
  readonly fsPolicy: ReturnType<typeof createFsPolicy>;
  readonly fenceEnv: Record<string, string>;
  readonly waveRoot: string;
  readonly fenceIsReadonly: boolean;
  readonly fsMode: FsIsolationMode;
  readonly homeRoot: string;
  readonly tmpDir: string;
  readonly unboundMainCheckout: string | undefined;
  readonly egressSession: EgressSession | undefined;
}): ReturnType<typeof createBwrapFence> {
  const payload = wrapCommandWithInnerBridge(
    args.egressSession?.spec,
    args.finalCommand
  );
  return createBwrapFence({
    command: "bash",
    args: ["-c", payload],
    fsPolicy: args.fsPolicy,
    env: args.fenceEnv,
    cwd: args.waveRoot,
    ...(args.fenceIsReadonly ? { cwdReadonly: true } : {}),
    // ADR-0092: source paths for the workspace-mode fence layers (host
    // root + system prefixes + home ro-bind + two write whitelists).
    // Under global mode `fsPolicy.mode === "global"` and bwrap emits
    // nothing, byte-identical to the V1 baseline.
    ...fenceWorkspaceMounts(
      args.fsMode,
      args.homeRoot,
      args.waveRoot,
      args.tmpDir
    ),
    ...(args.egressSession !== undefined
      ? { egress: args.egressSession.spec }
      : {}),
    // UNBOUND_FENCE physical segment — use the entry-frozen value, never
    // re-read the holder; pad=tmpDir keeps scratch writes landing (the
    // ADR's ruling point).
    ...(args.unboundMainCheckout !== undefined
      ? {
          unboundFence: {
            mainCheckout: args.unboundMainCheckout,
            tmpPad: args.tmpDir,
          },
        }
      : {}),
  });
}

/**
 * Output mask construction — scrub stdout / stderr once before
 * the handler returns.
 *
 * The mask is built fresh inside each call (registry values can change
 * across turns; no module-level caching). Absent secretRegistry → no mask
 * is built (no "mask from the three env sources even when absent"
 * extension). Truncation authority lies with the executor and the mask
 * runs after truncation — it masks already-truncated real values, giving
 * the maximum masking window.
 *
 * Extracted (S5 complexity gate).
 */
function buildOutputMask(
  opts: CreateBashToolOptions | undefined
): ReturnType<typeof createOutputMask> | undefined {
  if (opts?.secretRegistry === undefined) return undefined;
  return createOutputMask(
    currentSecretValues(process.env, opts.secretRegistry.values())
  );
}

/**
 * ADR-0084: after a foreground fence completes, record successful commands
 * that "read exactly one file".
 *
 * Extracted to control `runForegroundBash` complexity (S5 gate). This is
 * just a foreground-only wrapper around recordCompletedRead: it reads the
 * exit code, waveRoot and tmpDir once and passes them through — no extra
 * logic.
 */
async function recordForegroundRead(
  opts: CreateBashToolOptions | undefined,
  ctx: ToolExecutionContext | undefined,
  args: {
    readonly command: string;
    readonly exitCode: number;
    readonly waveRoot: string;
    readonly tmpDir: string;
  }
): Promise<void> {
  await recordCompletedRead(opts, ctx, {
    command: args.command,
    exitCode: args.exitCode,
    root: args.waveRoot,
    sessionTmpRoot: args.tmpDir,
  });
}

/**
 * Violation drain + egressStartError check → typed-failure / ok decision
 * point. Extracted to control `runForegroundBash` complexity (S5 gate).
 * Logic:
 *   - non-empty drain or startError present → compose the typed failure
 *     message and throw `ToolExecutionError`;
 *   - otherwise keep the original ok shape (assembleBashToolResult,
 *     byte-identical to before the typed-failure upgrade).
 *
 * Standalone function (S5 complexity gate).
 */
async function finalizeEgressPath(args: {
  readonly egressSession: EgressSession | undefined;
  readonly egressStartError: string | undefined;
  readonly egressInfraHint: string | undefined;
  readonly egressPolicyInput: EgressPolicyInput | undefined;
  readonly result: Awaited<ReturnType<typeof runInSandbox>>;
  readonly mask: ReturnType<typeof createOutputMask> | undefined;
  readonly unboundMainCheckout: string | undefined;
}): Promise<
  | { readonly kind: "throw"; readonly throwError: ToolExecutionError }
  | {
      readonly kind: "ok";
      readonly envelope: {
        output: string;
        meta: { stdout: string; stderr: string };
      };
    }
> {
  const {
    egressSession,
    egressStartError,
    egressInfraHint,
    egressPolicyInput,
    result,
    mask,
    unboundMainCheckout,
  } = args;
  const violations =
    egressSession !== undefined ? egressSession.violationSink.drain() : [];
  if (violations.length > 0 || egressStartError !== undefined) {
    const throwError = composeEgressFailure({
      violations,
      startError: egressStartError,
      ...(egressInfraHint !== undefined ? { infraHint: egressInfraHint } : {}),
      ...(egressPolicyInput?.allowlistSource !== undefined
        ? { allowlistSource: egressPolicyInput.allowlistSource }
        : {}),
    });
    return { kind: "throw", throwError };
  }
  // When the egress seam is present + the command exits non-zero + stderr
  // matches the ssh first-unseen-host-key shape → append one host-side
  // guidance line to the stderr tail (ssh-keyscan / UserKnownHostsFile
  // combo). This is a message-plane observation: it does not change exit
  // semantics and produces no egress violation; no match = byte-identical.
  const f4Guidance =
    egressSession !== undefined && result.exitCode !== 0
      ? sshHostKeyFailureGuidance(result.stderr)
      : undefined;
  // Under UNBOUND_FENCE, EROFS in stderr → feed back actionable guidance
  // (same ok-envelope stderr bypass as the ssh-key hint above: no exit
  // semantics change, no violation count — categorizeResult only knows
  // execution_failed). Non-unbound state = no segment emitted.
  const erofsGuidance =
    unboundMainCheckout !== undefined && result.exitCode !== 0
      ? unboundFenceErofsGuidance(result.stderr)
      : undefined;
  const guidanceLines = [f4Guidance, erofsGuidance].filter(
    (line): line is string => line !== undefined
  );
  const effectiveResult =
    guidanceLines.length === 0
      ? result
      : { ...result, stderr: `${result.stderr}\n${guidanceLines.join("\n")}` };
  return {
    kind: "ok",
    envelope: assembleBashToolResult(effectiveResult, mask),
  };
}

/**
 * Per-call egress session assembly — start the session before fence
 * assembly; on failure (EgressRelayUnavailableError etc.) this call runs
 * with no egress seam (no proxy env inside the sandbox, `--unshare-net`
 * still in place, i.e. plain isolation) + the failure text goes to the
 * caller's typed failure so the model / TUI sees it (no stderr bypass).
 *
 * policyInput is passed through: the caller reads
 * `policyInput.allowlistSource` when composing the typed failure to label
 * "current allowlist source". The session holds no extra policy reference
 * (captured in its filter closure), hence the caller-side cache.
 *
 * Typed-error catch contract (code-quality.md): discriminate the concrete
 * type first. EgressRelayUnavailableError carries detail +
 * remediationHint (this product's dependency guidance, ADR-0107), so build
 * a structured `startError` directly; unknown errors take the fallback
 * shape but keep the "unknown cause" marker, so a plain object never
 * renders as `[object Object]` under `String(err)` and hides `kind` /
 * `installHint`. `infraHint` is derived from the typed error and passed to
 * composeEgressFailure so the typed failure message spells out "which
 * dependency is missing + how to install it".
 *
 * Standalone function (S5 complexity gate).
 */
async function startEgressSessionForCall(
  egressPolicyFactory: (() => EgressPolicyInput | undefined) | undefined,
  createEgressSessionFn: typeof createEgressSession = createEgressSession
): Promise<{
  session?: EgressSession;
  startError?: string;
  infraHint?: string;
  policyInput?: EgressPolicyInput;
}> {
  const policyInput = egressPolicyFactory?.();
  if (policyInput === undefined) return {};
  try {
    // fail-closed semantics live inside the session; here we only catch
    // startup failure → no seam + leave a trace.
    const session = await createEgressSessionFn({ policy: policyInput });
    return { session, policyInput };
  } catch (err) {
    if (err instanceof EgressRelayUnavailableError) {
      // Typed branch: EgressRelayUnavailableError carries detail +
      // remediationHint (product dependency guidance, ADR-0107); use
      // err.message as the structured startError and pass it through
      // composeEgressFailure → renderEgressFailureMessage, so the typed
      // failure message shows "which product dependency is missing + how
      // to fix it" (typed-error catch contract).
      return {
        startError: err.message,
        infraHint: err.message,
        policyInput,
      };
    }
    // Fallback: for unknown errors keep the "unknown cause" marker so the
    // caller never renders a plain object as [object Object] (code-quality
    // typed-error catch contract). Putting err.message / String(err) into
    // startError is **explicitly labeled** unknown-cause to avoid confusion
    // with the typed path.
    const fallback = err instanceof Error ? err.message : String(err);
    return {
      startError: `egress seam unavailable (unknown cause): ${fallback}`,
      infraHint: `egress seam unavailable (unknown cause): ${fallback}`,
      policyInput,
    };
  }
}

/**
 * Compose the typed failure message — called when the drain is non-empty
 * or egressStartError is present.
 *
 * - Non-empty drain: render via `renderEgressFailureMessage` (typed
 *   failure text with the `[network_denied]` prefix + one line per
 *   violation + shared remediation guidance + the "command already ran"
 *   semantics; infra vs domain-denial messages are never mixed in one
 *   section).
 * - egressStartError present with an empty drain: fold the
 *   relay-dependency-missing / assembly-failure text into a typed failure
 *   (`[network_denied]` prefix + "egress seam unavailable" semantics) and
 *   synthesize an `infra-unavailable` violation through the same render
 *   pipeline for message consistency. **No** config-key guidance
 *   (infra ≠ domain-denial refusal).
 *
 * Returns a typed `ToolExecutionError`, thrown to the executor's
 * `buildFailureResult` → `execution_failed` path.
 *
 * Standalone function (S5 complexity gate).
 */
function composeEgressFailure(args: {
  readonly violations: readonly EgressViolation[];
  readonly startError?: string;
  readonly infraHint?: string;
  readonly allowlistSource?: EgressPolicyInput["allowlistSource"];
}): ToolExecutionError {
  const { violations, startError, infraHint, allowlistSource } = args;
  // startError present but drain empty → synthesize an infra-unavailable
  // violation so the render pipeline handles it uniformly (consistent text
  // + the infra/domain separation logic applies automatically).
  const effectiveViolations: EgressViolation[] =
    violations.length > 0
      ? [...violations]
      : startError !== undefined
        ? [
            {
              kind: "egress_violation",
              host: "egress-seam",
              port: 0,
              reason: "infra-unavailable",
              command: "(egress session startup)",
            },
          ]
        : [];
  const message = renderEgressFailureMessage({
    violations: effectiveViolations,
    ...(infraHint !== undefined ? { infraHint } : {}),
    ...(allowlistSource !== undefined ? { allowlistSource } : {}),
  });
  return new ToolExecutionError(message);
}

/**
 * runInSandbox + per-call egress session release in `finally` — exception
 * and normal paths share one release channel (the pinned ownership /
 * dispose contract). dispose is idempotent, repeat calls are safe.
 * Standalone function (S5 gate).
 */
async function runSandboxDisposingEgress(
  runArgs: Parameters<typeof runInSandbox>[0],
  egressSession: EgressSession | undefined
): Promise<Awaited<ReturnType<typeof runInSandbox>>> {
  try {
    return await runInSandbox(runArgs);
  } finally {
    if (egressSession !== undefined) {
      try {
        await egressSession.dispose();
      } catch {
        // best-effort: a dispose error must not pollute the caller's
        // control flow.
      }
    }
  }
}

/**
 * Assemble the bash tool return shape — {code, stdout, stderr} JSON + a
 * meta side channel.
 *
 * Since violations / egressStartError moved upstream into typed failure
 * (no more stderr bypass), this function now carries only the ok shape —
 * the byte-identical pre-upgrade path lives in this same branch.
 * Standalone function (S5 gate).
 */
function assembleBashToolResult(
  result: Awaited<ReturnType<typeof runInSandbox>>,
  mask: ReturnType<typeof createOutputMask> | undefined
): { output: string; meta: { stdout: string; stderr: string } } {
  const stdout = mask ? mask.mask(result.stdout) : result.stdout;
  const stderr = mask ? mask.mask(result.stderr) : result.stderr;
  return {
    output: JSON.stringify({
      code: result.exitCode,
      stdout,
      stderr,
    }),
    // bash stdout/stderr take the observation side channel (meta); the TUI
    // reads it for the 5-line tail preview (bypassing encodeToolResults
    // into the model tool_result — the model only sees the JSON-ized
    // code/stdout/stderr in the output field — shape unchanged).
    meta: {
      stdout,
      stderr,
    },
  };
}

export function createBashTool(
  cwd: string,
  opts?: CreateBashToolOptions
): AciToolDef {
  requireBwrap();
  // ADR-0092: the factory captures only `tmpDir` (process-stable). fsPolicy
  // is rebuilt per call by the handler, never closed over the factory cwd.
  let fallbackFenceTmp: string | undefined;
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  // First-seen domain approval: session-level gate built once in the
  // factory closure, shared across calls (allowed/denied sets + in-flight
  // merge table). askApproval absent → the gate internally fails closed:
  // any first-seen host is denied outright with violation reason
  // `no-approval-inlet`. Note: even with the gate present, whether an
  // approval persists back to settings is left TODO (call the write-back
  // API when ADR-0097's approval-persistence-granularity offers one; not
  // done here).
  const approvalGate: EgressApprovalGate | undefined =
    opts?.askApproval !== undefined
      ? createEgressApprovalGate({ askApproval: opts.askApproval })
      : undefined;
  // Wrap egressPolicyFactory — every policy returned per call gets
  // `approvalGate` injected. Keeping gate injection on the bash factory
  // side (not the caller's) preserves separation of concerns: the factory
  // provides data, the bash factory attaches the gate; the egress domain
  // never back-depends on permission's AskUser assembly.
  // "session-tier producer" (pinned by the egress-preset-allowlist spec):
  // the assembly side only produces builtin / persisted tiers; when the
  // caller left allowlistSource unset and the interactive approval surface
  // (approvalGate) is present, the wrapper fills in "session" — the
  // session-level allow granted by the approval flow, rendered as
  // "Current allowlist source: session-level allowlist". A caller-set
  // tier is never overwritten.
  const wrappedEgressPolicyFactory:
    (() => EgressPolicyInput | undefined) | undefined =
    opts?.egressPolicyFactory !== undefined
      ? () => {
          const pi = opts.egressPolicyFactory?.();
          if (pi === undefined) return undefined;
          if (approvalGate === undefined) return pi;
          if (pi.allowlistSource !== undefined) return pi;
          return { ...pi, allowlistSource: "session" as const };
        }
      : undefined;
  // The same gate is also attached to the policy (consumed by the session
  // assembly's filter): re-project — attach the gate onto the policy so the
  // egress domain decides per host.
  const effectiveEgressPolicyFactory:
    (() => EgressPolicyInput | undefined) | undefined =
    wrappedEgressPolicyFactory !== undefined && approvalGate !== undefined
      ? () => {
          const pi = wrappedEgressPolicyFactory();
          if (pi === undefined) return undefined;
          return { ...pi, approvalGate };
        }
      : wrappedEgressPolicyFactory;
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<unknown> => {
    const command = (input as BashInput | null)?.command;
    if (typeof command !== "string" || command.length === 0)
      throw new ToolExecutionError("bash: command must be a non-empty string");
    if (isDangerousCommand(command))
      throw new ToolExecutionError(
        `bash: dangerous command rejected: ${command}`
      );
    // bashMode="readonly" → enforce the read-only command policy.
    // Default ("any") → this branch never runs, handler byte-unchanged
    // (regression baseline). validateReadonlyCommand throws
    // ReadonlyViolationError (extends ToolExecutionError), caught by the
    // executor's existing ToolExecutionError path.
    if (opts?.bashMode === "readonly") {
      validateReadonlyCommand(command);
    }
    // ADR-0117 role-substitution gate: placed before the foreground /
    // background split so both arms are covered. Not a hard-wall — the
    // rules and refusal shape live in role-substitution.ts.
    assertNoBashGrepSubstitution(command);
    if (commandContainsSensitivePath(command))
      throw new ToolExecutionError(
        `bash: command targets a sensitive path: ${command}`
      );
    // Batch snapshot per handler call: read the cell once at entry and
    // freeze it as waveRoot, threading through the whole path (foreground
    // fence / background spawn get the same value) — later cell flips
    // inside the handler cannot leak into this call. liveTaskRoot absent →
    // fall back to the factory-captured cwd (legacy parity: without a cell
    // the path is byte-identical to V1).
    const waveRoot: string = opts?.liveTaskRoot
      ? opts.liveTaskRoot.read()
      : cwd;
    // The UNBOUND_FENCE decision shares waveRoot's vintage: read the live
    // holder once at entry and freeze — foreground fence / background
    // spawn / EROFS feedback all use this single snapshot; a mid-handler
    // holder flip cannot leak into this call (same snapshot discipline as
    // fsMode).
    const unboundMainCheckout = unboundFenceMainCheckout({
      gateOn: opts?.worktreeOnMutate?.get() === true,
      root: waveRoot,
    });
    const { mode: fsMode, homeRoot } = snapshotFenceInputs(opts);
    const tmpDir = resolveBashFenceTmp(opts, ctx?.conversationId, () => {
      if (fallbackFenceTmp === undefined) {
        fallbackFenceTmp = mkdtempSync(join(tmpdir(), "iknow-fence-tmp-"));
      }
      return fallbackFenceTmp;
    });
    // Only after the validation chain passes do we choose foreground /
    // background — dangerous-command and sensitive-path gates run on both
    // sides first (background does not bypass security checks).
    if ((input as BashInput | null)?.background === true) {
      // ADR-0097: the background spawn shares the foreground fence
      // construction seam (sandbox discipline G3): `--unshare-net` is
      // always present; egress likewise only via the egress seam.
      // Secret roundtrip: recordCommand keeps the original placeholder-form
      // input.command (placeholders land on disk); command carries the
      // restored real value (used for spawn, never persisted).
      const bgCommand = opts?.secretRegistry
        ? restore(command, opts.secretRegistry)
        : command;
      // The background path shares the same waveRoot as the foreground
      // path: handleBackground passes waveRoot to manager.spawn →
      // defaultBackgroundSpawn builds its createFsPolicy / createBwrapFence
      // around the same root. ADR-0092: the already-frozen fence snapshot
      // is forwarded via BackgroundSpawnRequest — foreground and background
      // fence sets are equal on the fs-mode axis (sandbox discipline G3).
      return await handleBackground(
        {
          finalCommand: bgCommand,
          recordCommand: command,
          cwd: waveRoot,
        },
        opts ?? {},
        ctx,
        { mode: fsMode, homeRoot, tmpDir, unboundMainCheckout },
        effectiveEgressPolicyFactory
      );
    }
    // bashMode="readonly" derives cwdReadonly:true for the fence + env.
    // The bashMode→cwdReadonly mapping is assembled here (the registry
    // only passes bashMode through and does not read the catalog). Either
    // an explicit cwdReadonly true or bashMode==="readonly" triggers it.
    // Default "any" / undefined → no cwdReadonly passed, argv baseline
    // unbroken.
    const fenceIsReadonly =
      opts?.cwdReadonly === true || opts?.bashMode === "readonly";
    const fenceEnv = {
      ...applyCwdReadonlyFenceEnv(
        envIsolation.filter(process.env),
        fenceIsReadonly
      ),
      // ADR-0092: the session tmp host path is the draft location; guest Linux
      // `/tmp` is never bound to it, so `$TMPDIR` names the real path.
      TMPDIR: tmpDir,
    };
    // Restore placeholders before building the fence — the restored command
    // is the text actually spawned into bwrap. The original command (with
    // placeholders) is the only form seen in tool-call records / model
    // context; the model never sees the restored command, only the bash
    // stdout output.
    const finalCommand = opts?.secretRegistry
      ? restore(command, opts.secretRegistry)
      : command;
    // fsPolicy per-call rebuild — `tmpDir` is frozen at factory time, only
    // the cwd axis follows waveRoot. The policy carries the fs mode (mode
    // field) so bwrap can stack the three workspace-mode layers (ADR-0092).
    // fsMode was already snapshotted at handler entry; consumed directly
    // here.
    const fsPolicy = createFsPolicy({ tmpDir, mode: fsMode });
    return runForegroundBash({
      finalCommand,
      command,
      waveRoot,
      fsMode,
      homeRoot,
      tmpDir,
      unboundMainCheckout,
      fsPolicy,
      fenceEnv,
      fenceIsReadonly,
      effectiveEgressPolicyFactory,
      toolOpts: opts,
      ctx,
    });
  };
  return Object.freeze({
    name: "bash",
    description:
      "Run shell commands inside the bwrap sandbox for builds, scripts, or one-shot operations without a dedicated tool; pair with read_file / grep / glob / edit_file / write_file for file work inside the fence. Returns {code, stdout, stderr}; stdout/stderr truncated at 12000 code points per stream. Hard-walls reject obvious destructive patterns and sensitive-path targets before spawn; non-hard-wall commands go through the normal permission flow. For long-running services (http servers, daemons, continuous watchers), set background: true — the call returns {task_id, log_path} immediately and the process keeps running beyond the call, outside the build-tier timeout; then read the log tail with bash_output(task_id, max_bytes?) (default 12 KB, cap 100 KB) and terminate the process group with bash_stop(task_id) (SIGTERM, 2-second grace, then SIGKILL; idempotent). Network egress leaves the fence only through the egress proxy seam: allowed domains pass, everything else is denied with [network_denied], and --unshare-net is always in effect. " +
      FENCE_WRITE_GUIDANCE,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: {
          type: "boolean",
          description:
            "When true, run the command in the background: returns {task_id, log_path} immediately and the process keeps running after the call, managed by the task registry. Use for long-lived servers or daemons; pair with bash_output (read the log) and bash_stop (terminate). Defaults to false (foreground).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "build" as const,
    },
  });
}

/**
 * Per-call inputs of the background branch (secret-roundtrip contract):
 * `recordCommand` is the original placeholder form (for registry JSON on
 * disk); `finalCommand` is the restored real value (lives only in the
 * spawn call stack — the sandbox executes it, never persisted); `cwd` is
 * the waveRoot frozen at handler entry (same source as the foreground
 * fence).
 *
 * ADR-0097: the network axis is constant across foreground and background
 * — the fence always contains `--unshare-net`, egress only via the seam,
 * and `BackgroundSpawnRequest` has no network field.
 */
interface BackgroundSpawnInput {
  readonly finalCommand: string;
  readonly recordCommand: string;
  readonly cwd: string;
}

/**
 * Background branch — manager.spawn starts a detached child and returns
 * {task_id, log_path} immediately. No await on child exit, no runInSandbox
 * (no second fence construction).
 *
 * ctx.conversationId is forwarded in the spawn request — the session that
 * started the process owns the label, and bash_output / bash_stop later
 * scope-filter on the same field. Missing ctx → conversation_id lands as
 * empty string in the record → no filtering (backward compatible, aligned
 * with ADR-0021).
 *
 * Fence inputs (holder mode / homeRoot / tmpDir) come from the handler
 * entry's `FenceSnapshot`; this function never re-reads the cell or holder.
 */
async function handleBackground(
  input: BackgroundSpawnInput,
  opts: CreateBashToolOptions,
  ctx: ToolExecutionContext | undefined,
  { mode: fsMode, homeRoot, tmpDir, unboundMainCheckout }: FenceSnapshot,
  /** ADR-0097: per-call egress policy — closure-derived, approvalGate
   *  already injected. manager.spawn starts the session during assembly;
   *  absent = no seam. */
  effectiveEgressPolicyFactory?:
    (() => EgressPolicyInput | undefined) | undefined
): Promise<{
  task_id: string;
  log_path: string;
  /** Present only in the UNBOUND_FENCE state — background stderr has no
   *  receipt channel, so the read-only physical state is pre-disclosed at
   *  spawn; bound / gate-OFF shapes are byte-identical. */
  notice?: string;
}> {
  const manager = opts.backgroundManager;
  if (!manager) {
    throw new ToolExecutionError(
      "bash: background execution is not available (no background manager configured)"
    );
  }
  const result = await manager.spawn({
    command: input.finalCommand,
    recordCommand: input.recordCommand,
    cwd: input.cwd,
    env: process.env,
    ...(ctx?.conversationId !== undefined
      ? { conversationId: ctx.conversationId }
      : {}),
    // Background path derives cwdReadonly — mirroring the foreground
    // bashMode→cwdReadonly mapping (bash.ts fenceIsReadonly) so foreground
    // and background bwrap argv / fence env are set-equal on the
    // cwdReadonly axis. GIT_OPTIONAL_LOCKS is injected in
    // defaultBackgroundSpawn after the filter (freeze-safe); here we only
    // pass the flag, not the env (the whitelist would strip that key).
    ...(opts.bashMode === "readonly" || opts.cwdReadonly === true
      ? { cwdReadonly: true }
      : {}),
    tmpDir,
    // ADR-0092: workspace-mode fence three layers (foreground and
    // background set-equal, sandbox discipline G3). fsMode is the already
    // snapshotted string; homeRoot / tmpDir are passed by the same closure
    // as the foreground handler (same-source values, no re-reading).
    fsMode,
    homeRoot,
    // ADR-0097: egress seam — policy injected by the caller (registry
    // assembly, derived via `effectiveEgressPolicyFactory`, approvalGate
    // already attached). manager.spawn starts the session during spawn
    // assembly; absent = caller passed no policy = no seam (V1 baseline
    // equivalent). The background path has no ask surface — even with a
    // policy present, the filter records a `no-approval-inlet` violation
    // for hosts not in `allowedDomains` (fail-closed for non-interactive
    // entries).
    ...(effectiveEgressPolicyFactory !== undefined
      ? { egressPolicy: effectiveEgressPolicyFactory() }
      : {}),
    // UNBOUND_FENCE entry-frozen value forwarded to the background fence
    // (foreground/background set-equal on this axis, G3 discipline);
    // tmpPad shares the foreground source = tmpDir.
    ...(unboundMainCheckout !== undefined
      ? {
          unboundFence: {
            mainCheckout: unboundMainCheckout,
            tmpPad: tmpDir,
          },
        }
      : {}),
  });
  if (result.status === "spawn_error") {
    // Consistent with bash's existing error shape: render the typed error
    // (${kind}: ${context}) into a ToolExecutionError so the caller's
    // catch contract is never polluted by [object Object].
    // concurrency_limit_reached carries a positively-worded message
    // (ADR-0021: current state + available actions + zero negative
    // wording); use message instead of context so the model sees an
    // actionable next step; other kinds keep the byte-identical context.
    const detail =
      "message" in result.error && result.error.message
        ? result.error.message
        : result.error.context;
    throw new ToolExecutionError(
      `bash: background spawn failed: ${result.error.kind}: ${detail}`
    );
  }
  return unboundMainCheckout !== undefined
    ? {
        task_id: result.task_id,
        log_path: result.log_path,
        notice: unboundFenceBackgroundNotice(),
      }
    : { task_id: result.task_id, log_path: result.log_path };
}

/**
 * ADR-0084: the recording entry point (decision chain lives here; the
 * handler only forwards).
 *
 * `exitCode !== 0` → nothing was read, no recording. The extractor only
 * accepts "exactly one top-level segment + no redirection/substitution +
 * whitelisted command + exactly one file operand"; anything without an
 * extractable path is not recorded (fail-closed): a missed entry merely
 * costs the model one extra read, a wrong one would let an unread non-empty
 * file be overwritten.
 */
async function recordCompletedRead(
  opts: CreateBashToolOptions | undefined,
  ctx: ToolExecutionContext | undefined,
  call: {
    readonly command: string;
    readonly exitCode: number;
    readonly root: string;
    readonly sessionTmpRoot: string;
  }
): Promise<void> {
  // EXIT: command failed (exit != 0) → nothing was read, no recording.
  if (call.exitCode !== 0) return;
  await recordSingleReadCommand(opts?.lastReadLedger, ctx, call.command, {
    root: call.root,
    sessionTmpRoot: call.sessionTmpRoot,
  });
}

/**
 * ADR-0084: register a successful "read exactly one file" command into the
 * last-read ledger.
 *
 * The extractor (`extractSingleReadPath`) does literal-shape matching only;
 * path resolution happens here — same convention as write_file's
 * `resolveWithinRoot(rootAtCall, …)`, so that the ledger key and the
 * write-side target can actually be equal. Resolution failure (out-of-root
 * / nonexistent path shape) → silently skipped: the ledger gates only
 * "can a non-empty file be overwritten"; a read command must not gain a
 * new failure surface from it.
 */
async function recordSingleReadCommand(
  host: LastReadLedgerHost | undefined,
  ctx: ToolExecutionContext | undefined,
  command: string,
  resolveCtx: { readonly root: string; readonly sessionTmpRoot: string }
): Promise<void> {
  // EXIT: host absent (legacy caller) or no conversationId (no anonymous
  // bucket) → no recording.
  const ledger = host?.ledgerFor(ctx?.conversationId);
  if (ledger === undefined) return;
  // EXIT: not the "unique single-file read" shape (pipe / redirect /
  // output-suppressing flag / in-place edit / recursive / multi-file /
  // non-whitelisted) → no recording (fail-closed).
  const candidate = extractSingleReadPath(command);
  if (candidate === undefined) return;
  let resolved: string;
  try {
    resolved = await resolveWithinRoot(resolveCtx.root, candidate, {
      sessionTmpRoot: resolveCtx.sessionTmpRoot,
    });
  } catch {
    // EXIT: path resolution failed (out-of-root / nonexistent shape) →
    // silently skip; the ledger gates only the non-empty-overwrite check,
    // a read command must not gain a new failure surface from it.
    return;
  }
  ledger.record(resolved);
}

function resolveBashFenceTmp(
  opts: CreateBashToolOptions | undefined,
  conversationId: string | undefined,
  fallback: () => string
): string {
  return (
    resolveSessionFenceTmp({
      tmpDir: opts?.tmpDir,
      projectDir: opts?.projectDir,
      conversationId,
    }) ?? fallback()
  );
}
