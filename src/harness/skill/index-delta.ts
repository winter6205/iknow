/**
 * T5 (`specs/skill-index-increment.md` / ADR-0098) — 送模型前的**技能索引
 * 增量**：每轮调用模型前 rescan 现行技能根 → `模型索引 − 索引进场史` →
 * 只把**新建行**渲染成 `<available_skills>` 文本，作为隐藏 user 消息接到
 * messages 最末；渲染复用 `skillsSegment`（identity/assemble.ts），不新写
 * 第二套。
 *
 * ## 这个模块负责什么
 *
 * 一个 `computeSkillIndexDelta()` = 一次完整的「本轮该贴什么」判定：
 *   1. `rescanner.rescan()` 拿现行 `SkillCatalogFaces`（失败 → typed
 *      `SkillRescanError` 直接上抛，**不贴残缺 delta**）；
 *   2. `catalog.modelIndex()`（有 description 且未 disable）里挑出
 *      `ledger.has(name) === false` 的**新建**名 —— 已进场名不重复贴
 *      （SC1 / SC3 / SC4：判定只看落盘史，不看 messages，compact 吃掉了
 *      增量也照样不重贴）；
 *   3. **先落盘**：`ledger.addMany(names)`；失败 → `SkillIndexLedgerError`
 *      上抛，调用方拿不到消息文本，**不得**把 messages 追加当成已进场
 *      （Input-contract exception 列 / 本模块最关键的顺序契约）；
 *   4. 落盘成功才渲染 —— `skillsSegment(added.map(...))`，**带完整
 *      description**（ADR-0098：10% 索引降档只作用于开场冻表，不在本路径）。
 *
 * 返回的 `added` 是该次落盘 receipt 的 name 集（升序），`text` 是渲染出的
 * 增量文本副本；`added.length === 0` → `text` 为空串、调用方零追加（SC1）。
 *
 * ## 这个模块不负责什么
 *
 * 不注入 messages（那是 loop-engine `createPendingInjected` 的缝）、不写
 * system（冻表字节由装配期 `skillIndexList` 冻结）、不碰 TUI / Web 投影
 * （隐藏谓词在 `isSkillIndexDeltaText` / `isTuiHiddenUserMessage`）。
 *
 * ## 隐藏谓词
 *
 * `isSkillIndexDeltaText` 与既有四子谓词（`isAgentStatusText` /
 * `isGraphModeText` / `isSubagentDrainText` / `isVerifyInjectedText`）同构：
 * 常量前缀 + 从 producer 模块导出，消费侧（TUI `isTuiHiddenUserMessage` /
 * Web `isTurnQuery`）只调谓词、不自己写前缀检查。前缀取
 * `<available_skills>` —— 增量文本与冻表段**同一形态**（模型读到的是同一
 * 段标题下的新行），故模型侧不需要第二套解读；人侧靠这个前缀识别出「这是
 * host 注入的索引增量，不是操作员键入」。
 *
 * **为什么前缀够精确**：操作员真会键入以 `<available_skills>` 开头的行是
 * 极端反例；既有四子谓词里的 `<agent_status>` / `<graph_mode>` 同为 XML 形
 * 段标题，采用同款「行首 trimStart 命中即注入」纪律（不为人类文本做例外）。
 */
import { skillsSegment, type SkillSummary } from "../identity/assemble.js";
import type { SkillCatalogFaces } from "./catalog.js";
import {
  createSkillIndexLedger,
  type SkillIndexLedger,
} from "./index-ledger.js";
import type { SkillRescanner } from "./rescan.js";

/**
 * 增量段的前导常量（与 `skillsSegment` 的段标题同一字面量 —— 单一 SSOT
 * 是 `skillsSegment`，本常量只是**谓词**面的读取锚，两处不会漂移：谓词
 * 命中的文本就是 `skillsSegment` 的产物）。
 */
export const SKILL_INDEX_DELTA_PREFIX = "<available_skills>";

/**
 * 该 user 消息文本是不是**技能索引增量**（host 注入，非操作员键入）。
 *
 * 与 `isAgentStatusText` 同款：`trimStart` 后行首命中前缀即注入 —— 正文里
 * 提到 `<available_skills>`（非行首）不误伤。
 */
