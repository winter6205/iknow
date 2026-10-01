import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  fenceScanScope,
  protectedFenceWiring,
} from "../../sandbox/protected-fence-wiring.js";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import {
  commandContainsSensitivePath,
  findDangerousPattern,
} from "../../permission/hard-walls.js";
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
  protectedTargetFenceGuidance,
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
  type ProtectedTargetInventory,
} from "../../sandbox/index.js";
import {
  FS_ISOLATION_MODE_DEFAULT,
  type FsIsolationMode,
  type FsModeContext,
} from "../../sandbox/fs-mode.js";
import type { YoloContext } from "../../sandbox/yolo.js";
// Direct module import (not the `sandbox/index.js` barrel): the EBUSY arm of
// the protected-target feedback is this seam's own consumer, and the barrel's
// re-export list is owned elsewhere.
import { protectedTargetEbusyFenceGuidance } from "../../sandbox/protected-target-feedback.js";
import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  requireBwrap,
  runInSandbox,
} from "../../sandbox/runner.js";
import { restore, type SecretRegistry } from "../../secret-roundtrip/index.js";
import type {
  BackgroundSpawnRequest,
  BackgroundTaskManager,
} from "../../background/manager.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import {
  resolveSessionFenceTmp,
  snapshotBashCleanupRoots,
} from "../../sandbox/fence-tmp.js";
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
import type { CleanupEvidence } from "../../sandbox/cleanup-result.js";
import { NOT_STARTED_CLEANUP } from "../../sandbox/cleanup-result.js";
import type { BashForegroundDeadlineErrorCode } from "../types.js";
import {
  BASH_FOREGROUND_DEADLINE_ERROR_REASONS,
  DEFAULT_FOREGROUND_BASH_TIMEOUT_MS,
} from "../types.js";
import { ToolInputValidationError } from "../../errors.js";

/**
 * The longest deadline a host timer can hold. `setTimeout` stores its delay in
 * a 32-bit signed integer, so anything at or beyond 2^31 ms wraps to ~1 ms and
 * fires almost immediately — the classic "silently clamped to a short timer"
 * failure. Rejecting there is a representation limit, not a runtime policy.
 *
 * One constant for both planes: the background plane validates against the
 * same bound (`MAX_BACKGROUND_TIMEOUT_MS`), so a value the Bash handler accepts
 * is a value the manager can represent.
 */
export const MAX_BASH_TIMEOUT_MS = 2_147_483_647;

/**
 * ADR-0134: a rejected `timeout_ms`.
 *
 * Named variant, not a message: a caller branches on the class (the Executor
 * maps `ToolInputValidationError` by class identity to `kind:
 * "validation_failed"`) or on the `code` field, and never on a substring. It
 * extends `ToolInputValidationError` so the model still sees a
 * `ToolExecutionError` message through the existing sanitizing seam.
 *
 * `cleanup` is `not_started` by construction: this is thrown before any fence
 * is built, any process is spawned or any timer is armed, so there is no
 * process group whose disappearance could be reported — and the field exists
 * so that fact is stated rather than left for the reader to infer.
 */
export class BashTimeoutInputError extends ToolInputValidationError {
  override readonly name: string = "BashTimeoutInputError";
  readonly code: BashForegroundDeadlineErrorCode;
  readonly cleanup: CleanupEvidence;
  constructor(code: BashForegroundDeadlineErrorCode, received: unknown) {
    super(
      `bash: timeout_ms ${BASH_FOREGROUND_DEADLINE_ERROR_REASONS[code]} (received ${renderReceived(received)})`
    );
    this.code = code;
    this.cleanup = NOT_STARTED_CLEANUP;
  }
}

/** How the offending value is echoed back. `JSON.stringify` cannot render a
 *  NaN / Infinity, and a bare `String(...)` would print an empty line for null
 *  and an empty string — both read as "no value was given", which is the one
 *  reading that is wrong. */
function renderReceived(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return Object.prototype.toString.call(value);
}

/**
 * ADR-0134: classify a raw `timeout_ms`.
 *
 * Returns the accepted deadline, or the named code that rejects it. The order
 * matters and is total: a string never reaches the numeric checks, and a
 * non-finite value is reported as such instead of as "not whole" (NaN and
 * Infinity are both non-integer, so checking integrality first would name the
 * wrong cause).
 */
