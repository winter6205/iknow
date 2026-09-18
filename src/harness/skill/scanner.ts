import { readdir, readFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import {
  stripNamespace,
  type SkillEntry,
  type SkillFrontmatter,
} from "./catalog.js";

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

/**
 * #global-plugins T1：插件 skill 目录条目 —— scanner 必须能区分 entry
 * 来自哪条插件根，以便给 SkillEntry.namespace 字段打标签。`dir` 是插件
 * 的 `<root>/skills`，`plugin` 是该插件的命名空间前缀（即插件名）。
 */
export interface PluginSkillDir {
  readonly dir: string;
  readonly plugin: string;
}

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
  /**
   * #global-plugins T1：插件 skill 目录列表（绝对路径），每条带命名空间。
   * 扫描顺序 = user < project < **插件** < IKNOW_SKILL_DIRS（§4.2）——
   * 插件 skill 后于用户/项目但先于 env IKNOW_SKILL_DIRS 注册到 index，
   * env 路径上的同名 skill 最终覆盖插件 skill（更高优先级）。
   *
   * 缺省：空数组 —— 行为与今日逐字节一致（既有测试不变）。
   */
  pluginSkillDirs?: readonly PluginSkillDir[];
  /**
   * `skill-index-increment` T6：真 IO 故障（非 ENOENT）的观察缝。每次故障
   * 回调一次，**在 warn 之后**（warn 面不变）。缺席 = 既有行为逐字节不变：
   * 故障只 warn + 跳过，扫描不抛（装配期纪律）。
   *
   * 注入者（`skill/rescan.ts`）据此把残缺扫描升级成 typed 错误 —— 「贴给
   * 模型前」的容错取舍与「装配期不阻塞」相反，两条纪律靠本缝共存。
   */
  onIoFailure?: (failure: SkillIoFailure) => void;
}

export interface SkillScanner {
  scan(): Promise<SkillEntry[]>;
}

/**
 * `skill-index-increment` T6：真 IO 故障（非 ENOENT）的观察通道。
 *
 * scanner 既有纪律是「坏根/坏文件 → warn + 跳过，扫描不阻塞」（装配期
 * 不能让一个不可读目录掀掉整次 build）。rescan 缝需要相反的取舍：把
 * **当时热**的结果贴给模型前，残缺的扫描结果会被误读成「这些技能被删了」，
 * 所以故障必须能被调用方看见并按 typed 错误处置。两条纪律共存的办法是
 * 把「记一笔」与「怎么处置」分开：scanner 照旧包住 IO 故障（不抛），
 * 但把每次故障经本回调**原样**报给注入的观察者；不注入 = 既有 warn 行为
 * 逐字节不变（`SkillScannerOptions.onIoFailure` 缺省 absent）。
 */
export interface SkillIoFailure {
  /**
   * `root_unreadable` = 技能根目录本身 readdir 失败（整根缺席）；
   * `file_unreadable` = 单个 SKILL.md readFile 失败（该技能缺席）。
   */
  readonly kind: "root_unreadable" | "file_unreadable";
  /** 故障路径：根目录，或 `<dir>/SKILL.md`。 */
  readonly path: string;
  /** 底层 errno（`EACCES` / `EIO` …）；非 errno 故障退化为 `undefined`。 */
  readonly code: string | undefined;
  /** `Error#message`（非 Error 抛出物退化 `String(err)`）。 */
  readonly cause: string;
}

export function createSkillScanner(options: SkillScannerOptions): SkillScanner {
  return Object.freeze({ scan: () => scanSkillDirs(options) });
}

export async function scanSkillDirs(
  options: SkillScannerOptions
): Promise<SkillEntry[]> {
  const warn = options.warn ?? console.warn;
  /**
   * 唯一把 IO 故障转成观察事件的出口：先按既有纪律 warn + 跳过，再把
   * 事实原样交给可选观察者。两件事都做 —— warn 是既有装配期观测面
   * （测试与 log 都依赖），回调是 rescan 缝的 typed 出口。
   */
  const reportIoFailure: ReportIoFailure = (failure, message) => {
    warn(message);
    options.onIoFailure?.(failure);
  };
  const index = new Map<string, SkillEntry>();
  // 裸名别名 → 首次占据该裸名的 entry（design §4.2：裸名冲突 → 只
  // 留规范名 + warn）。review C5：scanner 在建 entry 时负责 warn（既
  // 维护 single 入口也避免下游 catalog 接口污染）；catalog 内部的
  // bareIndex 行为不变（同 hashmap 第二次 set 静默 noop）。
  const bareOwner = new Map<string, SkillEntry>();
  // 第一轮：user / project / plugin → 写入 index（同名后者赢，即 plugin 覆盖 user/project）
  for (const root of scanRoots(options)) {
    for (const entry of await scanRoot(
      root.dir,
      root.namespace,
      warn,
      reportIoFailure
    )) {
      registerBareAlias(entry, bareOwner, warn);
      index.set(entry.name, entry);
    }
  }
  // 第二轮：IKNOW_SKILL_DIRS（最高优先级，最后写入覆盖插件）
  for (const dir of extrasDirs(options.env)) {
    for (const entry of await scanRoot(dir, undefined, warn, reportIoFailure))
      index.set(entry.name, entry);
  }
  return [...index.values()];
}

