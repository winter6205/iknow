import type { AciToolDef } from "../aci/types.js";
import {
  analyzeSecurityReview,
  findSubstitutionAsk,
  hardWalls,
  HARD_WALL_DENY_PREFIX,
  type HardWallId,
  type SubstitutionAsk,
} from "./hard-walls.js";
import { parseForSecurity } from "./shell-parse.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";
import type { SecurityReviewRequirement } from "./security-review.js";
import type { CleanupRootSnapshot } from "./cleanup-roots.js";
import { PATH_TARGET_KEYS } from "./path-target-keys.js";
import type {
  CodeBuiltInPolicySource,
  HardRuleSpec,
  NormalRuleSpec,
  PermissionOutcome,
  PermissionSource,
  ProjectSettingsPolicySource,
  SessionGrantsPolicySource,
  ToolCategory,
} from "./types.js";
import {
  asModeContext,
  type PermissionMode,
  type PermissionModeContext,
} from "./modes.js";

export type CategoryDefault = "allow" | "ask" | "ask+hardwall";

/**
 * ADR-0140 §2: the fence's boundary question as this layer consumes it — given a
 * write target, is it inside what the CURRENT fs isolation tier permits?
 *
 * The authority for that answer is the fence's own single declaration
 * (`sandbox/fs-boundary.ts`); this layer asks and acts on the answer, it does
 * not re-derive the set.
 */
export type FsBoundaryReader = (target: string) => boolean;

export const DEFAULT_BY_CATEGORY: Readonly<
  Record<ToolCategory, CategoryDefault>
> = Object.freeze({
  "read-only": "allow",
  write: "ask",
  execute: "ask",
  collaborate: "ask",
});

function codeBuiltInRules(): ReadonlyArray<NormalRuleSpec> {
  return Object.freeze([
    {
      // `memory_save` writes into the project memory library on the home
      // project tree (`…/projects/<slug>/memory/`), not the user's workspace.
      // memory library, not the user's workspace. Treating it like a generic
      // write tool caused the agent to be fail-closed at every non-interactive
      // inlet (ask / serve, or chat TTY with no prompt available), producing
      // `[user_denied] user declined tool call: memory_save` even when the user
      // never saw a prompt. The project / session layers can still escalate to
      // ask or deny; hard-walls remain un-overrideable.
      id: "code-allow-memory-save",
      match: ({ tool }) => tool === "memory_save",
      decision: "allow",
      reason:
        "code built-in: memory_save writes into the agent memory library, not user workspace",
    },
    {
      // ADR-0085: todo_write is category="write" → defaults to ask, but the
      // read sub-mode only reads and should bypass ask → allow. The rule sits
      // at the code layer; project/session can still escalate to ask/deny,
      // hard-walls remain non-overridable. Match: tool name +
      // input.mode === "read". Non-object input / missing mode / other mode →
      // no match, falls through to the default write → ask (the handler-layer
      // ToolExecutionError stays as defense in depth).
      id: "code-allow-todo-write-read",
      match: ({ tool, input }) =>
        tool === "todo_write" &&
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        (input as { mode?: unknown }).mode === "read",
      decision: "allow",
      reason: "code built-in: todo_write read mode is read-only (bypass ask)",
    },
  ]);
}

export interface PermissionPolicy {
  readonly sources: {
    readonly code: CodeBuiltInPolicySource;
    readonly project?: ProjectSettingsPolicySource;
    readonly session?: SessionGrantsPolicySource;
  };
  readonly hardWalls: ReadonlyArray<HardRuleSpec>;
  readonly defaultByCategory: Readonly<Record<ToolCategory, CategoryDefault>>;
  /** W2: process-level permission mode (default / plan / full_auto). */
  readonly mode: PermissionModeContext;
  /**
   * ADR-0132/ADR-0133: the host's per-call root context, read at the moment a
   * call is judged rather than frozen here, because a `taskRoot` rebind and a
   * `conversationId`-derived scratch both change per call. The host shares ONE
   * snapshot between this admission and the Bash handler, so the two gates
   * cannot disagree about which identity's scratch or which task root the
   * command was measured against.
   *
   * A function rather than a value so `CheckPermissionInput` callers that only
   * hold a policy (the permission runtime, the executor's prediction pass) get
   * the current roots for free, and so an assembly that never wired one leaves
   * every verdict byte-identical.
   */
  readonly hostRoots?: () => CleanupRootSnapshot;
  /**
   * ADR-0140 §2: the same reader, for the fence's writable set — absent → no
   * fs boundary is configured and `full_auto` answers exactly as it did before
   * the seam existed.
   */
  readonly fsBoundary?: FsBoundaryReader;
}

