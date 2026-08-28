/**
 * #121 T4: assembly.ts (assembleSystemPrompt — thin layer composer).
 *
 * Spec: specs/121-memory-injection.md (Project Structure assembly.ts, Testing
 * Strategy assembly half, SC 1/3/4/5/10, Boundaries Always — append-only 纪律,
 * 文件截断不丢字符).
 *
 * Order locked (ADR-0009 Decision 1+3+4):
 *   user AGENTS + user rules
 *   ↓ [PRIORITY_DECLARATION] — exactly once, between user and project
 *   project AGENTS + project rules
 *   ↓ [EXISTENCE_POINTER] — only when the memory library is non-empty
 *   ↓ [memory_catalog + English discipline] — autoExtract === true and ≥1 live
 *   promote 段 (if any) — <= 4000 chars, importance desc
 *
 * The function is a pure thin composer (≤30 lines, append-only on messages via
 * out-params — here simply returns a string): it reads static-layer files with
 * readFile fallback (discovery is metadata-only), reads promote entries from
 * disk when no cache is provided, and NEVER mutates ctx or writes to disk.
 */
import { readFile, opendir } from "node:fs/promises";
import {
  findProjectAgents,
  findUserAgents,
  listRulesFiles,
} from "./discovery.js";
import { formatMemoryCatalog } from "./catalog.js";
import { listPromotableEntries, PROMOTE_SEGMENT_CAP } from "./promote.js";
import type { MemoryEntryV1 } from "./schema.js";
import { listStoreEntries } from "./store.js";

/** Locked by spec SC 4 (must appear exactly once, between user and project). */
export const PRIORITY_DECLARATION =
  "Project-level instructions take precedence over user-level instructions.";

/** Locked by spec SC 5 (only when the memory library holds ≥1 entry). */
export const EXISTENCE_POINTER =
  "A memory library is available. Use memory_recall(query) to retrieve past experience.";

/** Per-file cap (spec SC 3 + Boundaries Always). Measured against UTF-16 length. */
const FILE_CAP = 12000;

/**
 * Inputs needed to compose the layered system prompt.
 *   cwd + userHome: discovery roots for the static layer (AGENTS.md + rules).
 *     user scope reads `<userHome>/.iknow/`; project scope stays at `<cwd>`.
 *   workspaceRoot: ADR-0019 (T2) per-root state anchor — memoryDir and the
 *     other per-root state live under it, but the user static layer does not
 *     (a project-local `.iknow/AGENTS.md` must not become user-level).
 *   memoryDir: project-namespaced memory root (<workspaceRoot>/.iknow/memory/
 *     <base>-<hash>, per-root memory decision).
 *   autoExtract: when true, append memory_catalog after EXISTENCE_POINTER.
 *     Absent / non-true → byte-identical to the catalog-less path.
 *   promoteEntries: optional injection — used by tests + per-turn refresh hook.
 */
export interface AssemblyContext {
  readonly cwd: string;
  readonly userHome: string;
  readonly workspaceRoot?: string;
  readonly memoryDir: string;
  readonly autoExtract?: boolean;
  readonly promoteEntries?: ReadonlyArray<MemoryEntryV1>;
}

/** Compose only the static instruction layer, without memory-library content. */
export async function assembleStaticSystemPrompt(
  ctx: Pick<AssemblyContext, "cwd" | "userHome" | "workspaceRoot">
): Promise<string> {
  const user = await loadStaticLayer(ctx.userHome, "user");
  const project = await loadStaticLayer(ctx.cwd, "project");
  const parts: string[] = [];
  if (user) parts.push(user);
  if (project) {
    if (user) parts.push(PRIORITY_DECLARATION);
    parts.push(project);
  }
  return parts.join("\n\n");
}

/** Compose the layered system prompt per the locked order (see file header). */
export async function assembleSystemPrompt(
  ctx: AssemblyContext
): Promise<string> {
  const staticPrompt = await assembleStaticSystemPrompt(ctx);
  const hasMemory = await memoryLibraryNonEmpty(ctx.memoryDir);
  const promote =
    ctx.promoteEntries ?? (await listPromotableEntries(ctx.memoryDir));
  const parts: string[] = staticPrompt ? [staticPrompt] : [];
  if (hasMemory) parts.push(EXISTENCE_POINTER);
  if (ctx.autoExtract === true) {
    const catalog = await loadCatalogSegment(ctx.memoryDir);
    if (catalog) parts.push(catalog);
  }
  if (promote.length > 0) parts.push(formatPromote(promote));
  return parts.join("\n\n");
}

// -- helpers (each thin, nested ≤4) -----------------------------------------

/** Read AGENTS.md + sorted rules for one scope; return joined, truncated text. */
async function loadStaticLayer(
  root: string,
  scope: "user" | "project"
): Promise<string> {
  const agents =
    scope === "user"
      ? await findUserAgents(root)
      : await findProjectAgents(root);
  const rules = await listRulesFiles(root, scope);
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

/**
 * Live-entry directory + locked English discipline. IO / parse failure
 * skips the segment so a missing catalog cannot fail the user turn.
 */
async function loadCatalogSegment(
  memoryDir: string
): Promise<string | undefined> {
  try {
    const scan = await listStoreEntries(memoryDir);
    const live = scan.entries
      .filter((row) => !row.entry.disabled)
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

/** Format sorted-by-importance entries as a promote segment, capped to 4000. */
function formatPromote(entries: ReadonlyArray<MemoryEntryV1>): string {
  const sorted = [...entries].sort(
    (a, b) => b.importance - a.importance || a.id.localeCompare(b.id)
  );
  const text = sorted
    .map(
      (e) =>
        `### ${e.title}\nupdated_at: ${e.updated_at}\nimportance: ${e.importance}\n${e.body}`
    )
    .join("\n\n");
  return truncate(text, PROMOTE_SEGMENT_CAP);
}

/** Read a UTF-8 file; return "" on ENOENT/read failure (Boundaries Always 跳过). */
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
