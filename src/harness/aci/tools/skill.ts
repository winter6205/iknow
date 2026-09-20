// `skill` tool — fetch the body of an installed skill by exact name.
//
// Behavior ground truth:
//   - input `{ name: string required }` — a hit against an indexed skill
//     name loads it; a wrong name returns guidance text pointing back to the
//     `<available_skills>` list (system section) or, when the operator named
//     a path, to `read_file`. It must never mention the removed
//     `skill_search` tool (ADR-0046).
//   - Model-index eligibility gate: only names with a description and
//     without `disable-model-invocation` get a body assembled. Ineligible
//     names throw `SkillNotModelIndexedError` (typed, so the reason reaches
//     the model); disk-read failures throw `SkillBodyReadError` (a distinct
//     type from eligibility rejection). The gate covers this tool only — file
//     tools reading the same SKILL.md do not fail because of it.
//   - output: the assembled body (frontmatter stripped + `Base directory`
//     line + `<skill_files>` section: ≤10 sampled absolute paths with a
//     sampled hint; references/ not recursed), built via
//     `src/harness/skill/body.ts` `createSkillBody({ entry, dir })`.
//   - aci metadata: read-only / lazy:false / timeoutTier:fast.
//
// Dependency injection: `createSkillTool(deps)` takes the catalog (passed by
// the assembly layer `createDefaultAciRegistry` via the `skillCatalog` opt).
// The catalog is created by `createSkillCatalog(entries)`; the factory stays
// callable for tests and migration paths when no catalog is assembled, and
// assembly simply does not register the tool in that case.
//
// ADR-0079 — skill bodies no longer append a write-root trailer (byte-identical
// to the assembly form): write-root disclosure goes through the worker prior +
// chat-session rebind one-time notification via the shared `writeRootSegment`
// helper, so `SkillToolDeps` needs no `liveTaskRoot` / `isolationOn`.
//
// Same-name short-circuit: when the model calls `skill()` again for a name
// whose successful full body is still visible in messages (a non-error
// tool_result with both assembly markers), return only a short receipt
// instead of re-assembling; if compaction drops that entry the full body is
// naturally re-fed (the criterion is a messages snapshot, not an
// only-growing session Set). With no snapshot available, fail closed and
// feed the full body. Two same-name calls in one wave: the tool_result is not
// yet in history, so a wave map (turnId → assembled-name set) covers the gap —
// the first assembly in the wave pre-records, and since Promise.all starts
// both handlers synchronously, the later one reads the pre-record and
// short-circuits. The gate covers the ACI `skill()` handler only (slash / Web
// do not go through this path).
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AnthropicNativeMessage } from "../../model-adapter/types.js";
import type { SkillCatalog, SkillEntry } from "../../skill/catalog.js";
import { modelIndexIneligibility } from "../../skill/catalog.js";
import { createSkillBody, SKILL_BODY_MARKERS } from "../../skill/body.js";
import { ToolExecutionError } from "../../errors.js";

/**
 * Dependency injection: the `catalog` index layer; this tool uses its
 * `get(name)` to obtain a SkillEntry (the body-assembly module takes
 * entry + dir).
 */
export interface SkillToolDeps {
  readonly catalog: SkillCatalog;
}

/**
 * Eligibility rejection: "not in the model index → refuse, feed no body".
 *
 * Model-index eligibility (docs/CONTEXT.md "skill model index") = has a
 * description and does not set `disable-model-invocation`. `skill()` serves
 * only this eligibility; the human slash surface covers **loadable skills**
 * (including those without description or with disable) and never enters
 * this handler.
 *
 * Why it extends `ToolExecutionError`: the executor's `sanitizeFailure` only
 * lets through that type's (or self-declared `modelFacing`) messages;
 * anything else collapses to the constant `"tool execution failed"`. The
 * rejection reason must reach the model — so it switches to an eligible name
 * from `<available_skills>` instead of blindly retrying.
 */
