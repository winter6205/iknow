/**
 * 全局插件组件加载 — catalog 数据面（plans/global-plugins-loading.md §4.1 / §4.4）。
 *
 * 职责：**只产数据，不装配**。`createPluginCatalog` 把 `PluginInstallation[]`
 * 拆成三个独立数组：
 *   - `skillDirs`：每个插件的 `<root>/skills` 绝对路径；
 *   - `agentDirs`：每个插件的 `<root>/agents` 绝对路径；
 *   - `hooksFiles`：每个插件的 `<root>/hooks/hooks.json` 绝对路径。
 *
 * 不存在的子目录 → 该数组里跳过该项（fail-open，缺一个不影响装配其他）。
 * `hooksFiles` 数组在 T1 没有消费者（T2 接入 plugin-hooks.ts 时消费），
 * 这里照样产出（T2 接 seam 而无须再改本模块）。T2 加性补 `hooksEntries`
 * （`{file, plugin}` 配对）—— 占位符替换需要插件名，文件路径本身推不出。
 *
 * 依赖方向（单向，无环）：skill/subagent/hooks → plugin，本模块不 import
 * 任何组件主。**无模块级缓存**：装配层（build-engine / worker）按需持有
 * 自己的实例；多次调用 createPluginCatalog 是幂等的，不互相覆盖。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginInstallation } from "./roots.js";

/**
 * T2 加性扩展（同一 PR，design §4.4）：hooks.json 与其所属插件名的配对。
 * 消费面 = `hooks/plugin-hooks.ts` 的占位符替换（`${*_PLUGIN_ROOT}` /
 * `${*_PLUGIN_DATA}`）—— 文件名本身推不出命名空间（同文件可经多根可达），
 * 配对必须由数据面给出。仍是纯数据，本模块不 import 任何组件主。
 */
export interface PluginHooksEntry {
  /** `<root>/hooks/hooks.json` 绝对路径。 */
  readonly file: string;
  /** 所属插件名（命名空间前缀），占位符替换与 plugin-data 目录的分母。 */
  readonly plugin: string;
}

/**
 * 三个数据面的并集 —— 装配层持有此对象并按需传给三个组件主。
 * 三个数组均按 plugins 入参顺序、与 components 子目录是否存在双向过滤。
 */
export interface PluginCatalog {
  /** 每个插件的 `<root>/skills`（绝对路径）；缺子目录 → 跳过该插件。 */
  readonly skillDirs: ReadonlyArray<string>;
  /** 每个插件的 `<root>/agents`（绝对路径）；缺子目录 → 跳过该插件。 */
  readonly agentDirs: ReadonlyArray<string>;
  /** 每个插件的 `<root>/hooks/hooks.json`（绝对路径）；缺文件 → 跳过该插件。 */
  readonly hooksFiles: ReadonlyArray<string>;
  /**
   * T2：`hooksFiles` 的 `{file, plugin}` 形式（同序、同过滤，二者一一对应）。
   * 既有 `hooksFiles` 保留不动（T1 测试与调用面零回归）。
   */
  readonly hooksEntries: ReadonlyArray<PluginHooksEntry>;
}

/**
 * 把插件安装列表摊平为三面目录/文件数据。同步：仅做路径拼接与 fs.existsSync
 * 检测（无须 IO 重 — readdir 在 roots.ts 已读过）；下游消费面自行扫描。
 */
export function createPluginCatalog(
  installations: ReadonlyArray<PluginInstallation>
): PluginCatalog {
  const skillDirs: string[] = [];
  const agentDirs: string[] = [];
  const hooksFiles: string[] = [];
  const hooksEntries: PluginHooksEntry[] = [];
  for (const plugin of installations) {
    const skillsPath = join(plugin.root, "skills");
    if (existsSync(skillsPath)) skillDirs.push(skillsPath);
    const agentsPath = join(plugin.root, "agents");
    if (existsSync(agentsPath)) agentDirs.push(agentsPath);
    const hooksPath = join(plugin.root, "hooks", "hooks.json");
    if (existsSync(hooksPath)) {
      hooksFiles.push(hooksPath);
      hooksEntries.push({ file: hooksPath, plugin: plugin.name });
    }
  }
  return Object.freeze({
    skillDirs: Object.freeze(skillDirs),
    agentDirs: Object.freeze(agentDirs),
    hooksFiles: Object.freeze(hooksFiles),
    hooksEntries: Object.freeze(hooksEntries.map((e) => Object.freeze(e))),
  });
}
