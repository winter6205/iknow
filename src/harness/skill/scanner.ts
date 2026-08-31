import { readdir, readFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import type { SkillEntry, SkillFrontmatter } from "./catalog.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const DESCRIPTION_LIMIT = 1536;
const ARCHIVED_KEYS = [
  "source",
  "version",
  "tags",
  "author",
  "license",
  "metadata",
] as const;

type SkillEnv = Readonly<Record<string, string | undefined>>;
type Warn = (message: string) => void;

export interface SkillScannerOptions {
  userHome: string;
  /**
   * T3 (plans/worktree-session-roots.md / ADR-0037 §4): the session's
   * `projectIdentityRoot` — the project the user is working on, pinned once
   * at startup and stable across worktree rebinds. Project skills are project
   * identity, so a worktree rebind must not move the scan onto the
   * gitignored task worktree (where the directory is simply absent).
   */
  projectIdentityRoot: string;
  env: SkillEnv;
  warn?: Warn;
}

export interface SkillScanner {
  scan(): Promise<SkillEntry[]>;
}

export function createSkillScanner(options: SkillScannerOptions): SkillScanner {
  return Object.freeze({ scan: () => scanSkillDirs(options) });
}

export async function scanSkillDirs(
  options: SkillScannerOptions
): Promise<SkillEntry[]> {
  const warn = options.warn ?? console.warn;
  const index = new Map<string, SkillEntry>();
  for (const root of scanRoots(options)) {
    for (const entry of await scanRoot(root, warn))
      index.set(entry.name, entry);
  }
  return [...index.values()];
}

function scanRoots({
  userHome,
  projectIdentityRoot,
  env,
}: SkillScannerOptions): string[] {
  const extras = (env.IKNOW_SKILL_DIRS ?? "")
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => resolve(dir));
  return [
    join(userHome, ".iknow", "skills"),
    join(projectIdentityRoot, ".iknow", "skills"),
    ...extras,
  ];
}

async function scanRoot(root: string, warn: Warn): Promise<SkillEntry[]> {
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    warn(`skill scan skipped directory: ${root}`);
    return [];
  }

  const entries: SkillEntry[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const dir = join(root, child.name);
    const parsed = await readSkill(dir, warn);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

async function readSkill(
  dir: string,
  warn: Warn
): Promise<SkillEntry | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    warn(`skill skipped unreadable file: ${join(dir, "SKILL.md")}`);
    return undefined;
  }

  const match = FRONTMATTER.exec(raw);
  if (!match) {
    warn(`skill skipped malformed frontmatter: ${join(dir, "SKILL.md")}`);
    return undefined;
  }
  return toEntry(parseFrontmatter(match[1], dir, warn), dir, warn);
}

function parseFrontmatter(
  block: string,
  dir: string,
  warn: Warn
): SkillFrontmatter {
  const parsed: Record<string, unknown> = {};
  let skipped = false;
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!key) {
      if (line.trim()) skipped = true;
      continue;
    }
    parsed[key] = scalar(line.slice(separator + 1).trim());
  }
  if (skipped)
    warn(`skill skipped malformed frontmatter line: ${join(dir, "SKILL.md")}`);
  return parsed as SkillFrontmatter;
}

function toEntry(
  frontmatter: SkillFrontmatter,
  dir: string,
  warn: Warn
): SkillEntry {
  let description =
    typeof frontmatter.description === "string"
      ? frontmatter.description
      : undefined;
  if (description && description.length > DESCRIPTION_LIMIT) {
    description = description.slice(0, DESCRIPTION_LIMIT);
    warn(`skill description truncated: ${join(dir, "SKILL.md")}`);
  }
  const entry: SkillEntry = {
    name:
      typeof frontmatter.name === "string" && frontmatter.name
        ? frontmatter.name
        : basename(dir),
    description,
    dir,
    disabled: frontmatter["disable-model-invocation"] === true,
  };
  for (const key of ARCHIVED_KEYS) {
    const value = frontmatter[key];
    if (value !== undefined)
      (entry as unknown as Record<string, unknown>)[key] = value;
  }
  return entry;
}

function scalar(raw: string): string | number | boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const number = Number(raw);
  return raw !== "" && Number.isFinite(number) ? number : raw;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
