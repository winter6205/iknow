import type { AciToolDef } from "../aci/types.js";
import {
  findSubstitutionAsk,
  hardWalls,
  HARD_WALL_DENY_PREFIX,
  type HardWallId,
  type SubstitutionAsk,
} from "./hard-walls.js";
import { parseForSecurity } from "./shell-parse.js";
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
 * judge, while an inner ask is only "the same flow says ask".
 */
function substitutionAskReason(
  opts: CheckPermissionInput,
  command: string,
  findings: readonly SubstitutionAsk[]
): string | null {
  const asks: SubstitutionAsk[] = [...findings];
  if (asks.length === 0) {
    for (const inner of directInnerCommands(command)) {
      const innerOutcome = checkPermission({
        ...opts,
        input: { command: inner },
      });
      if (innerOutcome.decision === "ask") {
        asks.push({ kind: "inner-ask", detail: "inner=ask", inner });
        break;
      }
    }
  }
  if (asks.length === 0) return null;
  return `${SUBSTITUTION_ASK_PREFIX} ${asks.map(askFindingText).join("; ")}`;
}

export function checkPermission(opts: CheckPermissionInput): PermissionOutcome {
  const { def, input } = opts;
  const ctx = { tool: def.name, input };

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
  const mode: PermissionMode = opts.mode?.get() ?? "default";
  const category = def.aci.category;

  if (mode === "full_auto") {
    // Full-auto allows every non-hard-walled tool. The user opted in
    // explicitly; sensitive paths / dangerous commands are still blocked by
    // step 1 above.
    return {
      decision: "allow",
      reason: `mode: full_auto → allow (${category})`,
    };
  }
  if (mode === "plan" && category !== "read-only") {
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
  // category. An analysis fault is never carried here: it is step 1's deny.
  const askCommand = shellCommandOf(ctx);
  if (askCommand !== null) {
    const askReason = substitutionAskReason(
      opts,
      askCommand,
      findSubstitutionAsk(askCommand)
    );
    if (askReason !== null) {
      return { decision: "ask", reason: askReason };
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
