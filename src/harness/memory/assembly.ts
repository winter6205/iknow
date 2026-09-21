/**
 * assembly.ts (assembleSystemPrompt — thin layer composer).
 *
 * Spec: specs/121-memory-injection.md (Project Structure assembly.ts, Testing
 * Strategy assembly half) — append-only discipline (truncating a file must
 * never lose characters).
 *
 * ## Assembly order (locked)
 *   ADR-0009 Decision 1+3+4; amended 2026-08-30.
 *     user AGENTS (+ user rules bodies in "bodies" mode)
 *     ↓ [PRIORITY_DECLARATION] — exactly once, between user and project
 *     project AGENTS (+ project rules bodies in "bodies" mode)
 *     ↓ [RULES_MANIFEST segment] — "manifest" mode only (parent opener):
 *       paths + read_file guidance, never bodies
 *     ↓ [EXISTENCE_POINTER] — only when the memory library is non-empty
 *     ↓ [memory_catalog + English discipline] — autoExtract === true and ≥1 live
 *
 * ## ADR-0044 — promote bodies NEVER enter the system string
 *   See `docs/adr/0044-promote-bodies-never-enter-system.md` and
 *   `specs/promote-bodies-never-enter-system.md` Boundaries.
 *   Invariant: any provenance (manual / `source: auto` / `source: dream`), any
 *   `autoExtract` value, and any value of `AssemblyContext.promoteEntries` must
 *   NOT cause a memory body to be appended. `usage.json` /
 *   `eligibleForPromote` are still produced (memory_gc reads them), the
 *   `promoteEntries` field is retained on `AssemblyContext` for back-compat
 *   but is intentionally ignored here, and the assemble seam therefore never
 *   calls `listPromotableEntries`.
 *
 * ## Thin composer discipline
 *   Pure, ≤30 lines of composition, append-only on messages (here simply
 *   returns a string). Reads static-layer files with readFile fallback
 *   (discovery is metadata-only), reads catalog entries from disk when the
 *   gate is open, and NEVER mutates ctx or writes to disk.
 */
import { readFile, opendir } from "node:fs/promises";
import {
  findProjectAgents,
  findUserAgents,
  listRulesFiles,
  type MemoryLayerEntry,
} from "./discovery.js";
import { formatMemoryCatalog } from "./catalog.js";
import { isCapabilityObservationEntry } from "./capability-gate.js";
import type { MemoryEntryV1 } from "./schema.js";
import { listStoreEntries } from "./store.js";

/** Locked by spec SC 4 (must appear exactly once, between user and project). */
export const PRIORITY_DECLARATION =
  "Project-level instructions take precedence over user-level instructions.";

/**
 * Locked by spec SC 5 (only when the memory library holds ≥1 entry) and
 * specs/casual-ask-context-hygiene.md (states existence only — never
 * commands the model to call memory_recall).
 */
export const EXISTENCE_POINTER = "A memory library is available.";

/**
 * How `.iknow/rules/*.md` files enter the static layer
 * (ADR-0009, amended 2026-08-30).
 *
 * - "bodies" (default): read each rules file and inject its (truncated) body.
 *   Used by the general-purpose worker path (identity staticInstructions) and
 *   the auto-memory ingest context — the worker opener contract stays intact.
 * - "manifest": never read rule bodies. Inject one index segment listing the
 *   absolute paths plus read-path guidance so the model opens a file on
 *   demand with `read_file`. Used by the parent session opener (chat / tui /
 *   serve via assembleSystemPrompt): the opener must not dump every rules
 *   body, and a missing / empty rules dir simply yields no segment (not
 *   fatal).
 */
export type RulesInjectionMode = "bodies" | "manifest";

/** Rules manifest segment title (parent opener, "manifest" mode only). */
export const RULES_MANIFEST_TITLE = "## Rules index";

/** Rules manifest read-path guidance line (parent opener, "manifest" mode). */
export const RULES_MANIFEST_GUIDANCE =
  "The following instruction rule files are available on disk. Their bodies are not injected at session start; read one with the read_file tool when its guidance applies:";

/** Per-file cap (spec SC 3 + Boundaries Always). Measured against UTF-16 length. */
const FILE_CAP = 12000;

/**
 * Inputs needed to compose the layered system prompt.
 *   projectIdentityRoot + userHome: discovery roots for the static layer
 *     (AGENTS.md + rules). user scope reads `<userHome>/.iknow/`; project
 *     scope reads `<projectIdentityRoot>/` (ADR-0037 §4): the project
 *     identity root the host pinned at startup,
 *     NOT the cwd. A worktree rebind moves the cwd onto a gitignored task
 *     worktree; the project's instructions must not move with it (and must not
 *     be seeded onto the tree either).
 *   workspaceRoot: the per-root state anchor (ADR-0019) — settings
 *     write-back and worktrees still follow it; the project memory store
 *     does not (ADR-0099, it lives in the home project tree).
 *   memoryDir: project-namespaced memory root
 *     (`<pool>/projects/<slug>/memory/`, ADR-0099)。
 *   autoExtract: when true, append memory_catalog after EXISTENCE_POINTER.
 *     Absent / non-true → no catalog; AGENTS layers + EXISTENCE_POINTER are
 *     unaffected (specs/auto-memory-layering.md).
 *   promoteEntries: Accepted by the contract for back-compat with existing
 *     callers, but the assembly step intentionally ignores it (ADR-0044 — see
 *     file header). Do NOT wire it up here: doing so would re-introduce
 *     memory bodies into the system string.
 */
export interface AssemblyContext {
  readonly projectIdentityRoot: string;
  readonly userHome: string;
  readonly workspaceRoot?: string;
  readonly memoryDir: string;
  readonly autoExtract?: boolean;
  /** Accepted but ignored — see file header (ADR-0044). */
  readonly promoteEntries?: ReadonlyArray<MemoryEntryV1>;
}