export function isSkillIndexDeltaText(text: string): boolean {
  return text.trimStart().startsWith(SKILL_INDEX_DELTA_PREFIX);
}

export interface SkillIndexDelta {
  /** 本次真正新进场的 name（ledger receipt，升序）；空 = 无新建。 */
  readonly added: readonly string[];
  /**
   * 渲染好的增量文本（`skillsSegment` 产物；`added` 为空时为空串）。
   * 调用方把它 `encodeUserText` 后接到 messages 最末。
   */
  readonly text: string;
}

export interface ComputeSkillIndexDeltaOptions {
  /** T6 的 rescan 缝（现行技能根）。失败抛 `SkillRescanError`。 */
  readonly rescanner: SkillRescanner;
  /** T4 的索引进场史。失败抛 `SkillIndexLedgerError`。 */
  readonly ledger: SkillIndexLedger;
  /**
   * T7 / SC10:rescan 成功后、任何判定之前调用一次，交出**这一拍看见的**
   * 模型索引面。装配层借它刷新 worker 快照的同步镜像（名 → 描述）——
   * 否则 spawn 只能拿到裸名，退化 worker 的 `<available_skills>` 渲染。
   *
   * 与判定/落盘结果无关（空增量也调用）：镜像记的是「现行面长什么样」。
   */
  readonly onModelIndex?: (
    entries: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
    }>
  ) => void;
}

/**
 * 一次完整的增量判定 + 落盘（见文件头四步）。永不静默降级：rescan 失败与
 * 落盘失败都上抛 typed 错误，调用方据此「不改冻表、不贴残缺 delta」。
 */
export async function computeSkillIndexDelta(
  options: ComputeSkillIndexDeltaOptions
): Promise<SkillIndexDelta> {
  const catalog: SkillCatalogFaces = await options.rescanner.rescan();
  // 模型索引面（有 description 且未 disable，name 升序 —— catalog SSOT）。
  const entries = catalog.modelIndex();
  // T7 / SC10:把这一拍的面交给装配层（刷 worker 快照镜像）。放在「取差」
  // 之前 —— 空增量也交，镜像记的是现行面而非本次新增。
  options.onModelIndex?.(
    entries.map((entry) =>
      entry.description === undefined
        ? { name: entry.name }
        : { name: entry.name, description: entry.description }
    )
  );
  // 进场史判定只读 ledger：不读 messages → compact 吃掉增量也不重贴（SC4）。
  const fresh = entries.filter((entry) => !options.ledger.has(entry.name));
  if (fresh.length === 0) return { added: [], text: "" };

  // 先落盘、再渲染：落盘失败 → throw，调用方拿不到 text，messages 不会
  // 追加一条「未进场」的 listing（spec Input-contract exception 列）。
  const receipt = await options.ledger.addMany(fresh.map((e) => e.name));
  if (receipt.added.length === 0) return { added: [], text: "" };

  // receipt.added 已是升序 name；渲染取条目时按 name 回查（并发窗口内
  // catalog 与 ledger 是两拍，用 name 对齐而非数组下标）。
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const summaries: SkillSummary[] = receipt.added.map((name) => {
    const entry = byName.get(name);
    // 完整 description：ADR-0098 —— 开场 10% 降档不在增量路径。
    return entry === undefined
      ? { name }
      : { name, description: entry.description ?? "" };
  });
  return {
    added: receipt.added,
    text: skillsSegment(summaries),
  };
}

