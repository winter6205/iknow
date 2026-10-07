/**
 * verify-loop main loop — advisor-layer wrapper around run() implementing the
 * failure auto-correction closed loop.
 *
 * Shape: an advisor wrapping run(), zero engine changes, stop semantics frozen.
 *   - Only StopReason=completed triggers verification;
 *   - the verify command runs in the bwrap sandbox via runVerify (default
 *     assembly identical to the bash tool);
 *   - injection is append-only: the failure envelope is appended to messages as
 *     one user message and replayed as next-round priorMessages; tool_use
 *     pairing is never forged;
 *   - timeout (default 600s) is judged "unstable", not "true failure";
 *   - user abort ends the whole loop, message history follows in-flight closeout;
 *   - exec spawn failure / sandbox rejection → exit=127 → true-failure branch;
 *   - no verify.command and no classifier seam → transparently disabled,
 *     byte-identical to a bare run (backward compatible);
 *   - no verify.command but a classifier seam (runClassifier) is assembled →
 *     the subagent LLM judge rules on task completion: pass → done; fail →
 *     inject the classifier envelope and continue; abort / transport / schema
 *     errors → unstable (fail-open).
 *
 * Dependency direction: consumes only the pure verdict / inject / types layers
 * plus the sandbox base layer. No ACI decoration imports, no settings
 * (configuration arrives via VerifyConfig from the caller).
 *
 * runFn / runVerify dual-seam injection: runFn delegates to run() (tests pass
 * a stub, assembly passes the real closure); runVerify is the verification
 * executor (tests pass scripted fake commands, production defaults to
 * runInSandbox). verify-loop never imports loop-engine deps, keeping testability.
 */
import { randomUUID } from "node:crypto";
import type { WorktreeGateReader } from "../isolation/worktree-gate.js";
import type { HarnessStreamEvent } from "../stream.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  RunResult,
} from "../model-adapter/types.js";
import type { SubagentFailureReason } from "../subagent/envelope.js";
import type { LoopTrace } from "../loop-trace.js";
import type { TraceService } from "../trace/index.js";
import { stampHostInjected } from "../model-adapter/outbound-projection.js";
import { lastTurnQueryIndex, sliceTurnFrom } from "../turn-boundary.js";
import { deriveClaimIndex } from "../last-nonempty-assistant.js";
import {
  checkEvidence,
  editBlockPath,
  shouldTriggerVerify,
} from "./evidence-checker.js";
import { probeVerifyCommand } from "./command-probe.js";
import {
  buildClassifierEnvelope,
  buildEvidenceRerunEnvelope,
  buildNotRunEnvelope,
  buildValidationEnvelope,
  EVIDENCE_RERUN_PREFIX,
  isVerifyInjectedText,
} from "./inject.js";
import {
  parseClassifierResult,
  truncateClassifierOutput,
} from "./classifier.js";
import {
  buildFailureSignature,
  confirmFailure,
  countFailures,
  evaluateTrend,
  type TrendResult,
} from "./verdict.js";
import {
  REASON_ABORT_TYPED,
  REASON_HITL_SKIP_COMPLETION_JUDGE,
  REASON_UNVERIFIED,
  type ClassifierCheck,
  type EvidenceContext,
  type EvidenceReport,
  type EvidenceVerdict,
  type VerificationRecord,
  type Verdict,
  type VerifyConfig,
} from "./types.js";
// Sandbox executor split: RunVerifyFn / makeDefaultRunVerify / runVerifyOnce
// live in sandbox-run.ts; this file only orchestrates decisions (no direct
// sandbox-layer imports).
import {
  makeDefaultRunVerify,
  runVerifyOnce,
  type RunVerifyFn,
} from "./sandbox-run.js";

/** Default verify-command timeout (seconds); a timeout is judged "unstable". */
export const DEFAULT_TIMEOUT_SEC = 600;
/** Default hard round cap; the judge is the trend, not the counter. */
export const DEFAULT_MAX_ROUNDS = 12;
/**
 * Evidence-rerun attempt cap per closed loop. At the cap the loop falls back
 * to the original produceObservation (judge / command mechanisms); 1 gives the
 * model one chance to supply evidence without risking an infinite loop.
 * Not exported: used only inside runVerifyLoopBody.
 */
const RERUN_ATTEMPT_CAP = 1;

/** Return shape of a single run() (what runFn delegates). */
export type RunOutcome = {
  readonly result: RunResult;
  readonly trace: LoopTrace;
};

// RunVerifyFn is re-exported via sandbox-run.ts; keep verify-loop's surface minimal.
export type { RunVerifyFn } from "./sandbox-run.js";

/**
 * Classifier worker reply envelope. The assembly layer adapts SubAgentManager's
 * SubAgentEnvelope to this shape:
 *   - status:"ok" → result carries the judge JSON (parsed by parseClassifierResult);
 *   - status:"failed" → transport error (reason ∈ crashed/timeout/protocolError);
 *     verify-loop converges it to unstable (fail-open) without injecting an envelope.
 * Process isolation is the seam implementation's job; verify-loop only
 * orchestrates, parses, and degrades.
 */
export interface ClassifierEnvelope {
  readonly status: "ok" | "failed";
  /** Judge JSON when status:"ok"; empty string when status:"failed". */
  readonly result: string;
  /** envelope reason union aligned by name with the envelope SSOT (ADR-0111
   *  fifth value modelTransient; failed always fail-opens to unstable as a
   *  transport error — widening the union does not change consumption here). */
  readonly reason?: SubagentFailureReason;
  readonly summary: string;
}

/**
 * Classifier executor — the subagent LLM judge seam used when command is absent.
 * The assembly layer adapts SubAgentManager (process-isolated worker spawn) to
 * this signature:
 *   - production: build SubAgentDefinition → manager.spawn → manager.waitFor →
 *     adapt SubAgentEnvelope to ClassifierEnvelope;
 *   - tests: inject a scripted double.
 * Spawn / envelope protocol / process isolation belong to the seam; verify-loop
 * only orchestrates.
 */
export interface RunClassifierFn {
  (args: {
    readonly task: string;
    readonly summary: string;
    readonly finalText: string | null;
    readonly signal?: AbortSignal;
    readonly cwd: string;
    /**
     * Evidence report card. A separate RunClassifierFn parameter
     * (prompt, not the exam question); must not be concatenated into task.
     * The failure-correction envelope still uses its evidence_context section.
     */
    readonly evidenceContext?: EvidenceContext;
  }): Promise<ClassifierEnvelope>;
}

