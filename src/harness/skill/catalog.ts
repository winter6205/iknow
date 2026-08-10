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
}

export interface SkillCatalog {
  search(query: string): SkillEntry[];
  get(name: string): SkillEntry | undefined;
  all(): SkillEntry[];
  available(): SkillEntry[];
  getBodyPath(name: string): string | undefined;
}

export function createSkillCatalog(
  entries: readonly SkillEntry[]
): SkillCatalog {
  const index = new Map(entries.map((entry) => [entry.name, entry]));
  const all = () => [...index.values()];
  const available = () =>
    all()
      .filter((entry) => !entry.disabled && entry.description !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));

  return Object.freeze({
    search(query: string) {
      const needle = query.toLocaleLowerCase();
      return available().filter(
        (entry) =>
          entry.name.toLocaleLowerCase().includes(needle) ||
          entry.description!.toLocaleLowerCase().includes(needle)
      );
    },
    get(name: string) {
      return index.get(name);
    },
    all,
    available,
    getBodyPath(name: string) {
      const entry = index.get(name);
      return entry ? join(entry.dir, "SKILL.md") : undefined;
    },
  });
}
