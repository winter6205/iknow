import { join } from "node:path";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  source?: string;
  version?: string | number;
  tags?: string;
  author?: string;
  license?: string;
  metadata?: string;
}

export interface SkillEntry {
  name: string;
  description?: string;
  dir: string;
  disabled: boolean;
  source?: string;
  version?: string | number;
  tags?: string;
  author?: string;
  license?: string;
  metadata?: string;
  /**
   * #global-plugins T1：插件 skill 的命名空间（= 插件名）。常规 skill
   * 缺席 → undefined。catalog 在裸名别名上优先 canonical，冲突时丢别名
   * （scanner 在建 entry 时负责 warn，catalog 接口不暴露 warn 通道）。
   */
  namespace?: string;
}

export interface SkillCatalog {
  search(query: string): SkillEntry[];
  get(name: string): SkillEntry | undefined;
  all(): SkillEntry[];
  /**
   * **技能模型索引面**：有 description 且未 disable 的条目，name 排序 ——
   * 即允许进 `<available_skills>`（开场冻表 / 会话内增量）并允许 `skill()`
   * 灌正文的资格集。
   *
   * **这不是 slash 列表**：人侧 slash 候选走 `loadable()`（可加载技能面，
   * 含无 description、含 disable）。无 description 或 disable 的技能是既有
   * 语义（ADR-0046 / #337 的可用性判定），本方法行为未变宽。
   *
   * @deprecated 新代码请具名调用 `modelIndex()`（同一面，名字自解释）；
   * 本方法保留给既有消费方（build-engine / hub / worker / TUI），避免一次
   * 改名同时改动多模块。ADR-0098。
   */
  available(): SkillEntry[];
  getBodyPath(name: string): string | undefined;
}

/**
 * ADR-0098 / `specs/skill-index-increment.md`：`available()` 一名两义（既
 * 当模型索引用、又当 slash 列表用）的拆清。两个面各自具名，`createSkillCatalog`
 * 的返回类型即本接口。
 *
 * 之所以**不**把两个方法直接加进 `SkillCatalog`：现存多处 `SkillCatalog`
 * 对象字面量（如 `src/tui/app.tsx` 的空 catalog fallback）需要逐处补齐才
 * 能通过类型检查；本切片只动 catalog 层，故以**加宽返回类型**的方式暴露新
 * API —— 结构性兼容 `SkillCatalog`，既有赋值/传参不受影响，消费新面的调用
 * 方按需把自己的标注放宽到本类型。
 */
export interface SkillCatalogFaces extends SkillCatalog {
  /**
   * **技能模型索引面**（与 `available()` 同一面）。每次返回**新数组**。
   */
  modelIndex(): SkillEntry[];
  /**
   * **可加载技能面**：磁盘上有可加载 SKILL.md 的全部 canonical 条目 ——
   * 含无 description、含 disable；不含 bare 别名重复项（`all()` 已只有
   * canonical）。人侧 slash（TUI / Web / CLI 同一入口）据此派生候选。
   *
   * `get(name)` 仍按名取条目（canonical 优先再 bare，含 disabled），不受
   * 本面影响。每次返回**新数组**。
   */
  loadable(): SkillEntry[];
}

/**
 * 模型索引资格的**单一权威判据**（docs/CONTEXT.md「技能模型索引」）：有
 * description 且未 `disable-model-invocation`。`modelIndex()` 的过滤器与
 * `skill()` 工具的门（`src/harness/aci/tools/skill.ts`）都调这里，避免两处
 * 各写一遍判据后漂移。`reason` 供拒绝文案分型（两类出路不同）。
 */
export function modelIndexIneligibility(
  entry: SkillEntry
): "disabled" | "no_description" | undefined {
  if (entry.disabled) return "disabled";
  if (entry.description === undefined) return "no_description";
  return undefined;
}

/** 便捷谓词面：`modelIndexIneligibility(entry) === undefined`。 */
export function isModelIndexEligible(entry: SkillEntry): boolean {
  return modelIndexIneligibility(entry) === undefined;
}

/**
 * #global-plugins T1：从 "<plugin>:<name>" 还原裸名（仅当 name 形如该
 * 形态）。不匹配 → undefined。与 scanner 的命名合同一致：namespace 必须是
 * entry.name 的 `<namespace>:` 前缀；bare 为空串也算不匹配（无意义裸名）。
 */
export function stripNamespace(
  entryName: string,
  namespace: string
): string | undefined {
  const prefix = `${namespace}:`;
  if (!entryName.startsWith(prefix)) return undefined;
  const bare = entryName.slice(prefix.length);
  return bare.length > 0 ? bare : undefined;
}

/** 两面共用的排序：name 升序。list 面排序不依赖 `readdir` 顺序（ext4 下
 *  不保证字典序），人侧候选与模型索引才都是确定的。 */
const byName = (a: SkillEntry, b: SkillEntry): number =>
  a.name.localeCompare(b.name);