export interface VerifyLoopOptions {
  /** run() delegate (injectable). runFn decides userText and history-resume semantics. */
  readonly runFn: (
    userText: string,
    opts?: {
      signal?: AbortSignal;
      priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
      onStream?: (event: HarnessStreamEvent) => void;
    }
  ) => Promise<RunOutcome>;
  /** Original userText of the task (reused by every round of the loop). */
  readonly userText: string;
  readonly config: VerifyConfig;
  readonly sessionId: string;
  /** User abort signal; abort ends the whole loop (in-flight closeout). */
  readonly signal?: AbortSignal;
  /** Observation sink (trace-domain VerificationRecord; every round's verdict is persisted, never throws). */
  readonly trace?: TraceService;
  /**
   * Diagnostic sink for the verify route's egress lifecycle faults (session
   * start / release). Absent = silent by caller choice, matching the
   * background manager's `log` convention. Independent of `trace`: the per
   * command row is the durable record; this is the live diagnostic line.
   */
  readonly log?: (message: string) => void;
  /** Test seam for the verification executor; default built internally via runInSandbox (bwrap). */
  readonly runVerify?: RunVerifyFn;
  /**
   * Classifier executor (subagent LLM judge when command is absent). Assembled
   * → classifier fills in; absent + no command → transparently disabled
   * (backward compatible).
   */
  readonly runClassifier?: RunClassifierFn;
  /**
   * Completion-facing judge dispatch.
   *
   // (ADR-0024)
   * `hitl` = skip LLM judge (named EXIT).
   * `goal` = the `/goal` feature's judge module: spawn judge on completed unless hard-fail,
   * including checker SUFFICIENT.
   * Omitted keeps the legacy evidence-first short-circuit (SUFFICIENT skips
   * the judge) so existing classifier unit tests stay on the old path.
   * Values name the goal axis, not PermissionMode: only the goal feature feeds
   * this field, so the word must not read as a permission statement.
   */
  readonly completionMode?: "hitl" | "goal";
  readonly cwd: string;
  /**
   * ADR-0092: fs isolation tier + home ro-bind source for the verify-command
   * fence. Passed through to `makeDefaultRunVerify` (same assembly semantics
   * as the bash tool); absent → global tier (baseline). Type-only import from
   * `sandbox/fs-mode.js` (types only, no runtime dependency — see the
   * "no sandbox-layer imports" discipline above).
   */
  readonly fsMode?: import("../sandbox/fs-mode.js").FsIsolationMode;
  /**
   * ADR-0119 / specs/yolo-mode.md: yolo no-sandbox holder. Passed through to
   * `makeDefaultRunVerify` (read once at assembly via `get()`, same vintage as
   * the bash handler entry's per-call snapshot); under yolo the verify fence takes
   * bare argv and starts no egress session (ADR-0119 ruling 3). Absent / false
   * → today's shape byte-for-byte unchanged (V1 baseline). One deliberate
   * difference from the fsMode value: this passes the **holder**, not the tier
   * value — the default runner rebuilds its closure per round, so the snapshot
   * belongs inside `makeDefaultRunVerify`.
   */
  readonly yolo?: import("../sandbox/yolo.js").YoloContext;
  readonly homeRoot?: string;
  /**
   * worktree-on-mutate holder (read-only view) — passed through to
   * `makeDefaultRunVerify` so the verify fence and the bash tool surface rule
   * identically on the UNBOUND_FENCE axis. Absent → segment not emitted
   * (baseline).
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * ADR-0092: session tmp host path for verify commands — both the in-fence
   * `$TMPDIR` value and the workspace-tier `--bind <tmpRoot>` source (must be
   * the same path). Callers resolve it via
   * `resolveSessionFenceTmp({ projectDir, conversationId })` — the **same**
   * helper as the bash tool surface; never derive a third source here.
   *
   * Absent → the default executor falls back to the process `tmpdir()` (a
   * fallback, not the target state: unwired / test-injection paths). It does
   * **not throw** when session tmp is unavailable — throwing would break
   * verify on hosts lacking projectDir / conversationId, out of this module's
   * scope.
   */
  readonly tmpDir?: string;
  /**
   * Egress proxy seam policy — injected by the caller (hub / chat-session,
   *
   // (ADR-0097)
   * usually derived via `createEgressPolicyFactory`) and passed to
   * `makeDefaultRunVerify` (module-level per-session singleton, lazy-started
   * on the first verify command). Default = no session = no seam (baseline).
   *
   * **Production assembly TODO**: hub / chat-session wiring points still to
   * be connected — this only defines the contract, not the assembly.
   *
   // (ADR-0097)
   */
  readonly egressPolicy?: import("../sandbox/index.js").EgressPolicyInput;
}

export type VerifyLoopOutcome =
  | "passed"
  | "failed"
  | "unstable"
  | "escalated"
  | "aborted"
  | "disabled"
  | "not_run";

export interface VerifyLoopResult {
  /** Final run result (passed, or the last state when the loop stopped). */
  readonly result: RunResult;
  readonly trace: LoopTrace;
  /** Verification rounds (0 = not configured / not triggered on non-completed). */
  readonly rounds: number;
  /** False when config.command is absent (transparently disabled, same as bare run). */
  readonly enabled: boolean;
  readonly outcome: VerifyLoopOutcome;
  /** verify-domain records (same source as what trace persisted). */
  readonly records: ReadonlyArray<VerificationRecord>;
}

/** Trend state (bestFailed / lastFailed / lastSignature), owned by verify-loop. */
interface TrendState {
  bestFailed?: number;
  lastFailed?: number;
  lastSignature?: string;
}

/** Raw per-round observation (roundOutcome), consumed by records / envelopes. */
interface RoundObservation {
  readonly verdict: Verdict;
  readonly exitCode: number;
  readonly failedCount?: number;
  readonly signature?: string;
  /** Initial verification stdout (raw input for the envelope's output_excerpt; truncation is inject's job). */
  readonly outputText: string;
  /**
   * Initial verification stderr. Kept beside stdout because the diagnostic a
   * failing toolchain produces usually lands here; the envelope excerpt joins
   * them (see buildCommandFailureEnvelope) so the model's failure text is not
   * built from stdout alone.
   */
  readonly stderrText?: string;
  /** Classifier branch: the judge's one-line rationale (envelope reason; absent on the command path). */
  readonly reason?: string;
  /** Classifier branch: judge-listed missing items (envelope missing; absent on the command path). */
  readonly missing?: ReadonlyArray<string>;
  /** Classifier branch: evidence the judge ran (persisted + envelope evidence field). */
  readonly evidence?: ReadonlyArray<ClassifierCheck>;
  /** Evidence-first pre-stage: merged into the observation by the body only on
   *  EVIDENCE_INSUFFICIENT rounds; Postel persistence via buildRecord
   *  (SUFFICIENT / CONTRADICTED carry nothing). */
  readonly evidenceVerdict?: EvidenceVerdict;
  readonly gamingSignals?: ReadonlyArray<string>;
  /**
   * Evidence-first pre-stage: present only when the CHECKER wrote this round's
   * verdict itself — the goal-mode EVIDENCE_CONTRADICTED veto, raised before and
   * without the completion-facing judge. Carries the reasons the veto was built
   * from, so the correction envelope can name its real author and narrate that
   * author's own reasons. Deliberately not persisted: the record's Postel shape
   * stays as it is; only the envelope reads who authored it.
   */
  readonly checkerVeto?: { readonly reasons: ReadonlyArray<string> };
}

/** Terminal state of one verification round; aborted = user interrupt during execution. */
type RoundResult =
  | { readonly aborted: true }
  | ({ readonly aborted?: false } & RoundObservation);

/** Loop disposition decision after a single verification round. */
type RoundDecision =
  | {
      readonly kind: "pass";
      readonly recordAction: "stop";
      readonly finalOutcome: "passed";
    }
  | {
      readonly kind: "stop";
      readonly recordAction: "stop";
      readonly finalOutcome: "failed" | "unstable" | "escalated";
    }
  | { readonly kind: "continue"; readonly recordAction: "continue" }
  | { readonly kind: "escalate"; readonly recordAction: "escalate" };

