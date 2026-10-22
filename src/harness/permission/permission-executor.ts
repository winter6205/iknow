/**
 * src/harness/permission/permission-executor.ts
 *
 * 5-step middleware executor:
 *
 *   1. preToolUse(call, def)           [hook — may short-circuit; throw → fail-closed]
 *   2. checkPermission({def, input})   [pure resolver: hard-walls → layers → default]
 *   3. askUser({tool, input, hint})    [only when decision = ask]
 *   4. inner.executeAll([call])        [only when decision = allow]
 *   5. postToolUse(result)             [hook — observability only; throw → fire-and-forget]
 *
 * deny → push execution_failed, never call inner (zero side effect).
 * Hook failure semantics: a throwing pre hook is fail-closed
 * (execution_failed + [hook_error], inner untouched, loop continues); a
 * throwing post hook is fire-and-forget (result unchanged, onHookError only).
 *
 * The gate is split so a wave can run its allowed calls before any approval
 * is asked: `prepareOne` runs the gate's non-approval part — the hydrate
 * path and the pre-hook — and stops before the question (an `ask` comes
 * back as `needs_approval`, carrying the decision that asked).
 * `approveOne` re-decides with the CURRENT policy state before asking.
 * `gateOne` is the two in sequence, so the single-call behaviour — one
 * decision, asked inline — is unchanged.
 *
 * The verdict a call is judged by is taken by the caller (the wave scan,
 * right before the wave runs) and handed to `prepareOne`; the gate enforces
 * exactly that verdict on the allow/deny path. The approval path re-decides
 * before the prompt, so the enforced verdict there may differ from the one
 * the caller observed. The ORDER inside one call is therefore: the verdict
 * (taken by the scan) → the hydrate path → the pre-hook → the inner
 * execution. The pre-hook is deny-only
 * (`src/harness/permission/hooks.ts:33-36`), so it can block a call but
 * never change a verdict.
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
  Registry,
  ToolDef,
} from "../tools/types.js";
import type { HarnessStreamEvent } from "../stream.js";
import type { AciCatalog, AciToolDef } from "../aci/types.js";
import { decidePermission, type PermissionPolicy } from "./policy.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";
import type {
  ApprovalOutcome,
  AskUser,
  AskUserOutcome,
  PermissionOutcome,
  PreHookBlock,
  PreToolUseHook,
  PostToolUseHook,
} from "./types.js";
import {
  SECURITY_REVIEW_DENY_PREFIX,
  SECURITY_REVIEW_OPTION,
  type SecurityReviewRequirement,
  type SecurityReviewRoute,
} from "./security-review.js";

// Permission-executor prefixes consumed from the SSOT table. Keeping a local
// const alias preserves the call-site ergonomics (no template-literal drift).
const USER_DENIED_PREFIX = VIOLATION_PREFIXES.userDenied;
const PERMISSION_DENIED_PREFIX = VIOLATION_PREFIXES.permissionDenied;
const HOOK_BLOCKED_PREFIX = VIOLATION_PREFIXES.hookBlocked;
const HOOK_ERROR_PREFIX = VIOLATION_PREFIXES.hookError;
const CANCELLED_RESULT_MESSAGE = "cancelled";

/**
 * Hook-error payload (observation side-channel of the failure semantics
 * above). phase identifies the source:
 *   - "pre" / "post": hook threw (fail-closed / fire-and-forget)
 *   - "guard-init": secrets-guard pattern compile failure
 *   - "user-rule-init": user-hook rule pattern compile failure
 *     (specs/user-hook-router.md — whole rule dropped + warning)
 *   - "plugin-init": plugin hooks.json scan/parse degradation (unreadable
 *     root, invalid JSON, missing hooks key, unknown event, matcher compile
 *     failure)
 *   - "plugin-exec": plugin hook runtime degradation (spawn failure, timeout,
 *     exit code other than 0/2, output truncation, Post exit-2 echo;
 *     fail-open)
 */
export interface HookErrorEvent {
  readonly phase:
    | "pre"
    | "post"
    | "guard-init"
    | "user-rule-init"
    | "plugin-init"
    | "plugin-exec";
  readonly tool?: string;
  readonly message: string;
}

