/**
 * 全局插件组件加载 — discovery 层（roots + 插件识别）。
 *
 * 设计边界（plans/global-plugins-loading.md §3 / §4.1 / §12 T1）：
 *   - 本模块**只产数据**，不装配（不 import skill/ subagent/ hooks/ permission/）。
 *   - 三个组件主各自消费本模块的输出，扩展自己的解析/命名/合并纪律。
 *   - 单向依赖：skill/subagent/hooks → plugin，plugin 不反向依赖任何组件主。
 *   - 与 `session-roots.ts` 正交：本模块根是**组件来源**，不是会话根，
 *     不参与 ADR-0037/0019 的 fence 计算、不受 worktree rebind 影响。
 *
 * 根解析顺序（resolvePluginRoots，§3.1）：
 *   1. 显式注入 `opts.pluginRoots`（测试缝）；
 *   2. 环境变量 `IKNOW_PLUGIN_ROOTS`（path.delimiter 分隔）；
 *   3. 用户设置 `plugins.roots`；
 *   4. 默认 `<userHome>/.iknow/plugins`。
 *   顺序合并 + 去重，缺/不存在的根静默跳过（未配置 = 合法态，非降级）。
 *
 * 插件识别（discoverPlugins，§3.2）两路同构（都产 PluginInstallation[]）：
 *   - ledger 优先：`<root>/installed_plugins.json` 给出精确名 + 任意深度
 *     installPath，key 前段（`@` 之前）= 插件命名空间。同 key 多条：
 *     `scope === "user"` 优先，否则取末项；installPath 缺/非绝对/不可读
 *     → 跳过 + warn（plugin-init）。JSON 损坏 → 整个文件 skip + warn，落
 *     目录扫描兜底。
 *   - 目录扫描兜底：根下每个直接子目录 D，含 skills/agents/hooks 任一 →
 *     D 是插件名 = basename(D)；否则若 D 恰有一个子目录 V 含组件目录 →
 *     插件 = V，名仍 = basename(D)（用户视角以丢入目录名为准）。
 *
 * 跳过规则（两路通用）：node_modules/、.git/、以 `.` 开头、含 `:`（WSL
 * 影子产物）、符号链接不跟随。
 *
 * 启用态（§3.3）：`plugins.disabled: string[]` → 整体跳过插件；缺席 = 启用。
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type {
  IknowSettings,
  IknowSettingsPlugins,
} from "../../config/settings.js";
import { createPluginCatalog, type PluginCatalog } from "./catalog.js";

/**
 * 单个插件安装的最小事实（发现层数据载体）。`marketplace` 仅 ledger 来源时
 * 存在（目录扫描兜底推断不出 — 不强猜）；`version` 同理。
 */
export interface PluginInstallation {
  /** 插件名 = 命名空间前缀（skill 用 `<plugin>:<name>` 时即此名）。 */
  readonly name: string;
  /** 插件根目录（绝对路径，含 skills/agents/hooks/ 子树）。 */
  readonly root: string;
  /** ledger 解析出的 marketplace，目录扫描兜底为 undefined。 */
  readonly marketplace?: string;
  /** ledger 解析出的版本，目录扫描兜底为 undefined。 */
  readonly version?: string;
}

/** roots.ts 注入缝 —— 默认 warn 走 console.warn；默认 home 走 os.homedir()。 */
export type PluginWarn = (message: string) => void;

/** resolvePluginRoots 的注入缝：测试可独立指定 env / settings / home。 */
export interface ResolvePluginRootsOptions {
  /** 显式根列表（最高优先级，测试缝）；非数组 → 视为未提供。 */
  readonly pluginRoots?: readonly string[];
  /** 进程环境变量来源；缺省取 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 用户 home；缺省取 os.homedir()。 */
  readonly userHome?: string;
  /** 已解析的 settings；本函数只读 `plugins.roots`。 */
  readonly settings?: Pick<IknowSettings, "plugins">;
  /** warn 通道；缺省 console.warn。 */
  readonly warn?: PluginWarn;
}

/**
 * 合并根解析（顺序合并去重）：
 *   explicit > env `IKNOW_PLUGIN_ROOTS` > settings `plugins.roots` > default。
 * 根不存在 / 不是目录 → 静默跳过（未配置 = 合法态，非降级）。
 * 返回的列表顺序 = 合并次序（插件在多个根中同名时**先到者优先**——上游
 * 调用方应按顺序扫描，扫描内部按 §3.2 排序序保证确定）。
 */
