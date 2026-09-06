/**
 * user agents 目录 — `~/.iknow/agents/` 下的自定义 subagent 角色文件。
 *
 * 角色文件 = AGENTS.md（与 skill 的 `<dir>/SKILL.md` 约定同构），两种布局：
 *   - `~/.iknow/agents/<id>/AGENTS.md`（每角色一个目录）
 *   - `~/.iknow/agents/<id>.md`（平铺文件，id 取 basename）
 *
 * 文件格式：可选 `---` frontmatter，支持键 `description`（string）、
 * `bashMode`（"any" | "readonly"）、`disallowedTools`（逗号分隔工具名）；
 * frontmatter 之后的正文 = persona body（注入 worker system prompt 的
 * persona 段，与 builtin catalog body 同通道）。无 frontmatter → 整文件
 * 都是 body，description 兜底 `User-defined subagent role '<id>'.`。
 *
 * 扫描必须**同步**：spawn_subagent 工厂在装配期同步从 `catalog.list()`
 * 派生 inputSchema enum + prose list（#556 T3 契约），异步扫描会错过
 * enum 构建时机。目录小（几个文件），readdirSync 代价可忽略。
 *
 * merge 语义（createMergedCatalogResolver）：
 *   - builtin 顺序在前（explore, general-purpose），user 新 id 按扫描序
 *     追加在后；user 同名 id 与 builtin 冲突 → warn + 跳过（保留 builtin
 *     权威 —— explore 的 readonly 隔离等保证不被用户目录静默替换）；
 *   - 缓存按 resolved agentsDir 记忆化（进程内一次扫描），测试用
 *     resetUserAgentsCache() 清缓存。
 *
 * 防御契约：目录缺失（ENOENT）→ 空数组（未配置 = 纯 builtin，字节级
 * 等价既有行为）；空 body / 非法 frontmatter 值 / 非法 id → warn + 降级
 * （description 兜底 / 键视为 undefined / skip 该文件），不 throw ——
 * 用户手写的角色文件不能炸掉 spawn 装配链。
 */
import { join, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  AgentCatalogLookupError,
  resolveAgentCatalog,
  type AgentCatalogEntry,
  type AgentCatalogResolver,
} from "./catalog.js";

/** 全局 agents 目录名（`<home>/.iknow/<dirname>`）。 */
const USER_AGENTS_DIRNAME = "agents";
/** 角色文件名（目录布局下目录内必须叫这个）。 */
const ROLE_FILENAME = "AGENTS.md";
/** description 截断上限（对齐 skill scanner 的 DESCRIPTION_LIMIT）。 */
const DESCRIPTION_LIMIT = 1536;
/** 合法角色 id：字母/数字开头，只含字母数字 - _（进 enum + prose list 的面）。 */
const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MD_SUFFIX = /\.md$/i;

type Warn = (message: string) => void;

export interface UserAgentScanOptions {
  /** 用户 home，默认 os.homedir()。测试缝：tmp fixture 隔离真实用户目录。 */
  readonly home?: string;
  /** 整个 agents 目录路径的显式覆盖（测试缝），优先级高于 home。 */
  readonly agentsDir?: string;
  /** warn 通道，默认 console.warn。 */
  readonly warn?: Warn;
}

export function resolveUserAgentsDir(opts: UserAgentScanOptions = {}): string {
  if (opts.agentsDir !== undefined) return resolve(opts.agentsDir);
  return join(opts.home ?? homedir(), ".iknow", USER_AGENTS_DIRNAME);
}

/** 单文件解析出的 (frontmatter, body)；无 frontmatter 时 frontmatter 为空。 */
function splitFrontmatter(
  raw: string,
  filePath: string,
  warn: Warn
): { frontmatter: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }
  return {
    frontmatter: parseFrontmatterBlock(match[1], filePath, warn),
    body: raw.slice(match[0].length).trim(),
  };
}

/**
 * frontmatter 键值解析：`key: scalar` 逐行（对齐 skill scanner 的
 * parseFrontmatter 形态）。这里所有键都是 string 语义，不做 scalar() 的
 * number/boolean 转换 —— bashMode/disallowedTools 都是字符串字面。
 */
function parseFrontmatterBlock(
  block: string,
  filePath: string,
  warn: Warn
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!key) {
      if (line.trim()) {
        warn(`user agent skipped malformed frontmatter line: ${filePath}`);
      }
      continue;
    }
    parsed[key] = line.slice(separator + 1).trim();
  }
  return parsed;
}

function parseDescription(
  frontmatter: Record<string, string>,
  filePath: string,
  warn: Warn
): string | undefined {
  const raw = frontmatter.description;
  if (raw === undefined || raw === "") return undefined;
  if (raw.length <= DESCRIPTION_LIMIT) return raw;
  warn(`user agent description truncated: ${filePath}`);
  return raw.slice(0, DESCRIPTION_LIMIT);
}

function parseBashMode(
  frontmatter: Record<string, string>,
  filePath: string,
  warn: Warn
): AgentCatalogEntry["bashMode"] {
  const raw = frontmatter.bashMode;
  if (raw === "readonly" || raw === "any") return raw;
  if (raw !== undefined) {
    warn(`user agent ignored invalid bashMode '${raw}': ${filePath}`);
  }
  return undefined;
}

function parseDisallowedTools(
  frontmatter: Record<string, string>,
  filePath: string,
  warn: Warn
): ReadonlyArray<string> | undefined {
  const raw = frontmatter.disallowedTools;
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    warn(`user agent ignored empty disallowedTools: ${filePath}`);
    return undefined;
  }
  return Object.freeze(names);
}