/**
 * Build an AciCatalog from a ToolRegistry by name. The catalog is
 * "ACI-aware" only via category / interruptBehavior / isConcurrencySafe;
 * tools lacking AciMeta are treated as read-only safe-by-default.
 *
 * `get` delegates dynamically to registry.get so mcp__ tools registered
 * after construction (registerExternal) stay visible; `all()` still returns
 * the construction-time snapshot for permission-layer enumeration.
 *
 * ADR-0043 §2 + ADR-0114 §3: the optional `isDiscovered` is the data source
 * for the "called-without-loading" gate — assembly injects
 * AciRegistry.isDiscovered and gateOne routes undiscovered mcp__ calls
 * through the hydrate path (discover + input validation this round →
 * execute or project, see gateOne). The optional `discover` is the hydrate
 * side-effect entry: it adds the name to the discovered set so the next
 * round's visibleSchemas appends its schema.
 *
 * Both absent → the gate passes through (non-ACI assembly paths such as
 * worker subagents or stub tests; byte-stable behavior).
 */
export function createAciCatalog(
  registry: Registry,
  isDiscovered?: (name: string) => boolean,
  discover?: (name: string) => void
): AciCatalog {
  const list = registry.list();
  const byName = new Map<string, AciToolDef>();
  for (const def of list) {
    const aci = (def as { aci?: AciToolDef["aci"] }).aci;
    if (!aci) continue;
    byName.set(def.name, project(def));
  }
  return Object.freeze({
    get: (name: string) => {
      const hit = byName.get(name);
      if (hit !== undefined) return hit;
      // Dynamic fallback: registerExternal tools are not in the snapshot.
      const dynamic = registry.get(name);
      if (!dynamic) return undefined;
      const aci = (dynamic as { aci?: AciToolDef["aci"] }).aci;
      if (!aci) return undefined;
      return project(dynamic);
    },
    all: () => Object.freeze([...byName.values()]) as ReadonlyArray<AciToolDef>,
    ...(isDiscovered ? { isDiscovered } : {}),
    ...(discover ? { discover } : {}),
  });
}

/**
 * ToolDef → AciToolDef projection (SSOT), shared by the construction-time
 * snapshot and the dynamic get fallback so projected fields cannot drift.
 *
 * ADR-0114 §3: `lazy` must survive the projection — gateOne's hydrate
 * decision reads `def.aci.lazy` to recognize retired builtins (no `mcp__`
 * prefix to identify them by name). Written only when `true`, keeping the
 * projection of resident tools byte-identical.
 *
 * The per-call concurrency-safety predicate (`isConcurrencySafeForInput`)
 * must survive the projection too — the wave splitter reads it off the
 * projected def. Written only when present, for the same byte-identical
 * reason as `lazy`.
 */
function project(def: ToolDef): AciToolDef {
  const aci = (def as { aci?: AciToolDef["aci"] }).aci!;
  return Object.freeze({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: def.handler,
    aci: Object.freeze({
      category: aci.category,
      isConcurrencySafe: aci.isConcurrencySafe,
      ...(aci.isConcurrencySafeForInput
        ? { isConcurrencySafeForInput: aci.isConcurrencySafeForInput }
        : {}),
      interruptBehavior: aci.interruptBehavior,
      ...(aci.lazy === true ? { lazy: true as const } : {}),
    }),
  }) as AciToolDef;
}

export interface PermissionExecutorOptions {
  readonly inner: Executor;
  readonly registry: Registry;
  readonly policy: PermissionPolicy;
  readonly askUser: AskUser;
  readonly preToolUse?: PreToolUseHook;
  readonly postToolUse?: PostToolUseHook;
  /** Hook-error observation callback. Default = silent (post) / no warning
   *  channel (pre still fail-closed, just unobserved). */
  readonly onHookError?: (e: HookErrorEvent) => void;
  /**
   * ADR-0043 §2: "already loaded" check — the gate rejects mcp__ calls that
   * were never discovered. build-engine injects `AciRegistry.isDiscovered`;
   * absent = gate passes through (non-ACI assembly or stub tests).
   */
  readonly isDiscovered?: (name: string) => boolean;
  /**
   * ADR-0114 §3: hydrate side-effect entry — the gate calls this for an
   * undiscovered mcp__ tool so the next round's visibleSchemas appends its
   * schema (ACI discipline replicated automatically). Absent → treated as a
   * non-ACI assembly path (handed straight to inner).
   */
  readonly discover?: (name: string) => void;
  /**
   * ADR-0127's end-to-end interactive review route (option name pinned by
   * `SECURITY_REVIEW_OPTION` below). Host entry adapters supply it; a worker
   * without a parent-owned broker and a bare ACI caller without an
   * interactive host do NOT — and an ordinary `askUser` callback is never
   * such a route, however permissive its implementation.
   */
  readonly securityReview?: SecurityReviewRoute;
}