/** Compile countRegex; invalid regex degrades to undefined (built-in failure-line fallback, same discipline as verdict.ts). */
function compileCountRegex(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    // EXIT: invalid regex → undefined, built-in failure-line fallback.
    return undefined;
  }
}

/** {files} extraction: take the first failure line after `|` in the signature `exit=N|...`; bare-exit signature → undefined. */
function extractFiles(signature: string): string | undefined {
  const sep = signature.indexOf("|");
  if (sep < 0) return undefined;
  const files = signature.slice(sep + 1).trim();
  return files.length > 0 ? files : undefined;
}

/* ------------------------------ one verification round (initial + confirmation ladder) ------------------------------ */

/**
 * One verification round: initial run → exit 0 is pass; exit≠0 enters the
 * two-level confirmation ladder (full rerun once → failed-case single rerun
 * once; each level at most once, no recursion). A timeout at any level →
 * unstable (never a true failure); a user abort at any level → aborted.
 */
async function runVerificationRound(opts: {
  readonly command: string;
  readonly runVerify: RunVerifyFn;
  readonly timeoutSec: number;
  readonly signal?: AbortSignal;
  readonly rerunTemplate?: string;
  readonly countRegex?: string;
  /** Observation sink + parentTurnId, passed through runVerifyOnce to persist SandboxCmdRecord. */
  readonly trace?: TraceService;
  readonly parentTurnId: string;
}): Promise<RoundResult> {
  const countRegex = compileCountRegex(opts.countRegex);

  const initial = await runVerifyOnce(opts.runVerify, opts.command, opts);
  if (opts.signal?.aborted) return { aborted: true };
  const { result: initialResult, timedOut: initialTimedOut } = initial;
  const exitCode = initialResult.exitCode;
  const outputText = initialResult.stdout;
  const stderrText = initialResult.stderr;
  const failedCount = countFailures(outputText, countRegex, exitCode);
  const signature = buildFailureSignature({
    exitCode,
    outputText,
    countRegex: opts.countRegex,
  });

  if (initialTimedOut) {
    return {
      verdict: "unstable",
      exitCode,
      failedCount,
      signature,
      outputText,
      stderrText,
    };
  }
  if (exitCode === 0) {
    return { verdict: "pass", exitCode, failedCount, signature, outputText };
  }

  // Confirmation ladder level 1: full rerun (same command, once more).
  const rerun = await runVerifyOnce(opts.runVerify, opts.command, opts);
  if (opts.signal?.aborted) return { aborted: true };
  if (rerun.timedOut) {
    return {
      verdict: "unstable",
      exitCode,
      failedCount,
      signature,
      outputText,
      stderrText,
    };
  }
  const rerunPassed = rerun.result.exitCode === 0;

  // Confirmation ladder level 2: failed-case single rerun (only when rerunTemplate is set and cases are extractable).
  let singleRunPassed: boolean | undefined;
  const rerunTemplate = opts.rerunTemplate;
  const files =
    rerunTemplate !== undefined ? extractFiles(signature) : undefined;
  if (rerunTemplate !== undefined && files !== undefined) {
    const singleCommand = rerunTemplate.replace("{files}", files);
    const single = await runVerifyOnce(opts.runVerify, singleCommand, opts);
    if (opts.signal?.aborted) return { aborted: true };
    if (single.timedOut) {
      return {
        verdict: "unstable",
        exitCode,
        failedCount,
        signature,
        outputText,
        stderrText,
      };
    }
    singleRunPassed = single.result.exitCode === 0;
  }

  const confirmation = confirmFailure({ rerunPassed, singleRunPassed });
  const verdict: Verdict =
    confirmation.verdict === "flaky"
      ? "pass"
      : confirmation.verdict === "unstable"
        ? "unstable"
        : "true-failure";
  return { verdict, exitCode, failedCount, signature, outputText, stderrText };
}

/* ------------------------------ disposition ------------------------------ */

/**
 * Post-round disposition (pure): pass / unstable → stop; true-failure → trend
 * judgment. When the trend allows continuing but the round cap is hit →
 * exhaustion handling: report → stop (honest report); first escalate →
 * inject the escalation directive and extend the budget to maxRounds*2 (the
 * total budget is not reset and the round counter keeps running); exhausting
 * again during the extension → stop (outcome escalated).
 */
function decideRoundAction(args: {
  readonly verdict: Verdict;
  readonly trend: TrendResult;
  readonly round: number;
  readonly maxRounds: number;
  readonly escalated: boolean;
  readonly onExhausted: "report" | "escalate" | undefined;
}): RoundDecision {
  if (args.verdict === "pass") {
    return { kind: "pass", recordAction: "stop", finalOutcome: "passed" };
  }
  if (args.verdict === "unstable") {
    return { kind: "stop", recordAction: "stop", finalOutcome: "unstable" };
  }
  if (args.trend.action === "stop") {
    return { kind: "stop", recordAction: "stop", finalOutcome: "failed" };
  }
  // true-failure + trend allows continuing: backstop round cap.
  const cap = args.maxRounds * (args.escalated ? 2 : 1);
  if (args.round >= cap) {
    if (args.onExhausted === "escalate" && !args.escalated) {
      return { kind: "escalate", recordAction: "escalate" };
    }
    return {
      kind: "stop",
      recordAction: "stop",
      finalOutcome: args.escalated ? "escalated" : "failed",
    };
  }
  return { kind: "continue", recordAction: "continue" };
}

/** Trend-state advance: only rounds allowed to continue update it, and only the first best is kept. */
function updateTrendState(
  trend: TrendState,
  observation: RoundObservation,
  action: "continue" | "stop"
): void {
  if (action !== "continue") return;
  const current = observation.failedCount;
  if (
    trend.bestFailed === undefined ||
    (current !== undefined && current < trend.bestFailed)
  ) {
    trend.bestFailed = current;
  }
  trend.lastFailed = current;
  trend.lastSignature = observation.signature;
}

/* ------------------------------ record & envelope construction ------------------------------ */

/** Build one verify-domain VerificationRecord (field-isomorphic to the trace domain, directly persistable). */
function buildRecord(opts: {
  readonly sessionId: string;
  readonly round: number;
  readonly observation: RoundObservation;
  readonly action: "continue" | "stop" | "escalate";
  readonly finalOutcome?: string;
}): VerificationRecord {
  const { observation, action, finalOutcome } = opts;
  const record: VerificationRecord = {
    id: randomUUID(),
    sessionId: opts.sessionId,
    round: opts.round,
    verdict: observation.verdict,
    exitCode: observation.exitCode,
    ...(observation.failedCount !== undefined
      ? { failedCount: observation.failedCount }
      : {}),
    ...(observation.signature !== undefined
      ? { signature: observation.signature }
      : {}),
    // Classifier-branch fields persist Postel-style (absent on the command path).
    ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
    ...(observation.evidence !== undefined
      ? { evidence: observation.evidence }
      : {}),
    ...(observation.missing !== undefined
      ? { missing: observation.missing }
      : {}),
    // Evidence-first pre-stage fields persist Postel-style (only INSUFFICIENT
    // rounds carry them; short-circuited SUFFICIENT / CONTRADICTED observations
    // lack the fields naturally).
    ...(observation.evidenceVerdict !== undefined
      ? { evidenceVerdict: observation.evidenceVerdict }
      : {}),
    ...(observation.gamingSignals !== undefined
      ? { gamingSignals: observation.gamingSignals }
      : {}),
    action,
    ...(finalOutcome !== undefined ? { finalOutcome } : {}),
    ts: new Date().toISOString(),
  };
  return Object.freeze(record);
}

