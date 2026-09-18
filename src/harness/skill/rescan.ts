/**
 * `skill-index-increment` T6 —— 可加载面「当时热」扫描缝。
 *
 * Spec: `specs/skill-index-increment.md` T6 / SC8 / SC11 + Input-contract
 * 「模型索引查询」exception 列。
 *
 * ## 这个缝负责什么
 *
 * 一次 `rescan()` = 用**当前**根列表重跑 `createSkillScanner().scan()`，
 * 并把结果封成一份**新的** `SkillCatalogFaces`（`modelIndex()` /
 * `loadable()` 两面具名）。覆盖现行 `scan()` 全部技能根：user / project /
 * `IKNOW_SKILL_DIRS` / 已解析插件 skill dirs（assumption 10）。
 *
 * 之所以要把「根列表」收进一个**可变持有者**：plugin 根是唯一需要在显式
 * reload 时换血的部分（SC11 / assumption 9）。缝**不自己读**
 * `installed_plugins.json`，也不自己做插件发现 —— 它只接收 host 在
 * reload 时解析好的列表。于是「未 reload 时仅 plugin 包变化 → 不产生新
 * 条目」是**结构性**成立的：根列表没换血，扫描就没有新根可走。
 *
 * ## 这个缝不负责什么
 *
 * 冻结表 / 进场史 / 去重 / 注入全部归消费方（T5）。`rescan()` 不读也不写
 * 任何会话状态；失败时它只抛 typed 错误，**不改动任何东西** —— 调用方据
 * 此不换冻表、不贴残缺 delta、保留进场史（Input-contract exception 列）。
 *
 * ## 失败分型
 *
 * scanner 的既有纪律是「缺目录 = 空，不抛」（装配期不能被一个不可读目录
 * 掀掉），这个缝要保留那一半（ENOENT 仍是合法空态），但把**真 IO 故障**
 * 升级成 typed 错误 —— 把残缺扫描当成「技能都被删了」贴给模型是错的。
 * 两条纪律共存的机制：scanner 的 `onIoFailure` 观察缝收下故障事实，
 * `rescan()` 在扫描结束后按需抛 `SkillRescanError`（一次抛全部，便于定位
 * 多根同时坏掉的情形）。
 */
import { createSkillCatalog, type SkillCatalogFaces } from "./catalog.js";
import {
  createSkillScanner,
  type PluginSkillDir,
  type SkillIoFailure,
  type SkillScannerOptions,
} from "./scanner.js";

export type { SkillIoFailure };

/**
 * rescan 失败的 typed 错误（`kind` 为线的稳定判别位，同 `store` 的
 * `SessionStoreError` 纪律：消费方先认 `kind` 再分流，不用 message 解析）。
 *
 * `faults` 一次带**全部** IO 故障（非首个）：一次 rescan 可能同时坏掉多个
 * 根，只报第一个会让操作员修完一轮再来一轮。空 faults 不会出现（只在真
 * 有故障时抛）。
 */
export class SkillRescanError extends Error {
  override readonly name = "SkillRescanError";
  readonly kind = "rescan_failed" as const;
  readonly faults: readonly SkillIoFailure[];
  constructor(faults: readonly SkillIoFailure[]) {
    super(
      `skill rescan failed: ${faults
        .map((f) => `${f.kind} ${f.path}${f.code ? ` (${f.code})` : ""}`)
        .join("; ")}`
    );
    this.faults = Object.freeze([...faults]);
  }
}

export interface SkillRescanOptions {
  userHome: string;
  /** 会话的 `projectIdentityRoot`（同 `SkillScannerOptions`）。 */
  projectIdentityRoot: string;
  /**
   * 环境变量来源。每次 `rescan()` 重新读 `IKNOW_SKILL_DIRS` —— 该值属于
   * 「现行 scan 根」，不是需要 reload 才换血的 plugin 面，故不固化进
   * 持有者（调用方传的通常是 `process.env` 本身）。
   */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * 初始插件 skill 根列表（host 装配期解析结果）。之后只在显式 reload 时
   * 经 `setPluginSkillDirs()` 换血。缺省空数组。
   */
  pluginSkillDirs?: readonly PluginSkillDir[];
  warn?: SkillScannerOptions["warn"];
}

export interface SkillRescanner {
  /**
   * 用**当前**根列表重扫 → 新的 `SkillCatalogFaces`。
   *
   * 每次返回新实例，旧实例是当时的快照（不被后续 rescan 改写）。IO 故障
   * → 抛 `SkillRescanError`，调用方据此不换冻表、不贴残缺 delta。
   */
  rescan(): Promise<SkillCatalogFaces>;
  /**
   * 插件根列表**整体置换**（不是合并）—— host 在显式 reload 后调用，
   * 参数是这一轮重新解析出的完整列表。置换只作用于下一次 `rescan()`；
   * 已返回的 catalog 不受影响（它们是当时快照）。
   */
  setPluginSkillDirs(dirs: readonly PluginSkillDir[]): void;
  /** 当前插件根列表快照（每次返回新数组；调用方不得借此换血）。 */
  pluginSkillDirs(): readonly PluginSkillDir[];
}

export function createSkillRescanner(
  options: SkillRescanOptions
): SkillRescanner {
  // 唯一可变态：plugin 根列表。其余选项（userHome / projectIdentityRoot /
  // env 来源 / warn）在缝的生命周期内是常量 —— 会话根是身份（ADR-0037），
  // env 每次重读，故都不需要持有者。
  let pluginSkillDirs: readonly PluginSkillDir[] = Object.freeze([
    ...(options.pluginSkillDirs ?? []),
  ]);

  return Object.freeze({
    async rescan(): Promise<SkillCatalogFaces> {
      const faults: SkillIoFailure[] = [];
      const entries = await createSkillScanner({
        userHome: options.userHome,
        projectIdentityRoot: options.projectIdentityRoot,
        env: options.env,
        pluginSkillDirs,
        ...(options.warn !== undefined ? { warn: options.warn } : {}),
        // 故障先收齐：扫描结束后一次性抛，避免只报首个根。
        onIoFailure: (failure) => faults.push(failure),
      }).scan();
      // EXIT: 真 IO 故障（非 ENOENT）→ typed 错，**不返回**残缺 catalog。
      // 调用方按 Input-contract exception 列处置：不改冻表、不贴残缺
      // delta、保留进场史（EXIT 写在进场史行）。这里只抛，不碰任何状态。
      if (faults.length > 0) throw new SkillRescanError(faults);
      return createSkillCatalog(entries);
    },
    setPluginSkillDirs(dirs: readonly PluginSkillDir[]): void {
      pluginSkillDirs = Object.freeze([...dirs]);
    },
    pluginSkillDirs(): readonly PluginSkillDir[] {
      return [...pluginSkillDirs];
    },
  });
}
