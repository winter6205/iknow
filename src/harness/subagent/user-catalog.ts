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
 *   - builtin 顺序在前（explore, general-purpose），user / plugin 按合并序
 *     追加在后；与 builtin 同名 id → warn + 跳过（builtin 权威 —— explore
 *     的 readonly 隔离等保证不被用户/插件目录静默替换）；
 *   - 缓存按 resolved agentsDir 记忆化（进程内一次扫描），测试用
 *     resetUserAgentsCache() 清缓存（同时清插件目录记忆化）。
 *
 * #global-plugins T1（§4.3）扩展：
 *   - ROLE_ID_PATTERN 放宽为 `^[A-Za-z0-9][A-Za-z0-9_:-]*$`（允许 `:` 命名空间）；
 *   - 插件 agent 来自 `<pluginRoot>/agents/*.md`，规范 id = `<plugin>:<basename>`；
 *   - 裸名别名仅在未与 builtin / user / 其他插件裸名冲突时登记，冲突 → 丢 + warn；
 *   - id 原样传递不变式（§4.3 ACR #6）: enum 由 list() 派生、模型按 enum
 *     原样传参、handler / capability 原样透传，零 normalize / trim / case-fold。
 *
 * 防御契约：目录缺失（ENOENT）→ 空数组（未配置 = 纯 builtin，字节级
 * 等价既有行为）；空 body / 非法 frontmatter 值 / 非法 id → warn + 降级
 * （description 兜底 / 键视为 undefined / skip 该文件），不 throw ——
 * 用户手写的角色文件不能炸掉 spawn 装配链。
 */
import { basename, join, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  AgentCatalogLookupError,
  resolveAgentCatalog,
  type AgentCatalogEntry,
  type AgentCatalogResolver,
} from "./catalog.js";
import {
  enumeratePluginAgentDirs,
  resolvePluginRoots,
} from "../plugin/roots.js";

/** 全局 agents 目录名（`<home>/.iknow/<dirname>`）。 */
const USER_AGENTS_DIRNAME = "agents";
/** 角色文件名（目录布局下目录内必须叫这个）。 */
const ROLE_FILENAME = "AGENTS.md";
/** description 截断上限（对齐 skill scanner 的 DESCRIPTION_LIMIT）。 */
const DESCRIPTION_LIMIT = 1536;
/**
 * 合法角色 id：字母/数字开头，只含字母数字 - _（进 enum + prose list 的面）。
 * #global-plugins T1: 允许 `:` 容纳 `<plugin>:<id>` 命名空间形态。
 */
const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;

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
  /**
   * #global-plugins T1：插件 agent 目录列表（绝对路径 = `<pluginRoot>/agents`）。
   * 缺省：createMergedCatalogResolver() 在调用时由 plugin/roots.ts 自解析
   * （env IKNOW_PLUGIN_ROOTS > settings.plugins.roots > ~/.iknow/plugins），
   * 保证 spawn 工具面与 capability 解析面同源（ACR #5）—— 测试可显式
   * 注入以隔离真实插件目录。
   */
  readonly pluginAgentDirs?: readonly string[];
  /**
   * #global-plugins T1：插件命名空间映射（pluginDir → pluginName），与
   * pluginAgentDirs 顺序一一对应。缺省时按 pluginAgentDirs[i] 的 basename
   * 父目录（即 `<pluginRoot>` basename）兜底推断（目录扫描形态）；
   * 测试注入可解耦（fixture 临时目录的 basename 未必是想要的插件名）。
   */
  readonly pluginNames?: readonly string[];
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
  // #global-plugins T1: 同步清插件 agent 缓存,否则 fixture 写入不会被
  // 同一进程的二次 createMergedCatalogResolver() 看见。
  pluginAgentsCache.clear();
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
 * 默认 catalog 源）。
 *
 * merge 顺序（§4.3）：builtin < user < plugins。builtin 权威 —— 任何
 * builtin 同名 id → warn + 跳过（user 与 plugin 同样规则）。裸名别名
 * 仅在未与 builtin / 用户 / 其他插件裸名冲突时登记。
 *
 * id 原样传递不变式（§4.3 ACR #6）：list() → 模型 → handler / capability
 * 三段间**零 normalize、零 trim、零大小写折叠**。get(id) 是数组 .find
 * 的引用比较 + 严格相等 —— id 字符串任何前置/后置空格或大小写差异都会
 * 命中 AgentCatalogLookupError（fail-fast）。该不变式由测试
 * `whitespace id not accepted` 钉死。
 *
 * 默认解析面：opts 未指定 pluginAgentDirs / pluginNames 时，
 * createMergedCatalogResolver 自解析插件根（plugin/roots.ts → env >
 * settings > ~/.iknow/plugins），保证 spawn 工具面与 capability 解析面
 * 同源（ACR #5）—— 调用方不传 opts 仍看见插件。
 *
 * 记忆化：user + plugin 各自按 resolved agentsDir / 插件根集 cache。
 * resetUserAgentsCache() 同时清两边。
 */