export function resolvePluginRoots(
  opts: ResolvePluginRootsOptions = {}
): ReadonlyArray<string> {
  // 候选按优先级拼接（explicit > env > settings > default）：每段自行过滤
  // 非法 / 空条目，未配置的段贡献空数组，不影响其余段次序。
  const env = opts.env ?? process.env;
  const candidates: string[] = [
    ...normalizeRootList(opts.pluginRoots),
    ...normalizeEnvRoots(env.IKNOW_PLUGIN_ROOTS),
    ...normalizeRootList(opts.settings?.plugins?.roots),
  ];

  const home = opts.userHome ?? homedir();
  candidates.push(resolve(join(home, ".iknow", "plugins")));

  return distinctExistingDirs(candidates);
}

/**
 * 显式 / settings 根列表规范化：非字符串、trim 后为空 → 丢弃；其余
 * `resolve` 为绝对路径（**不 trim 原值** —— 与既有行为一致：只借 trim
 * 做空值判定，路径本身可含前导空格）。顺序 = 入参顺序（调用方据此
 * 保证「先到者优先」）。
 */
function normalizeRootList(raw: readonly string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (value.trim().length === 0) continue;
    out.push(resolve(value));
  }
  return out;
}

/** env `IKNOW_PLUGIN_ROOTS`：path.delimiter 分隔，逐段 trim 后 resolve。 */
function normalizeEnvRoots(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const out: string[] = [];
  for (const segment of raw.split(delimiter)) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) out.push(resolve(trimmed));
  }
  return out;
}

/**
 * 去重保序（保留首次出现的位置，先到者赢）+ 剔除不存在的根。返回 frozen：
 * 调用方不得依赖可变性（既有契约）。
 */