/**
 * 装配期建缝：把「装配期一次」的 rescan 根与「per-conversation」的进场史在
 * 一个闭包里合流，产出的正是 `LoopEngineDeps.skillIndexDelta` 的形状
 * （loop-engine 对本接口是**结构类型**，不 import 本模块 —— Gate B）。
 *
 * 为什么在装配层合流、而不是让 loop-engine 持两个对象：loop-engine 只需要
 * 知道「拿一次增量，非空就贴」，不需要知道 rescan / ledger / 渲染的存在
 * （与 `boundaryAttachment` / `agentStatus` 同款「宿主注入纯闭包」纪律）。
 *
 * ## 为什么 `conversationId` 是**调用参数**而不是装配参数
 *
 * 形态照抄 `agentStatus`（`{todoDir}` 装配期常量 + loop-engine 调用时传
 * `deps.conversationId`）：装配期（尤其 serve）拿不到 conversationId ——
 * 一个 build-engine 实例跨会话共享，per-session 叶子在调用期才定。把会话
 * 锚放在调用参数上，`serve` 不必 per-session 重建引擎。
 *
 * 进场史按 conversationId **懒建并记忆**（同 `todoDir` 的
 * `<projectDir>/<sanitize(convId)>/` 叶子形状）：同一会话内每次 `delta()`
 * 复用同一 ledger（含其内存集与串行队列）；换会话走另一份。首次构造读盘，
 * 故 harness 恢复 session 时落盘史被载回 → 不重贴（SC3）。
 *
 * `conversationId === undefined`（ask / worker / 未锚装配）→ 返回空增量：
 * 无会话锚就没有可持久化的进场史，贴了必然每轮重贴 —— fail-closed 不贴。
 */
export interface CreateSkillIndexDeltaSeamOptions {
  /** T6 的 rescan 缝（装配期一次，跨会话共用）。 */
  readonly rescanner: SkillRescanner;
  /** 会话文件夹根（`SessionStore.getProjectDir()` / `BuildEngineOpts.todoDir`）。 */
  readonly projectDir: string;
  /**
   * 该会话开场模型索引名集（冻表投影）—— ledger 的 `initialNames`：
   * 冻表里已有的名不会被当新建再贴一次（SC3）。
   */
  readonly initialNames: readonly string[];
  /**
   * 同一冻表的**条目**面（名 + 描述，T7 / SC10 用）—— 只用来给 worker 快照
   * 的同步镜像预填描述：spawn 可能发生在首个 turn 之前（此时还没跑过
   * `delta()`，镜像里只有冻表那半）。缺席 → 冻表名进快照时是裸名。
   */
  readonly initialEntries?: readonly SkillIndexSnapshotEntryShape[];
  /**
   * 写入闸（ledger 的 `isIndexedName`）：只收**现行**模型索引面里的名。
   * 缺省 = 全收（`computeSkillIndexDelta` 已经只喂 `modelIndex()` 的产物，
   * 故缺省安全；host 想额外收窄时传入）。
   */
  readonly isIndexedName?: (name: string) => boolean;
}

/**
 * 缝的形状（与 `LoopEngineDeps.skillIndexDelta` 结构一致）。loop-engine
 * 定义的是同一形状的接口副本 —— 两侧靠结构类型对齐，无 import 耦合。
 */
export interface SkillIndexDeltaSeam {
  delta(conversationId: string | undefined): Promise<SkillIndexDelta>;
  /**
   * T7 / SC10:该会话**已进场**的条目（进程序内的内存镜像，同步）。
   *
   * 供 worker spawn 时的快照 getter 消费（`manager.opts.skillIndexSnapshot`
   * 是同步面，而 ledger 的构造是异步读盘 —— 故这里维护一份同步可读的镜像，
   * 在 ledger 载入与每次 `delta()` 落盘后刷新）。镜像的权威仍是落盘史：
   * 刷新只从 `ledger.snapshot()` 取值，不自己记账。
   *
   * description 取自**最近一次 rescan** 的模型索引面（会话内新建的技能只有
   * 重扫过才有描述）；某名在现行面上查不到（例如根被换血后旧名消失）→
   * 退化为裸名条目 —— 「索引可见、正文取不到」的已知退化（T7 选定「传条目」
   * 而非「传 name 名单」的同一取舍）。
   *
   * 三态（与 envelope 的 `skillIndexSnapshot` 键语义逐字对齐）：
   *   - 该会话**加载过** → 条目数组（可能为空：冻表为空且无进场 —— 那是
   *     确定事实「父确实没有模型索引」）;
   *   - 该会话**未加载过**（进程内还没跑过 `delta()`）→ `undefined` ——
   *     「不知道」不是「没有」。调用方据此**省略** envelope 键，让 worker
   *     退回自有 rescan，而不是拿一个空数组谎报父侧无技能;
   *   - `conversationId === undefined`（ask / worker / 未锚）→ `undefined`
   *     同理（无会话锚 = 无从谈起该会话的史）。
   */
  enteredEntries(
    conversationId: string | undefined
  ): readonly SkillIndexSnapshotEntryShape[] | undefined;
}