/**
 * Inject the envelope as a user message (append-only, never fakes tool blocks).
 * ADR-0112: the envelope is a host-injected commit — stamped with a
 * non-model-visible provenance marker. All three injection seams (failure
 * envelope / rerun envelope / escalation directive) share it; the outbound
 * projection passes the official prefix anchor through on stamped frames.
 */
function userTextMessage(text: string): AnthropicNativeMessage {
  const block: AnthropicContentBlock = { type: "text", text };
  return stampHostInjected({
    role: "user",
    content: Object.freeze([block]),
  });
}

/**
 * Whether this is one of the envelopes injected by this loop (prevents stale
 * envelope accumulation). Covers both the [VALIDATION FAILED] correction
 * envelope and the [VERIFY: rerun needed] evidence-rerun envelope.
 */
function isInjectedEnvelope(message: AnthropicNativeMessage): boolean {
  if (message.role !== "user") return false;
  return message.content.some((b) => {
    if (b.type !== "text") return false;
    return isVerifyInjectedText(b.text);
  });
}

/**
 * Rebuild next-round priorMessages: filter previously injected verification
 * envelopes ([VALIDATION FAILED] / [VERIFY: rerun needed]) out of
 * current.result.messages, then append the new injection. Keeps the model
 * from re-reading already-invalidated stale context (history convergence;
 * closeout leaves no stale context behind).
 */
function buildNextPriorMessages(
  current: RunOutcome,
  injected: AnthropicNativeMessage
): ReadonlyArray<AnthropicNativeMessage> {
  const filtered = current.result.messages.filter(
    (m) => !isInjectedEnvelope(m)
  );
  return [...filtered, injected];
}

/**
 * Terminal `not_run` injection (spec: the not-verified case IS returned to the
 * model; the success case is NOT).
 *
 * Delivery seam: the terminal site returns immediately, so unlike every other
 * injection there is no next `runFn` call for `priorMessages` to carry the text
 * into. `result.messages` is instead the durable hand-off — the host persists
 * it verbatim (conditionalSave / the chat REPL) and the next turn seeds
 * `priorMessages` from that same persisted history, so the model reads the
 * envelope on its next turn. Appending (not replacing) keeps the loop's own
 * `result` byte-identical in every other respect: same finalText, same turn
 * list, same trace — only one extra trailing user message.
 *
 * `buildNextPriorMessages` filtering runs on the NEXT round's injection, so a
 * stale copy from an earlier round can never accumulate (same convergence
 * discipline the failure and rerun envelopes rely on).
 *
 * Idempotence: the loop terminates on the first `not_run`, so this site runs at
 * most once; the `filter` is defense-in-depth against a double-append if a
 * future refactor revisits the terminal with the same outcome.
 *
 * Returns `current` UNCHANGED for every other terminal outcome — the `passed`
 * path deliberately injects nothing (the model already knows its own command
 * exited 0, and a success envelope would be noise).
 */
function appendNotRunInjection(
  current: RunOutcome,
  outcome: VerifyLoopOutcome,
  facts: {
    readonly round: number;
    readonly maxRounds: number;
    readonly configCommand: string | undefined;
    /**
     * What this terminal's record says about the evidence. The envelope
     * narrates it, so a CONTRADICTED turn is told about its conflict rather
     * than about a configuration it never lacked.
     */
    readonly evidenceVerdict: EvidenceVerdict | undefined;
    readonly reasons: ReadonlyArray<string>;
  }
): RunOutcome {
  if (outcome !== "not_run") return current;
  const injected = userTextMessage(
    buildNotRunEnvelope({
      round: facts.round,
      maxRounds: facts.maxRounds,
      ...(facts.configCommand !== undefined
        ? { command: facts.configCommand }
        : {}),
      ...(facts.evidenceVerdict !== undefined
        ? { evidenceVerdict: facts.evidenceVerdict }
        : {}),
      reasons: facts.reasons,
    })
  );
  const filtered = current.result.messages.filter(
    (m) => !isInjectedEnvelope(m)
  );
  return {
    ...current,
    result: {
      ...current.result,
      messages: Object.freeze([...filtered, injected]),
    },
  };
}

/** Flag-file candidates for probeVerifyCommand input. */
const PROBE_FLAG_FILES: ReadonlySet<string> = new Set([
  "pyproject.toml",
  "pytest.ini",
  "go.mod",
  "Cargo.toml",
]);

/**
 * Derive rerunAttempted (whether an evidence rerun was already tried) from the
 * message history. The closure cannot reach runVerifyLoopBody's local
 * rerunAttempts (the produceObservation seam signature is frozen), so use an
 * observable trace instead: a user message starting with
 * `[VERIFY: rerun needed]` means the rerun envelope was injected.
 * checkEvidence stays a read-only idempotent scan over the same messages.
 */
function hasRerunEnvelope(
  messages: ReadonlyArray<AnthropicNativeMessage>
): boolean {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      if (block.text.startsWith(EVIDENCE_RERUN_PREFIX)) return true;
    }
  }
  return false;
}

/**
 * Serialize the evidence summary (evidenceSummary data source): one line per
 * run, `command exit=N green=<bool>`. Host-side truncation is the downstream
 * consumer's job (classifier envelope / judge task assembly).
 */
function buildEvidenceSummary(report: EvidenceReport): string {
  if (report.runs.length === 0) return "";
  return report.runs
    .map((r) => `${r.command} exit=${r.exitCode} green=${r.greenSummary}`)
    .join("\n");
}

/**
 * Assemble the EvidenceContext report card. Pure and idempotent: called
 * independently of the body's pre-stage checkEvidence, no side effects.
 *   - checkerVerdict = report.verdict;
 *   - reasons = report.reasons;
 *   - executedCommands = report.runs commands;
 *   - rerunAttempted = derived by scanning messages for the [VERIFY: rerun needed] prefix;
 *   - evidenceSummary = one line per run.
 */
function buildEvidenceContext(
  report: EvidenceReport,
  messages: ReadonlyArray<AnthropicNativeMessage>
): EvidenceContext {
  return {
    checkerVerdict: report.verdict,
    reasons: report.reasons,
    executedCommands: report.runs.map((r) => r.command),
    rerunAttempted: hasRerunEnvelope(messages),
    evidenceSummary: buildEvidenceSummary(report),
  };
}

/**
 * Extract probeVerifyCommand input candidates from message history (prefer
 * real derivation):
 *   - write_file / edit_file tool_use filePath: contributes when it names a
 *     flag file;
 *   - write_file with filePath === "package.json" whose content string starts
 *     with `{`: treated as package.json content (probe parses JSON for
 *     vitest / jest deps);
 *   - other paths / package.json without content: no contribution (probe is
 *     fail-closed).
 * Follows probeVerifyCommand's two-shape contract (path string | JSON content string).
 */
