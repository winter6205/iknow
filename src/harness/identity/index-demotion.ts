/**
 * Index-demotion decision layer (pure logic). ADR-0046 Decision 2.
 *
 * The governance targets are **only two kinds of index entries**: tool lines
 * in `<mcp_name_directory>` and skill lines in `<available_skills>`. The gate
 * = the two segments' **combined** countTokens (measured, not estimated —
 * chars/4 estimation is forbidden) exceeding 10% of the endpoint
 * contextWindow (the caller computes and passes the threshold). When over
 * threshold, descriptions are stripped entry by entry **largest first**,
 * leaving name-only entries — names are never deleted and segments are never
 * absent (the model backfills descriptions for demoted name-only entries via
 * `tool_search` / `skill({name})`).
 *
 * Surfaces excluded from demotion:
 *   - `<deferred_internal_tools>` (schema-evicted built-ins in name+description
 *     form) — ADR-0046 Decision 2 pins "evicted built-ins do not participate
 *     in description stripping", so this module's input has no such category
 *     and a mis-strip path cannot exist.
 *   - the built-in schema-eviction ladder itself (`aci/tool-overflow.ts`) — a
 *     different governance tier; callers run eviction first, then this demotion.
 *
 * Why two separate measurements with `runOverflowJudge`: the eviction ladder
 * measures the **whole first-turn request surface** (tools schema + system),
 * while this gate measures the **two index segments combined**. One measurement
 * cannot yield both quantities, and merging them would silently redefine the
 * gate as "whole prompt over threshold" — a different locked definition. So we
 * reuse the same countTokens source and the same moment (once at first assembly
 * turn) but measure each quantity separately.
 *
 * Failure contract (same skip semantics as `tool-overflow.ts`): countTokens
 * throws / returns a non-finite or negative number → **skip the whole session**
 * (data returned untouched, no half-stripped state), caller logs one
 * `console.warn` line; no throw, no retry.
 *
 * Pure logic: no build-engine coupling, no env reads. Input = two index
 * snapshots + threshold + countTokens closure; output = demoted snapshots +
 * demoted-name list + reason.
 */

import {
  mcpNameDirectorySegment,
  shortToolDescription,
  skillIndexLine,
  skillsSegment,
  type McpServiceSummary,
  type SkillSummary,
} from "./assemble.js";

/** Measurement closure for the index gate: input = the two segments' current
 *  rendered text, returns the measured token count or throws. The caller wires
 *  it to the endpoint countTokens (SDK `messages.countTokens`). */
export type CountIndexTokensFn = (indexText: string) => Promise<number>;

export interface IndexDemotionInput {
  /** MCP name-directory snapshot (the one frozen after firstTurnReady).
   *  Non-connected services are filtered by the renderer; candidate
   *  derivation here uses the same filter. */
  readonly mcp: ReadonlyArray<McpServiceSummary>;
  /** `<available_skills>` snapshot. Disabled entries are filtered by the
   *  renderer; candidate derivation uses the same filter. */
  readonly skills: ReadonlyArray<SkillSummary>;
  /** Threshold = contextWindow * 0.1 (computed by the caller; this module
   *  does not read env). */
  readonly threshold: number;
  readonly countTokens: CountIndexTokensFn;
}

export type IndexDemotionReason =
  /** Nothing strippable (both segments empty / all entries already bare names)
   *  → zero measurement, zero action. */
  "no_index" | "no_overflow" | "demoted" | "countTokens_failed";

export interface IndexDemotionResult {
  readonly reason: IndexDemotionReason;
  readonly mcp: ReadonlyArray<McpServiceSummary>;
  readonly skills: ReadonlyArray<SkillSummary>;
  /** Entries stripped to name-only (MCP tool names / skill names). */
  readonly demoted: ReadonlyArray<string>;
  readonly cause?: unknown;
}

/** SSOT rendering of the two index segments concatenated — the measured
 *  surface = exactly the text the model sees for these two segments.
 *  `<deferred_internal_tools>` is deliberately excluded (neither this gate nor
 *  description stripping applies to it). */
export function renderIndexText(
  mcp: ReadonlyArray<McpServiceSummary>,
  skills: ReadonlyArray<SkillSummary>
): string {
  const parts: string[] = [];
  const directory = mcpNameDirectorySegment(mcp);
  if (directory !== undefined) parts.push(directory);
  // With an empty list the segment text is the fixed "No skills installed"
  // line — it carries no strippable description, and counting it only adds
  // noise to the measurement, so align with the renderer's "content only when
  // there are skills" rule before counting.
  if (skills.some((s) => !s.disabled)) parts.push(skillsSegment(skills));
  return parts.join("\n\n");
}

/** Candidate entries: those whose description-stripping actually shrinks the
 *  surface (rendered lines that carry a description). */