export interface CreatePermissionPolicyOpts {
  readonly project?: ProjectSettingsPolicySource;
  readonly session?: SessionGrantsPolicySource;
  readonly defaultByCategory?: Readonly<Record<ToolCategory, CategoryDefault>>;
  /** W2: Permission mode. Either a static value or a mutable context (REPL
   *  can flip via `/permissions full_auto` without rebuilding the engine). */
  readonly mode?: PermissionMode | PermissionModeContext;
  /**
   * ADR-0132/ADR-0133: the host's root-context reader. Absent → the
   * destructive-rm wall answers exactly as it did before this seam existed,
   * because a cleanup exception is only ever a REMOVAL of a finding and
   * without a root context nothing can establish one.
   */
  readonly hostRoots?: () => CleanupRootSnapshot;
  /**
   * ADR-0140 §2: the host's fence-boundary reader, built at the composition
   * root — the one place allowed to import both the sandbox's boundary
   * derivation and this policy. Absent → no fs boundary is configured and
   * `full_auto` answers exactly as it did before the seam existed.
   */
  readonly fsBoundary?: FsBoundaryReader;
}

/**
 * The `fsBoundary` reader as the optional `checkPermission` field, or nothing
 * at all when the assembly wired none. ONE helper for the field, read by the
 * policy factory, the permission executor's gate and the executor's prediction
 * pass: `{}` reaches `checkPermission` as a missing field, not as a reader that
 * could only answer "outside" — the difference between "no boundary is
 * configured" and "a boundary with an empty set", which ADR-0140 §2 would
 * otherwise have to tell apart three times over.
 */
export function fsBoundaryOption(
  source: { readonly fsBoundary?: FsBoundaryReader | undefined } | undefined
): { readonly fsBoundary?: FsBoundaryReader } {
  if (source?.fsBoundary === undefined) return {};
  return { fsBoundary: source.fsBoundary };
}

export function createPermissionPolicy(
  opts?: CreatePermissionPolicyOpts
): PermissionPolicy {
  return Object.freeze({
    sources: Object.freeze({
      code: Object.freeze({
        kind: "code" as const,
        rules: codeBuiltInRules(),
      }),
      ...(opts?.project ? { project: opts.project } : {}),
      ...(opts?.session ? { session: opts.session } : {}),
    }),
    hardWalls: hardWalls(),
    defaultByCategory: opts?.defaultByCategory
      ? Object.freeze({ ...opts.defaultByCategory })
      : DEFAULT_BY_CATEGORY,
    mode: asModeContext(opts?.mode),
    ...(opts?.hostRoots !== undefined ? { hostRoots: opts.hostRoots } : {}),
    ...fsBoundaryOption(opts),
  });
}

export interface CheckPermissionInput {
  readonly def: AciToolDef;
  readonly input: unknown;
  readonly sources: PermissionPolicy["sources"];
  readonly hardWalls: ReadonlyArray<HardRuleSpec>;
  readonly defaultByCategory: Readonly<Record<ToolCategory, CategoryDefault>>;
  /** W2: mode context — resolved at call time so a REPL `/permissions`
   *  toggle takes effect for subsequent tool calls without rebuilding. */
  readonly mode?: PermissionModeContext;
  /**
   * ADR-0132/ADR-0133: the call's host root context. Read ONCE here so the
   * wall below and the executor's own prediction pass see the same vintage a
   * `taskRoot` rebind cannot split. Absent → no cleanup exception is
   * reachable and every verdict is the pre-existing one.
   */
  readonly hostRoots?: () => CleanupRootSnapshot;
  /**
   * ADR-0140 §2: "is this write target inside what the CURRENT fs isolation tier
   * permits?" — `true` is inside the fence's declared writable set, `false` is
   * a crossing of its edge.
   *
   * A CLOSURE, not a snapshot value, for two reasons. **Layering:** the boundary
   * derivation lives in `sandbox/fs-boundary.ts` and the dependency between the
   * two layers is deliberately one-way (sandbox imports permission, never the
   * reverse), so a value typed by that module would drag `../sandbox/` into
   * `permission/`; the composition root imports both worlds and hands this layer
   * a plain answer instead. **Vintage:** `fsMode` is a mid-session holder, so
   * the answer is read per call — once, one vintage — exactly as `hostRoots`
   * above is.
   *
   * Absent → no boundary is configured and every verdict is the pre-existing one.
   */
  readonly fsBoundary?: FsBoundaryReader;
}

