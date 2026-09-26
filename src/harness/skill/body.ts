// Skill body assembly (`src/harness/skill/body.ts`).
//
// Assembly shape:
//   - body = frontmatter-stripped text + a `Base directory: <abs dir>` hint
//     line + a `<skill_files>` segment (recursive walk excluding SKILL.md,
//     sorted, sampled ≤10, absolute paths, with a "file list is sampled" hint).
//   - references/ is not recursed.
//   - Byte-stable: same input twice yields the same string (KV-cache contract).
//
// `readDir` / `readFile` are injectable test seams (default `node:fs/promises`)
// so tests can build a SKILL.md tree in a tmp dir; no glob dependency.
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, sep } from "node:path";

import { stripFence } from "../frontmatter/index.js";
import type { SkillEntry } from "./catalog.js";
import type { WriteSituation } from "../session-roots.js";

/** Max sampled entries in the skill_files segment. */
export const SKILL_FILES_SAMPLE_LIMIT = 10;

/** references/ dir — excluded from the skill_files walk. */
const REFERENCES_DIR = "references";

/**
 * The two markers that define the assembled full-body shape: a successful
 * full-text tool_result always contains both `Base directory:` and
 * `</skill_files>`. Shared by the recognizer (skill() second-load short
 * circuit) and the assembly SSOT — changing the assembly shape must update
 * these literals together.
 */
export const SKILL_BODY_MARKERS = {
  /** Prefix of the `Base directory: <dir>` hint line rendered by createSkillBody. */
  baseDirectory: "Base directory:",
  /** Closing tag of the `<skill_files>` segment. */
  skillFilesClose: "</skill_files>",
} as const;

/** SKILL.md file name — never listed inside skill_files. */
const SKILL_BODY_FILE = "SKILL.md";

export interface SkillBodyFs {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly readDir: (path: string) => Promise<Dirent[]>;
}

const defaultFs: SkillBodyFs = {
  readFile: (p, enc) => readFile(p, enc),
  readDir: (p) => readdir(p, { withFileTypes: true }),
};

export interface SkillBodyOptions {
  readonly entry: SkillEntry;
  readonly dir: string;
  /**
   * ADR-0079 — the skill body no longer carries a write-root trailer (keeping
   * the byte-exact shape: frontmatter stripped + Base directory line +
   * `<skill_files>` segment). Write-situation disclosure moved to the worker
   * prior (`src/harness/subagent/worker.ts`) and the `chat-session.ts` rebind
   * notification — both share the same `writeRootSegment` helper but no longer
   * append it to the skill body. SkillBodyOptions no longer accepts
   * `writeSituation` / `taskRoot`.
   */
  readonly fs?: SkillBodyFs;
}

/**
 * The single authoritative format (SSOT) for the skill-load message prefix.
 * Three places share this literal: TUI assembly (via `buildSkillLoadText`),
 * web assembly (`web/src/hooks/use-slash-commands.ts`, which keeps a local
 * constant because of the workspace boundary, with an SSOT comment pointing
 * here), and the hub/chat-session length check (via `isSkillLoadText` /
 * `exceedsUserInputCap`).
 *
 * Any relaxation lets oversized skill-loads hit `MAX_MESSAGE_CHARS = 8000`
 * (loading a 78KB SKILL.md would trip it immediately).
 */
export const SKILL_LOAD_PREFIX = '[skill-load name="';

/**
 * Short prefix used by the TUI's skip-display predicate — intentionally
 * broader than `SKILL_LOAD_PREFIX`: hides any `[skill-load ...]` shape (
 * including future variants) from user-visible history. Kept separate from
 * the closed-form check (`SKILL_LOAD_PREFIX`) so the two semantics don't mix.
 */
export const SKILL_LOAD_PREFIX_SHORT = "[skill-load ";

/**
 * Assemble one standard skill-load message:
 *   `[skill-load name="<name>"]\n<body>[+"\n\n<remainder>" if non-empty]`
 * Byte-identical to the existing TUI and web assembly behavior (web keeps its
 * local concatenation across the workspace boundary, with an SSOT comment
 * pointing here).
 */
export function buildSkillLoadText(
  name: string,
  body: string,
  remainder?: string
): string {
  const tail =
    remainder !== undefined && remainder.length > 0 ? `\n\n${remainder}` : "";
  return `[skill-load name="${name}"]\n${body}${tail}`;
}

/**
 * Is `text` a closed-form, machine-assembled skill-load message? Matches
 * `SKILL_LOAD_PREFIX` and requires the `name="..."` closing quote (rejects
 * half-typed prefixes). Used for the user-input length-cap exemption.
 */
export function isSkillLoadText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SKILL_LOAD_PREFIX)) return false;
  // Closed form requires the quote after `name="`; no constraint on name
  // characters (assembly always injects a catalog entry name, so this just
  // mirrors the TUI/web assembly shape).
  const after = trimmed.slice(SKILL_LOAD_PREFIX.length);
  return after.includes('"');
}

/**
 * Combined guard: should `text` be rejected for being too long? Encapsulates
 * trim policy + skill-load exemption + cap comparison so hub and chat-session
 * don't duplicate the expression. Semantics:
 *   - non-empty skill-load messages are never rejected (even when long);
 *   - other over-cap text is rejected;
 *   - empty text returns false (emptiness is caught by validateText upstream).
 *
 * The cap is passed in (default 8000, matching session-api `MAX_MESSAGE_CHARS`).
 * This file deliberately does not import that constant: `src/harness/` is a
 * low-level module and must not depend back on `src/session-api/`.
 */
