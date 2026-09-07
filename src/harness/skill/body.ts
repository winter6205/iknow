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
  /**
   * 活 `taskRoot`（写根）快照。非空 → 正文末尾（`</skill_files>` 之后）追加
   * 与子代理 prior 同一 helper 的写根段（specs/skill-load-write-root.md）；
   * 缺席 / 空白 → 无 trailer（与 337 SC6 现形态逐字节一致）。生产调用方
   * （TUI slash / hub loadSkillBody / ACI skill 工具）必须在调用时机读活
   * cell 传入，不得传装配期冻结值。
   */
  readonly taskRoot?: string;
  readonly fs?: SkillBodyFs;
}

/**
 * 单一权威格式来源（SSOT）—— skill-load 消息前缀必须经此常量。三处共
 * 用同一字面量：
 *   - TUI 装配（`src/tui/app.tsx:1780`，经 `buildSkillLoadText`）
 *   - Web 装配（`web/src/hooks/use-slash-commands.ts:251`，跨 workspace
 *     边界所以本侧无法 import 留本地常量 + SSOT 注释）
 *   - hub/chat-session 长度校验（经 `isSkillLoadText` / `exceedsUserInputCap`）
 *
 * 任何放宽都会让超长 skill-load 撞 `MAX_MESSAGE_CHARS = 8000`（78KB 的
 * SKILL.md 加载会立即触发）。
 */
export const SKILL_LOAD_PREFIX = '[skill-load name="';

/**
 * TUI `session-state.ts:319` 显示跳过谓词用的短前缀 —— 语义略宽于
 * `SKILL_LOAD_PREFIX`：识别任何 `[skill-load ...]` 形态以从用户可见历史中
 * 屏蔽（含潜在的 `[skill-load reload=...]` 等未来变体）。与具体闭合形态
 * 的判定（`SKILL_LOAD_PREFIX`）保持两套，避免混淆两套语义。
 */
export const SKILL_LOAD_PREFIX_SHORT = "[skill-load ";

/**
 * 装配一条标准 skill-load 消息。返回形态：
 *   `[skill-load name="<name>"]\n<body>[+"\n\n<remainder>" if non-empty]`
 * 与 `src/tui/app.tsx:1780-1782` 与 `web/src/hooks/use-slash-commands.ts:251-253`
 * 现有 byte 级行为完全一致（web 因跨 workspace 边界无法共用，保留其本地拼
 * 接但 SSOT 注释指向本函数）。
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
 * 判定 `text` 是否为闭合形态的机器装配 skill-load 消息。前缀匹配
 * `SKILL_LOAD_PREFIX`，且 `name="..."` 必须用双引号闭合（拒绝半截前缀）。
 * 用于 hub/chat-session 的用户输入长度上限豁免判定。
 */
export function isSkillLoadText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SKILL_LOAD_PREFIX)) return false;
  // SKILL_LOAD_PREFIX 长度 = "[skill-load name=\"".length。
  // 闭合形态：`name="..."` 至少要有引号闭合（暂不约束 name 内容字符集，
  // 与 TUI/Web 装配形态一致即可 —— 装配路径已固定 `${name}` 是 catalog 条目名）。
  const after = trimmed.slice(SKILL_LOAD_PREFIX.length);
  return after.includes('"');
}

/**
 * 组合守卫：`text` 是否应触发「长度超限」拒绝判定。封装 trim 策略 +
 * skill-load 豁免 + 上限比较三处共用逻辑，避免 hub 与 chat-session 两侧
 * 重复同一表达式。返回值语义：
 *   - 非空 skill-load 消息 → 永不拒绝（即使超长）
 *   - 其余超长 → 拒绝
 *   - 空 → 由调用方另行判空；本函数对空文本返回 false（不拒绝，因空已
 *     在 validateText 的非空校验里被拦截）。
 *
 * 上限值由调用方传入（默认 8000，对齐 session-api `MAX_MESSAGE_CHARS`）。
 * 本函数刻意不 import 该常量以遵守 Gate B：`src/harness/` 是底层能力
 * 模块，不可反向依赖 `src/session-api/`。
 */
export function exceedsUserInputCap(text: string, cap: number = 8000): boolean {
  const query = text.trim();
  if (query.length === 0) return false;
  if (isSkillLoadText(query)) return false;
  return query.length > cap;
}

/** 剥离 frontmatter：返回去掉 `---\n...\n---\n` 块之后剩余正文。 */
export function stripFrontmatter(raw: string): string {
  const match = FRONTMATTER.exec(raw);
  if (!match) return raw;
  return raw.slice(match[0].length);
}

/**
 * 「当前写根」段文案 SSOT —— skill 正文 trailer 与子代理 worker prior
 * （`priorMessagesFromEnvelope`）共用同一份字节。spec
 * skill-load-write-root.md：两处各写一套长句会漂移，故文案只有本函数。
 * 传入根为空 / 空白 → 返回 null（调用方不注入任何段）。
 */
export function writeRootSegment(taskRoot: string): string | null {
  const root = taskRoot.trim();
  if (root.length === 0) return null;
  return (
    `current write root (for write_file / edit_file / bash cwd): ${root}\n` +
    `System ## Project path is still the project identity root and is read-only; the write root above is where file mutations should land. Use relative paths from this root.`
  );
}

/**
 * 装配 skill 正文（frontmatter 剥离 + Base directory 行 + `<skill_files>` 段
 * + 可选写根 trailer）。同输入两次调用字符串相等（KV 缓存契约）。
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
  const writeRoot =
    options.taskRoot !== undefined ? writeRootSegment(options.taskRoot) : null;
  if (writeRoot !== null) segments.push(writeRoot);
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