/**
 * 裸名别名归属登记（review C5：scanner 在 entry 落地时负责 warn，
 * 维护 single 入口 + 避免下游 catalog 接口污染）。本函数只对插件
 * entry 触发；user / project entry 无 namespace 跳过。
 */
function registerBareAlias(
  entry: SkillEntry,
  bareOwner: Map<string, SkillEntry>,
  warn: Warn
): void {
  const namespace = entry.namespace;
  if (namespace === undefined) return;
  if (entry.namespace === entry.name) return;
  const bare = stripNamespace(entry.name, namespace);
  if (bare === undefined) return;
  if (!bareOwner.has(bare)) {
    bareOwner.set(bare, entry);
    return;
  }
  // EXIT: 裸名别名已被更早的 entry（builtin / user / 其它插件）
  // 占下 → 丢别名（catalog 内部仍登记 canonical，但
  // bareIndex 不再指向本条）+ warn 一次。规范名保留。
  const prior = bareOwner.get(bare)!;
  warn(
    `skill bare alias '${bare}' already taken by '${prior.name}'; namespace entry '${entry.name}' keeps canonical only`
  );
}

interface ScannedRoot {
  readonly dir: string;
  readonly namespace: string | undefined;
}

function scanRoots({
  userHome,
  projectIdentityRoot,
  pluginSkillDirs,
}: SkillScannerOptions): ReadonlyArray<ScannedRoot> {
  const plugins: ScannedRoot[] = (pluginSkillDirs ?? []).map((p) => ({
    dir: p.dir,
    namespace: p.plugin,
  }));
  return [
    { dir: join(userHome, ".iknow", "skills"), namespace: undefined },
    {
      dir: join(projectIdentityRoot, ".iknow", "skills"),
      namespace: undefined,
    },
    ...plugins,
  ];
}

/** 拆出 env IKNOW_SKILL_DIRS 列表，独立于常规根序以便优先级控制。 */
function extrasDirs(env: SkillEnv): string[] {
  return (env.IKNOW_SKILL_DIRS ?? "")
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => resolve(dir));
}

/**
 * 扫描单个根。`namespace` 在常规 user/project 根下为 undefined（命名空间
 * 字段不入 SkillEntry，entry.name 即 frontmatter 名 / 目录 basename）；插件
 * 根下走 namespace 分支，entry.name 拼装为 `<namespace>:<bare>` 规范名
 * （design §4.2），namespace 字段打标签供 catalog 索引裸名别名。
 */
async function scanRoot(
  root: string,
  namespace: string | undefined,
  warn: Warn,
  reportIoFailure: ReportIoFailure
): Promise<SkillEntry[]> {
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    reportIoFailure(
      toIoFailure("root_unreadable", root, error),
      `skill scan skipped directory: ${root}`
    );
    return [];
  }

  const entries: SkillEntry[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const dir = join(root, child.name);
    const parsed = await readSkill(dir, warn, reportIoFailure);
    if (parsed === undefined) continue;
    if (namespace !== undefined) {
      // 插件 skill：entry.name 取自 frontmatter（首选）或目录 basename 作
      // 裸名；catalog 索引要求 name 字段已是规范名 `<plugin>:<bare>`。
      const bare =
        typeof parsed.frontmatter.name === "string" && parsed.frontmatter.name
          ? parsed.frontmatter.name
          : basename(dir);
      const entry: SkillEntry = {
        ...parsed.entry,
        name: `${namespace}:${bare}`,
        namespace,
      };
      entries.push(entry);
    } else {
      entries.push(parsed.entry);
    }
  }
  return entries;
}

async function readSkill(
  dir: string,
  warn: Warn,
  reportIoFailure: ReportIoFailure
): Promise<{ entry: SkillEntry; frontmatter: SkillFrontmatter } | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    const file = join(dir, "SKILL.md");
    reportIoFailure(
      toIoFailure("file_unreadable", file, error),
      `skill skipped unreadable file: ${file}`
    );
    return undefined;
  }

  const match = FRONTMATTER.exec(raw);
  if (!match) {
    warn(`skill skipped malformed frontmatter: ${join(dir, "SKILL.md")}`);
    return undefined;
  }
  const frontmatter = parseFrontmatter(match[1], dir, warn);
  return { entry: toEntry(frontmatter, dir, warn), frontmatter };
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

/** 故障观察缝的内部签名：一次故障同时给出结构化事实与既有 warn 文案。 */
type ReportIoFailure = (failure: SkillIoFailure, message: string) => void;

/**
 * 原始抛出物 → `SkillIoFailure`。`code` 只在抛出物是真 Error 且带
 * `code` 字段时取值（errno 形态）；其余（非 Error / 无 code）退化为
 * `undefined` —— 调用方按 `kind` + `path` 分型，不依赖 code 必然在场。
 */
function toIoFailure(
  kind: SkillIoFailure["kind"],
  path: string,
  error: unknown
): SkillIoFailure {
  return {
    kind,
    path,
    code:
      error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined,
    cause: error instanceof Error ? error.message : String(error),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