export class SkillNotModelIndexedError extends ToolExecutionError {
  override readonly name: string = "SkillNotModelIndexedError";
  readonly kind = "not_model_indexed" as const;
  readonly skillName: string;
  /** Which side fails, orthogonal to `disabled` (the two have different exits). */
  readonly reason: "disabled" | "no_description";

  constructor(skillName: string, reason: "disabled" | "no_description") {
    super(
      reason === "disabled"
        ? `skill '${skillName}' is human-slash-only: its frontmatter sets \`disable-model-invocation: true\`, so it is not in the model index and its body is not loaded through this tool. Use the operator's \`/${skillName}\` slash command instead, or pick a model-indexed name from the \`<available_skills>\` list.`
        : `skill '${skillName}' has no \`description\` in its frontmatter, so it is not in the model index and its body is not loaded through this tool. It stays available via the operator's \`/${skillName}\` slash command; ask the skill author to add a \`description\` to index it for the model.`
    );
    this.skillName = skillName;
    this.reason = reason;
  }
}

/**
 * Assembly-time disk-read failure (SKILL.md unreadable / skill directory
 * unreachable). A **distinct type** from `SkillNotModelIndexedError`:
 * eligibility rejection means "this route is not open to you", a disk-read
 * failure means "it should be open but is unreadable right now" — the
 * caller's next step differs.
 *
 * Disk-fault handling: the raw ENOENT / EACCES thrown by `createSkillBody`
 * embeds absolute paths, so passing it through verbatim would write the
 * skill install root's layout into model-visible text (and the executor only
 * honors `ToolExecutionError` messages). This class therefore **does not
 * carry over** the cause's message — `message` says only "which skill could
 * not be read + fall back to read_file", and the raw fault stays on `cause`
 * for tests and host-side branching.
 */
export class SkillBodyReadError extends ToolExecutionError {
  override readonly name: string = "SkillBodyReadError";
  readonly kind = "body_read_failed" as const;
  readonly skillName: string;
  override readonly cause: unknown;

  constructor(skillName: string, cause: unknown) {
    super(
      `skill '${skillName}' is model-indexed but its SKILL.md could not be read (${errorSummary(cause)}). Use \`read_file\` on the path if you have it, or retry once the file is available.`
    );
    this.skillName = skillName;
    this.cause = cause;
  }
}

/**
 * Disk fault → safe short summary (errno code style; never a path). The
 * cause's shape is not fixed (Error / plain object), so follow the same
 * discipline as `errorMessage`: no bare `err.message` access and no
 * `String(err)` that prints `[object Object]`.
 */
function errorSummary(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "read error";
}

/**
 * Short-receipt literal: non-empty, meaning "already in visible context /
 * do not call again / act on the body fed earlier". Deliberately contains
 * **neither** assembly marker — a receipt must never be mistaken by the
 * recognizer for a full body.
 */
const SHORT_CIRCUIT_RECEIPT =
  "Skill body already in context. Do not call `skill` again — use the body fed earlier.";

type ContentBlock = AnthropicNativeMessage["content"][number];
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

/** Is this block a tool_use for the skill name under evaluation (other names don't count)? */
function isSkillUseOf(
  block: ContentBlock,
  name: string
): block is ToolUseBlock {
  return (
    block.type === "tool_use" &&
    block.name === "skill" &&
    (block.input as { name?: unknown } | null | undefined)?.name === name
  );
}

/**
 * Is this tool_result a successful result for a claimed id and non-error?
 * An is_error failure does not count — failure text may carry the markers
 * while the body never actually entered history.
 */
function isSuccessResultOf(
  block: ContentBlock,
  wantedIds: ReadonlySet<string>
): block is ToolResultBlock {
  return (
    block.type === "tool_result" &&
    wantedIds.has(block.tool_use_id) &&
    block.is_error !== true
  );
}

