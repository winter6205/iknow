// #337 T6: skill 正文装配 (`src/harness/skill/body.ts`)。
//
// 装配形态（spec 337-skill-mcp-extension.md § Code Style + SC6）：
//   - 正文 = frontmatter 剥离后正文 + `Base directory: <abs dir>` 提示行
//     + `<skill_files>` 段（glob `**/*` 排除 SKILL.md、排序、采样 ≤10、
//     绝对路径、"file list is sampled" 提示）。
//   - references/ 不递归（SC6）。
//   - 字节级稳定：同输入二次调用字符串相等（KV 缓存契约）。
//
// 本模块依赖注入 `readDir` / `readFile` 形 test seam（默认 `node:fs/promises`）
// 便于单测在 tmp 目录构造 SKILL.md / 辅助文件 + 走全路径；不引入 glob 依赖。
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, sep } from "node:path";

import type { SkillEntry } from "./catalog.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** skill_files 段最大采样数（spec SC6）。 */
export const SKILL_FILES_SAMPLE_LIMIT = 10;

/** references/ 目录名 — 此目录不递归进 skill_files。 */
const REFERENCES_DIR = "references";

/** SKILL.md 文件名 — 不出现在 skill_files 清单里。 */
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
  readonly fs?: SkillBodyFs;
}

/** 剥离 frontmatter：返回去掉 `---\n...\n---\n` 块之后剩余正文。 */
export function stripFrontmatter(raw: string): string {
  const match = FRONTMATTER.exec(raw);
  if (!match) return raw;
  return raw.slice(match[0].length);
}

/**
 * 装配 skill 正文（frontmatter 剥离 + Base directory 行 + `<skill_files>` 段）。
 * 同输入两次调用字符串相等（KV 缓存契约）。
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

/** 列出 skill 目录下除 SKILL.md + references/ 之外的所有文件（绝对路径，排序）。 */
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
      // SC6: references/ 不递归
      if (entry.name === REFERENCES_DIR) continue;
      // 跳过常见依赖/隐藏目录，避免大仓库遍历（spec 未强制，按最小原则）
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(root, child, collected, fs);
      continue;
    }
    if (!entry.isFile()) continue;
    // SKILL.md 排除
    if (current === root && entry.name === SKILL_BODY_FILE) continue;
    collected.push(child);
  }
}

/** 渲染 `<skill_files>` 段：每行一个绝对路径；>10 个时截断 + sampled 提示。 */
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

// 触发 `sep` 不被未用导入警告（不同平台 path 拼接可能引入差异，备用）
void sep;