function classifyDeadline(
  value: unknown
): { readonly ok: true; readonly deadlineMs: number } | { readonly ok: false; readonly code: BashForegroundDeadlineErrorCode } {
  if (value === undefined) {
    return { ok: true, deadlineMs: DEFAULT_FOREGROUND_BASH_TIMEOUT_MS };
  }
  if (typeof value !== "number") return { ok: false, code: "not_a_number" };
  if (!Number.isFinite(value)) return { ok: false, code: "not_finite" };
  if (!Number.isInteger(value)) return { ok: false, code: "not_whole" };
  if (value <= 0) return { ok: false, code: "not_positive" };
  if (value > MAX_BASH_TIMEOUT_MS) {
    return { ok: false, code: "unrepresentable" };
  }
  return { ok: true, deadlineMs: value };
}

/**
 * The handler's single entry into `classifyDeadline`: resolve a raw
 * `timeout_ms` to the deadline the run plane enforces, or throw the typed
 * rejection.
 *
 * The throw is deliberately here rather than at the call site so the handler
 * reads as "resolve, then use" and cannot acquire a second validation site
 * later — the two arms (foreground / background) both consume this one value.
 */
function resolveBashDeadline(value: unknown): number {
  const deadline = classifyDeadline(value);
  if (!deadline.ok) throw new BashTimeoutInputError(deadline.code, value);
  return deadline.deadlineMs;
}