/**
 * 按 canonical id 去重追加（user 面）：builtin 占用 → warn + skip（builtin
 * 权威）；更早的 user / plugin entry 占用 → warn + skip（先到者赢）；
 * 否则登记 id 并追加。返回追加后的条目（调用方 push 进 merged）。
 */
function appendUniqueById(
  entries: ReadonlyArray<AgentCatalogEntry>,
  source: "user" | "plugin",
  builtinIds: ReadonlySet<string>,
  seenIds: Set<string>,
  warn: Warn
): AgentCatalogEntry[] {
  const appended: AgentCatalogEntry[] = [];
  for (const entry of entries) {
    if (builtinIds.has(entry.id)) {
      warn(
        `${source} agent '${entry.id}' collides with builtin catalog entry; builtin kept`
      );
      continue;
    }
    if (seenIds.has(entry.id)) {
      warn(
        `${source} agent '${entry.id}' collides with earlier entry; earlier kept`
      );
      continue;
    }
    seenIds.add(entry.id);
    appended.push(entry);
  }
  return appended;
}

/**
 * 插件 agent 追加：canonical id 走 `appendUniqueById` 同款纪律，另加裸名
 * 别名占用校验 —— 同名裸名已被 builtin / user / 其它插件占用 → 丢别名
 * （`stripBareAlias` 重构 entry：frozen 状态下不可 delete）；别名可用 →
 * 登记进 seenIds（先记 alias，后续 canonical 撞库即可直接判冲突）。
 */
function appendPluginEntries(
  entries: ReadonlyArray<AgentCatalogEntry>,
  builtinIds: ReadonlySet<string>,
  seenIds: Set<string>,
  warn: Warn
): AgentCatalogEntry[] {
  const appended: AgentCatalogEntry[] = [];
  for (const entry of entries) {
    if (builtinIds.has(entry.id)) {
      warn(
        `plugin agent '${entry.id}' collides with builtin catalog entry; builtin kept`
      );
      continue;
    }
    if (seenIds.has(entry.id)) {
      warn(
        `plugin agent '${entry.id}' collides with earlier entry; earlier kept`
      );
      continue;
    }
    seenIds.add(entry.id);
    appended.push(keepAliasOrStrip(entry, builtinIds, seenIds, warn));
  }
  return appended;
}

/** 单条 plugin entry 的裸名别名占用校验（见 `appendPluginEntries`）。 */
function keepAliasOrStrip(
  entry: AgentCatalogEntry,
  builtinIds: ReadonlySet<string>,
  seenIds: Set<string>,
  warn: Warn
): AgentCatalogEntry {
  const alias = entry.bareAlias;
  if (alias === undefined || alias.length === 0) return entry;
  if (builtinIds.has(alias) || seenIds.has(alias)) {
    warn(
      `plugin agent bare alias '${alias}' (canonical '${entry.id}') collides with earlier entry; alias dropped`
    );
    return stripBareAlias(entry);
  }
  seenIds.add(alias);
  return entry;
}

