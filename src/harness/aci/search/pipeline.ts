/**
 * The confluence layer for both engines (single landing point of the display
 * contract).
 *
 * Why this layer exists: rg and the Node scan **produce different shapes** (rg
 * emits `-l` path tables / `--count` tables directly, the Node scan emits hit
 * lines directly), yet the contract requires both to answer the same query
 * identically. If the handler projected along two paths, the `also` line
 * window, pagination, and `total:` would each be written twice — "full Node
 * semantics" would become a slogan.
 *
 * Approach: both engines **normalize to hit lines first**, then all semantics
 * (also filtering → sorting → pagination → projection) happen exactly once on
 * this pipeline. `paths` / `count` are merely narrowed projection views, no
 * longer a separate sampling path of the engine.
 *
 * The only exception is **`paths` / `count` without `also`**: those two cases
 * need no line numbers, so rg may take its `-l` / `--count` fast path and skip
 * shipping line content (an order-of-magnitude difference on large repos).
 * Even on this fast path, `total:` is computed "before slicing", consistent
 * with the slow path.
 */

import { ToolExecutionError } from "../../errors.js";
import type { LineHit, QuerySpec } from "./types.js";
import type { EngineResult } from "./rg-engine.js";
import { expandAlsoNeedle, filterHitsByAlsoWindow } from "./also-window.js";
import { buildContextGroups } from "./context-groups.js";
import { NO_ENTRIES_AT_OFFSET } from "./paginate.js";
import { keepRepresentablePaths } from "./path-representable.js";
import { sortContextGroups, sortLineHits } from "./sort.js";
import {
  projectContent,
  projectContext,
  projectCount,
  projectCounts,
  projectPathList,
  projectPaths,
} from "./project.js";

export interface PipelineInput {
  readonly spec: QuerySpec;
  readonly result: EngineResult;
  /** Line fetcher callback for hit lines (shared by `context` display and the `also` line window). */
  readonly readLines: (path: string) => Promise<ReadonlyArray<string> | null>;
}

/**
 * Engine result → model-visible string.
 *
 * Order is part of the contract: **also-filter first, then sort, then slice**.
 * Reversing any step makes pagination drop or duplicate entries.
 */
export async function renderResult(input: PipelineInput): Promise<string> {
  const { spec, result } = input;
  if (result.kind === "unavailable") {
    // This layer should never see unavailable: the dispatch logic (`grep.ts`
    // resolveEngineResult) already switches to the Node scan when
    // downgrading. Reaching here means an assembly bug, so throw this layer's
    // uniform typed error (`ToolExecutionError`, same shape as other tool-
    // layer failures) rather than let a bare Error into the ACI failure
    // domain.
    throw new ToolExecutionError(
      "grep: internal error: result projection received an unavailable engine result"
    );
  }

  const engineResult = dropUnrepresentable(result);
  const lines = await applyAlsoFilter({ ...input, result: engineResult });

  if (spec.output === "content") {
    if (spec.context > 0)
      return renderContext({ ...input, result: engineResult }, lines);
    return projectContent(projection(lines, spec));
  }
  if (spec.output === "count") {
    if (engineResult.kind === "counts" && !hasAlso(spec)) {
      return projectCounts(engineResult.counts, spec.offset, spec.headLimit);
    }
    return projectCount(projection(lines, spec));
  }
  if (engineResult.kind === "paths" && !hasAlso(spec)) {
    return projectPathList(engineResult.paths, spec.offset, spec.headLimit);
  }
  return projectPaths(projection(lines, spec));
}

/**
 * Line-protocol representability gate (shared by both engines).
 *
 * Paths containing `\n` / `\0` must not appear in any output mode: `\n` splits
 * the record into two (under the `path:line:text` line protocol the first half
 * becomes a fake hit), and `\0` collides with the `--null` delimiter. This
 * sits at the **confluence of both engines**, not inside each engine — any
 * future engine that goes through this pipeline inherits it automatically, so
 * no third kind of breakage can fork off.
 *
 * During traversal the argv exclusion globs already block most cases (the
 * whole subtree of a `\n`-containing directory); rg's explicit named targets
 * are blocked pre-exec by `rg-engine.ts`; this layer catches everything else
 * (the Node scan, explicit file arguments, and strays like "the newline only
 * appears in an ancestor segment"). Decision and rationale in
 * `path-representable.ts`.
 */