interface BashInput {
  readonly command?: unknown;
  /** background?: boolean — defaults to false (foreground, existing path). */
  readonly background?: unknown;
  /**
   * ADR-0134: optional finite runtime budget in milliseconds. Foreground:
   * the invocation's execution deadline (replacing the build tier's 300s).
   * Background with a value: one deadline, frozen at launch and never
   * extended by polling. Background without a value: the persistent-service
   * lifecycle, with no runtime deadline. `unknown` here because the schema is
   * the first validator and a wrong type must fail as a typed input error,
   * not be coerced.
   */
  readonly timeout_ms?: unknown;
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
   * ADR-0119: the `--yolo` no-sandbox mode holder (see `sandbox/yolo.ts`).
   * The handler reads `get() === true` once per call (per-call snapshot, same
   * discipline as `fsMode`); the foreground fence and the background spawn
   * share that one frozen value. Under yolo the fence emits bare argv, the
   * egress seam is skipped entirely (ADR-0119 ruling 3) and the factory
   * skips `requireBwrap` (ruling 5 (requireBwrap timing)). Absent / false → today's
   * shape byte-identical.
   */
  readonly yolo?: YoloContext;
  /**
   * ADR-0092: workspace-mode home ro-bind source host absolute path.
   * Default `homedir()` — same injection shape as `tmpDir` (testable).
   * Production assembly passes it through (build-engine: userHome;
   * worker: the matching sessionRoots field).
   */
  readonly homeRoot?: string;
  /**
   * Name-pattern scan scope (specs/effect-boundary-protection.md "Scan
   * scope"): the workspace directory the fence's name rules enumerate. Frozen
   * at handler entry next to `homeRoot`, so foreground and background share
   * one vintage and both fs modes scan the same root.
   *
   * Production assembly ALWAYS threads the already-resolved session root
   * (build-engine `env.workspaceRoot` via the env SSOT, so a `.env` /
   * `.env.local` configured root rides the same surface as every other
   * per-root consumer). Absent — an unwired / direct-factory caller — falls
   * back to `fenceScanScope(<the factory cwd>)`, never to a raw `process.env`
   * read: the `.env` SSOT is invisible to `process.env`, so such a read would
   * scan a different tree from the one the rest of the session anchors on.
   */
  readonly workspaceRoot?: string;
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
 *
 * `fallbackRoot` is the scan scope for an assembly that threaded no
 * workspaceRoot: the factory's own cwd, resolved through the shared helper
 * (never a raw `process.env` read — the `.env` SSOT lives in
 * `loadIknowEnv`, not in the process environment, so a raw read here would
 * scan `process.cwd()` for a `.env`-configured session).
 */
function snapshotFenceInputs(
  opts: CreateBashToolOptions | undefined,
  fallbackRoot: string
): {
  readonly mode: FsIsolationMode;
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  readonly yolo: boolean;
} {
  return {
    mode: opts?.fsMode?.get() ?? FS_ISOLATION_MODE_DEFAULT,
    homeRoot: opts?.homeRoot ?? homedir(),
    // Frozen here, beside homeRoot, so the foreground fence and the
    // background spawn carry ONE scan-scope vintage.
    workspaceRoot: opts?.workspaceRoot ?? fenceScanScope(fallbackRoot),
    yolo: opts?.yolo?.get() === true,
  };
}

/**
 * Batch-snapshotted fence inputs (frozen at handler entry): fs mode holder
 * / homeRoot / tmpDir / yolo share one vintage — foreground fence and
 * background spawn use the same snapshot; later holder or cell flips
 * cannot leak into the current call.
 */
interface FenceSnapshot {
  readonly mode: FsIsolationMode;
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  readonly tmpDir: string;
  /** UNBOUND_FENCE main checkout frozen at entry (absent = no segment). */
  readonly unboundMainCheckout: string | undefined;
  /** ADR-0119: D2-frozen yolo reading (shared by fence and spawn). */
  readonly yolo: boolean;
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
    workspaceRoot,
    tmpDir,
    unboundMainCheckout,
    yolo,
    fsPolicy,
    fenceEnv,
    fenceIsReadonly,
    effectiveEgressPolicyFactory,
    toolOpts: opts,
    ctx,
    deadlineMs,
  } = args;
  // The protected-fence pair (inventory + credential read mask) is resolved
  // ONCE for this call through the single wiring point, against the
  // entry-frozen homeRoot and workspaceRoot: the fence mount block and the
  // EROFS boundary-refusal feedback consume the same snapshot, so the message
  // can only ever describe a refusal the fence actually enforces.
  const fenceWiring = protectedFenceWiring({
    homeRoot,
    workspaceRoot,
  });
  // start session → build fence → run sandbox → install mask → record
  // ledger → finalize: 6 steps, each an extracted sub-function; this
  // function only orchestrates them in order.
  // ADR-0119 ruling 3: under yolo the egress seam is skipped wholesale — no
  // fence means no netns, so a proxy seam would be meaningless (no session
  // started, no socket bound, no proxy env injected). The non-yolo path is
  // byte-identical (the egress assembly below stays intact).
  const egress =
    yolo === true
      ? {}
      : await startEgressSessionForCall(
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
    yolo,
    egressSession: egress.session,
    fenceWiring,
  });
  const result = await runSandboxDisposingEgress(
    {
      fence,
      cwd: waveRoot,
      signal: ctx?.signal,
      env: fenceEnv,
      maxOutputCodePoints: DEFAULT_MAX_OUTPUT_CODE_POINTS,
      // ADR-0134: the real runtime deadline. It reaches the process plane, so
      // expiry tears the process group down through the existing bounded
      // TERM/grace/KILL route and reports its CleanupEvidence — this is not a
      // frontend wait that returns while the command keeps running.
      deadlineMs: deadlineMs,
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
    // ADR-0119: under yolo the fence is retired, so an EROFS here cannot be
    // the protected-target block refusing — no fence-attributed guidance.
    protectedTargets: yolo === true ? undefined : fenceWiring.protectedTargets,
    // EBUSY arm correlation set: the `/dev/null` masks THIS fence emitted.
    // Under yolo the fence returned bare argv before the boundary block was
    // assembled, so its list is empty by construction and no EBUSY line can
    // match — the same guard, riding the fence's own field rather than a
    // second yolo re-check.
    exactFileMaskPaths: fence.exactFileMaskPaths,
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
  workspaceRoot: string;
  tmpDir: string;
  /** UNBOUND_FENCE main checkout frozen at entry (undefined = no segment). */
  unboundMainCheckout: string | undefined;
  /** ADR-0119: D2-frozen yolo reading (same value foreground and background). */
  yolo: boolean;
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
  /**
   * ADR-0134: this invocation's resolved runtime deadline in milliseconds —
   * the model-supplied value, or `DEFAULT_FOREGROUND_BASH_TIMEOUT_MS` when the
   * model omitted `timeout_ms`. Resolved and validated by the handler before
   * this function is called, so the run path never re-reads raw input.
   */
  deadlineMs: number;
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
  readonly yolo: boolean;
  readonly egressSession: EgressSession | undefined;
  /** PROTECTED_TARGETS pair (inventory + read mask) from the
   *  single wiring point, resolved once at the path entry against the same
   *  entry-frozen homeRoot for the fence mount block AND the EROFS
   *  feedback — one snapshot per call, they can never diverge. */
  readonly fenceWiring: ReturnType<typeof protectedFenceWiring>;
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
    // PROTECTED_TARGETS wiring (T7 write block + T8 credential read mask) —
    // one spread of `protectedFenceWiring`'s bundle, the single wiring point
    // shared by the foreground / background / verify routes (the drift this
    // removes was the review finding; the helper resolves the inventory
    // against the entry-frozen homeRoot). The skip warning stays on the
    // fence factory's default warn channel.
    ...args.fenceWiring,
    // ADR-0119: the fence-retirement switch — the spread-guard keeps the
    // non-yolo opts byte-identical; true makes the fence factory emit bare
    // argv (the egress field above is already short-circuited to absent).
    ...(args.yolo ? { yolo: true } : {}),
    // UNBOUND_FENCE physical segment — use the entry-frozen value, never
    // re-read the holder; pad=tmpDir keeps scratch writes landing (the
    // ADR's ruling point). Inert under yolo: the factory returns before
    // reaching this segment (ADR-0119 Amendment).
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
 * Guard for the protected-target boundary-refusal guidance: only a non-zero
 * exit with an inventory present can produce a message (yolo passes
 * `undefined` — no fence, no fence-attributed message). Covers BOTH refusal
 * arms — the EROFS write refusal and the EBUSY unlink-of-a-mask-point
 * refusal — hence the boundary-level name, not an errno-level one. Extracted
 * to keep `finalizeEgressPath` at its baseline complexity (S5 gate).
 */
function protectedTargetGuidanceForCall(
  protectedTargets: ProtectedTargetInventory | undefined,
  exactFileMaskPaths: readonly string[],
  result: Awaited<ReturnType<typeof runInSandbox>>
): string | undefined {
  if (protectedTargets === undefined || result.exitCode === 0) {
    return undefined;
  }
  const erofs = protectedTargetFenceGuidance(result.stderr, protectedTargets);
  const ebusy = protectedTargetEbusyFenceGuidance(
    result.stderr,
    protectedTargets,
    exactFileMaskPaths
  );
  const messages = [erofs, ebusy].filter(
    (line): line is string => line !== undefined
  );
  // Empty (not "") is the "nothing to annotate" contract: a caller that
  // appends "" would still mutate the stderr with a stray newline.
  return messages.length > 0 ? messages.join("\n") : undefined;
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
  /** Protected-target inventory for the boundary-refusal feedback; the
   *  yolo path passes `undefined` (no fence → no fence-attributed message). */
  readonly protectedTargets: ProtectedTargetInventory | undefined;
  /** The `/dev/null` credential masks this fence emitted — the EBUSY arm's
   *  correlation set. Empty under yolo (the fence never assembled one). */
  readonly exactFileMaskPaths: readonly string[];
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
    protectedTargets,
    exactFileMaskPaths,
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
  // Protected-target boundary refusal: EROFS on a covered path, or EBUSY on
  // a path this fence masked, gets the class-named boundary refusal (ok-
  // envelope stderr channel again: no exit-semantics change, no violation
  // count). Lines resolving to no protected class produce no message — the
  // result stays byte-identical.
  const protectedTargetGuidance = protectedTargetGuidanceForCall(
    protectedTargets,
    exactFileMaskPaths,
    result
  );
  const guidanceLines = [
    f4Guidance,
    erofsGuidance,
    protectedTargetGuidance,
  ].filter((line): line is string => line !== undefined);
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
      // ADR-0134: how this run ended, as two additive fields. A call that
      // finished on its own carries neither, so the model-visible JSON is
      // byte-identical to the pre-ADR-0134 shape for every call no deadline
      // and no teardown touched. `not_started` is withheld for the same
      // reason: it asserts nothing happened, so it is not worth a key on every
      // ordinary call. The states that DO carry a claim (`confirmed_stopped` /
      // `unconfirmed`) are always reported, and are never dropped.
      ...(result.deadline_expired === true
        ? { deadline_expired: true }
        : {}),
      ...(result.cleanup !== undefined &&
      result.cleanup.state !== "not_started"
        ? { cleanup: result.cleanup }
        : {}),
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
  // ADR-0119 §5 (requireBwrap timing ruling): the factory probe is gated on
  // the yolo holder's *initial* value — the yolo assembly path skips it (a
  // host without bwrap must not block assembly; the exit side is covered by
  // the controller's symmetric probe), the non-yolo path is byte-identical
  // (absent / false still fails loud).
  if (opts?.yolo?.get() !== true) requireBwrap();
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
    const bashInput = input as BashInput | null;
    const command = bashInput?.command;
    if (typeof command !== "string" || command.length === 0)
      throw new ToolExecutionError("bash: command must be a non-empty string");
    // ADR-0134: the ONE validation of `timeout_ms`, ahead of every gate that
    // could do work, in `resolveBashDeadline`. A rejected value therefore
    // creates no fence, no egress session, no process, no background registry
    // entry and no timer — the contract is "fails before launch", and this is
    // the only place that can guarantee it. Both the foreground and the
    // background arm read their input from this one result, so the two can
    // never disagree about what a legal value is.
    const deadline = resolveBashDeadline(bashInput?.timeout_ms);
    // ADR-0132/ADR-0133: the per-call root context is resolved HERE, ahead of
    // the dangerous-command gate, because the gate is one of the two consumers
    // ADR-0132 requires to share it with permission admission. Hoisting it
    // above the gate costs nothing on the reject path (both values are cheap
    // reads of already-configured holders) and is what lets the handler answer
    // with the SAME roots the policy answered with — the disagreement the ADR
    // forbids. `resolveBashFenceTmp` is called once and the one value feeds
    // the snapshot, the fence env and the fs policy below.
    const waveRoot: string = opts?.liveTaskRoot
      ? opts.liveTaskRoot.read()
      : cwd;
    const tmpDir = resolveBashFenceTmp(opts, ctx?.conversationId, () => {
      if (fallbackFenceTmp === undefined) {
        fallbackFenceTmp = mkdtempSync(join(tmpdir(), "iknow-fence-tmp-"));
      }
      return fallbackFenceTmp;
    });
    const cleanupRoots = snapshotBashCleanupRoots({ tmpDir, waveRoot });
    if (findDangerousPattern(command, cleanupRoots) !== null)
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
    // ADR-0131: the handler reads the SAME shared classification the
    // permission wall admitted on (`commandContainsSensitivePath` is the
    // `confirmed` arm of `classifySensitivePathEvidence`). It must not
    // re-derive this with a broader rule of its own: a command permission
    // admitted is never rejected here for a sensitive path. An `unresolved`
    // match is deliberately NOT refused at this gate — it has no interactive
    // review route here, and inventing a denial the wall did not reach would
    // price an unresolved question as a confirmed violation.
    if (commandContainsSensitivePath(command))
      throw new ToolExecutionError(
        `bash: command targets a sensitive path: ${command}`
      );
    // The UNBOUND_FENCE decision shares waveRoot's vintage: read the live
    // holder once at entry and freeze — foreground fence / background
    // spawn / EROFS feedback all use this single snapshot; a mid-handler
    // holder flip cannot leak into this call (same snapshot discipline as
    // fsMode).
    const unboundMainCheckout = unboundFenceMainCheckout({
      gateOn: opts?.worktreeOnMutate?.get() === true,
      root: waveRoot,
    });
    const {
      mode: fsMode,
      homeRoot,
      workspaceRoot,
      yolo,
    } = snapshotFenceInputs(opts, cwd);
    // Only after the validation chain passes do we choose foreground /
    // background — dangerous-command and sensitive-path gates run on both
    // sides first (background does not bypass security checks).
    if (bashInput?.background === true) {
      // ADR-0134: omission (undefined) is a deliberate distinction from the
      // 10 s foreground default, so it is read off the raw input, not off the
      // resolved `deadline` — a background job without a value keeps the
      // persistent-service lifecycle and gets no runtime deadline at all.
      return await handleBackground(
        buildBackgroundSpawnInput({
          command,
          timeoutMs: bashInput.timeout_ms as number | undefined,
          cwd: waveRoot,
          secretRegistry: opts?.secretRegistry,
        }),
        opts ?? {},
        ctx,
        {
          mode: fsMode,
          homeRoot,
          workspaceRoot,
          tmpDir,
          unboundMainCheckout,
          yolo,
        },
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
      deadlineMs: deadline,
      waveRoot,
      fsMode,
      homeRoot,
      workspaceRoot,
      tmpDir,
      unboundMainCheckout,
      yolo,
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
      "Run shell commands inside the bwrap sandbox for builds, scripts, or one-shot operations without a dedicated tool; pair with read_file / grep / glob / edit_file / write_file for file work inside the fence. Returns {code, stdout, stderr}; stdout/stderr truncated at 12000 code points per stream. Hard-walls reject obvious destructive patterns and sensitive-path targets before spawn; non-hard-wall commands go through the normal permission flow. For long-running services (http servers, daemons, continuous watchers), set background: true — the call returns {task_id, log_path} immediately and the process keeps running after the call; then read the log tail with bash_output(task_id, max_bytes?) (default 12 KB, cap 100 KB) and terminate the process group with bash_stop(task_id) (SIGTERM, 2-second grace, then SIGKILL; idempotent). Set timeout_ms to give one call a finite runtime budget: a foreground call runs until it finishes or its budget expires (10 seconds when omitted), and a background job is terminated when the budget measured from its launch expires — reading the log or polling status does not extend it, so a job you keep checking still ends on time; a background call without timeout_ms keeps running until you stop it. Network egress leaves the fence only through the egress proxy seam: allowed domains pass, everything else is denied with [network_denied], and --unshare-net is always in effect. Substitution walls read the parsed command, so spelling decides the outcome: `$(...)` and backtick command substitution recurse through the same judgment as the top-level command (`echo $(date)` passes, and an inner command that is denied on its own is denied inside the parentheses), a third nesting level arrives as an ask, `${VAR}` names land in three buckets — a secret-shaped name such as `API_KEY` or `TOKEN` is a hard wall, a base-env name such as `PATH` passes, an unfamiliar name asks — `<(...)` and `>(...)` process substitution recurses for a plain receiver (`diff <(sort a) <(sort b)`) and is a hard wall for an interpreter receiver (`bash <(...)`, `python3 <(...)`), and quoted text is data: single quotes, `#` comments and a quoted heredoc delimiter handed to a text command (`cat <<'EOF'`) carry no wall findings, while an interpreter reading a heredoc has its body judged as code. Use the `<<<SECRET_N>>>` placeholder when a command needs a secret value — the harness restores the real value before spawn, so the placeholder is the form that appears in your call and in the record. Use the redirect-to-file idiom when you want a command's output later or the text runs long: `cmd > $TMPDIR/out.txt`, then read_file / grep that file. Use the fixed-filename idiom when several commands share one artifact: pick one name in the session tmp dir and pass it by path (`sort a.txt > $TMPDIR/a.sorted`, `grep -f $TMPDIR/patterns.txt app.py`), which keeps values in files instead of in shell variables that end with the call. " +
      FENCE_WRITE_GUIDANCE,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
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
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      // ADR-0134: the handler owns this tool's clock now (the validated
      // `timeout_ms`, or the 10 s default), and it enforces it in the process
      // plane. `unbounded` is the honest declaration that the ACI layer adds
      // no second timer above it — a `build` tier would abort a 10-minute
      // `timeout_ms` at 5 minutes, which is the nesting this tier used to
      // impose. Other tools' tiers are untouched.
      timeoutTier: "unbounded" as const,
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
  /** ADR-0134: the validated finite runtime budget, or undefined to keep the
   *  persistent-service lifecycle. Validation happens in the handler before
   *  this value exists, so the manager never sees an unchecked number. */
  readonly timeoutMs?: number;
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
/**
 * ADR-0119 / S5 extraction: assemble the background spawn request — moves
 * the spread-guard branches out of `handleBackground` so the latter stays
 * under the complexity gate (the standing `lint:s5:staged` discipline:
 * extract, never relax). Semantics are byte-identical to the inline form:
 *
 *   - `conversationId` / `cwdReadonly` are #653 T1 + D2 standing fields;
 *   - `yolo` is ADR-0119's D2-frozen reading (spread-guard: absent =
 *     non-yolo, legacy request field set unchanged);
 *   - `unboundMainCheckout` is the UNBOUND_FENCE entry-frozen value
 *     (foreground/background set-equal on this axis, G3 discipline);
 *   - `fsMode` / `homeRoot` are ADR-0092 Round 2's mode surface;
 *   - `egressPolicy` is ADR-0097 / T7's per-call policy (derived via the
 *     caller-injected `effectiveEgressPolicyFactory`).
 *
 * The parameters are already-destructured values (no holder / no cell):
 * this function re-reads no mutable state, matching `FenceSnapshot`'s D2
 * discipline.
 */
function buildBackgroundSpawnRequest(args: {
  readonly input: BackgroundSpawnInput;
  readonly ctx: ToolExecutionContext | undefined;
  readonly cwdReadonly: boolean;
  readonly tmpDir: string;
  readonly fsMode: FsIsolationMode;
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  readonly unboundMainCheckout: string | undefined;
  readonly yolo: boolean;
  readonly effectiveEgressPolicyFactory:
    (() => EgressPolicyInput | undefined) | undefined;
}): BackgroundSpawnRequest {
  const {
    input,
    ctx,
    cwdReadonly,
    tmpDir,
    fsMode,
    homeRoot,
    workspaceRoot,
    unboundMainCheckout,
    yolo,
    effectiveEgressPolicyFactory,
  } = args;
  return {
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
    ...(cwdReadonly ? { cwdReadonly: true } : {}),
    tmpDir,
    // ADR-0092: workspace-mode fence three layers (foreground and
    // background set-equal, sandbox discipline G3). fsMode is the already
    // snapshotted string; homeRoot / tmpDir are passed by the same closure
    // as the foreground handler (same-source values, no re-reading).
    fsMode,
    homeRoot,
    // The name-pattern scan scope, same frozen vintage as homeRoot above —
    // foreground and background materialize over one shared root.
    workspaceRoot,
    // ADR-0119: the D2-frozen yolo reading (spread-guard: absent =
    // non-yolo, legacy request field set unchanged). manager skips the
    // egress session on it; the spawn factory emits bare argv from it.
    ...(yolo ? { yolo: true } : {}),
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
    // ADR-0134: the finite runtime budget, spread-guarded so an omitted
    // timeout_ms reaches the manager as a request with no deadline at all
    // (persistent service), never as a synthesised default.
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
}

/**
 * Assemble the background branch's per-call inputs.
 *
 * ADR-0097: the background spawn shares the foreground fence construction seam
 * (sandbox discipline G3) — `--unshare-net` always present, egress only via
 * the seam. Secret roundtrip: `recordCommand` keeps the original
 * placeholder-form input (placeholders land on disk), `finalCommand` carries
 * the restored real value (used for spawn, never persisted). `cwd` is the
 * waveRoot frozen at handler entry, so the background fence is built around
 * the same root the foreground fence uses (ADR-0092 set-equality, G3).
 *
 * ADR-0134: `timeoutMs` is spread in only when supplied — omission must
 * reach the manager as a request with no deadline at all, never as a
 * synthesised default.
 */
function buildBackgroundSpawnInput(args: {
  readonly command: string;
  readonly timeoutMs: number | undefined;
  readonly cwd: string;
  readonly secretRegistry: SecretRegistry | undefined;
}): BackgroundSpawnInput {
  return {
    finalCommand: args.secretRegistry
      ? restore(args.command, args.secretRegistry)
      : args.command,
    recordCommand: args.command,
    cwd: args.cwd,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  };
}

async function handleBackground(
  input: BackgroundSpawnInput,
  opts: CreateBashToolOptions,
  ctx: ToolExecutionContext | undefined,
  {
    mode: fsMode,
    homeRoot,
    workspaceRoot,
    tmpDir,
    unboundMainCheckout,
    yolo,
  }: FenceSnapshot,
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
  const result = await manager.spawn(
    buildBackgroundSpawnRequest({
      input,
      ctx,
      cwdReadonly: opts.bashMode === "readonly" || opts.cwdReadonly === true,
      tmpDir,
      fsMode,
      homeRoot,
      workspaceRoot,
      unboundMainCheckout,
      yolo,
      effectiveEgressPolicyFactory,
    })
  );
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
  // ADR-0119: under yolo the whole fence retires — the main checkout is never
  // ro-mounted, so the EROFS pre-disclosure would assert a physical state that
  // does not exist. The receipt keeps the bound / gate-OFF shape (no notice
  // key); the worktree-gate axis itself is unchanged.
  return unboundMainCheckout !== undefined && !yolo
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