/** Assembly-form criterion: the result text contains both markers (one missing = truncated form, doesn't count). */
function hasAssemblyMarkers(text: string): boolean {
  return (
    text.includes(SKILL_BODY_MARKERS.baseDirectory) &&
    text.includes(SKILL_BODY_MARKERS.skillFilesClose)
  );
}

/**
 * Does the visible history already contain a successful full-body
 * tool_result for skill `name`? The "successful full body" criterion: an
 * assistant `tool_use(name === "skill", input.name === name)` whose id is
 * answered by a later `tool_result(tool_use_id match, is_error !== true)`,
 * and the result text contains both assembly markers. Guidance text and
 * short receipts lack the markers, so they never match.
 */
export function hasVisibleFullSkillBody(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  name: string
): boolean {
  // First collect all tool_use ids that are skill calls needing the full body.
  const wantedIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (isSkillUseOf(block, name)) wantedIds.add(block.id);
    }
  }
  if (wantedIds.size === 0) return false;
  for (const message of messages) {
    for (const block of message.content) {
      if (!isSuccessResultOf(block, wantedIds)) continue;
      if (hasAssemblyMarkers(resultBlockText(block.content))) return true;
    }
  }
  return false;
}

/** Project tool_result content to plain text (string as-is; blocks joined by their text parts). */
function resultBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : ""
      )
      .join("\n");
  }
  return "";
}

/**
 * Same-wave short-circuit lookup + pre-record in one step: returns
 * `undefined` when this turn has already assembled the name (caller sends
 * the short receipt); otherwise synchronously pre-records and returns the
 * rollback handle. The pre-record must happen before assembly — the second
 * handler started concurrently by Promise.all in the same wave can read it
 * before this handler returns (until the tool_result enters history, the
 * wave map is the only visible criterion).
 */
function claimSameWave(
  assembledByTurn: Map<string, Set<string>>,
  turnId: string,
  name: string
): Set<string> | undefined {
  const existing = assembledByTurn.get(turnId);
  if (existing?.has(name) === true) return undefined;
  const waveSet = existing ?? new Set<string>();
  waveSet.add(name);
  assembledByTurn.set(turnId, waveSet);
  return waveSet;
}

/**
 * Assemble the body (frontmatter strip + Base directory line + skill_files
 * section; no write-root trailer since ADR-0079). entry.dir is the directory
 * containing SKILL.md (catalog.getBodyPath internally joins dir/SKILL.md).
 * If assembly throws, roll back the pre-record (fail closed): a body that
 * never entered history must never be claimed as loaded — the next same-name
 * call should re-assemble or let the error surface.
 */
async function assembleWithRollback(
  entry: SkillEntry,
  name: string,
  waveSet: Set<string> | undefined
): Promise<string> {
  try {
    return await createSkillBody({ entry, dir: entry.dir });
  } catch (err) {
    waveSet?.delete(name);
    // Disk-read failure keeps a type distinct from eligibility rejection.
    // The pre-record rollback completes here: never claim an unloaded body.
    throw new SkillBodyReadError(name, err);
  }
}

/**
 * Factory: createSkillTool(deps) — fetch a skill body by exact name.
 *
 * On a hit whose successful full body is still visible → short receipt;
 * otherwise assemble the body (frontmatter strip + Base directory line +
 * `<skill_files>` sampling, byte-identical with the assembly form).
 * On a miss: return guidance text (no throw, conveying "check the
 * `<available_skills>` list, or use `read_file` when the operator named a
 * path") — the only fallback entry after `skill_search` was removed
 * (ADR-0046).
 *
 * On a hit, the model-index eligibility gate runs first: ineligible →
 * `SkillNotModelIndexedError`, no body assembled, no wave-map entry. The
 * order is **gate before short-circuit**: an ineligible name should not be
 * on the model's call surface at all, and a stale same-name body in history
 * must not "launder" it into loaded.
 *
 * Wave-map trade-off: keyed by turnId; cross-turn residue is harmless (the
 * criterion stays the messages snapshot; the map only covers the "same wave,
 * tool_result not yet in history" window). Held by the factory closure and
 * never cleaned — the key space is the number of turnIds actually used in a
 * session, which is small. Pre-record before assembly (under Promise.all in
 * the same wave, the second handler must see the first's intent even though
 * it has not returned), and roll back the pre-record when assembly throws:
 * a body that never entered history must never be claimed as loaded
 * (fail-closed on the exception path).
 */