function dropUnrepresentable(result: EngineResult): EngineResult {
  if (result.kind === "unavailable") return result;
  if (result.kind === "lines") {
    return {
      kind: "lines",
      lines: keepRepresentablePaths(result.lines, (hit) => hit.path),
    };
  }
  if (result.kind === "paths") {
    return {
      kind: "paths",
      paths: keepRepresentablePaths(result.paths, (path) => path),
    };
  }
  if (result.kind === "counts") {
    return {
      kind: "counts",
      counts: keepRepresentablePaths(result.counts, (count) => count.path),
    };
  }
  if (result.kind === "context") {
    return {
      kind: "context",
      groups: result.groups
        .map((group) => ({
          entries: keepRepresentablePaths(group.entries, (entry) => entry.path),
        }))
        .filter((group) => group.entries.length > 0),
    };
  }
  return result;
}

/**
 * `context` output: obtain groups → sort → slice by group. The pagination
 * unit is the **group** (one contiguous display block).
 *
 * The rg path already computed the groups (the `--` separators it inserts are
 * the group boundaries), used directly; the Node path lacks that info, so
 * `buildContextGroups` rebuilds the same shape from "hit line ± context". Both
 * engines produce identical group structures, hence one projection.
 *
 * Sorting before slicing is required for **both engines**: rg's group order
 * follows parallel traversal, Node's follows `readdir`, and neither is
 * (path, line) order. Without this step, the same `offset` would land on
 * different groups across calls — the pagination roster must be deterministic.
 */
async function renderContext(
  input: PipelineInput,
  lines: ReadonlyArray<LineHit>
): Promise<string> {
  const raw =
    input.result.kind === "context"
      ? input.result.groups
      : await buildContextGroups({
          matches: sortLineHits(lines),
          context: input.spec.context,
          readLines: input.readLines,
        });
  const groups = sortContextGroups(raw);
  if (groups.length === 0) return "";
  const { offset, headLimit } = input.spec;
  if (offset >= groups.length) return NO_ENTRIES_AT_OFFSET;
  return projectContext(groups.slice(offset, offset + headLimit));
}

/**
 * `also` line-window filtering.
 *
 * With `also`, line numbers are required first, so the sampling mode at this
 * point is `content` (see `engineSpecFor`), and `lines` are the hit lines;
 * hits whose second segment is outside the window are dropped.
 */
async function applyAlsoFilter(
  input: PipelineInput
): Promise<ReadonlyArray<LineHit>> {
  const { spec, result } = input;
  const lines = result.kind === "lines" ? result.lines : [];
  if (!hasAlso(spec)) return lines;
  const also = expandAlsoNeedle(spec.also!, spec.ignoreCase);
  // `filterHitsByAlsoWindow` reads lines synchronously (pure decision layer),
  // so here we **pre-read** the files involved in hits into a synchronous
  // table before feeding it — file reading still goes through
  // `input.readLines` (async, with the 1MB / binary admission), and the
  // decision layer need not know about fs.
  const files = new Map<string, ReadonlyArray<string> | null>();
  for (const hit of lines) {
    if (files.has(hit.path)) continue;
    files.set(hit.path, await input.readLines(hit.path));
  }
  return filterHitsByAlsoWindow({
    matches: lines,
    also,
    withinLines: spec.withinLines,
    readLines: (path) => files.get(path) ?? null,
  });
}

/** Minimal shape for projection input (`project.ts` only needs hit lines + slice params). */
function projection(
  lines: ReadonlyArray<LineHit>,
  spec: QuerySpec
): {
  hits: { lines: ReadonlyArray<LineHit> };
  offset: number;
  headLimit: number;
} {
  return { hits: { lines }, offset: spec.offset, headLimit: spec.headLimit };
}

function hasAlso(spec: QuerySpec): boolean {
  return spec.also !== undefined && spec.also.length > 0;
}

/**
 * Spec used for engine sampling.
 *
 * With `also` present, content lines **must** be sampled (line numbers are
 * needed to judge the window), so the output mode is temporarily set to
 * `content` and context is turned off (the line window is filtering, not
 * display). Without `also`, sample per the requested mode so rg can take its
 * `-l` / `--count` fast path.
 */
export function engineSpecFor(spec: QuerySpec): QuerySpec {
  if (!hasAlso(spec)) return spec;
  return { ...spec, output: "content", context: 0 };
}