function collectProbeFiles(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  const files: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as AnthropicContentBlock;
      if (b.type !== "tool_use") continue;
      if (b.name !== "write_file" && b.name !== "edit_file") continue;
      const input = b.input as { content?: unknown };
      const filePath = editBlockPath(b.input) ?? "";
      if (filePath.length === 0) continue;
      if (PROBE_FLAG_FILES.has(filePath)) {
        files.push(filePath);
        continue;
      }
      if (
        b.name === "write_file" &&
        filePath === "package.json" &&
        typeof input.content === "string" &&
        input.content.startsWith("{")
      ) {
        files.push(input.content);
      }
    }
  }
  return files;
}

/**
 * Derive the evidence-rerun command (judge-path-only mechanism).
 *
 * The command path (non-empty config.command) already reruns inside the
 * sandbox (frozen legacy): a rerun envelope would be redundant and would
 * break the command-path baseline → no rerun → fall to produceObservation.
 * Only the judge path (empty command) probes via probeVerifyCommand
 * (write_file/edit_file flag files + package.json JSON content).
 *
 * Returns: the unique rerun command | null (no command / conflict / not
 * detected → skip rerun).
 */
function deriveRerunCommand(
  configCommand: string | undefined,
  current: RunOutcome
): string | null {
  const configured = (configCommand ?? "").trim();
  if (configured.length > 0) return null;
  return probeVerifyCommand(collectProbeFiles(current.result.messages));
}

/** Escalation directive (fixed template): forbid repeating the same fix, change approach or report the blocker. */
function buildEscalateMessage(round: number): string {
  return `${round} attempts with the same approach failed. Do not repeat the same fix — re-read the task and take a different approach, or report the blocker explicitly.`;
}

/** Terminal return: the frozen VerifyLoopResult. */
function buildResult(opts: {
  readonly current: RunOutcome;
  readonly records: ReadonlyArray<VerificationRecord>;
  readonly rounds: number;
  readonly enabled: boolean;
  readonly outcome: VerifyLoopOutcome;
}): VerifyLoopResult {
  return Object.freeze({
    result: opts.current.result,
    trace: opts.current.trace,
    rounds: opts.rounds,
    enabled: opts.enabled,
    outcome: opts.outcome,
    records: Object.freeze(opts.records.slice()),
  });
}

/**
 * Loop terminal outcome at a pass/stop exit. A HITL skip of the completion
 * judge (produceObservation's named-reason "pass", reached only with
 * EVIDENCE_INSUFFICIENT / EVIDENCE_CONTRADICTED in hand) ends as an honest
 * not_run: the loop ran, nothing was verified — the loop's terminal
 * vocabulary carries the state instead of only the wire projection. The
 * evidence-backed pass (SUFFICIENT short-circuit / green command round) and
 * every stop outcome keep decision.finalOutcome. The persisted record still
 * carries the skip reason + evidenceVerdict, so
 * projectVerifyHumanView's record-based mapping works for BOTH the new loop
 * terminal and legacy passed+skip records (migration-free rule stands).
 */
function loopTerminalOutcome(
  finalOutcome: "passed" | "failed" | "unstable" | "escalated",
  observation: RoundObservation
): VerifyLoopOutcome {
  if (
    finalOutcome === "passed" &&
    observation.reason === REASON_HITL_SKIP_COMPLETION_JUDGE
  ) {
    return "not_run";
  }
  return finalOutcome;
}

/* ------------------------------ classifier branch (fills in when command is absent) ------------------------------ */

/**
 * One classifier judgment (the command-absent branch executor).
 * Normalization rules:
 *   - user abort → aborted;
 *   - transport error (status:"failed", reason ∈ crashed/timeout/protocolError)
 *     → verdict=unstable, reason=REASON_ABORT_TYPED (the judge's own fault
 *     unifies under abort); no envelope injection (fail-open, never a silent
 *     pass);
 *   - schema error (parseClassifierResult converges to abort) →
 *     verdict=unstable, reason=REASON_ABORT_TYPED, no envelope injection;
 *   - {kind:"unverified"} (judge read the evidence, still insufficient, refuses
 *     to guess PASS/FAIL — the 4th state) → verdict=unstable,
 *     signature="classifier-unverified", reason=REASON_UNVERIFIED, no envelope
 *     injection — strictly distinguished from abort (typed reason persisted);
 *     both take the stop path in decideRoundAction → outcome=unstable;
 *   - {kind:"pass"} → verdict=pass;
 *   - {kind:"fail"} → verdict=true-failure + reason/missing (envelope consumes them).
 */
async function runClassifierOnce(opts: {
  readonly task: string;
  readonly runClassifier: RunClassifierFn;
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly summary: string;
  readonly finalText: string | null;
  /**
   * Evidence report card (assembled inside the produceObservation closure).
   * undefined → the judge gets no evidenceContext and task is byte-identical
   * to userText (compatibility with the existing classifier path).
   */
  readonly evidenceContext?: EvidenceContext;
}): Promise<RoundResult> {
  let envelope: ClassifierEnvelope;
  try {
    envelope = await opts.runClassifier({
      task: opts.task,
      summary: opts.summary,
      finalText: opts.finalText,
      signal: opts.signal,
      cwd: opts.cwd,
      ...(opts.evidenceContext !== undefined
        ? { evidenceContext: opts.evidenceContext }
        : {}),
    });
  } catch {
    // User abort takes priority over transport classification: the seam may
    // reject with AbortError / worker death on Ctrl+C — that must take the
    // in-flight abort closeout (outcome=aborted), never degrade to unstable.
    if (opts.signal?.aborted) return { aborted: true };
    // EXIT: seam throw (not user abort) = transport error → fail-open
    // unstable, no failure-envelope injection (never a silent pass);
    // reason=REASON_ABORT_TYPED (judge's own fault, unified with the schema
    // downgrade, distinguished in persisted typed reasons).
    return {
      verdict: "unstable",
      exitCode: 1,
      signature: "classifier-transport-error",
      outputText: "",
      reason: REASON_ABORT_TYPED,
    };
  }
  if (opts.signal?.aborted) return { aborted: true };
  if (envelope.status === "failed") {
    // EXIT: worker process-level failure (crashed/timeout/protocolError) =
    // transport error → fail-open unstable, no envelope injection;
    // reason=REASON_ABORT_TYPED (as above).
    return {
      verdict: "unstable",
      exitCode: 1,
      signature: "classifier-transport-error",
      outputText: "",
      reason: REASON_ABORT_TYPED,
    };
  }
  // Runtime guarantee: judge output is host-side truncated before parsing (the
  // prompt states no length limit; truncation is actually applied pre-parse,
  // not just a spec grep).
  const parsed = parseClassifierResult(
    truncateClassifierOutput(envelope.result)
  );
  if (parsed.kind === "abort") {
    // EXIT: schema error / judge cannot decide → fail-open unstable, no
    // envelope injection; reason=REASON_ABORT_TYPED (typed reason persisted).
    return {
      verdict: "unstable",
      exitCode: 1,
      signature: "classifier-abort",
      outputText: "",
      reason: REASON_ABORT_TYPED,
    };
  }
  if (parsed.kind === "unverified") {
    // unverified is the judge's honest stop (evidence read, still
    // insufficient, refuses to guess PASS/FAIL), not a judge fault —
    // signature/reason strictly distinguished from abort; likewise takes the
    // decideRoundAction stop path → outcome=unstable, no envelope injection.
    return {
      verdict: "unstable",
      exitCode: 1,
      signature: "classifier-unverified",
      outputText: "",
      reason: REASON_UNVERIFIED,
    };
  }
  if (parsed.kind === "pass") {
    return {
      verdict: "pass",
      exitCode: 0,
      signature: undefined,
      outputText: "",
    };
  }
  // true classifier fail: inject the envelope and continue; failure-signature
  // semantics parallel to the command path.
  return {
    verdict: "true-failure",
    exitCode: 1,
    failedCount: 1,
    signature: parsed.reason,
    outputText: "",
    reason: parsed.reason,
    missing: parsed.missing,
    evidence: parsed.evidence,
  };
}