export function createMergedCatalogResolver(
  opts: UserAgentScanOptions = {}
): AgentCatalogResolver {
  const warn = opts.warn ?? console.warn;
  const userEntries = cachedUserEntries(opts);
  const pluginSources = resolvePluginAgentSources(opts);
  const pluginEntries = pluginSources.flatMap((source) =>
    cachedPluginEntries(source, warn)
  );
  const builtinIds = new Set(resolveAgentCatalog().map((e) => e.id));

  // 冲突消解（builtin 权威 + 裸名别名）：先按规范 id 排除 builtin 撞库，
  // 然后再对剩余 plugin / user 互相对裸名去重。
  const seenIds = new Set<string>();
  const merged: AgentCatalogEntry[] = [...resolveAgentCatalog()];

  merged.push(
    ...appendUniqueById(userEntries, "user", builtinIds, seenIds, warn)
  );

  // 插件 agent：每条 pluginEntry 已带 canonical id（"<plugin>:<basename>"）
  // 和 (可选) bareAlias（typed 字段，AgentCatalogEntry.bareAlias）。
  merged.push(...appendPluginEntries(pluginEntries, builtinIds, seenIds, warn));

  const frozen: ReadonlyArray<AgentCatalogEntry> = Object.freeze(merged);
  return Object.freeze({
    list: () => frozen,
    get: (id: string) => {
      // 严格按规范 id 查：list 已含 canonical + 携带 bareAlias 的 entry。
      // 若 id 是某 entry 的裸名别名（命中 bareAlias），返回该 entry。
      // 优先 canonical 命中 → 一次 find 即可；别名命中仅在 canonical 不
      // 命中时退化到线性扫 —— 顺序按 merge（builtin < user < plugin），
      // 别名冲突时前者赢。
      const direct = frozen.find((e) => e.id === id);
      if (direct !== undefined) return direct;
      const aliased = frozen.find((e) => e.bareAlias === id);
      if (aliased !== undefined) return aliased;
      throw new AgentCatalogLookupError(id);
    },
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// ─── plugin agent sources ────────────────────────────────────────────────────

/**
 * 解析 pluginAgentSources —— 测试注入优先；否则委托 plugin/roots.ts 走
 * env / settings / default-root 链路（ACR #5：两处解析面同源 = 两个
 * createMergedCatalogResolver() 默认调用都看见同一份插件集）。
 *
 * 默认路径走 `enumeratePluginAgentDirs`（sync，**ledger 优先 + 目录扫
 * 描兜底**，review C1）—— ledger 解析已同步化（`readFileSync` + 同样
 * 校验），不再依赖 T2 装配期 await 缓存。ledger 在场时直接以 ledger
 * key 前段（`@` 之前）为命名空间，目录扫描兜底仅在 ledger 缺 / 损坏
 * 时启用 → spawn enum 与 capability 解析面同源，命名空间不再漂移。
 */
function resolvePluginAgentSources(
  opts: UserAgentScanOptions
): ReadonlyArray<PluginAgentSource> {
  if (opts.pluginAgentDirs !== undefined) {
    return opts.pluginAgentDirs.map((dir, i) => ({
      dir,
      plugin: opts.pluginNames?.[i] ?? basename(resolve(dir)),
    }));
  }
  const rootsOpts: Parameters<typeof resolvePluginRoots>[0] = {
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
    ...(opts.home !== undefined ? { userHome: opts.home } : {}),
  };
  const pluginRoots = resolvePluginRoots(rootsOpts);
  if (pluginRoots.length === 0) return [];
  return enumeratePluginAgentDirs(pluginRoots, {
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
  });
}

/** 插件 agent 来源：pluginDir = <pluginRoot>/agents；plugin = 命名空间。 */
interface PluginAgentSource {
  readonly dir: string;
  readonly plugin: string;
}

/**
 * 进程内记忆化：key = resolved pluginDir。resetUserAgentsCache 同时清。
 */
const pluginAgentsCache = new Map<string, ReadonlyArray<AgentCatalogEntry>>();

function cachedPluginEntries(
  source: PluginAgentSource,
  warn: Warn
): ReadonlyArray<AgentCatalogEntry> {
  const cached = pluginAgentsCache.get(source.dir);
  if (cached !== undefined) return cached;
  const entries = loadPluginAgentEntries(source, warn);
  pluginAgentsCache.set(source.dir, entries);
  return entries;
}

/**
 * 扫描 `<pluginDir>`（即 `<pluginRoot>/agents`）下的角色文件：与
 * loadUserAgentEntries 同形（目录 / 平铺双形态），但只支持**平铺**
 * `<basename>.md` —— design §4.3 明确插件 agents 是平铺文件，不复用
 * 用户的目录布局。
 */
function loadPluginAgentEntries(
  source: PluginAgentSource,
  warn: Warn
): ReadonlyArray<AgentCatalogEntry> {
  let children;
  try {
    children = readdirSync(source.dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return Object.freeze([]);
    warn(`plugin agents scan skipped directory: ${source.dir}`);
    return Object.freeze([]);
  }

  const entries: AgentCatalogEntry[] = [];
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sorted) {
    // 插件 agents 仅平铺 .md 文件形态（design §4.3），目录布局由用户
    // agent 路径独占；插件目录下若放目录，silently skip。
    if (!child.isFile() || !MD_SUFFIX.test(child.name)) continue;
    const bare = child.name.replace(MD_SUFFIX, "");
    const canonicalId = `${source.plugin}:${bare}`;
    if (!ROLE_ID_PATTERN.test(canonicalId)) {
      warn(`plugin agent skipped invalid role id '${canonicalId}'`);
      continue;
    }
    const filePath = join(source.dir, child.name);
    const raw = readRoleSource(filePath, false, warn);
    if (raw === undefined) continue;
    const entry = parseRoleFile(canonicalId, raw, filePath, warn);
    if (entry === undefined) continue;
    // 裸名别名：typed 字段 `AgentCatalogEntry.bareAlias`（review C4），
    // 取代之前 `as unknown as { __bareAlias?: string }` 私有字段的
    // 走私形式。冻结前挂上（frozen 后赋值会抛 TypeError）。
    const withAlias = Object.freeze({
      ...entry,
      bareAlias: bare,
    }) as AgentCatalogEntry;
    entries.push(withAlias);
  }
  return Object.freeze(entries);
}

/**
 * 取消裸名别名 —— 通过 Object.freeze 替换为不携带该字段的新 entry。
 * entry 已 frozen；不能用 delete。spread 解构所有字段后丢掉 bareAlias
 * 重构。
 */
function stripBareAlias(entry: AgentCatalogEntry): AgentCatalogEntry {
  const { bareAlias: _stripped, ...rest } = entry;
  void _stripped;
  return Object.freeze(rest) as AgentCatalogEntry;
}