interface Candidate {
  readonly name: string;
  /** Rendered size = character count of this entry's line(s) in its segment
   *  (MCP uses the actual form after the 120-char short-description truncation,
   *  skills use the full description plus their when_to_use line) — the
   *  "largest first" sort key. */
  readonly size: number;
}

export async function runIndexDemotion(
  input: IndexDemotionInput
): Promise<IndexDemotionResult> {
  const unchanged = { mcp: input.mcp, skills: input.skills } as const;
  const candidates = deriveCandidates(input);
  if (candidates.length === 0) {
    return { reason: "no_index", ...unchanged, demoted: [] };
  }
  const first = await measure(input.countTokens, input.mcp, input.skills);
  if (!first.ok) {
    return {
      reason: "countTokens_failed",
      ...unchanged,
      demoted: [],
      cause: first.cause,
    };
  }
  if (first.value <= input.threshold) {
    return { reason: "no_overflow", ...unchanged, demoted: [] };
  }
  // Strip one entry at a time, largest first, re-measuring after each strip.
  const stripped = new Set<string>();
  const demoted: string[] = [];
  for (const candidate of candidates) {
    stripped.add(candidate.name);
    demoted.push(candidate.name);
    const mcp = stripMcp(input.mcp, stripped);
    const skills = stripSkills(input.skills, stripped);
    const next = await measure(input.countTokens, mcp, skills);
    if (!next.ok) {
      // Failure = skip this session: no half-stripped state lands (data
      // untouched), matching tool-overflow skip semantics — within a session
      // the index shape is either all-with-descriptions or one final verdict.
      return {
        reason: "countTokens_failed",
        ...unchanged,
        demoted: [],
        cause: next.cause,
      };
    }
    if (next.value <= input.threshold) {
      return { reason: "demoted", mcp, skills, demoted };
    }
  }
  // Still over threshold after stripping everything → accept the overflow:
  // no names deleted, no built-in descriptions stripped.
  return {
    reason: "demoted",
    mcp: stripMcp(input.mcp, stripped),
    skills: stripSkills(input.skills, stripped),
    demoted,
  };
}

type Measured =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly cause: unknown };

async function measure(
  countTokens: CountIndexTokensFn,
  mcp: ReadonlyArray<McpServiceSummary>,
  skills: ReadonlyArray<SkillSummary>
): Promise<Measured> {
  let value: number;
  try {
    value = await countTokens(renderIndexText(mcp, skills));
  } catch (cause) {
    return { ok: false, cause };
  }
  if (!Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      cause: new Error(`countTokens returned non-finite: ${value}`),
    };
  }
  return { ok: true, value };
}

/**
 * Candidate derivation: both entry kinds share one sorted pool ("largest
 * first" is a single ordering over the **combined** two kinds, not one round
 * per kind).
 *   - MCP: connected services only (same filter as
 *     `mcpNameDirectorySegment`), tool lines with a non-empty short
 *     description;
 *   - skill: non-disabled (same filter as `skillsSegment`), non-empty
 *     description.
 * Equal size → alphabetical by name (demotion output is byte-deterministic,
 * keeping the KV cache stability contract).
 */
function deriveCandidates(input: IndexDemotionInput): ReadonlyArray<Candidate> {
  const out: Candidate[] = [];
  for (const service of input.mcp) {
    if (service.state !== "connected") continue;
    for (const tool of service.tools) {
      const short = shortToolDescription(tool.description);
      if (short === undefined) continue;
      out.push({ name: tool.name, size: `- ${tool.name}: ${short}`.length });
    }
  }
  for (const skill of input.skills) {
    if (skill.disabled) continue;
    const description = skill.description?.trim();
    if (description === undefined || description.length === 0) continue;
    // Sized through the renderer, so a change to the entry line can never make
    // the measurement describe bytes that are no longer emitted.
    out.push({ name: skill.name, size: skillIndexLine(skill).length });
  }
  return out.sort((a, b) =>
    b.size !== a.size ? b.size - a.size : a.name.localeCompare(b.name)
  );
}

/** Stripping a description = dropping the description and when_to_use fields;
 *  names and service membership stay as-is (names are never deleted). */
function stripMcp(
  mcp: ReadonlyArray<McpServiceSummary>,
  stripped: ReadonlySet<string>
): ReadonlyArray<McpServiceSummary> {
  return mcp.map((service) => ({
    ...service,
    tools: service.tools.map((tool) =>
      stripped.has(tool.name) ? { name: tool.name } : tool
    ),
  }));
}

function stripSkills(
  skills: ReadonlyArray<SkillSummary>,
  stripped: ReadonlySet<string>
): ReadonlyArray<SkillSummary> {
  return skills.map((skill) => {
    if (!stripped.has(skill.name)) return skill;
    // Drop both text fields entirely → `skillsSegment` downgrades to a bare
    // name line (same rule as the MCP directory / evicted-built-in segments:
    // "description absent → render name only", not a second decision layer).
    const { description: _dropped, whenToUse: _droppedToo, ...rest } = skill;
    return rest;
  });
}