/* ------------------------------ main loop (shared by command & classifier) ------------------------------ */

/**
 * Per-iteration pre-round exits, evaluated in order on the current round's
 * state: user abort, non-completed stop reason, and the upstream content
 * gate. Returns undefined when the round may proceed.
 */
function preRoundExit(opts: {
  readonly current: RunOutcome;
  readonly turnMessages: ReadonlyArray<AnthropicNativeMessage>;
  readonly records: ReadonlyArray<VerificationRecord>;
  readonly round: number;
  readonly signal: AbortSignal | undefined;
}): VerifyLoopResult | undefined {
  if (opts.signal?.aborted) {
    return buildResult({
      current: opts.current,
      records: opts.records,
      rounds: opts.round,
      enabled: true,
      outcome: "aborted",
    });
  }
  // Only StopReason=completed triggers verification; everything else passes through.
  if (opts.current.result.stopReason !== "completed") {
    const outcome: VerifyLoopOutcome =
      opts.current.result.stopReason === "cancelled" ? "aborted" : "failed";
    return buildResult({
      current: opts.current,
      records: opts.records,
      rounds: opts.round,
      enabled: true,
      outcome,
    });
  }
  // Upstream content gate (pre-stage, re-evaluated every round on the current
  // round's turn slice — a round-2 edit is seen): a turn without a usable
  // content signal never enters the verify
  // subsystem, even when verify.command is configured. The no-op result is
  // the disabled path's exact shape, byte-identical to an unconfigured
  // bare run; round 1's runFn already ran, so result is the model's real
  // output.
  if (!shouldTriggerVerify({ messages: opts.turnMessages })) {
    return buildResult({
      current: opts.current,
      records: [],
      rounds: 0,
      enabled: false,
      outcome: "disabled",
    });
  }
  return undefined;
}

/**
 * The loop body (shared by the command and classifier branches).
 * Differences are parameterized by two seams:
 *   - produceObservation: one-round verification output (runVerificationRound vs runClassifierOnce);
 *   - buildFailureEnvelope: failure envelope text (buildValidationEnvelope vs buildClassifierEnvelope).
 * Round model / trend judgment / maxRounds backstop / escalate / abort closeout
 * are isomorphic across branches — the classifier is just another verification
 * executor of the same advisor.
 */