/** 快照条目形状（与 `subagent/envelope.ts` 的 `SkillIndexSnapshotEntry`
 *  结构对齐；本模块不 import 子代理层的类型 —— 结构类型对齐即可）。 */
export interface SkillIndexSnapshotEntryShape {
  readonly name: string;
  readonly description?: string;
}

export function createSkillIndexDeltaSeam(
  options: CreateSkillIndexDeltaSeamOptions
): SkillIndexDeltaSeam {
  // 懒建 + 记忆：同一 conversationId 复用同一 ledger（内存集 + 串行队列
  // 都是会话状态的一部分）；失败不缓存 —— 下次调用重试，不把一次瞬时
  // IO 故障钉成永久降级。
  const ledgers = new Map<string, Promise<SkillIndexLedger>>();
  // T7 / SC10：进场史的**同步镜像**（worker spawn 的 getter 是同步面，而
  // ledger 构造要异步读盘）。名从 `ledger.snapshot()` 刷（权威是落盘史，
  // 不自己记账）；描述取最近一次 rescan 的模型索引面。未加载过的会话 → 缺席。
  const enteredMirror = new Map<string, readonly string[]>();
  // 每次 rescan 都整体替换（现行面是权威）：旧描述不残留 —— 根换血后消失
  // 的名退化为裸名，而不是拿过期描述。初值 = 冻表条目面（首个 turn 之前
  // spawn 时，快照描述取自这里而非空表）。
  let faceMirror: ReadonlyMap<string, string> = new Map(
    (options.initialEntries ?? [])
      .filter((entry) => entry.description !== undefined)
      .map((entry) => [entry.name, entry.description as string])
  );
  const refreshEntryMirror = (
    conversationId: string,
    ledger: SkillIndexLedger
  ): void => {
    enteredMirror.set(conversationId, ledger.snapshot());
  };
  const ledgerFor = (conversationId: string): Promise<SkillIndexLedger> => {
    const cached = ledgers.get(conversationId);
    if (cached !== undefined) return cached;
    const created = createSkillIndexLedger({
      projectDir: options.projectDir,
      conversationId,
      initialNames: options.initialNames,
      isIndexedName: options.isIndexedName ?? (() => true),
    })
      .then((ledger) => {
        // 载盘完成即刷新镜像（resume 场景：spawn 早于首个 turn 时也能拿到
        // 落盘史，而不是空数组）。
        refreshEntryMirror(conversationId, ledger);
        return ledger;
      })
      .catch((err: unknown) => {
        ledgers.delete(conversationId);
        throw err;
      });
    ledgers.set(conversationId, created);
    return created;
  };

  return Object.freeze({
    async delta(conversationId: string | undefined): Promise<SkillIndexDelta> {
      // EXIT: 无会话锚 → 无可持久化进场史 → 不贴（贴了每轮重贴）。
      if (conversationId === undefined) return { added: [], text: "" };
      const ledger = await ledgerFor(conversationId);
      const result = await computeSkillIndexDelta({
        rescanner: options.rescanner,
        ledger,
        onModelIndex: (entries) => {
          const next = new Map<string, string>();
          for (const entry of entries) {
            if (entry.description !== undefined) {
              next.set(entry.name, entry.description);
            }
          }
          faceMirror = next;
        },
      });
      // 落盘成功后刷新镜像（addMany 是「先落盘后返回」，走到这里史已持久）。
      refreshEntryMirror(conversationId, ledger);
      return result;
    },
    enteredEntries(
      conversationId: string | undefined
    ): readonly SkillIndexSnapshotEntryShape[] | undefined {
      // EXIT: 无会话锚 / 该会话尚未加载 → undefined（「不知道」不是「没有」；
      // 调用方据此省键，worker 走自有退路）。
      if (conversationId === undefined) return undefined;
      const names = enteredMirror.get(conversationId);
      if (names === undefined) return undefined;
      return names.map((name) => {
        const description = faceMirror.get(name);
        return description === undefined ? { name } : { name, description };
      });
    },
  });
}