/** Compose only the static instruction layer, without memory-library content.
 *  `rulesMode` defaults to "bodies" (worker opener contract, unchanged);
 *  the parent session opener passes "manifest" via assembleSystemPrompt. */
export async function assembleStaticSystemPrompt(
  ctx: Pick<
    AssemblyContext,
    "projectIdentityRoot" | "userHome" | "workspaceRoot"
  >,
  opts: { readonly rulesMode?: RulesInjectionMode } = {}
): Promise<string> {
  const rulesMode = opts.rulesMode ?? "bodies";
  const user = await loadStaticLayer(ctx.userHome, "user", rulesMode);
  const project = await loadStaticLayer(
    ctx.projectIdentityRoot,
    "project",
    rulesMode
  );
  const parts: string[] = [];
  if (user) parts.push(user);
  if (project) {
    if (user) parts.push(PRIORITY_DECLARATION);
    parts.push(project);
  }
  if (rulesMode === "manifest") {
    // Parent opener carries a rules index (paths + read-path
    // guidance), never the bodies. Missing / empty rules dirs → no segment.
    const [userRules, projectRules] = await Promise.all([
      listRulesFiles(ctx.userHome, "user"),
      listRulesFiles(ctx.projectIdentityRoot, "project"),
    ]);
    const manifest = rulesManifestSegment([...userRules, ...projectRules]);
    if (manifest) parts.push(manifest);
  }
  return parts.join("\n\n");
}

/** Compose the layered system prompt per the locked order (see file header).
 *  Parent session opener (chat / tui / serve via refresh.createSystemResolver).
 *  Note: rules enter as a manifest here, not bodies (ADR-0009
 *  amended); the ADR-0044 invariant itself lives in the file header. */
export async function assembleSystemPrompt(
  ctx: AssemblyContext
): Promise<string> {
  const staticPrompt = await assembleStaticSystemPrompt(ctx, {
    rulesMode: "manifest",
  });
  const hasMemory = await memoryLibraryNonEmpty(ctx.memoryDir);
  const parts: string[] = staticPrompt ? [staticPrompt] : [];
  if (hasMemory) parts.push(EXISTENCE_POINTER);
  if (ctx.autoExtract === true) {
    const catalog = await loadCatalogSegment(ctx.memoryDir);
    if (catalog) parts.push(catalog);
  }
  return parts.join("\n\n");
}

// -- helpers (each thin, nested ≤4) -----------------------------------------

/** Read AGENTS.md + (bodies mode only) sorted rules for one scope. */
async function loadStaticLayer(
  root: string,
  scope: "user" | "project",
  rulesMode: RulesInjectionMode
): Promise<string> {
  const agents =
    scope === "user"
      ? await findUserAgents(root)
      : await findProjectAgents(root);
  // "manifest" mode never reads rule bodies — discovery for the manifest
  // segment happens once, scope-joined, in assembleStaticSystemPrompt.
  const rules = rulesMode === "bodies" ? await listRulesFiles(root, scope) : [];
  const chunks: string[] = [];
  if (agents) {
    const text = await readOrEmpty(agents.path);
    if (text) chunks.push(truncate(text));
  }
  for (const r of rules) {
    const text = await readOrEmpty(r.path);
    if (text) chunks.push(truncate(text));
  }
  return chunks.join("\n\n");
}

/** Render the rules index segment: title + guidance + one path per line.
 *  No rules (missing / empty dir) → undefined so no empty segment renders. */
function rulesManifestSegment(
  rules: ReadonlyArray<MemoryLayerEntry>
): string | undefined {
  if (rules.length === 0) return undefined;
  const lines = rules.map((r) => `- ${r.path}`);
  return `${RULES_MANIFEST_TITLE}\n${RULES_MANIFEST_GUIDANCE}\n${lines.join("\n")}`;
}

/**
 * Live-entry directory + locked English discipline. IO / parse failure
 * skips the segment so a missing catalog cannot fail the user turn.
 * `disabled` stays the first gate; the capability filter then keeps runtime
 * snapshots out of the session snapshot (spec runtime-capability-memory-gate
 * read-side filtering). The snapshot eats the filtered list (ADR-0042).
 * Filtering lives here, not in formatMemoryCatalog, which stays a dumb formatter.
 */
async function loadCatalogSegment(
  memoryDir: string
): Promise<string | undefined> {
  try {
    const scan = await listStoreEntries(memoryDir);
    const live = scan.entries
      .filter(
        (row) => !row.entry.disabled && !isCapabilityObservationEntry(row.entry)
      )
      .map((row) => row.entry);
    return formatMemoryCatalog(live);
  } catch (err) {
    // EXIT: log-and-continue — catalog is advisory; turn still succeeds.
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[memory/assembly] catalog skipped: ${detail}\n`);
    return undefined;
  }
}

/** True when memoryDir contains any *.md entry (excluding the MEMORY.md index). */
async function memoryLibraryNonEmpty(memoryDir: string): Promise<boolean> {
  let dir;
  try {
    dir = await opendir(memoryDir);
  } catch {
    return false;
  }
  for await (const e of dir) {
    if (e.name.endsWith(".md") && e.name !== "MEMORY.md") return true;
  }
  return false;
}

/** Read a UTF-8 file; return "" on ENOENT/read failure (bad files are skipped). */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Truncate to cap + `[truncated N chars]` marker if over; preserve prefix verbatim. */
function truncate(text: string, cap = FILE_CAP): string {
  if (text.length <= cap) return text;
  const dropped = text.length - cap;
  return `${text.slice(0, cap)}[truncated ${dropped} chars]`;
}