async function runVerifyLoopBody(opts: {
  readonly options: VerifyLoopOptions;
  readonly maxRounds: number;
  readonly sessionId: string;
  readonly produceObservation: (
    round: number,
    current: RunOutcome,
    turnMessages: ReadonlyArray<AnthropicNativeMessage>
  ) => Promise<RoundResult>;
  readonly buildFailureEnvelope: (
    round: number,
    maxRounds: number,
    observation: RoundObservation
  ) => string;
}): Promise<VerifyLoopResult> {
  const { options } = opts;
  const records: VerificationRecord[] = [];
  const trend: TrendState = {};
  let escalated = false;
  /** Evidence-rerun attempt counter (cap-based; local state beside trend/escalated). */
  let rerunAttempts = 0;
  let current = await options.runFn(options.userText, {
    signal: options.signal,
  });
  // The judged turn's boundary, read once here: `result.messages` is seeded
  // from `priorMessages`, so an earlier turn's green run sits before this index
  // and must neither open this turn's gate nor stand as this turn's evidence.
  // Not re-read per round: each continuation appends the loop's own envelope and
  // run()'s re-appended task text, both of which read as queries, so a re-scan
  // would walk the boundary forward mid-loop and cut this turn's earlier
  // evidence (and its gate signal) off. Rounds only grow the tail, so
  // re-slicing from this index is the same turn seen later. A negative index is
  // kept: with no query there is no turn to judge, and sliceTurnFrom collapses
  // that to the empty array (fail-closed) rather than scanning all history.
  const turnStart = lastTurnQueryIndex(current.result.messages);
  let round = 0;

  while (true) {
    // The one array this observation judges: the gate and both checker sites get
    // this same slice, so claimIndex and the evidence window share its
    // coordinates (claimIndex is slice-relative, not history-relative).
    const turnMessages = sliceTurnFrom(current.result.messages, turnStart);
    const exit = preRoundExit({
      current,
      turnMessages,
      records,
      round,
      signal: options.signal,
    });
    if (exit !== undefined) return exit;

    round += 1;
    // Evidence-first pre-stage: before each round's produceObservation run
    // checkEvidence on the same turn slice the gate judged; three-state mapping:
    //   EVIDENCE_SUFFICIENT → PASS short-circuit (zero judge, zero rerun, even
    //     when a command is configured);
    //     exception: completionMode === "goal" and command empty → still spawn
    // (ADR-0024)
    //     the completion-facing judge (judged even on success; the command
    //     sandbox loop stays out of this);
    //   EVIDENCE_CONTRADICTED → goal feature (completionMode goal) / omitted:
    //     true-failure (enters correction round);
    // (ADR-0073)
    //     HITL: same EXIT as INSUFFICIENT (skip the completion-facing judge,
    //     no true-failure, no rerun/rebuke of the working model; HITL persists
    //     evidenceVerdict for the human-readable projection);
    //   EVIDENCE_INSUFFICIENT → fall to the original produceObservation (judge /
    //     command mechanisms), merging evidenceVerdict + gamingSignals into
    //     this round's observation (Postel persistence via buildRecord).
    //     SUFFICIENT and goal-mode CONTRADICTED do not persist evidenceVerdict.
    const evidenceReport = checkEvidence({
      messages: turnMessages,
      claimIndex: deriveClaimIndex(turnMessages),
    });
    let pendingEvidence:
      | {
          readonly evidenceVerdict: EvidenceVerdict;
          readonly gamingSignals: ReadonlyArray<string>;
        }
      | undefined;
    let observation: RoundResult;
    const goalJudgeOnSufficient =
      options.completionMode === "goal" &&
      (options.config.command ?? "").trim() === "";
    if (
      evidenceReport.verdict === "EVIDENCE_SUFFICIENT" &&
      goalJudgeOnSufficient
    ) {
      observation = await opts.produceObservation(round, current, turnMessages);
    } else if (evidenceReport.verdict === "EVIDENCE_SUFFICIENT") {
      observation = {
        verdict: "pass",
        exitCode: 0,
        outputText: "",
      };
    } else if (evidenceReport.verdict === "EVIDENCE_CONTRADICTED") {
      if (options.completionMode === "hitl") {
        // EXIT: HITL CONTRADICTED consumes like INSUFFICIENT — skip
        // completion judge, no true-failure, no extra worker/rerun round.
        // Persist evidenceVerdict so human projection can hide the
        // "verification passed" banner (Postel still omits the verdict on
        // goal-mode true-failure / SUFFICIENT).
        observation = await opts.produceObservation(
          round,
          current,
          turnMessages
        );
        pendingEvidence = {
          evidenceVerdict: "EVIDENCE_CONTRADICTED",
          gamingSignals: evidenceReport.gamingSignals,
        };
      } else {
        observation = {
          verdict: "true-failure",
          exitCode: 1,
          signature: buildFailureSignature({
            exitCode: 1,
            outputText: evidenceReport.reasons.join("\n"),
            countRegex: undefined,
          }),
          outputText: "",
          // The checker raised this veto; the completion-facing judge never ran.
          // Authorship travels with the verdict so the correction envelope names
          // the checker and quotes these reasons instead of inventing a judge
          // line for a judge that was never asked.
          checkerVeto: { reasons: evidenceReport.reasons },
        };
      }
    } else {
      // Evidence-rerun envelope (judge-path-only mechanism): INSUFFICIENT +
      // deriveRerunCommand non-null (command empty and probeVerifyCommand hit)
      // and rerunAttempts below cap → inject the rerun envelope → one run()
      // continuation (rerunAttempts += 1) → next round re-enters the evidence
      // check. The command path (non-empty config.command) never reruns here:
      // it falls straight to produceObservation's sandbox rerun (frozen legacy,
      // never overlap the command baseline). Once the cap is spent, fall to
      // the original produceObservation — no unbounded reruns (single-attempt
      // cap is hard-coded, not a config field).
      if (rerunAttempts < RERUN_ATTEMPT_CAP) {
        const rerunCommand = deriveRerunCommand(
          options.config.command,
          current
        );
        if (rerunCommand !== null) {
          rerunAttempts += 1;
          current = await options.runFn(options.userText, {
            signal: options.signal,
            priorMessages: buildNextPriorMessages(
              current,
              userTextMessage(
                buildEvidenceRerunEnvelope({
                  round,
                  maxRounds: opts.maxRounds,
                  reasons: evidenceReport.reasons,
                  command: rerunCommand,
                })
              )
            ),
          });
          continue;
        }
      }
      observation = await opts.produceObservation(round, current, turnMessages);
      pendingEvidence = {
        evidenceVerdict: "EVIDENCE_INSUFFICIENT",
        gamingSignals: evidenceReport.gamingSignals,
      };
    }
    // Merge evidenceVerdict for INSUFFICIENT + HITL CONTRADICTED skip rounds
    // (Postel: short-circuited SUFFICIENT / goal-mode CONTRADICTED carry
    // nothing, so buildRecord never persists it).
    if (pendingEvidence !== undefined) {
      observation = {
        ...observation,
        ...pendingEvidence,
      };
    }
    if (observation.aborted) {
      return buildResult({
        current,
        records,
        rounds: round,
        enabled: true,
        outcome: "aborted",
      });
    }

    // Trend judgment (the trend is the judge, not the counter); when allowed
    // to continue, update state first, then decide disposition.
    const trendResult = evaluateTrend({
      currentFailed: observation.failedCount,
      bestFailed: trend.bestFailed,
      lastFailed: trend.lastFailed,
      currentSignature: observation.signature ?? "",
      lastSignature: trend.lastSignature,
    });
    updateTrendState(trend, observation, trendResult.action);

    const decision = decideRoundAction({
      verdict: observation.verdict,
      trend: trendResult,
      round,
      maxRounds: opts.maxRounds,
      escalated,
      onExhausted: options.config.onExhausted,
    });
    // finalOutcome exists only on terminal rounds (pass/stop); continue/escalate rounds carry none.
    const finalOutcome =
      decision.kind === "pass" || decision.kind === "stop"
        ? decision.finalOutcome
        : undefined;
    records.push(
      buildRecord({
        sessionId: opts.sessionId,
        round,
        observation,
        action: decision.recordAction,
        ...(finalOutcome !== undefined ? { finalOutcome } : {}),
      })
    );
    void options.trace?.recordVerification(records[records.length - 1]!);

    if (decision.kind === "pass" || decision.kind === "stop") {
      const terminalOutcome = loopTerminalOutcome(
        decision.finalOutcome,
        observation
      );
      return buildResult({
        current: appendNotRunInjection(current, terminalOutcome, {
          round,
          maxRounds: opts.maxRounds,
          configCommand: options.config.command,
          // The record's own evidence fact and the reasons behind it, both in
          // scope at this terminal: `observation` carries the verdict the
          // pre-stage merged in, `evidenceReport` the checker's reasons.
          evidenceVerdict: observation.evidenceVerdict,
          reasons: evidenceReport.reasons,
        }),
        records,
        rounds: round,
        enabled: true,
        outcome: terminalOutcome,
      });
    }
    if (decision.kind === "escalate") {
      escalated = true;
      current = await options.runFn(options.userText, {
        signal: options.signal,
        priorMessages: buildNextPriorMessages(
          current,
          userTextMessage(buildEscalateMessage(round))
        ),
      });
      continue;
    }

    // Normal continuation: inject the verification-failure envelope
    // (append-only) so the next run() round carries it. priorMessages go
    // through buildNextPriorMessages to filter stale envelopes — history
    // convergence.
    const envelope = opts.buildFailureEnvelope(
      round,
      opts.maxRounds,
      observation
    );
    current = await options.runFn(options.userText, {
      signal: options.signal,
      priorMessages: buildNextPriorMessages(current, userTextMessage(envelope)),
    });
  }
}

/** Command-path observation producer: sandbox verification + confirmation ladder (runVerificationRound). */
function produceCommandObservation(opts: {
  readonly options: VerifyLoopOptions;
  readonly command: string;
  readonly runVerify: RunVerifyFn;
  readonly timeoutSec: number;
}): (round: number, current: RunOutcome) => Promise<RoundResult> {
  const { options, command, runVerify, timeoutSec } = opts;
  return async (round, current) => {
    // parentTurnId: the completed turn that triggered this verification round —
    // stringified turnIndex of the last turn in the previous run (trace-domain
    // TurnRecord has no separate id; turnIndex is the only stable anchor).
    // Only completed reaches here, so the last turn is the triggering one.
    const lastTurn = current.trace.turns[current.trace.turns.length - 1];
    const parentTurnId =
      lastTurn !== undefined ? String(lastTurn.turnIndex) : `round-${round}`;
    return runVerificationRound({
      command,
      runVerify,
      timeoutSec,
      signal: options.signal,
      rerunTemplate: options.config.rerunTemplate,
      countRegex: options.config.countRegex,
      trace: options.trace,
      parentTurnId,
    });
  };
}

/**
 * The envelope's `output_excerpt`: the command's stdout plus its stderr.
 *
 * A failing toolchain usually speaks on stderr, so an excerpt built from stdout
 * alone can hand the model an empty failure and no cause to fix. Byte-identical
 * to stdout when the command wrote nothing to stderr (Postel — every envelope
 * byte pinned by existing tests is unchanged).
 */
function buildOutputExcerpt(
  stdout: string,
  stderr: string | undefined
): string {
  const trimmed = stderr?.trim() ?? "";
  if (trimmed.length === 0) return stdout;
  return stdout.length > 0 ? `${stdout}\n${trimmed}` : trimmed;
}

