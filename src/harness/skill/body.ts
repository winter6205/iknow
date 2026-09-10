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
import type { WriteSituation } from "../session-roots.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** skill_files 段最大采样数（spec SC6）。 */
export const SKILL_FILES_SAMPLE_LIMIT = 10;

/** references/ 目录名 — 此目录不递归进 skill_files。 */
const REFERENCES_DIR = "references";

/**
 * 337 装配形态双标记（skill-body-short-circuit spec）：成功全文 tool_result
 * 必然同时含 `Base directory:` 与 `</skill_files>`。recognizer（ACI skill()
 * 二次短路）与装配 SSOT 共源 —— 改装配形态必须同步这两个字面量。
 */
export const SKILL_BODY_MARKERS = {
  /** createSkillBody 渲染的 `Base directory: <dir>` 提示行前缀。 */
  baseDirectory: "Base directory:",
  /** `<skill_files>` 段闭合标签。 */
  skillFilesClose: "</skill_files>",
} as const;

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
   * ADR-0079 — skill 正文不再挂写根 trailer（与 337 SC6 形态逐字节一致：
   * frontmatter 剥离 + Base directory 行 + `<skill_files>` 段）。
   * 写处境披露的权威路径迁到 worker prior（`src/harness/subagent/worker.ts`
   * 与 `chat-session.ts` rebind 通知）—— 共用同一 helper `writeRootSegment`，
   * 但不再追加进 skill 正文装配结果。SkillBodyOptions 不再接受 `writeSituation` /
   * `taskRoot` 字段。
   */
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
 * T4 (plans/write-situation-disclosure.md) — 「当前写根」段文案 SSOT，按
 * 处境三态渲染。skill 正文 trailer、子代理 worker prior
 * （`priorMessagesFromEnvelope`）、chat-session rebind 一次性通知
 * （`refreshChatDepsForRebind`）三处共用同一份字节。spec
 * skill-load-write-root.md 合同 1「文案只有一份」。
 *
 * 语义（spec SC1-SC3 / ADR-0069 Decision 2/3）：
 *   - `writable_main`（隔离 OFF）/ `writable_tree`（隔离 ON + 树形根）→
 *     返回与改造前**逐字节相等**的写根段（含 `current write root ...`）。
 *     形状判断由调用方的 `writeSituation(isolationOn, root)` 承担，本函数
 *     不重复判定（SC4 依赖方向钉死：`body.ts` 不 import `isolation/`）。
 *   - `no_writable_root`（隔离 ON + 非树形根）→ ③ 态披露：仅陈述事实，
 *     **不点名** `create-task-worktree`（ADR-0069 D3：trailer 在装配时
 *     进上下文，早于任何写意图；点名工具 = 对每个未绑会话推一次建树），
 *     **不嵌入** `taskRoot`（无可写对象，指向根是错的）。
 *
 * empty 臂：`taskRoot` 空 / 空白 + `writable_main` / `writable_tree` → null
 * （不渲染「写根 = 」半句，A 表 empty 臂）；`no_writable_root` + 空根 → 仍
 * 返回披露（披露与根无关，typed 不 throw）。
 */
export function writeRootSegment(
  situation: WriteSituation,
  taskRoot: string
): string | null {
  // ③ 态：纯披露，不嵌入根。SC3 / ADR-0069 D3 — trailer 在装配时进上下文，
  // 早于任何写意图；点名工具 = 对每个未绑会话推一次建树（更激进）。
  if (situation === "no_writable_root") {
    return NO_WRITE_ROOT_DISCLOSURE;
  }
  // ① / ②: 与改造前逐字节相等（SC2 硬约束）。
  const root = taskRoot.trim();
  if (root.length === 0) return null;
  return (
    `current write root (for write_file / edit_file / bash cwd): ${root}\n` +
    `System ## Project path is still the project identity root and is read-only; the write root above is where file mutations should land. Use relative paths from this root.`
  );
}

/**
 * ③ 态披露文案（spec SC3 / ADR-0069 D3）：陈述「隔离开着、未绑树、主仓对
 * 文件改动只读、此刻无可写根」四个事实，不点名建树工具，不嵌入任何根。
 * 静态字面量（不随绑定 / 隔离开关漂移），便于单测做字节断言。
 */
const NO_WRITE_ROOT_DISCLOSURE =
  `Worktree isolation is on for this session but no task worktree is bound: ` +
  `the main checkout is read-only for file mutations, so there is no writable ` +
  `root in scope right now.`;

/**
 * 装配 skill 正文（frontmatter 剥离 + Base directory 行 + `<skill_files>` 段）。
 * 同输入两次调用字符串相等（KV 缓存契约）。
 *
 * ADR-0079 — 不再追加写根 trailer。写处境披露的权威路径迁到 worker prior
 * （`src/harness/subagent/worker.ts` 与 `src/cli/chat-session.ts` rebind 通知），
 * 共用同一 helper `writeRootSegment`。skill 正文装配只保留 skill 自身的两
 * 段（Base directory 行 + skill_files 段），与 #337 SC6 形态逐字节一致。
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