/** 单个角色文件 → entry。解析失败（空 body）→ undefined（调用方 skip）。 */
function parseRoleFile(
  id: string,
  raw: string,
  filePath: string,
  warn: Warn
): AgentCatalogEntry | undefined {
  const { frontmatter, body } = splitFrontmatter(raw, filePath, warn);
  if (body.length === 0) {
    warn(`user agent skipped empty body: ${filePath}`);
    return undefined;
  }
  const description =
    parseDescription(frontmatter, filePath, warn) ??
    `User-defined subagent role '${id}'.`;
  const bashMode = parseBashMode(frontmatter, filePath, warn);
  const disallowedTools = parseDisallowedTools(frontmatter, filePath, warn);
  return Object.freeze({
    id,
    description,
    body,
    ...(bashMode !== undefined ? { bashMode } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
  });
}

/**
 * 读单个角色文件源码。`missingIsSilent`：目录布局下缺 AGENTS.md = 不是
 * 角色目录，静默跳过（对齐 skill scanner 对无 SKILL.md 目录的宽容）；
 * 平铺文件读失败则 warn。其他读错误一律 warn。
 */
function readRoleSource(
  filePath: string,
  missingIsSilent: boolean,
  warn: Warn
): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (!(isMissing(error) && missingIsSilent)) {
      warn(`user agent skipped unreadable file: ${filePath}`);
    }
    return undefined;
  }
}

/** dirent → 角色位置 (id + 文件路径)。非角色形态（目录无 AGENTS.md 约定由读端处理 / 非 md 文件）→ undefined。 */
function childRoleLocation(
  root: string,
  child: { isDirectory(): boolean; isFile(): boolean; name: string }
): { id: string; filePath: string } | undefined {
  if (child.isDirectory()) {
    return { id: child.name, filePath: join(root, child.name, ROLE_FILENAME) };
  }
  if (child.isFile() && MD_SUFFIX.test(child.name)) {
    return {
      id: child.name.replace(MD_SUFFIX, ""),
      filePath: join(root, child.name),
    };
  }
  return undefined;
}

/**
 * 同步扫描 `~/.iknow/agents/`。目录缺失 → []（静默）；其他 readdir 错误
 * → warn + []。dirent 按名字排序保证 dir 与平铺文件 id 冲突时结果确定
 * （先到者赢，后者 warn 丢弃）。
 */
export function loadUserAgentEntries(
  opts: UserAgentScanOptions = {}
): ReadonlyArray<AgentCatalogEntry> {
  const warn = opts.warn ?? console.warn;
  const root = resolveUserAgentsDir(opts);
  let children;
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    warn(`user agents scan skipped directory: ${root}`);
    return [];
  }

  const entries: AgentCatalogEntry[] = [];
  const seenIds = new Set<string>();
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sorted) {
    const location = childRoleLocation(root, child);
    if (location === undefined) continue;
    if (!ROLE_ID_PATTERN.test(location.id)) {
      warn(`user agent skipped invalid role id '${location.id}'`);
      continue;
    }
    if (seenIds.has(location.id)) {
      warn(
        `user agent id '${location.id}' already defined; skipped: ${location.filePath}`
      );
      continue;
    }
    const raw = readRoleSource(location.filePath, child.isDirectory(), warn);
    if (raw === undefined) continue;
    const entry = parseRoleFile(location.id, raw, location.filePath, warn);
    if (entry === undefined) continue;
    seenIds.add(location.id);
    entries.push(entry);
  }
  return entries;
}

/**
 * 进程内记忆化缓存：key = resolved agentsDir。目录内容在进程生命周期内
 * 读一次（spawn 装配 / worker 装配各命中一次），改动目录需重启进程生效；
 * 测试写入 fixture 后必须先 resetUserAgentsCache()。
 */
const userAgentsCache = new Map<string, ReadonlyArray<AgentCatalogEntry>>();

export function resetUserAgentsCache(): void {
  userAgentsCache.clear();
}

function cachedUserEntries(
  opts: UserAgentScanOptions
): ReadonlyArray<AgentCatalogEntry> {
  const root = resolveUserAgentsDir(opts);
  const cached = userAgentsCache.get(root);
  if (cached !== undefined) return cached;
  const entries = loadUserAgentEntries(opts);
  userAgentsCache.set(root, entries);
  return entries;
}

/**
 * builtin + user 合并 resolver（spawn 工具 / capability / worker 共用的
 * 默认 catalog 源）。user 新 id 按扫描序追加；与 builtin 同名 id → warn +
 * 跳过（builtin 权威，防 explore readonly 等保证被静默替换）。返回 frozen
 * resolver；merge 结果按 agentsDir 记忆化。
 */
export function createMergedCatalogResolver(
  opts: UserAgentScanOptions = {}
): AgentCatalogResolver {
  const userEntries = cachedUserEntries(opts);
  const builtinIds = new Set(resolveAgentCatalog().map((e) => e.id));
  const appended = userEntries.filter((entry) => {
    if (!builtinIds.has(entry.id)) return true;
    (opts.warn ?? console.warn)(
      `user agent '${entry.id}' collides with builtin catalog entry; builtin kept`
    );
    return false;
  });
  const merged: ReadonlyArray<AgentCatalogEntry> = Object.freeze([
    ...resolveAgentCatalog(),
    ...appended,
  ]);
  return Object.freeze({
    list: () => merged,
    get: (id: string) => {
      const entry = merged.find((e) => e.id === id);
      if (entry === undefined) {
        throw new AgentCatalogLookupError(id);
      }
      return entry;
    },
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
