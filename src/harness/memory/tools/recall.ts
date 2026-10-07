/**
 * memory_recall tool (read-side, no side effects).
 *
 * Spec: specs/121-memory-injection.md (Project Structure tools/recall.ts,
 * Testing Strategy tools-recall half). Registered by build-engine;
 * here only the bounded-context-local definition + AciMeta (recall =
 * read-only / cancel / fast by design).
 *
 * Contract:
 *   - inputSchema `{ query: string (required), limit?: integer (1..50) }`
 *   - output pure string — each hit `### <title>\n<frontmatter metadata>\n<body>`
 *   - capped at OUTPUT_HARD_CAP (20000) chars as a self-floor; the executor
 *     is the truncation authority (contract X) — the tool never carries a
 *     truncated/total metadata field (contract Y1)
 *   - no writes, no side effects, no FS mutation
 *   - `disabled: true` entries are dropped before scoring
 *   - scoring delegates to scoreMemoryEntries (bm25 heuristic)
 *
 * Injection seam (web tool precedent): `entries` overrides disk reads so unit
 * tests do not need a tmpdir populated with fixture files.
 */
import { mkdir, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AciToolDef } from "../../aci/types.js";
import { ToolExecutionError } from "../../errors.js";
import { scoreMemoryEntries } from "../bm25.js";
import { isCapabilityObservationEntry } from "../capability-gate.js";
import { MemoryDisabled } from "../errors.js";
import { MEMORY_ADVISORY_PREFIX } from "../prefetch.js";
import { parseMemoryEntry } from "../frontmatter.js";
import type { MemoryEntryV1 } from "../schema.js";

const OUTPUT_HARD_CAP = 20_000;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 50;

export interface MemoryRecallToolDeps {
  readonly memoryDir: string;
  /** Test / upstream seam: override disk reads with pre-built entries. */
  readonly entries?: ReadonlyArray<MemoryEntryV1>;
  /**
   * Live memory-capability gate (ADR-0031 amendment 2026-10-07). Absent =
   * always on. False refuses the call before the store is read, so a call
   * produced while memory was on — including one replayed from older
   * conversation history — cannot read the store.
   */
  readonly isEnabled?: () => boolean;
}

export function createMemoryRecallTool(deps: MemoryRecallToolDeps): AciToolDef {
  return Object.freeze({
    name: "memory_recall",
    description:
      "Look up a specific stored fact (convention, contract, project note) when that fact is needed this turn; pair with memory_save to capture a new fact worth keeping. This is an index, not a checklist — most turns need no recall. Returns one block per hit: a `### title` line, metadata lines, a blank line, then the body (limit 1..50, default 3), self-capped at 20000 chars; pure read-only over the per-conversation memory library.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "fast",
    } as const,
    handler: async (input: unknown) => {
      // Total memory OFF: refuse before the store is read.
      // EXIT: absent gate = always on (ask path / direct construction).
      if (deps.isEnabled?.() === false)
        throw new MemoryDisabled("memory_recall");
      const params = parseInput(input);
      const resolved =
        deps.entries ?? (await readEntriesFromDisk(deps.memoryDir));
      // Soft-disabled entries (memory_gc never hard-deletes) stay on disk but
      // must not reach the model — drop them before scoring so they cannot
      // occupy a limit slot either. The capability gate follows: a runtime
      // snapshot must not be handed back as durable fact (spec
      // runtime-capability-memory-gate read-side filtering).
      const entries = resolved.filter(
        (entry) => !entry.disabled && !isCapabilityObservationEntry(entry)
      );
      const scored = scoreMemoryEntries(params.query, entries)
        .filter((row) => row.titleHits + row.bodyHits > 0)
        .slice(0, params.limit);
      const rendered = formatHits(scored);
      if (rendered.length === 0) return rendered;
      const labeled = `${MEMORY_ADVISORY_PREFIX}\n\n${rendered}`;
      if (labeled.length <= OUTPUT_HARD_CAP) return labeled;
      // Self-floor at OUTPUT_HARD_CAP (contract X: executor is the
      // truncation authority, but the tool still returns ≤ 20000 so the
      // executor floor is a no-op on this output). Pure string, no
      // truncated/total metadata (contract Y1).
      return labeled.slice(0, OUTPUT_HARD_CAP);
    },
  });
}

interface ParsedInput {
  readonly query: string;
  readonly limit: number;
}

function parseInput(input: unknown): ParsedInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[memory_recall] input must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.query !== "string") {
    throw new ToolExecutionError("[memory_recall] query must be a string");
  }
  const limit =
    raw.limit === undefined ? DEFAULT_LIMIT : requireLimit(raw.limit);
  return { query: raw.query, limit };
}

function requireLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolExecutionError(
      "[memory_recall] limit must be an integer in 1..50"
    );
  }
  if (value < 1 || value > MAX_LIMIT) {
    throw new ToolExecutionError("[memory_recall] limit must be in 1..50");
  }
  return value;
}

/**
 * Format each hit as `### <title>\n<metadata>\n<body>`, separated by blank
 * lines. Metadata is a fixed-order dump of the canonical 6 frontmatter fields
 * (id / type / importance / ttl_days / disabled / supersedes / updated_at);
 * unknown extras are preserved.
 */
function formatHits(
  hits: ReadonlyArray<{ readonly entry: MemoryEntryV1 }>
): string {
  const blocks: string[] = [];
  for (const { entry } of hits) {
    blocks.push(formatHit(entry));
  }
  return blocks.join("\n\n");
}

function formatHit(e: MemoryEntryV1): string {
  const meta = [
    `id: ${e.id}`,
    `type: ${e.type}`,
    `importance: ${e.importance}`,
    `ttl_days: ${e.ttl_days}`,
    `disabled: ${e.disabled}`,
    `supersedes: ${e.supersedes ?? "null"}`,
    `updated_at: ${e.updated_at}`,
  ].join("\n");
  return `### ${e.title}\n${meta}\n\n${e.body}`;
}

/** Read all *.md entries (excluding MEMORY.md) from a memory dir. */
async function readEntriesFromDisk(
  memoryDir: string
): Promise<ReadonlyArray<MemoryEntryV1>> {
  try {
    await mkdir(memoryDir, { recursive: true });
  } catch {
    // ignore: read path must not throw on a missing dir
  }
  const out: MemoryEntryV1[] = [];
  let dir;
  try {
    dir = await opendir(memoryDir);
  } catch {
    return out;
  }
  for await (const e of dir) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name === "MEMORY.md") continue;
    try {
      const buf = await readFile(join(memoryDir, e.name), "utf8");
      out.push(parseMemoryEntry(buf));
    } catch {
      // Bad frontmatter / read error: skip with no surfacing — recall is a
      // low-trust data channel; corrupted entries are quarantined silently
      // (mirrors discovery.ts non-UTF-8 skip behavior).
      continue;
    }
  }
  return out;
}