/** Command-path failure envelope: buildValidationEnvelope with all command fields. */
function buildCommandFailureEnvelope(opts: {
  readonly command: string;
}): (
  round: number,
  maxRounds: number,
  observation: RoundObservation
) => string {
  const { command } = opts;
  return (round, maxRounds, observation) =>
    buildValidationEnvelope({
      round,
      maxRounds,
      verdict: "true-failure",
      command,
      exitCode: observation.exitCode,
      ...(observation.failedCount !== undefined
        ? { failedCount: observation.failedCount }
        : {}),
      ...(observation.signature !== undefined
        ? { signature: observation.signature }
        : {}),
      outputExcerpt: buildOutputExcerpt(
        observation.outputText,
        observation.stderrText
      ),
    });
}

/**
 * Command absent + classifier seam assembled → the subagent LLM judge fills
 * in. Runs through runVerifyLoopBody isomorphically with the command path;
 * summary is the completed run's finalText digest (the judge sees "what the
 * model finally claimed", not trace anchors). The caller (runVerifyLoop entry)
 * guarantees runClassifier exists.
 */
function runClassifierLoop(
  options: VerifyLoopOptions & { readonly runClassifier: RunClassifierFn },
  maxRounds: number,
  sessionId: string
): Promise<VerifyLoopResult> {
  const { runClassifier } = options;
  /**
   * evidenceContext derived once and shared between the produceObservation and
   * buildFailureEnvelope closures: produceObservation assembles it,
   * buildFailureEnvelope reads it. Both fire in order within one round
   * (produceObservation → observation → decision → buildFailureEnvelope only
   * on continue), so the shared variable is order-consistent.
   */
  let lastEvidenceContext: EvidenceContext | undefined;
  return runVerifyLoopBody({
    options,
    maxRounds,
    sessionId,
    produceObservation: (_round, current, turnMessages) => {
      if (options.completionMode === "hitl") {
        // EXIT: HITL skips completion-facing LLM; checker already ran.
        return Promise.resolve({
          verdict: "pass" as const,
          exitCode: 0,
          outputText: "",
          reason: REASON_HITL_SKIP_COMPLETION_JUDGE,
        });
      }
      const summary = current.result.finalText ?? "";
      // Reuse the evidence-first pre-stage's report (checkEvidence is pure and
      // idempotent; the second call is independent and side-effect-free; it
      // receives the pre-stage's own turn slice, so its claimIndex is the same
      // coordinate).
      const report = checkEvidence({
        messages: turnMessages,
        claimIndex: deriveClaimIndex(turnMessages),
      });
      lastEvidenceContext = buildEvidenceContext(
        report,
        current.result.messages
      );
      return runClassifierOnce({
        task: options.userText,
        runClassifier,
        signal: options.signal,
        cwd: options.cwd,
        summary,
        finalText: current.result.finalText,
        evidenceContext: lastEvidenceContext,
      });
    },
    buildFailureEnvelope: (round, maxRounds, observation) => {
      // Authorship is a fact about this round's observation, never a default:
      // the checker veto names the checker and quotes its own reasons; anything
      // else reaching this builder came from the completion-facing judge (the
      // command path renders buildValidationEnvelope, not this one).
      const veto = observation.checkerVeto;
      return buildClassifierEnvelope({
        round,
        maxRounds,
        source: veto !== undefined ? "checker" : "classifier",
        task: options.userText,
        reason:
          veto !== undefined
            ? veto.reasons.join("; ")
            : (observation.reason ?? "classifier reported failure"),
        missing: observation.missing ?? [],
        // Failure-correction envelope carries the evidence_context section
        // (Postel: undefined → envelope bytes unchanged, section omitted). On a
        // checker veto the judge never ran this round, so the shared context is
        // either absent or the PREVIOUS round's report — quoting a stale
        // checker_verdict under a checker-authored headline would be a new
        // inaccuracy, and the veto's own reasons already ride `reason:` above.
        ...(veto === undefined && lastEvidenceContext !== undefined
          ? { evidenceContext: lastEvidenceContext }
          : {}),
      });
    },
  });
}

/**
 * Build makeDefaultRunVerify's assembly args — fs tier trio + egress seam in
 * one place (runVerifyLoop stays pure orchestration).
 *
 * ADR-0092: fs tier + homeRoot + session tmp pass-through (all absent →
 * global tier / process tmpdir, baseline bytes unchanged).
 * Egress seam: module-level per-session singleton, lazy-started on the first
 *
 // (ADR-0097)
 * verify call. **Production assembly TODO**: hub / chat-session wiring still
 * to be connected — this only defines the contract.
 */
function buildVerifyRunnerArgs(options: VerifyLoopOptions): {
  cwd: string;
  fsMode?: VerifyLoopOptions["fsMode"];
  yolo?: VerifyLoopOptions["yolo"];
  homeRoot?: string;
  tmpDir?: string;
  egressPolicy?: VerifyLoopOptions["egressPolicy"];
  worktreeOnMutate?: VerifyLoopOptions["worktreeOnMutate"];
  log?: VerifyLoopOptions["log"];
} {
  return {
    cwd: options.cwd,
    ...(options.fsMode !== undefined ? { fsMode: options.fsMode } : {}),
    ...(options.worktreeOnMutate !== undefined
      ? { worktreeOnMutate: options.worktreeOnMutate }
      : {}),
    ...(options.yolo !== undefined ? { yolo: options.yolo } : {}),
    ...(options.homeRoot !== undefined ? { homeRoot: options.homeRoot } : {}),
    ...(options.tmpDir !== undefined ? { tmpDir: options.tmpDir } : {}),
    ...(options.egressPolicy !== undefined
      ? { egressPolicy: options.egressPolicy }
      : {}),
    // The default runVerify owns the egress session, so its release faults
    // need the host's diagnostic sink — otherwise the only evidence is the
    // command row, and nothing says so when a proxy may still be live.
    ...(options.log !== undefined ? { log: options.log } : {}),
  };
}

export async function runVerifyLoop(
  options: VerifyLoopOptions
): Promise<VerifyLoopResult> {
  const command = (options.config.command ?? "").trim();
  const maxRounds = options.config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const sessionId = options.sessionId;

  // No verify.command → one of two paths:
  //   classifier seam assembled → judge fills in;
  //   not assembled → transparently disabled, single run, byte-identical to a
  //   bare run (backward compatible).
  if (command.length === 0) {
    if (options.runClassifier !== undefined) {
      return runClassifierLoop(
        { ...options, runClassifier: options.runClassifier },
        maxRounds,
        sessionId
      );
    }
    const current = await options.runFn(options.userText, {
      signal: options.signal,
    });
    return buildResult({
      current,
      records: [],
      rounds: 0,
      enabled: false,
      outcome: "disabled",
    });
  }

  const runVerify =
    options.runVerify ?? makeDefaultRunVerify(buildVerifyRunnerArgs(options));
  const timeoutSec = options.config.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  return runVerifyLoopBody({
    options,
    maxRounds,
    sessionId,
    produceObservation: produceCommandObservation({
      options,
      command,
      runVerify,
      timeoutSec,
    }),
    buildFailureEnvelope: buildCommandFailureEnvelope({ command }),
  });
}