/**
 * Compile-time pin: the options field above must keep the exact name the
 * frozen contract exports, so a rename on either side breaks the build.
 */
const _SECURITY_REVIEW_OPTION_IS_FIELD: typeof SECURITY_REVIEW_OPTION extends keyof PermissionExecutorOptions
  ? true
  : never = true;
void _SECURITY_REVIEW_OPTION_IS_FIELD;

/**
 * What a gate carries about the question that was actually shown
 * (ADR-0147 amendment R1/R3). `approval` is set only by `askGate` — a
 * silent §7 re-decision (admit or deny) shows no question and sets no
 * ending; `redecidedDeny` marks the deny that re-decision produced where the
 * wave scan had judged the call `ask`.
 */
interface ApprovalFields {
  readonly approval?: { readonly outcome: ApprovalOutcome };
  readonly redecidedDeny?: true;
}

export type PermissionGate = ApprovalFields &
  (
    | { readonly kind: "blocked"; readonly result: ToolExecutionResult }
    | { readonly kind: "proceed"; readonly def: AciToolDef | undefined }
  );

/**
 * The gate's answer BEFORE any approval is requested.
 *
 * `needs_approval` carries the decision that asked, so the caller can prompt
 * with it (and only it) — the wave gate uses this arm to run the allowed
 * calls first and to ask the remaining ones one at a time.
 *
 * No `ApprovalFields` here: `prepareOne` never shows a question and never
 * re-decides, so this answer can carry neither a recorded ending nor a
 * re-decided deny. Those belong to the post-approval gate only.
 */
export type PermissionPrepare =
  | { readonly kind: "blocked"; readonly result: ToolExecutionResult }
  | { readonly kind: "proceed"; readonly def: AciToolDef | undefined }
  | {
      readonly kind: "needs_approval";
      readonly def: AciToolDef;
      readonly outcome: PermissionOutcome;
    };

/**
 * The approval arm's observation channel (ADR-0147 R1): the wave's
 * conversation and its stream listener, so a shown question is emitted as a
 * call-addressed event. Absent → no events (a caller with no host stream).
 */
export interface ApprovalContext {
  readonly conversationId?: string;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}

export interface PermissionRuntime {
  readonly executor: Executor;
  readonly gateOne: (
    call: ToolCall,
    signal?: AbortSignal
  ) => Promise<PermissionGate>;
  /**
   * The gate's non-approval part: the hydrate path and the pre-hook —
   * WITHOUT asking. `decision` is the caller's already computed verdict; it
   * is the verdict the gate enforces. Absent, the gate computes one itself.
   */
  readonly prepareOne: (
    call: ToolCall,
    decision?: PermissionOutcome
  ) => Promise<PermissionPrepare>;
  /**
   * The approval arm: re-decide with the CURRENT policy state (a session
   * grant an earlier "always allow" answer added is visible here), then
   * proceed without prompting, block with the deny shape, or ask. `ctx`
   * carries the wave's conversation and stream listener so a shown question
   * is emitted as a call-addressed event pair.
   */
  readonly approveOne: (
    call: ToolCall,
    def: AciToolDef,
    signal?: AbortSignal,
    ctx?: ApprovalContext
  ) => Promise<PermissionGate>;
  readonly runAllowed: (
    call: ToolCall,
    def: AciToolDef | undefined,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    turnId?: string,
    onStream?: (event: HarnessStreamEvent) => void,
    messages?: ToolExecutionContext["messages"],
    parentThinking?: ToolExecutionContext["parentThinking"],
    parentModelRoute?: ToolExecutionContext["parentModelRoute"]
  ) => Promise<ToolExecutionResult>;
}

