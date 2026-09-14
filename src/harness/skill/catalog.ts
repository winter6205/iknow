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
  available(): SkillEntry[];
  getBodyPath(name: string): string | undefined;
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

export function createSkillCatalog(
  entries: readonly SkillEntry[]
): SkillCatalog {
  // 双索引：canonical = 规范名（插件 skill 即 "<plugin>:<name>"）；裸名别名
  // 只在 canonical 未被占用的前提下登记（先到者赢；冲突 → 丢别名）。
  // listing 只出 canonical 一条 → all/available/search 不会重复。
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
  const available = (): SkillEntry[] =>
    all()
      .filter((entry) => !entry.disabled && entry.description !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));

  return Object.freeze({
    search(query: string): SkillEntry[] {
      const needle = query.toLocaleLowerCase();
      return available().filter(
        (entry) =>
          entry.name.toLocaleLowerCase().includes(needle) ||
          (entry.description ?? "").toLocaleLowerCase().includes(needle)
      );
    },
    get(name: string): SkillEntry | undefined {
      return index.get(name) ?? bareIndex.get(name);
    },
    all,
    available,
    getBodyPath(name: string): string | undefined {
      const entry = index.get(name) ?? bareIndex.get(name);
      return entry ? join(entry.dir, "SKILL.md") : undefined;
    },
  });
}