/** The ask tier's own reason prefix; `[hard_wall]` is deny's, never reused here. */
const SUBSTITUTION_ASK_PREFIX = "substitution ask:";

/** The command of a shell-bearing call, or `null` for every other tool. */
function shellCommandOf(ctx: {
  readonly tool: string;
  readonly input: unknown;
}): string | null {
  if (ctx.tool !== "bash" && ctx.tool !== "execute") return null;
  const command = (ctx.input as { command?: unknown } | null | undefined)
    ?.command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

/** Distinct from "not a shell call": a shell call whose `command` field is
 *  present but not a string is invalid input for the review layer, while a
 *  call with no `command` field at all is the schema layer's to refuse. */
const NOT_SHELL_CALL = Symbol("not-shell-call");

/** The raw `command` value of a shell-bearing call, without the ask tier's
 *  string-and-emptiness filter — the review layer types both itself. */
function shellReviewCommandOf(ctx: {
  readonly tool: string;
  readonly input: unknown;
}): unknown | typeof NOT_SHELL_CALL {
  if (ctx.tool !== "bash" && ctx.tool !== "execute") return NOT_SHELL_CALL;
  if (ctx.input === null || typeof ctx.input !== "object") {
    return NOT_SHELL_CALL;
  }
  const command = (ctx.input as { command?: unknown }).command;
  // An absent `command` is the schema layer's refusal, not this layer's
  // invalid input; a present-but-unusable one is exactly what the review
  // input contract types as a deny.
  if (command === undefined) return NOT_SHELL_CALL;
  return command;
}

/** The review requirement rendered for an outcome reason: cause, span, detail. */
function securityReviewAskReason(
  requirement: SecurityReviewRequirement
): string {
  return (
    `security review required: ${requirement.cause} ` +
    `[span ${String(requirement.span.start)}-${String(requirement.span.end)}] ` +
    requirement.detail
  );
}

/** Plan mode's mutating deny — one predicate, two consumers (the review arm
 *  defers to it and step 3 enforces it; they must not drift). */
function planBlocksMutation(
  mode: PermissionMode,
  category: ToolCategory
): boolean {
  return mode === "plan" && category !== "read-only";
}

/**
 * ADR-0127's step 1.5 as one outcome: the review scan's verdict routed —
 * `null` when the call asks nothing (not a shell call, or a clean /
 * fall-through verdict), otherwise the deny (broken input / evaluation fault)
 * or the review-bearing ask. Plan mode's mutating deny is no allowance to
 * pre-empt, so a review never turns it into an approvable ask — that verdict
 * falls through to step 3's plan arm.
 */
function securityReviewOutcome(
  ctx: { readonly tool: string; readonly input: unknown },
  mode: PermissionMode,
  category: ToolCategory
): PermissionOutcome | null {
  const reviewInput = shellReviewCommandOf(ctx);
  if (reviewInput === NOT_SHELL_CALL) return null;
  const scan = analyzeSecurityReview(reviewInput);
  if (scan.verdict === "invalid") {
    return {
      decision: "deny",
      reason: `${VIOLATION_PREFIXES.securityReviewInputInvalid} ${scan.reason}`,
    };
  }
  if (scan.verdict === "fault") {
    return {
      decision: "deny",
      reason: `${VIOLATION_PREFIXES.securityReviewEvaluationFailed} ${scan.reason}`,
    };
  }
  if (scan.verdict === "review" && !planBlocksMutation(mode, category)) {
    return {
      decision: "ask",
      reason: securityReviewAskReason(scan.requirement),
      securityReview: scan.requirement,
    };
  }
  return null;
}

/** One reported ask: its token, its kind when the token does not carry it, and
 *  the inner command the operator would have to act on. */
function askFindingText(ask: SubstitutionAsk): string {
  const token = ask.detail.startsWith(ask.kind)
    ? ask.detail
    : `${ask.kind} ${ask.detail}`;
  return ask.inner === undefined
    ? token
    : `${token} ${JSON.stringify(ask.inner)}`;
}

/**
 * The inner commands of `command` that this call owes the operator an
 * explanation for: the substitution sites the parse hangs directly off the
 * outer command. A site nested inside another inner belongs to that inner's own
 * resolution — reached through the same flow below — so this list stays one
 * level wide, and every level is a strict substring of the one above it.
 */
function directInnerCommands(command: string): readonly string[] {
  const parse = parseForSecurity(command);
  if (parse.kind !== "ok") return [];
  const innerIndexes = new Set<number>();
  for (const site of parse.substitutions) {
    if (site.innerCommandIndex !== null) {
      innerIndexes.add(site.innerCommandIndex);
    }
  }
  const inners: string[] = [];
  for (const site of parse.substitutions) {
    const inner = site.innerCommandIndex;
    if (inner === null) continue;
    const owner = site.ownerCommandIndex;
    if (owner !== null && innerIndexes.has(owner)) continue;
    const fact = parse.commands.find((entry) => entry.index === inner);
    if (fact === undefined) continue;
    const source = parse.text.slice(fact.span.start, fact.span.end);
    if (source.length === 0 || source === command) continue;
    if (!inners.includes(source)) inners.push(source);
  }
  return inners;
}

/**
 * ADR-0125 §1's ask tier: the wall's channel is deny-only, so an inner command
 * that merely needs approval is decided here — the one place that can resolve it
 * through the same rules, mode and category arms as the outer command, and
 * therefore the only `inner-ask` constructor. The substitution arms arrive from
 * `hard-walls.ts` and outrank this one: they name a shape the walk could not
 * judge, while an inner ask is only "the same flow says ask". An inner's
 * DENIAL and an inner's review requirement outrank even the substitution
 * arms: the inner runs as part of this call, so what the same flow denies or
 * puts before a human for it is what this call denies or puts before a human
 * for the whole.
 */
function substitutionAskResolution(
  opts: CheckPermissionInput,
  command: string,
  findings: readonly SubstitutionAsk[]
): PermissionOutcome | null {
  const asks: SubstitutionAsk[] = [...findings];
  if (asks.length === 0) {
    for (const inner of directInnerCommands(command)) {
      const innerOutcome = checkPermission({
        ...opts,
        input: { command: inner },
      });
      if (innerOutcome.decision === "deny") {
        return innerOutcome;
      }
      if (innerOutcome.securityReview !== undefined) {
        return innerOutcome;
      }
      if (innerOutcome.decision === "ask") {
        asks.push({ kind: "inner-ask", detail: "inner=ask", inner });
        break;
      }
    }
  }
  if (asks.length === 0) return null;
  return {
    decision: "ask",
    reason: `${SUBSTITUTION_ASK_PREFIX} ${asks.map(askFindingText).join("; ")}`,
  };
}

export function checkPermission(opts: CheckPermissionInput): PermissionOutcome {
  const { def, input } = opts;
  const ctx = { tool: def.name, input };
  const mode: PermissionMode = opts.mode?.get() ?? "default";
  const category = def.aci.category;
  // One read, one vintage: the wall below is the only consumer, and reading it
  // per predicate would let a `taskRoot` flip between the two walls below.
  const roots = opts.hostRoots?.();
  // The extra key is the ONLY difference from the declared `HardRuleSpec` input
  // shape, and it is additive: a wall that does not read it ignores it.
  const wallCtx: { tool: string; input: unknown; roots?: CleanupRootSnapshot } =
    roots === undefined ? ctx : { ...ctx, roots };

  // 1. Hard-walls FIRST — un-overrideable in any mode. This is the security
  //    backstop and must run before mode resolution.
  const walled = hardWallOutcome(opts.hardWalls, wallCtx);
  if (walled !== null) return walled;

  // 1.5 ADR-0127 Security review requirement — below the deny tier (a
  //     confirmed inner deny has already returned above, and the
  //     hard-wall layer's depth-cap descents report confirmed inner denials
  //     before this step ever sees the call), ABOVE session/project grants and
  //     above either mode branch: neither a stored grant nor `full_auto` may
  //     answer a question the parse could not.
  const review = securityReviewOutcome(ctx, mode, category);
  if (review !== null) return review;

  // 2. Layered rules (session > project > code). First match wins per layer
  //    priority. Mode does NOT relax layer rules — only fills the gap.
  const granted = layerRuleOutcome(opts.sources, ctx);
  if (granted !== null) return granted;

  // 3. Mode + category default resolution.
  const defaulted = modeAndCategoryOutcome(opts, mode, category, ctx);
  if (defaulted !== null) return defaulted;
  return {
    decision: "ask",
    reason: `category default: ${category} → ask user`,
  };
}

/**
 * The declared write target of a path-bearing call, or `undefined` for a call
 * that declares none.
 *
 * The field roster is the shared one (`PATH_TARGET_KEYS`, read by the
 * protected-target wall too) — the two ACCESSORS stay separate because they
 * answer different questions: that module asks "is this a protected target",
 * this one asks "is this a write the current tier cannot reach", and merging
 * them would couple two unrelated verdicts' scope. The key list, by contrast,
 * must not drift: a tool declaring its target under a key the wall reads and
 * this accessor omits is denied by the wall yet silently escapes the boundary
 * ask.
 *
 * A call that derives its own target (`bash`, `todo_write`) declares none here
 * and is therefore NOT narrowed by this question — the fence stays the thing
 * that refuses those, through the `[fs_denied]` channel. This decision is an
 * additional refusal source, never a substitute for it (ADR-0140 §2).
 */
function writeTargetOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of PATH_TARGET_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The write target that leaves what the current fs tier permits, or `undefined`
 * when this call cannot cross that edge. Three gates, in the fail-toward-quiet
 * order:
 *   - no reader wired → nothing is configured, nothing is asked;
 *   - a read-only category → the boundary is a WRITE boundary (home stays
 *     `--ro-bind`, so an outside read is inside what the tier permits);
 *   - no declared target, or a target the reader places inside → no crossing.
 */
function boundaryCrossing(
  opts: CheckPermissionInput,
  category: ToolCategory,
  ctx: { tool: string; input: unknown }
): string | undefined {
  const fsBoundary = opts.fsBoundary;
  if (fsBoundary === undefined) return undefined;
  if (category === "read-only") return undefined;
  const target = writeTargetOf(ctx.input);
  if (target === undefined) return undefined;
  return fsBoundary(target) ? undefined : target;
}

/**
 * ADR-0140 §1: `full_auto` asks nothing INSIDE what the current tier permits and
 * raises the ordinary `ask` decision at its edge. The answer decides that one
 * call — nothing here writes a mode, a settings file or any holder, so the
 * question stays per-call (ADR-0140 §3) rather than becoming a session grant the
 * way the egress gate's `askIfUnknown` is.
 *
 * Reached only below the hard wall and the security review, which are
 * pre-filters in every mode (ADR-0068 / ADR-0127) — the narrowing occupies only
 * the gap between them.
 */
function fullAutoOutcome(
  opts: CheckPermissionInput,
  category: ToolCategory,
  ctx: { tool: string; input: unknown }
): PermissionOutcome {
  const crossing = boundaryCrossing(opts, category, ctx);
  if (crossing !== undefined) {
    return {
      decision: "ask",
      reason:
        `mode: full_auto → boundary ask: the fence would refuse this write ` +
        `(${crossing}); answering yes means the call is ATTEMPTED, not that ` +
        `it will succeed — the fence and the tool's own root guard stay ` +
        `authoritative and may still refuse, and the fs mode is not changed`,
    };
  }
  // Inside the tier's reach the mode is unbounded by design — that is its value.
  return {
    decision: "allow",
    reason: `mode: full_auto → allow (${category})`,
  };
}

/**
 * Step 3's answer for everything ABOVE the category default, or `null` when the
 * call reaches the default.
 *
 * The trailing `ask` stays in the caller so it reads as the unconditional floor
 * of this tier: no mode, no substitution arm and no stored rule above ever
 * leaves the function without an answer, and a mode that neither allows nor
 * denies lands on that floor rather than on a missing value.
 */
function modeAndCategoryOutcome(
  opts: CheckPermissionInput,
  mode: PermissionMode,
  category: ToolCategory,
  ctx: { tool: string; input: unknown }
): PermissionOutcome | null {
  if (mode === "full_auto") return fullAutoOutcome(opts, category, ctx);
  if (planBlocksMutation(mode, category)) {
    // Plan mode treats mutating tools as denied without asking — useful for
    // "read, never write" planning sessions.
    return {
      decision: "deny",
      reason: `mode: plan blocks mutating tools (${category})`,
    };
  }
  // ADR-0125 §1's ask tier, below BOTH mode branches and above the category
  // default: it answers parse complexity, never danger. A mode that does not
  // prompt has already allowed, `plan` has already denied a mutating category,
  // and a session allow rule answered in step 2 — so what reaches here is a call
  // this mode puts to the user anyway, and the reason now names the shape that
  // made it hard to read (and the inner command to read) instead of only the
  // category. The inner resolution may also carry an inner's DENY or review
  // requirement outward — a confirmed inner deny outranks every outer
  // uncertainty, and this is the one place the ask tier re-enters the full
  // flow for an inner.
  const askCommand = shellCommandOf(ctx);
  if (askCommand !== null) {
    const resolution = substitutionAskResolution(
      opts,
      askCommand,
      findSubstitutionAsk(askCommand)
    );
    if (resolution !== null) {
      return resolution;
    }
  }
  if (opts.defaultByCategory[category] === "allow") {
    return {
      decision: "allow",
      reason: `category default: ${category} → allow`,
    };
  }
  return null;
}

/**
 * Step 1's answer: the first hard wall that matches, or `null` when none does.
 *
 * `null` is what lets the caller proceed to the layers below — it means "no
 * wall claimed this call", never "no wall ran". Every wall in the list is
 * offered the call before the answer is `null`.
 */
function hardWallOutcome(
  hardWalls: ReadonlyArray<HardRuleSpec>,
  wallCtx: { tool: string; input: unknown; roots?: CleanupRootSnapshot }
): PermissionOutcome | null {
  for (const hardWall of hardWalls) {
    if (!hardWall.match(wallCtx)) continue;
    // SC3: prefer the input-specific reason (carries the matched pattern
    // id) over the static one when the hard-wall provides `reasonFor`.
    const specific = hardWall.reasonFor?.(wallCtx);
    const detail = specific ?? hardWall.reason;
    return {
      decision: "deny",
      reason: `${HARD_WALL_DENY_PREFIX} ${detail}`,
    };
  }
  return null;
}

/**
 * Step 2's answer: the first matching stored rule, layer by layer, or `null`
 * when no layer grants or denies this call.
 *
 * `null` means "no stored rule claimed it", which is what hands the call to the
 * mode + category resolution below. It is never a skip of any layer: the loop
 * visits all three before answering.
 */
function layerRuleOutcome(
  sources: CheckPermissionInput["sources"],
  ctx: { tool: string; input: unknown }
): PermissionOutcome | null {
  const layerOrder: ReadonlyArray<PermissionSource> = [
    "session",
    "project",
    "code",
  ];
  for (const layer of layerOrder) {
    for (const rule of rulesFor(sources, layer)) {
      if (rule.match(ctx)) {
        return { decision: rule.decision, reason: rule.reason };
      }
    }
  }
  return null;
}

function rulesFor(
  sources: CheckPermissionInput["sources"],
  layer: PermissionSource
): ReadonlyArray<NormalRuleSpec> {
  if (layer === "session") return sources.session?.rules() ?? [];
  if (layer === "project") return sources.project?.rules ?? [];
  return sources.code.rules;
}

export { HARD_WALL_DENY_PREFIX };
export type { HardWallId };