function distinctExistingDirs(
  candidates: readonly string[]
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    if (!existsSync(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return Object.freeze(out);
}

/**
 * discoverPlugins 的注入缝。`disabled` 过滤由调用方在装配层负责
 * （build-engine / worker 各自按 `settings.plugins.disabled` 过滤后
 * 再交给本函数）—— 本函数只产数据，不掺 enable/disable 决策，避免
 * 与装配层做重复劳动（review C2：dead-param 收敛）。
 */
export interface DiscoverPluginsOptions {
  /** warn 通道；缺省 console.warn。 */
  readonly warn?: PluginWarn;
}

/**
 * 单根的插件识别：ledger 优先 → 目录扫描兜底。
 * 根不存在 / 不是目录 → []（静默，与 resolvePluginRoots 行为一致）。
 * enable/disable 决策在装配层（build-engine / worker），本函数只
 * 产数据。
 */
export async function discoverPlugins(
  root: string,
  opts: DiscoverPluginsOptions = {}
): Promise<ReadonlyArray<PluginInstallation>> {
  const warn = opts.warn ?? console.warn;
  if (!existsSync(root)) return Object.freeze([]);

  const fromLedger = await readLedger(root, warn);
  if (fromLedger !== undefined) {
    return Object.freeze(fromLedger.map(freezePlugin));
  }

  return Object.freeze((await scanRootDir(root, warn)).map(freezePlugin));
}

/**
 * 解析 → 扫描 → enabled 过滤 → catalog 的完整装配链（build-engine /
 * worker 共用）。
 *
 * 过滤归装配层（`discoverPlugins` 只产数据、不掺 enable/disable 决策）：
 * 两处装配因此共用同一条「逐根扫描 → 剔 disabled」路径，不会各自漏掉
 * 过滤或次序漂移。单根扫描失败不阻断整轮（discoverPlugins 内部已降级为
 * warn + []），installations 保持插件声明序（多根按 roots 顺序拼接）。
 *
 * 入参收 `plugins` 配置段本体（不是调用方自建的 Set）：读 `disabled` 的
 * 两层可缺席（段缺席 / 字段缺席）只在本函数内判一次，两处调用点不再各
 * 写一遍 `?.` + `??`。`disabled` 缺席 = 全启用（§3.3）。
 *
 * 前置条件：调用方已按自家读取根解析好 `roots`（engine 用 settings /
 * worker 用 workerSettings）。返回的 catalog 已按 enabled 集合派生；同时
 * 透出 `enabled` —— hooks 文件源的占位符替换需要插件名 → 根目录映射。
 * 返回 frozen：装配层可安全跨装配点复用同一份快照。
 */
export async function resolvePluginCatalog(input: {
  readonly roots: readonly string[];
  readonly plugins?: IknowSettingsPlugins;
}): Promise<{
  readonly catalog: PluginCatalog;
  readonly enabled: ReadonlyArray<PluginInstallation>;
}> {
  const found: PluginInstallation[] = [];
  for (const root of input.roots) {
    found.push(...(await discoverPlugins(root)));
  }
  const disabled = new Set(input.plugins?.disabled ?? []);
  const enabled = found.filter((plugin) => !disabled.has(plugin.name));
  const frozen: ReadonlyArray<PluginInstallation> = Object.freeze(enabled);
  return Object.freeze({
    catalog: createPluginCatalog(frozen),
    enabled: frozen,
  });
}

// ─── ledger ──────────────────────────────────────────────────────────────────

interface LedgerEntry {
  scope?: unknown;
  installPath?: unknown;
  version?: unknown;
}

interface Ledger {
  version?: unknown;
  plugins?: Record<string, LedgerEntry[]>;
}

/**
 * 读 `<root>/installed_plugins.json`，按 §3.2 规则归并多版本记录。返回
 * `undefined` 表示 ledger 不存在或 JSON 损坏 → 调用方落目录扫描兜底。
 * 返回数组表示 ledger 可用，不再做扫描。
 */
async function readLedger(
  root: string,
  warn: PluginWarn
): Promise<ReadonlyArray<PluginInstallation> | undefined> {
  const file = join(root, "installed_plugins.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    // EXIT: ledger 读失败（非 ENOENT，权限 / IO 故障）→ warn +
    // 落目录扫描兜底；装配不阻塞。
    // 读失败分支不复用 readLedgerFile：async 侧的 warn 前缀是 **root**
    // （sync 侧是 file）—— 逐字节保留既有观测面。
    warn(`plugin-init: ledger read failed for ${root}: ${errorMessage(err)}`);
    return undefined;
  }
  const ledger = parseLedgerText(raw, file, warn);
  if (ledger === undefined) return undefined;
  return toPluginInstallations(ledger, warn);
}

/**
 * 解析 + 顶层校验 ledger 文本，任一步失败返 undefined（调用方落目录扫描
 * 兜底）。**async / sync 两条读取路径共用本段**：接受条件必须一致，否则
 * 同一份坏 ledger 在 engine 装配面与 spawn 装配面会得到不同降级结论。
 *
 * 失败分支（每支 warn 原因不同，便于定位）：
 *   - JSON 损坏 → warn + undefined（整个文件 skip）；
 *   - 顶层非对象 / `ledger.plugins` 非对象 → warn + undefined。
 *
 * 返回 Ledger 表示校验通过；`plugins` 缺席 / 非对象已在返回前 reject，
 * 调用方无须再判（Ledger 类型上仍 optional，消费面自行兜底）。
 */
function parseLedgerText(
  raw: string,
  file: string,
  warn: PluginWarn
): Ledger | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // EXIT: ledger JSON 损坏 → 整个文件 skip + warn，落目录扫描
    // 兜底；不让坏文件阻断整根解析。
    warn(
      `plugin-init: ledger JSON corrupt at ${file}: ${errorMessage(err)} — falling back to directory scan`
    );
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    // EXIT: ledger 顶层非对象 → 落目录扫描兜底（warn 描述原因）。
    warn(
      `plugin-init: ledger root is not an object at ${file} — falling back to directory scan`
    );
    return undefined;
  }
  const ledger = parsed as Ledger;
  if (!isPlainObject(ledger.plugins)) {
    // EXIT: ledger.plugins 非对象 → 落目录扫描兜底。
    warn(
      `plugin-init: ledger.plugins is not an object at ${file} — falling back to directory scan`
    );
    return undefined;
  }
  return ledger;
}

/**
 * ledger 每条 record → PluginInstallation，逐条独立成败（坏 entry 只跳过
 * 自己）。命名空间 / marketplace 解析规则见 `splitLedgerKey`。async 路径
 * 的产出携带 marketplace / version；sync 路径只取 {root, plugin}，故 map
 * 阶段分开实现。
 */
