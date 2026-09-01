/**
 * #121 T4: assembly.ts (assembleSystemPrompt — thin layer composer).
 *
 * Spec: specs/121-memory-injection.md (Project Structure assembly.ts, Testing
 * Strategy assembly half, SC 1/3/4/5/10, Boundaries Always — append-only 纪律,
 * 文件截断不丢字符).
 *
 * Order locked (ADR-0009 Decision 1+3+4; D2 amended 2026-08-30, #841 T6):
 *   user AGENTS (+ user rules bodies in "bodies" mode)
 *   ↓ [PRIORITY_DECLARATION] — exactly once, between user and project
 *   project AGENTS (+ project rules bodies in "bodies" mode)
 *   ↓ [RULES_MANIFEST segment] — "manifest" mode only (parent opener):
 *     paths + read_file guidance, never bodies
 *   ↓ [EXISTENCE_POINTER] — only when the memory library is non-empty
 *   ↓ [memory_catalog + English discipline] — autoExtract === true and ≥1 live
 *   ↓ [promote 段 (if any)] — autoExtract === true (specs/auto-memory-layering.md),
 *     <= 4000 chars, importance desc
 *
 * The function is a pure thin composer (≤30 lines, append-only on messages via
 * out-params — here simply returns a string): it reads static-layer files with
 * readFile fallback (discovery is metadata-only), reads promote entries from
 * disk when no cache is provided and autoExtract is on, and NEVER mutates ctx
 * or writes to disk.
 */
import { readFile, opendir } from "node:fs/promises";
import {
  findProjectAgents,
  findUserAgents,
  listRulesFiles,
  type MemoryLayerEntry,
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

/**
 * How `.iknow/rules/*.md` files enter the static layer
 * (ADR-0009 D2 amended 2026-08-30 — plans/worktree-isolation-model-provision.md T6).
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
 *     scope reads `<projectIdentityRoot>/` — T3 (plans/worktree-session-roots.md
 *     / ADR-0037 §4): the project identity root the host pinned at startup,
 *     NOT the cwd. A worktree rebind moves the cwd onto a gitignored task
 *     worktree; the project's instructions must not move with it (and must not
 *     be seeded onto the tree either).
 *   workspaceRoot: ADR-0019 (T2) per-root state anchor — memoryDir and the
 *     other per-root state live under it, but the user static layer does not
 *     (a project-local `.iknow/AGENTS.md` must not become user-level).
 *   memoryDir: project-namespaced memory root (<workspaceRoot>/.iknow/memory/
 *     <base>-<hash>, per-root memory decision).
 *   autoExtract: when true, append memory_catalog after EXISTENCE_POINTER,
 *     then the promote segment (if any). Absent / non-true → no catalog and
 *     no promote segment; AGENTS layers + EXISTENCE_POINTER are unaffected
 *     (specs/auto-memory-layering.md — promote 与抽取同闸).
 *   promoteEntries: optional injection — used by tests + per-turn refresh hook.
 */
export interface AssemblyContext {
  readonly projectIdentityRoot: string;
  readonly userHome: string;
  readonly workspaceRoot?: string;
  readonly memoryDir: string;
  readonly autoExtract?: boolean;
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
    // #841 T6: parent opener carries a rules index (paths + read-path
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
 *  Parent session opener (chat / tui / serve via refresh.createSystemResolver):
 *  rules enter as a manifest, not bodies (#841 T6 / ADR-0009 D2 amended). */
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
    // specs/auto-memory-layering.md: promote 段与 catalog 同闸 — only when
    // autoExtract === true; lazy-scan disk only inside the gate so the gated-off
    // path never touches promote state.
    const promote =
      ctx.promoteEntries ?? (await listPromotableEntries(ctx.memoryDir));
    if (promote.length > 0) parts.push(formatPromote(promote));
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