export function createSkillCatalog(
  entries: readonly SkillEntry[]
): SkillCatalogFaces {
  // 双索引：canonical = 规范名（插件 skill 即 "<plugin>:<name>"）；裸名别名
  // 只在 canonical 未被占用的前提下登记（先到者赢；冲突 → 丢别名）。
  // listing 只出 canonical 一条 → all/modelIndex/loadable/search 不会重复。
  const index = new Map<string, SkillEntry>();
  const bareIndex = new Map<string, SkillEntry>();
  for (const entry of entries) {
    if (index.has(entry.name)) continue;
    index.set(entry.name, entry);
    if (entry.namespace !== undefined && entry.namespace !== entry.name) {
      const bare = stripNamespace(entry.name, entry.namespace);
      if (bare !== undefined && !bareIndex.has(bare)) {
        bareIndex.set(bare, entry);
      }
    }
  }
  const all = (): SkillEntry[] => [...index.values()];
  const modelIndex = (): SkillEntry[] =>
    all().filter(isModelIndexEligible).sort(byName);
  const loadable = (): SkillEntry[] => all().sort(byName);

  return Object.freeze({
    search(query: string): SkillEntry[] {
      const needle = query.toLocaleLowerCase();
      return modelIndex().filter(
        (entry) =>
          entry.name.toLocaleLowerCase().includes(needle) ||
          (entry.description ?? "").toLocaleLowerCase().includes(needle)
      );
    },
    get(name: string): SkillEntry | undefined {
      return index.get(name) ?? bareIndex.get(name);
    },
    all,
    modelIndex,
    loadable,
    available: modelIndex,
    getBodyPath(name: string): string | undefined {
      const entry = index.get(name) ?? bareIndex.get(name);
      return entry ? join(entry.dir, "SKILL.md") : undefined;
    },
  });
}

/**
 * slash 投影层（plan T3「harness 可复用的 slash 投影」—— TUI / CLI / hub
 * 三宿主同一算法的**单一**实现；web 因 tsconfig include 边界仍持本地镜像，
 * 镜像份数从 3 降到 1+web）。
 *
 * 语义（与既有三份实现逐字一致，收敛时未改任何行为）：
 *   - 候选集 = `loadableOf(catalog)`：可加载面（含无 description、含
 *     disable），结构性兼容测试注入的精简 catalog（无 `loadable` → `all()`）；
 *   - 别名 = 唯一裸名：`stripNamespace` 还原 + `get(bare) === entry` 登记
 *     判据 + 全部首 token 小写折叠进占用表，占用者不唯一 → 整组不发别名
 *     （宁可不可用，不可歧义）；
 *   - 产出恒用规范名（invariant 2：展示与补全都用 `plugin:skill`）。
 */
export interface SkillSlashEntry {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
}

/**
 * 结构性取**可加载技能面**：真实现走 `loadable()`（T1 新增面），测试注入
 * 的 `SkillCatalog` 字面量退 `all()`。三宿主此前各写一份 3 行体，收敛于此。
 */
export function loadableOf(catalog: SkillCatalog): ReadonlyArray<SkillEntry> {
  const withFaces = catalog as Partial<SkillCatalogFaces>;
  return withFaces.loadable?.() ?? catalog.all();
}

/**
 * slash 候选投影的**唯一裸名别名**算法（别名典）。产出 `SkillSlashEntry[]`
 * —— 各宿主再按需切片成自己的最小形状（TUI `SkillEntryLike` / CLI
 * `CliSkillEntryLike` 同形，宿主本地类型保持，只共享算法）。
 */
export function projectSlashEntries(
  catalog: SkillCatalog
): ReadonlyArray<SkillSlashEntry> {
  const entries = loadableOf(catalog);
  const bares = entries.map((entry) => {
    if (entry.namespace === undefined) return undefined;
    const bare = stripNamespace(entry.name, entry.namespace);
    return bare !== undefined && catalog.get(bare) === entry ? bare : undefined;
  });
  const claimants = new Map<string, ReadonlyArray<string>>();
  const claim = (name: string, owner: string): void => {
    const key = name.toLowerCase();
    const owners = claimants.get(key) ?? [];
    claimants.set(key, owners.includes(owner) ? owners : [...owners, owner]);
  };
  for (const entry of entries) claim(entry.name, entry.name);
  entries.forEach((entry, i) => {
    const bare = bares[i];
    if (bare !== undefined) claim(bare, entry.name);
  });
  return entries.map((entry, i) => {
    const bare = bares[i];
    const owners =
      bare === undefined ? undefined : claimants.get(bare.toLowerCase());
    const description =
      entry.description !== undefined ? { description: entry.description } : {};
    if (owners?.length !== 1 || owners[0] !== entry.name) {
      return { name: entry.name, ...description };
    }
    return { name: entry.name, ...description, aliases: [bare!] };
  });
}

/**
 * slash 输入的首 token 小写形（`/xxx...` → `xxx`）。`/Echo` 与 `/echo`
 * 同判 —— 人侧匹配语义的大小写折叠单点。
 */
export function slashHeadPrefix(text: string): string {
  if (!text.startsWith("/")) return "";
  return (text.slice(1).split(/\s+/, 1)[0] ?? "").toLowerCase();
}

/**
 * remainder = 首 token 之后的剩余段（trim）。**按 typed token 长度切** ——
 * 用 `skill.name.length` 会在裸名输入里吃掉 remainder 前缀（spec SC9
 * 明令禁止）。
 */
export function slashTailRemainder(raw: string): string {
  const text = raw.trim();
  const firstTok = text.split(/\s+/, 1)[0] ?? text;
  return text.slice(firstTok.length).trim();
}