function toPluginInstallations(
  ledger: Ledger,
  warn: PluginWarn
): PluginInstallation[] {
  const out: PluginInstallation[] = [];
  for (const [key, records] of Object.entries(ledger.plugins ?? {})) {
    if (!Array.isArray(records)) continue;
    const { name, marketplace } = splitLedgerKey(key);
    if (name.length === 0) continue;
    const picked = pickLedgerRecord(records, warn);
    if (picked === undefined) continue;
    const installed = toPluginInstallation(name, marketplace, picked, warn);
    if (installed !== undefined) out.push(installed);
  }
  return out;
}

/**
 * ledger key → 命名空间 / marketplace。约定 key = `<plugin>@<marketplace>`
 * （`@` 可缺席 = 无 marketplace；多段 `@` 时 marketplace 取首段之后的全部
 * —— marketplace 名本身可含 `@`）。name 为空串 = 脏 key，调用方跳过。
 */
function splitLedgerKey(key: string): {
  readonly name: string;
  readonly marketplace: string | undefined;
} {
  return {
    name: key.split("@")[0]?.trim() ?? "",
    marketplace: key.includes("@")
      ? key.split("@").slice(1).join("@")
      : undefined,
  };
}

/**
 * `scope === "user"` 优先；否则取数组末项。空数组 → undefined（调用方
 * skip + warn 已在外层处置）。
 */
function pickLedgerRecord(
  records: ReadonlyArray<LedgerEntry>,
  warn: PluginWarn
): LedgerEntry | undefined {
  if (records.length === 0) return undefined;
  const userPref = records.find((r) => isPlainObject(r) && r.scope === "user");
  if (userPref !== undefined) return userPref;
  // 末项兜底：数组里其它任意元素也可能是个普通对象。
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const candidate = records[i];
    if (isPlainObject(candidate)) return candidate;
  }
  warn(`plugin-init: ledger entry has no usable record`);
  return undefined;
}