/**
 * Factory for the permission-middleware Executor. Per-call rules:
 *  - catalog miss → delegate to inner one call at a time.
 *  - hook_blocked → execution_failed with [hook_blocked] prefix.
 *  - deny → execution_failed [permission_denied] prefix, inner not called.
 *  - ask → await askUser; false → execution_failed [user_denied] prefix.
 *  - allow → inner.executeAll([call]) and return its single result.
 *
 * gateOne / runAllowed are split so the ACI layer can gate serially then
 * run inner in parallel. Within one call the order is: the verdict (taken
 * by the caller, the wave scan) → hydrate → pre-hook → inner; ACROSS calls
 * it no longer holds: an allowed call's inner may now run while another
 * call's question is pending (ADR-0147).
 */
export function createPermissionRuntime(
  opts: PermissionExecutorOptions
): PermissionRuntime {
  if (!opts.askUser) {
    throw new Error(
      "permission executor: ask_inlet_missing (AskUser implementation is required at construction)"
    );
  }
  const catalog = createAciCatalog(
    opts.registry,
    opts.isDiscovered,
    opts.discover
  );
  const pre: PreToolUseHook = opts.preToolUse ?? (() => undefined);
  const post: PostToolUseHook = opts.postToolUse ?? (() => undefined);
  const askUser = opts.askUser;
  const policy = opts.policy;
  const onHookError = opts.onHookError;
  const reviewRoute = opts.securityReview;
  let reviewRequestCounter = 0;

  /** One `blocked` outcome with an `execution_failed` message. */
  function reviewBlocked(call: ToolCall, message: string): PermissionGate {
    return {
      kind: "blocked",
      result: { kind: "execution_failed", toolUseId: call.id, message },
    };
  }

  /**
   * One `blocked` outcome for a permission DENY — the one shape both the
   * prepare pass and the approval pass build, so the two cannot drift on the
   * prefix or on the reason.
   */
  function denyBlocked(
    call: ToolCall,
    outcome: PermissionOutcome
  ): { readonly kind: "blocked"; readonly result: ToolExecutionResult } {
    return {
      kind: "blocked",
      result: {
        kind: "execution_failed",
        toolUseId: call.id,
        message: `${PERMISSION_DENIED_PREFIX} ${outcome.reason}`,
      },
    };
  }

  /**
   * ADR-0127's executor gate, run INSTEAD of the ordinary ask whenever the
   * outcome carries a review requirement: presence of the end-to-end route —
   * not of an ask callback — is the proof that a question can reach a human.
   * No route → typed deny without ever invoking `askUser` (a permissive
   * callback must not answer a review). Route present → exactly one request
   * for this call, fresh every call and never persisted; a false answer, a
   * throw, or a cancellation all deny with the cause recorded.
   */
  async function reviewGate(
    call: ToolCall,
    def: AciToolDef,
    requirement: SecurityReviewRequirement,
    signal?: AbortSignal
  ): Promise<PermissionGate> {
    const cause =
      `cause=${requirement.cause} ` +
      `span=${String(requirement.span.start)}-${String(requirement.span.end)} ` +
      `(${def.name})`;
    if (reviewRoute === undefined) {
      return reviewBlocked(
        call,
        `${SECURITY_REVIEW_DENY_PREFIX}no interactive security-review route for this call: ${cause}`
      );
    }
    let approved = false;
    try {
      reviewRequestCounter += 1;
      approved = await reviewRoute.request({
        requirement,
        tool: def.name,
        input: call.input,
        summaryHint: summarizeInput(call.input),
        requestId: `${call.id}#review-${String(reviewRequestCounter)}`,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch {
      // EXIT: a failed or disconnected review channel denies this call; the
      // review never falls through to the ordinary inlet either.
      approved = false;
    }
    if (isAborted(signal)) {
      return {
        kind: "blocked",
        result: {
          kind: "execution_failed",
          toolUseId: call.id,
          message: CANCELLED_RESULT_MESSAGE,
        },
      };
    }
    if (!approved) {
      return reviewBlocked(
        call,
        `${SECURITY_REVIEW_DENY_PREFIX}security review not approved for this call: ${cause}`
      );
    }
    return { kind: "proceed", def };
  }

  /**
   * The effective decision for a call: the caller's own verdict when it has
   * one (the wave gate takes the verdict in the wave scan, right before the
   * wave runs), the freshly computed one otherwise.
   */
  function effectiveDecision(
    def: AciToolDef,
    input: unknown,
    decision?: PermissionOutcome
  ): PermissionOutcome {
    if (decision !== undefined) return decision;
    return decidePermission(policy, def, input);
  }

  /**
   * The gate's non-approval part: the hydrate path, the pre-hook and the pure
   * decision — WITHOUT asking. An `ask` decision comes back as
   * `needs_approval` (with the decision that asked), so the caller decides
   * when to prompt.
   *
   * `decision` is the caller's already computed verdict — the one the gate
   * enforces. Absent, the gate computes it through the same
   * `decidePermission` assembly, so the inputs are identical either way.
   */
  async function prepareOne(
    call: ToolCall,
    decision?: PermissionOutcome
  ): Promise<PermissionPrepare> {
    const def = catalog.get(call.name);
    if (!def) return { kind: "proceed", def: undefined };

    // ADR-0114 §3: a direct call to an undiscovered lazy tool → hydrate
    // (discover this round → next round's visibleSchemas appends the
    // schema); if input passes the tool's inputSchema → execute; otherwise
    // return a non-error text projection of {name, description,
    // inputSchema} so the model can fill in the input.
    //   - Trigger = (`mcp__` prefix — MCP tools are inherently lazy even
    //     without aci.lazy) **or** `def.aci.lazy === true` (builtins retired
    //     by schema overflow are stamped lazy by `retireBuiltin`, no name
    //     prefix to recognize them) **and** `isDiscovered` present and
    //     false. The core tools are never lazy (the derivation layer strips
    //     CORE_TOOL_NAMES), so resident tools never enter this branch.
    //   - The gate runs before the pre-hook: hydrate is not a user-permission
    //     question; input validation happens inline (ajv compiled once per
    //     def.inputSchema, WeakMap-cached for later direct calls).
    //   - Missing `catalog.discover` / `catalog.isDiscovered` → gate passes
    //     (non-ACI assembly or stub tests; worker / hub runDeps unaffected).
    if (
      (def.name.startsWith("mcp__") || def.aci.lazy === true) &&
      catalog.isDiscovered !== undefined &&
      !catalog.isDiscovered(def.name)
    ) {
      // Hydrate side effect before input validation: discover fires even for
      // invalid input — the schema must be visible next round before the
      // model can correct the input.
      catalog.discover?.(def.name);
      const validator = getOrCompileValidator(def);
      if (validator(call.input)) {
        return { kind: "proceed", def };
      }
      // Input fails the schema → non-error text projection: hand the schema
      // back explicitly so the model can complete the input (kind "ok", so
      // is_error stays false). The `blocked` arm is prepareOne's three-armed
      // contract: this one is "decided nothing, ran nothing, result passed
      // through" — the hydrate path is not a user-permission question, so no
      // verdict is taken and the caller's verdict is not consulted here.
      return {
        kind: "blocked",
        result: {
          kind: "ok",
          toolUseId: call.id,
          payload: [
            {
              type: "text",
              text: JSON.stringify({
                name: def.name,
                description: def.description,
                inputSchema: def.inputSchema,
              }),
            },
          ],
        },
      };
    }

    let hookDecision: PreHookBlock | undefined;
    try {
      // await covers both sync and async hooks (awaiting a sync hook is
      // free); the existing try/catch also collects async rejections, so
      // fail-closed semantics are unchanged.
      hookDecision = await pre({ tool: def.name, input: call.input });
    } catch (err) {
      const sanitized = errMsg(err, call.input);
      onHookError?.({ phase: "pre", tool: def.name, message: sanitized });
      return {
        kind: "blocked",
        result: {
          kind: "execution_failed",
          toolUseId: call.id,
          message: `${HOOK_ERROR_PREFIX} pre-hook threw: ${sanitized}`,
        },
      };
    }
    if (hookDecision !== undefined) {
      return {
        kind: "blocked",
        result: {
          kind: "execution_failed",
          toolUseId: call.id,
          message: `${HOOK_BLOCKED_PREFIX} ${hookDecision.reason}`,
        },
      };
    }

    const outcome = effectiveDecision(def, call.input, decision);

    if (outcome.decision === "ask") {
      return { kind: "needs_approval", def, outcome };
    } else if (outcome.decision === "deny") {
      return denyBlocked(call, outcome);
    }
    return { kind: "proceed", def };
  }

  /**
   * The full gate for a call that is not coordinated with other calls:
   * prepare, then answer the approval inline. The decision is evaluated ONCE,
   * in the prepare pass, and the same decision is the one the prompt carries.
   */
  async function gateOne(
    call: ToolCall,
    signal?: AbortSignal
  ): Promise<PermissionGate> {
    const prepared = await prepareOne(call);
    if (prepared.kind === "needs_approval") {
      return await askGate(call, prepared.def, prepared.outcome, signal);
    }
    return prepared;
  }

  /**
   * The approval arm of the wave gate: re-decide with the CURRENT policy
   * state before prompting, so an "always allow" answer recorded by an
   * earlier prompt (a tool-scoped session grant) reaches this call and no
   * second question is asked.
   *
   * A fresh `deny` here is the §7 re-decision refusing a call the wave scan
   * had judged `ask`: it carries `redecidedDeny` so the caller can tell the
   * agent that the state changed while the wave ran (ADR-0147 R3).
   */
  async function approveOne(
    call: ToolCall,
    def: AciToolDef,
    signal?: AbortSignal,
    ctx?: ApprovalContext
  ): Promise<PermissionGate> {
    const outcome = decidePermission(policy, def, call.input);
    if (outcome.decision === "ask") {
      return await askGate(call, def, outcome, signal, ctx);
    }
    if (outcome.decision === "deny") {
      return { ...denyBlocked(call, outcome), redecidedDeny: true };
    }
    return { kind: "proceed", def };
  }

  /**
   * The `ask` arm of the gate: a review-required ask is answered ONLY through
   * the route — checked BEFORE `askUser` is invoked, in every mode alike
   * (ADR-0127) — and everything else keeps the ordinary approval flow
   * (abort → deny, inlet failure → deny, explicit decline → `[user_denied]`).
   *
   * ADR-0147 R1/R2: a question that is actually shown is emitted as an
   * `approval_pending` / `approval_resolved` pair (safe-emit: a listener
   * fault never affects the gate), and the ending decides both the result
   * text and the `approval` the returned gate carries. A security review is
   * answered through its own route / inlet (reviewGate), not this one, so it
   * shows no question here and emits no approval event pair; a pre-aborted
   * wait emits nothing either, and neither records an ending.
   */
  async function askGate(
    call: ToolCall,
    def: AciToolDef,
    outcome: PermissionOutcome,
    signal?: AbortSignal,
    ctx?: ApprovalContext
  ): Promise<PermissionGate> {
    if (outcome.securityReview !== undefined) {
      return await reviewGate(call, def, outcome.securityReview, signal);
    }
    if (isAborted(signal)) {
      return cancelledBlocked(call);
    }
    const conversation = conversationField(ctx);
    safeEmit(ctx, {
      type: "approval_pending",
      toolUseId: call.id,
      tool: def.name,
      ...conversation,
    });
    let ending: SettledEnding;
    try {
      const answer = await askUser({
        tool: def.name,
        input: call.input,
        summaryHint: summarizeInput(call.input),
        ...(signal !== undefined ? { signal } : {}),
        toolUseId: call.id,
        ...conversation,
      });
      ending = normalizeAnswer(answer);
    } catch (err) {
      // EXIT: an unavailable approval inlet must deny the call; never allow
      // a tool side effect merely because the user prompt failed.
      ending = { kind: "prompt_failed", cause: errMsg(err, call.input) };
    }
    if (isAborted(signal)) {
      // EXIT: caller cancellation wins over a late answer; AskUser cannot
      // revive a call after the permission wait has been cancelled.
      ending = { kind: "cancelled" };
    }
    safeEmit(ctx, {
      type: "approval_resolved",
      toolUseId: call.id,
      outcome: ending.kind,
    });
    return settledGate(call, def, ending);
  }

  async function runAllowed(
    call: ToolCall,
    def: AciToolDef | undefined,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    turnId?: string,
    onStream?: (event: HarnessStreamEvent) => void,
    messages?: ToolExecutionContext["messages"],
    parentThinking?: ToolExecutionContext["parentThinking"],
    parentModelRoute?: ToolExecutionContext["parentModelRoute"]
  ): Promise<ToolExecutionResult> {
    const [result] = await opts.inner.executeAll(
      [call],
      signal,
      timeoutMs,
      conversationId,
      undefined,
      turnId,
      onStream,
      messages,
      parentThinking,
      parentModelRoute
    );
    const r = result as ToolExecutionResult;
    if (!def) return r;
    const message =
      r.kind === "execution_failed" || r.kind === "validation_failed"
        ? r.message
        : undefined;
    const payload = r.kind === "ok" ? r.payload : undefined;
    const meta = r.kind === "ok" ? r.meta : undefined;
    try {
      // Must await: an un-awaited rejected promise from an async post hook
      // would escape as unhandledRejection. The result is unchanged
      // (fire-and-forget); the rejection just folds into the existing
      // catch → onHookError.
      await post({
        toolUseId: r.toolUseId,
        name: def.name,
        input: call.input,
        kind: r.kind,
        message,
        payload,
        meta,
      });
    } catch (err) {
      onHookError?.({
        phase: "post",
        tool: def.name,
        message: errMsg(err, call.input),
      });
    }
    return r;
  }

  async function executeAll(
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>,
    turnId?: string,
    onStream?: (event: HarnessStreamEvent) => void,
    messages?: ToolExecutionContext["messages"],
    parentThinking?: ToolExecutionContext["parentThinking"],
    parentModelRoute?: ToolExecutionContext["parentModelRoute"]
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const [index, call] of calls.entries()) {
      const gate = await gateOne(call, signal);
      const result =
        gate.kind === "blocked"
          ? gate.result
          : await runAllowed(
              call,
              gate.def,
              signal,
              timeoutMs,
              conversationId,
              turnId,
              onStream,
              messages,
              parentThinking,
              parentModelRoute
            );
      await onSettled?.(result, index);
      out.push(result);
    }
    return out;
  }

  return Object.freeze({
    executor: Object.freeze({ executeAll }),
    gateOne,
    prepareOne,
    approveOne,
    runAllowed,
  });
}

export function createPermissionExecutor(
  opts: PermissionExecutorOptions
): Executor {
  return createPermissionRuntime(opts).executor;
}

/** Compact human-readable summary used as askUser hint (≤ 80 chars). */
function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    if (s.length <= 80) return s;
    return s.slice(0, 77) + "...";
  } catch {
    return "(unserializable input)";
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A shown question's ending; `timeout` and `prompt_failed` keep their detail. */
type SettledEnding =
  | { readonly kind: "approved" }
  | { readonly kind: "declined" }
  | { readonly kind: "timeout"; readonly afterMs: number }
  | { readonly kind: "prompt_failed"; readonly cause: string }
  | { readonly kind: "cancelled" };

/**
 * Normalize the inlet's answer to a typed ending. A bare boolean stays
 * accepted (`true` = approved, `false` = declined), so the TTY / fail-closed
 * / no-ask inlets need no change (ADR-0147 R2).
 */
function normalizeAnswer(answer: boolean | AskUserOutcome): SettledEnding {
  if (typeof answer === "boolean") {
    return { kind: answer ? "approved" : "declined" };
  }
  if (answer.kind === "timeout") {
    return { kind: "timeout", afterMs: answer.afterMs };
  }
  return { kind: answer.kind };
}

/** The blocked gate for a wait that was cancelled before/without an answer. */
function cancelledBlocked(call: ToolCall): PermissionGate {
  return {
    kind: "blocked",
    result: {
      kind: "execution_failed",
      toolUseId: call.id,
      message: CANCELLED_RESULT_MESSAGE,
    },
  };
}

/**
 * The gate for a question that settled: approved proceeds (recording the
 * ending), every other ending blocks with its own text (ADR-0147 R2) and
 * records the ending for the caller's `[approval]` note (R3).
 */
function settledGate(
  call: ToolCall,
  def: AciToolDef,
  ending: SettledEnding
): PermissionGate {
  if (ending.kind === "approved") {
    return { kind: "proceed", def, approval: { outcome: "approved" } };
  }
  return {
    kind: "blocked",
    result: {
      kind: "execution_failed",
      toolUseId: call.id,
      message: endingMessage(def, ending),
    },
    approval: { outcome: ending.kind },
  };
}

/** The distinct `[user_denied]` / `cancelled` text for each non-approved ending. */
function endingMessage(def: AciToolDef, ending: SettledEnding): string {
  switch (ending.kind) {
    case "timeout":
      return `${USER_DENIED_PREFIX} approval timed out after ${String(ending.afterMs / 1000)}s with no answer: ${def.name}`;
    case "prompt_failed":
      return `${USER_DENIED_PREFIX} approval prompt failed (${ending.cause}): ${def.name}`;
    case "declined":
      return `${USER_DENIED_PREFIX} user declined tool call: ${def.name}`;
    default:
      return CANCELLED_RESULT_MESSAGE;
  }
}

/** The `conversationId` field of an approval event / inlet input, when present. */
function conversationField(ctx: ApprovalContext | undefined): {
  conversationId?: string;
} {
  return ctx?.conversationId !== undefined
    ? { conversationId: ctx.conversationId }
    : {};
}

/**
 * Emit a stream event without letting a listener fault reach the gate: the
 * permission decision must not depend on a host observer (ADR-0147 R1).
 */
function safeEmit(
  ctx: ApprovalContext | undefined,
  event: HarnessStreamEvent
): void {
  const listener = ctx?.onStream;
  if (listener === undefined) return;
  try {
    listener(event);
  } catch {
    // EXIT: a stream listener's own failure is not a permission event.
  }
}

/**
 * Sanitized hook-error message: class name + truncated message only, ≤200
 * chars, never echoing raw input (error text must not leak sensitive detail).
 *
 * Any throw is handled (non-Error throws go through String()); the message
 * is hard-truncated at the cap. If the error message embeds the serialized
 * input, the whole embedding is replaced first — truncation alone is not
 * enough, since the sensitive string may sit inside the kept window.
 *
 * The cap reserves room for the wrapper: pre fail-closed prepends
 * `[hook_error] pre-hook threw: `, so the budget is reduced by that prefix
 * length and the assembled message still fits ≤200.
 */
function errMsg(err: unknown, input?: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message.length > 0 ? `${err.name}: ${err.message}` : String(err);
  } else {
    raw = String(err);
  }
  if (input !== undefined) {
    try {
      const serialized = JSON.stringify(input);
      if (serialized.length > 0 && raw.includes(serialized)) {
        raw = raw.split(serialized).join("[input]");
      }
    } catch {
      // Serialization failed (cycles etc.) → keep raw, truncation is the backstop.
    }
  }
  // Static-prefix reserve: fixed cost of `${HOOK_ERROR_PREFIX} pre-hook threw: `.
  const prefixOverhead = HOOK_ERROR_PREFIX.length + " pre-hook threw: ".length;
  const max = 200 - prefixOverhead;
  return raw.length <= max ? raw : raw.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// ADR-0114 §3 — ajv validation for the hydrate direct-call path
// ---------------------------------------------------------------------------

import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

/**
 * Input validation for the hydrate direct-call path: one ajv validator per
 * def.inputSchema, WeakMap-cached by def instance. Independent of the inner
 * executor's validators — this gate validates synchronously while inner
 * still validates asynchronously (the double ajv run on the success path is
 * acceptable: mcp__ tools are lazy and rarely reach this prompt path).
 *
 * `strict: true` and addFormats mirror the aci-registry configuration so
 * existing schemas validate identically.
 */
const HYDRATE_AJV = new Ajv.default({ strict: true, allErrors: true });
addFormats.default(HYDRATE_AJV);
const HYDRATE_VALIDATOR_CACHE = new WeakMap<AciToolDef, ValidateFunction>();

function getOrCompileValidator(def: AciToolDef): ValidateFunction {
  let v = HYDRATE_VALIDATOR_CACHE.get(def);
  if (v !== undefined) return v;
  // Compile failure (invalid inputSchema) throws like in aci-registry; only
  // reachable for dynamic defs never validated at construction — known
  // mcp__ tools were already ajv-compiled via `registerExternal`, so this
  // path reuses rather than re-discovers.
  v = HYDRATE_AJV.compile(def.inputSchema);
  HYDRATE_VALIDATOR_CACHE.set(def, v);
  return v;
}