export function exceedsUserInputCap(text: string, cap: number = 8000): boolean {
  const query = text.trim();
  if (query.length === 0) return false;
  if (isSkillLoadText(query)) return false;
  return query.length > cap;
}

/**
 * Strip frontmatter: return the text after the `---\n...\n---\n` block. The
 * shared fence strip is content-independent, so an invalid YAML block is
 * stripped the same way — the returned body is always an exact byte slice.
 */
export function stripFrontmatter(raw: string): string {
  return stripFence(raw).body;
}

/**
 * SSOT wording for the "current write root" segment, rendered per situation.
 * Shared verbatim by the skill body trailer, the subagent worker prior
 * (`priorMessagesFromEnvelope`), and the chat-session one-shot rebind
 * notification (`refreshChatDepsForRebind`) — there is only one copy of this
 * text.
 *
 * Semantics:
 *   - `writable_main` (isolation off) / `writable_tree` (isolation on +
 *     tree-shaped root) → byte-identical to the pre-refactor segment
 *     (including `current write root ...`). Shape judgment is the caller's
 *     (`writeSituation(isolationOn, root)`); this function does not re-check
 *     (body.ts must not import `isolation/`).
 *   - `no_writable_root` (isolation on + non-tree root) → fact-only
 *     disclosure: it does NOT name `create-worktree` (the trailer enters
 *     context at assembly time, before any write intent; naming the tool
 *     would push every unbound session toward creating a worktree) and does
 *     NOT embed `taskRoot` (there is nothing writable; pointing at a root
 *     would be wrong).
 *
 * Empty arm: blank `taskRoot` + writable situations → null (don't render a
 * "write root = " half-sentence); `no_writable_root` + empty root still
 * returns the disclosure (it doesn't depend on any root).
 */
export function writeRootSegment(
  situation: WriteSituation,
  taskRoot: string
): string | null {
  // Disclosure-only arm: facts, no root embedded — the trailer reaches the
  // model before any write intent exists.
  if (situation === "no_writable_root") {
    return NO_WRITE_ROOT_DISCLOSURE;
  }
  // Writable arms: byte-identical to the pre-refactor segment.
  const root = taskRoot.trim();
  if (root.length === 0) return null;
  return (
    `current write root (for write_file / edit_file / bash cwd): ${root}\n` +
    `System ## Project path is still the project identity root and is read-only; the write root above is where file mutations should land. Use relative paths from this root.`
  );
}

/**
 * No-writable-root disclosure: states four facts (isolation on, no worktree
 * bound, main checkout read-only for mutations, nothing writable right now)
 * without naming the worktree-creation tool or embedding any root. Static
 * literal so tests can assert it byte-for-byte.
 */
const NO_WRITE_ROOT_DISCLOSURE =
  `Worktree isolation is on for this session but no task worktree is bound: ` +
  `the main checkout is read-only for file mutations, so there is no writable ` +
  `root in scope right now.`;

/**
 * Assemble the skill body (frontmatter stripped + Base directory line +
 * `<skill_files>` segment). Same input twice yields the same string (KV-cache
 * contract).
 *
 * ADR-0079 — no write-root trailer is appended anymore; write-situation
 * disclosure lives in the worker prior (`src/harness/subagent/worker.ts`) and
 * the chat-session rebind notification, sharing the `writeRootSegment` helper.
 */
export async function createSkillBody(
  options: SkillBodyOptions
): Promise<string> {
  const { dir } = options;
  const fs = options.fs ?? defaultFs;
  const raw = await fs.readFile(join(dir, SKILL_BODY_FILE), "utf8");
  const body = stripFrontmatter(raw);
  const files = await collectSkillFiles(dir, fs);
  const skillsSegment = renderSkillFiles(files);

  const segments: string[] = [];
  if (body.length > 0) segments.push(body);
  segments.push(`Base directory: ${dir}`);
  segments.push(skillsSegment);
  return segments.join("\n\n");
}

/** All files under the skill dir except SKILL.md and references/ (absolute paths, sorted). */
async function collectSkillFiles(
  dir: string,
  fs: SkillBodyFs
): Promise<string[]> {
  const collected: string[] = [];
  await walk(dir, dir, collected, fs);
  collected.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return collected;
}

async function walk(
  root: string,
  current: string,
  collected: string[],
  fs: SkillBodyFs
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readDir(current);
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(current, entry.name);
    if (entry.isDirectory()) {
      // references/ is not recursed
      if (entry.name === REFERENCES_DIR) continue;
      // Skip common dependency/hidden dirs to avoid walking huge trees
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(root, child, collected, fs);
      continue;
    }
    if (!entry.isFile()) continue;
    // SKILL.md is excluded from its own file list
    if (current === root && entry.name === SKILL_BODY_FILE) continue;
    collected.push(child);
  }
}

/** Render the `<skill_files>` segment: one absolute path per line; >10 → truncate + sampled hint. */
function renderSkillFiles(files: ReadonlyArray<string>): string {
  const sampled = files.slice(0, SKILL_FILES_SAMPLE_LIMIT);
  const truncated = files.length > SKILL_FILES_SAMPLE_LIMIT;
  if (sampled.length === 0) {
    return "<skill_files>\n</skill_files>";
  }
  const body = sampled.join("\n");
  const hint = truncated ? "\nfile list is sampled" : "";
  return `<skill_files>\n${body}${hint}\n</skill_files>`;
}

// Keep `sep` imported without warning (reserved for platform-specific joins).
void sep;