function toPluginInstallation(
  name: string,
  marketplace: string | undefined,
  record: LedgerEntry,
  warn: PluginWarn
): PluginInstallation | undefined {
  if (!shouldKeepName(name)) {
    // EXIT: 非法插件名（`:`, `.`, 空）→ skip + warn。命名空间脏名
    // 会破 `<plugin>:<id>` 拼装，fail-fast 拒绝该条。
    warn(`plugin-init: ledger entry name '${name}' rejected`);
    return undefined;
  }
  const installPath = record.installPath;
  if (typeof installPath !== "string" || installPath.length === 0) {
    // EXIT: record 缺 installPath → skip + warn。ledger 失锚，
    // 装配期拿到空字符串也不可恢复。
    warn(`plugin-init: plugin '${name}' missing installPath`);
    return undefined;
  }
  if (!isAbsolute(installPath)) {
    // EXIT: installPath 非绝对 → skip + warn。spawn 装配期
    // resolve 相对路径会引入 cwd 漂移，必须是绝对。
    warn(
      `plugin-init: plugin '${name}' installPath is not absolute: ${installPath}`
    );
    return undefined;
  }
  if (!existsSync(installPath)) {
    // EXIT: installPath 不可读 → skip + warn。spawn 期无法 navigate
    // 落子进程。
    warn(
      `plugin-init: plugin '${name}' installPath unreadable: ${installPath}`
    );
    return undefined;
  }
  const version =
    typeof record.version === "string" ? record.version : undefined;
  return {
    name,
    root: installPath,
    ...(marketplace !== undefined ? { marketplace } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

// ─── directory scan fallback ──────────────────────────────────────────────────

/**
 * 根下每个直接子目录 D：
 *   - D 含 skills/agents/hooks 至少之一 → 插件 = D，名 = basename(D)；
 *   - 否则若 D 恰有一个子目录 V 且 V 含组件目录 → 插件 = V，名仍 basename(D)
 *     （用户视角以「丢入的目录名」为准 — design §3.2）。
 * 跳过 node_modules/、.git/、以 `.` 开头、含 `:`、符号链接。
 */
async function scanRootDir(
  root: string,
  warn: PluginWarn
): Promise<ReadonlyArray<PluginInstallation>> {
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    // EXIT: 根目录扫读失败（非 ENOENT，权限 / IO）→ warn + []。
    // 装配不阻塞；该根上的 plugin 全部缺席。
    warn(`plugin-init: plugin root scan failed: ${root}: ${errorMessage(err)}`);
    return [];
  }
  const out: PluginInstallation[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (child.isSymbolicLink()) continue;
    const name = child.name;
    if (!shouldKeepName(name)) continue;
    const direct = join(root, name);
    if (await hasAnyComponents(direct)) {
      out.push({ name, root: direct });
      continue;
    }
    // 嵌套布局：<root>/<plugin>/<version>/{skills|agents|hooks}
    const nested = await pickSingleNestedVersion(direct);
    if (nested !== undefined) {
      out.push({ name, root: nested });
    }
  }
  return out;
}

/**
 * D 含组件目录（skills/agents/hooks/hooks.json 任一存在即算）。符号链接
 * 不跟随：fs/promises lstat 由上层 `isSymbolicLink` 过滤，这里用 stat
 * 直接同步测试三个候选（readdir + lstat 已给 directory 形态保证）。
 *
 * 子目录是否为空不计 —— empty skills/ 也算合法组件目录（用户可能先把
 * 插件框架搭好、稍后填内容）；判断依据是目录**存在**本身（hooks 例外：
 * 必须含 hooks.json 才算合法 hooks 组件目录）。
 */
async function hasAnyComponents(dir: string): Promise<boolean> {
  try {
    await readdir(join(dir, "skills"));
    return true;
  } catch {
    // ENOENT/其他 → 试 agents
  }
  try {
    await readdir(join(dir, "agents"));
    return true;
  } catch {
    // ENOENT/其他 → 试 hooks
  }
  try {
    const children = await readdir(join(dir, "hooks"));
    if (children.includes("hooks.json")) return true;
  } catch {
    // 全无 → false
  }
  return false;
}

/**
 * D 下若有**恰好一个**子目录 V 且 V 含组件目录 → 返回 V 的绝对路径；否则
 * undefined。零个 / 多于一个 → undefined（design §3.2 "恰有一个"）。
 */
async function pickSingleNestedVersion(
  dir: string
): Promise<string | undefined> {
  let children;
  try {
    children = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return undefined;
    // EXIT: 嵌套布局子目录扫读失败（非 ENOENT）→ undefined；不
    // 阻塞外层，外层仅跳过这一支嵌套候选。
    return undefined;
  }
  const subdirs = children.filter(
    (c) => c.isDirectory() && !c.isSymbolicLink() && shouldKeepName(c.name)
  );
  if (subdirs.length !== 1) return undefined;
  const candidate = join(dir, subdirs[0]!.name);
  if (await hasAnyComponents(candidate)) return candidate;
  return undefined;
}

// ─── sync agent-dir enumeration (for sync catalog resolver) ─────────────────

/**
 * 同步枚举插件 agent 目录 —— **ledger 优先 + 目录扫描兜底**（与
 * `discoverPlugins` 异步路径同语义，但同步 IO）。ledger 解析与目录
 * 扫描**同源**输出（{ dir, plugin }[]），二者互斥：ledger 在场时
 * 目录扫描不再产出。命名空间正确性依赖 ledger —— key 前段（`@`
 * 之前）= 插件名，扫描兜底只用 basename 推断，二者名字可能不同；
 * spawn 装配期必须以 ledger 名为准，否则「plugin agent 进 enum 但
 * capability 查不到」漂移（C1 修复）。
 *
 * 用途：`subagent/user-catalog.ts` 的 `createMergedCatalogResolver`
 * 默认路径（spawn 工厂需同步拿到 list()，#556 T3 契约）。修复后
 * 该默认路径走「读 ledger + 验 installPath」全流程，spawn enum 与
 * capability 解析面同源（ACR #5）。
 *
 * 返回：每个插件的 `<root>/agents` 绝对路径 + 命名空间（ledger 名
 * / basename 兜底）。不存在的子目录 → 跳过。已知 disable 列表 → 过
 * 滤。ledger 损坏 / 缺 / JSON 解析失败 → 落目录扫描兜底。
 */
export function enumeratePluginAgentDirs(
  pluginRoots: readonly string[],
  opts: {
    disabled?: ReadonlySet<string>;
    warn?: PluginWarn;
  } = {}
): ReadonlyArray<{ readonly dir: string; readonly plugin: string }> {
  const warn = opts.warn ?? console.warn;
  const out: { dir: string; plugin: string }[] = [];
  for (const root of pluginRoots) {
    if (!existsSync(root)) continue;
    // Ledger 优先（review C1：默认路径必须 ledger-aware，否则 ledger
    // only 布局下 skills 进 catalog 但 agents 不进 enum）。
    const ledgerEntries = readLedgerSync(root, warn);
    if (ledgerEntries !== undefined) {
      collectAgentDirsFromLedger(ledgerEntries, opts.disabled, out);
      continue;
    }
    // 目录扫描兜底（ledger 不存在 / 损坏）。
    collectAgentDirsFromScan(root, opts.disabled, out);
  }
  return out;
}

/**
 * ledger entry 列表 → 收集 { dir, plugin }。命名空间 = ledger key 前
 * 段（与 async `readLedger` 同源）；`agents` 子目录不存在 → 跳过。
 */
function collectAgentDirsFromLedger(
  entries: ReadonlyArray<{ readonly root: string; readonly plugin: string }>,
  disabled: ReadonlySet<string> | undefined,
  out: { dir: string; plugin: string }[]
): void {
  for (const entry of entries) {
    if (disabled?.has(entry.plugin)) continue;
    const agentsDir = join(entry.root, "agents");
    if (existsSync(agentsDir)) {
      out.push({ dir: agentsDir, plugin: entry.plugin });
    }
  }
}

/**
 * 单根目录扫描兜底：直接布局 + 嵌套布局各取一次。disabled 检查
 * 在外层就 gate 两种布局（review C2 修复）。命名空间 = basename。
 */
function collectAgentDirsFromScan(
  root: string,
  disabled: ReadonlySet<string> | undefined,
  out: { dir: string; plugin: string }[]
): void {
  const children = readdirSyncSafe(root);
  if (children === undefined) return;
  for (const child of children) {
    if (!isPluginDirCandidate(child)) continue;
    if (disabled?.has(child.name)) continue;
    const dir = resolvePluginAgentDir(join(root, child.name));
    if (dir !== undefined) out.push({ dir, plugin: child.name });
  }
}

/** readdirSync 的 catch-all 形态：读失败（不存在 / 权限 / IO）→ undefined。 */
function readdirSyncSafe(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/** 目录扫描的通用 child 过滤：真目录、非符号链接、名字合法（shouldKeepName）。 */
function isPluginDirCandidate(child: Dirent): boolean {
  return (
    child.isDirectory() && !child.isSymbolicLink() && shouldKeepName(child.name)
  );
}

/**
 * 单插件目录下定位 agents 面：直接布局 `<dir>/agents` 优先；否则嵌套布局
 * `<dir>/<version>/agents`（版本目录 = **恰好一个**合法子目录，且组件目录
 * 本身不算版本 —— 否则 `<plugin>/agents` 这种直接布局已被上面的分支吃掉，
 * 这里的排除只为防 `<plugin>/<skills>/agents` 之类的伪嵌套命中）。
 */
function resolvePluginAgentDir(dir: string): string | undefined {
  const direct = join(dir, "agents");
  if (existsSync(direct)) return direct;
  const subChildren = readdirSyncSafe(dir);
  if (subChildren === undefined) return undefined;
  const subdirs = subChildren.filter(
    (c) => isPluginDirCandidate(c) && !COMPONENT_DIR_NAMES.has(c.name)
  );
  if (subdirs.length !== 1) return undefined;
  const versioned = join(dir, subdirs[0]!.name, "agents");
  return existsSync(versioned) ? versioned : undefined;
}

/** 插件组件目录名 —— 嵌套版本探测须排除（避免伪版本目录）。 */
const COMPONENT_DIR_NAMES: ReadonlySet<string> = new Set([
  "agents",
  "skills",
  "hooks",
]);

/**
 * 同步读 `<root>/installed_plugins.json` —— 与 async `readLedger` 同语义
 * 但用 readFileSync（spawn 装配期必须同步）。校验沿用同一套规则：
 *   - JSON 损坏 / 缺 plugins 字段 / 顶层非对象 → undefined（调用方
 *     落目录扫描兜底）；
 *   - 每条 record：scope === "user" 优先，否则末项；
 *   - installPath 缺 / 非绝对 / 不可读 → 跳过 + warn；
 *   - key 前段（`@` 之前）= 插件命名空间。
 */
function readLedgerSync(
  root: string,
  warn: PluginWarn
):
  | ReadonlyArray<{ readonly root: string; readonly plugin: string }>
  | undefined {
  const file = join(root, "installed_plugins.json");
  const parsed = readLedgerFileSync(file, warn);
  if (parsed === undefined) return undefined;
  return collectLedgerEntries(parsed, warn);
}

/**
 * 读 + 解析 + 顶层校验 —— 任何一步失败都返 undefined（调用方落
 * 目录扫描兜底）。IO / JSON 失败两类都单独 warn，定位精准。
 */
function readLedgerFileSync(
  file: string,
  warn: PluginWarn
): Ledger | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    // EXIT: ledger 读失败（非 ENOENT）→ warn + 落目录扫描兜底，
    // 装配不阻塞。生产很少见（权限 / IO 故障），不抛。
    warn(`plugin-init: ledger read failed for ${file}: ${errorMessage(err)}`);
    return undefined;
  }
  return parseLedgerText(raw, file, warn);
}

/**
 * 单 ledger 内的逐 entry 解析：scope=user 优先 / 末项兜底 / record
 * 校验 → {root, plugin}[]。每条 entry 独立成败，坏 entry 不阻断其他。
 */
function collectLedgerEntries(
  ledger: Ledger,
  warn: PluginWarn
): ReadonlyArray<{ readonly root: string; readonly plugin: string }> {
  // ledger.plugins 在 Ledger 类型上是 optional，但调用方
  // readLedgerFileSync 已 isPlainObject 校验过（types ReadonlyMap 兜底
  // 防止 undefined 漏进 Object.entries）。
  const plugins = (ledger.plugins ?? {}) as Record<string, LedgerEntry[]>;
  const out: { root: string; plugin: string }[] = [];
  for (const [key, records] of Object.entries(plugins)) {
    if (!Array.isArray(records)) continue;
    const { name, marketplace } = splitLedgerKey(key);
    if (name.length === 0) continue;
    const picked = pickLedgerRecord(records, warn);
    if (picked === undefined) {
      // EXIT: 该 key 的 record 数组无可用对象 → skip + warn，ledger 其余 key
      // 继续解析（不让一条坏 key 阻断整文件）。
      continue;
    }
    const installed = ledgerRecordToDir(name, marketplace, picked, warn);
    if (installed !== undefined) out.push(installed);
  }
  return out;
}

function ledgerRecordToDir(
  name: string,
  marketplace: string | undefined,
  record: LedgerEntry,
  warn: PluginWarn
): { root: string; plugin: string } | undefined {
  if (!shouldKeepName(name)) {
    // EXIT: 非法插件名（`:`, `.`, 空）→ skip + warn。命名空间脏名
    // 会破 `<plugin>:<id>` 拼装，fail-fast 拒绝。
    warn(`plugin-init: ledger entry name '${name}' rejected`);
    return undefined;
  }
  const installPath = record.installPath;
  if (typeof installPath !== "string" || installPath.length === 0) {
    // EXIT: record 缺 installPath → skip + warn。ledger 失锚，
    // 装配期拿到空字符串也不可恢复。
    warn(`plugin-init: plugin '${name}' missing installPath`);
    return undefined;
  }
  if (!isAbsolute(installPath)) {
    // EXIT: installPath 非绝对 → skip + warn。sync 路径也用同判
    // 据；不 resolve 相对路径（用户可能误传 cwd 相对）。
    warn(
      `plugin-init: plugin '${name}' installPath is not absolute: ${installPath}`
    );
    return undefined;
  }
  if (!existsSync(installPath)) {
    // EXIT: installPath 不可读 → skip + warn。spawn 期无法 navigate。
    warn(
      `plugin-init: plugin '${name}' installPath unreadable: ${installPath}`
    );
    return undefined;
  }
  // marketplace / version 暂不消费（sync 路径不返，调用方只取
  // {root, plugin} 即可）；保留 type 兼容未来 T2/T3 扩展需要。
  void marketplace;
  return { root: installPath, plugin: name };
}

/**
 * 通用名过滤：跳过 node_modules/、.git/、以 `.` 开头的目录、含 `:` 的目录
 * （WSL 影子产物）、符号链接（不跟随，readdir 已通过 withFileTypes 给）。
 */
function shouldKeepName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith(".")) return false;
  if (name === "node_modules" || name === ".git") return false;
  if (name.includes(":")) return false;
  return true;
}

function freezePlugin(p: PluginInstallation): PluginInstallation {
  return Object.freeze({ ...p });
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