export function createSkillTool(deps: SkillToolDeps): AciToolDef {
  // Same-wave assembled-name sets within this factory (one per session).
  const assembledByTurn = new Map<string, Set<string>>();
  return Object.freeze({
    name: "skill",
    description:
      "Load the full body of a skill by its exact name from the `<available_skills>` catalog. Returns the assembled skill body (frontmatter stripped, `Base directory` line, sampled `<skill_files>`). When the name is unknown, points back to the `<available_skills>` list in the system prompt or, for paths outside the assembly scan root, to `read_file`. If the skill body was already loaded and is still visible in the conversation, returns a short receipt instead.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    // ADR-0083 — statically declared at assembly time: this tool's output is
    // a one-shot assembly product with whole-document semantics (not a
    // re-derivable query), so it is exempt from the executor's
    // `OUTPUT_HARD_CAP` fallback truncation. Declared here, read only in
    // `src/harness/tools/executor.ts` (safeContent); other built-in factories
    // do not declare it, and the MCP conversion path does not either
    // (`toAciToolDef` maps only name / description / inputSchema);
    // `registerExternal` strips it so hand-built mcp__ defs can't smuggle it.
    exemptFromOutputCap: true,
    handler: async (
      input: unknown,
      ctx?: ToolExecutionContext
    ): Promise<string> => {
      const name = parseName(input);
      const entry = deps.catalog.get(name);
      if (!entry) {
        // Guidance doesn't count as loaded: no wave-map entry, retries still get guidance.
        return `skill '${name}' not found. Pick the name from the \`<available_skills>\` list in the system prompt, or — if the operator pointed at a file path outside the scan root — use \`read_file\`.`;
      }
      // Model-index eligibility gate — runs **before** any short-circuit /
      // wave pre-record / assembly. An ineligible name must enter no path:
      // neither body assembly nor a "loaded" marking that would hand a short
      // receipt to the next same-name call (rejection must outrank
      // short-circuit, or stale history would launder it). catalog.get still
      // returns disabled entries by name (the loadable-skills surface); the
      // gate lives only in this handler.
      const ineligibility = modelIndexIneligibility(entry);
      if (ineligibility !== undefined) {
        throw new SkillNotModelIndexedError(name, ineligibility);
      }
      const messages = ctx?.messages;
      if (messages !== undefined && hasVisibleFullSkillBody(messages, name)) {
        return SHORT_CIRCUIT_RECEIPT;
      }
      // No turnId (slash / direct handler call) → no same-wave record to
      // consult; fail closed and feed the full body.
      const turnId = ctx?.turnId;
      let waveSet: Set<string> | undefined;
      if (turnId !== undefined) {
        waveSet = claimSameWave(assembledByTurn, turnId, name);
        // undefined = this turn already assembled the name → body is present, short-circuit.
        if (waveSet === undefined) return SHORT_CIRCUIT_RECEIPT;
      }
      return await assembleWithRollback(entry, name, waveSet);
    },
    aci: {
      category: "read-only",
      // No lazy needed before assembly; the skill tool is resident in the prompt.
      lazy: false,
      timeoutTier: "fast",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
    } as const,
  });
}

/** Parse the name field; non-string / missing → treated as a miss (returns guidance text). */
function parseName(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const raw = input as Record<string, unknown>;
  return typeof raw.name === "string" ? raw.name : "";
}
