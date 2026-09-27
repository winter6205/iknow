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
}

export interface CreatePermissionPolicyOpts {
  readonly project?: ProjectSettingsPolicySource;
  readonly session?: SessionGrantsPolicySource;
  readonly defaultByCategory?: Readonly<Record<ToolCategory, CategoryDefault>>;
  /** W2: Permission mode. Either a static value or a mutable context (REPL
   *  can flip via `/permissions full_auto` without rebuilding the engine). */
  readonly mode?: PermissionMode | PermissionModeContext;
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

  // 1. Hard-walls FIRST — un-overrideable in any mode. This is the security
  //    backstop and must run before mode resolution.
  for (const hardWall of opts.hardWalls) {
    if (hardWall.match(ctx)) {
      // SC3: prefer the input-specific reason (carries the matched pattern
      // id) over the static one when the hard-wall provides `reasonFor`.
      const specific = hardWall.reasonFor?.(ctx);
      const detail = specific ?? hardWall.reason;
      return {
        decision: "deny",
        reason: `${HARD_WALL_DENY_PREFIX} ${detail}`,
      };
    }
  }

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
  const layerOrder: ReadonlyArray<PermissionSource> = [
    "session",
    "project",
    "code",
  ];
  for (const layer of layerOrder) {
    for (const rule of rulesFor(opts.sources, layer)) {
      if (rule.match(ctx)) {
        return { decision: rule.decision, reason: rule.reason };
      }
    }
  }

  // 3. Mode + category default resolution.
  if (mode === "full_auto") {
    // Full-auto allows every non-hard-walled tool. The user opted in
    // explicitly; sensitive paths / dangerous commands are still blocked by
    // step 1 above.
    return {
      decision: "allow",
      reason: `mode: full_auto → allow (${category})`,
    };
  }
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
  return {
    decision: "ask",
    reason: `category default: ${category} → ask user`,
  };
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
