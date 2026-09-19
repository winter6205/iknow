/**
 * T4 (`specs/skill-index-increment.md` / ADR-0098) — **索引进场史**：本会话
 * 已进入模型索引的 skill name 集（= 开场冻表 name ∪ 已追加增量），跟 session
 * 落盘。
 *
 * 落盘形态（为什么是 JSON 集合而不是 append-only 行）：
 *   - 进场史的使用方式只有一种 —— **整集查 diff**：`模型索引 − 进场史`。
 *     它是**可重写的 name 集**，不是逐条流水：不记时间、不记来源、不记顺序
 *     语义（name 升序输出只是渲染安定）。append-only 行格式会为这个用法多
 *     背一套解析 / 去重 / 冲突合并（手改文件后同 name 出现两次算不算两次），
 *     换来的是没有消费方需要的审计流。
 *   - 唯一写入者就是本模块，没有第二个 writer 需要并发追加（对照 todo
 *     ledger：那里 append-only 行 + 人手可读是 ADR-0085 的产品面要求）。
 *   - 故取单一权威 JSON：整集原子写（tmp + rename，形态同 session-store.ts
 *     save / todo-write 的原子写），文件即当前真值，无重放歧义。
 *
 * 落点与 todo ledger 同构（`resolveConversationTodoPath` 的会话文件夹叶子
 * 形态）：`<projectDir>/<sanitize(conversationId)>/<SKILL_INDEX_LEDGER_FILE>`。
 * projectDir 由宿主经 `SessionStore.getProjectDir()` 注入（#950 T2 / ADR-0071
 * 的唯一 `(baseDir, projectIdentityRoot)` 决策点），本模块不自算。
 *
 * 语义边界（spec Input-contract 表「索引进场史」行）：
 *   - empty：新 session 初值 = 该 session 开场模型索引名集（`initialNames`）。
 *   - invalid：未知 name 写入忽略 —— 现行谓词 `isIndexedName` 说不是模型索引
 *     就不收。slash 信封灌正文不写入进场史（SC7），本模块也**不提供**信封侧
 *     写入通道（唯一 mutator 是 `addMany`，拒绝名单由调用方经谓词给）。
 *   - concurrent：追加与落盘**同一拍** —— 落盘成功才改内存集并返 receipt；
 *     失败 → `write_failed`，调用方拿不到「已追加」，不得把 messages 追加
 *     当成已进场。并发调用按 promise 队列串行（read-modify-write 不互踩）。
 *   - exception：落盘失败 → typed error；读失败 / 损坏 → typed error（不静默
 *     当空集重建，否则已进场名会被当新建再贴一次 listing）。
 *
 * 不依赖 messages：`snapshot()` / `has()` 只读本模块持有的集 —— compact 重写
 * messages 后集仍在（SC4）。
 *
 * 非目标：不做「有 description 且未 disable」的资格判定（SSOT 是
 * `catalog.ts:modelIndexIneligibility`），调用方按现行模型索引面传谓词；
 * 不写 messages、不注入、不渲染 delta（T5）。
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeConversationSegment } from "../session-roots.js";
import { createSerialQueue } from "../../util/serial-queue.js";

/** 会话文件夹里的叶子名（唯一字面量声明点，与 todos.md / trace.jsonl 同级）。 */
export const SKILL_INDEX_LEDGER_FILE = "skill-index.json";

/** 落盘 schema 版本。形状不符 / 版本不符一律 `read_failed`（不猜、不迁移）。 */
export const SKILL_INDEX_LEDGER_VERSION = 1;

/** typed 失败判别值（T5 与宿主按 `kind` 分支，不解析 message）。 */
export type SkillIndexLedgerErrorKind =
  "invalid_conversation_id" | "read_failed" | "write_failed";

export interface SkillIndexLedgerErrorContext {
  readonly conversationId: string;
  /** 失败细节（IO 的 code / 解析原因）；可能为空串。 */
  readonly detail: string;
}

/**
 * 索引进场史落盘 / 载入的 typed 错误。
 *
 * 为什么不是 `ToolExecutionError` 子类：本错误不面向模型（模型不写进场史、
 * 也读不到这个文件），落盘失败是**宿主**侧信号 —— 与 `SessionRootError` /
 * `SessionStoreError` 同档。继承 `Error` 使其可被 `instanceof` 分型，并保留
 * `kind` 判别值给调用方（T5：`write_failed` → 本轮不追加 messages 增量）。
 */
export class SkillIndexLedgerError extends Error {
  override readonly name: string = "SkillIndexLedgerError";
  readonly kind: SkillIndexLedgerErrorKind;
  readonly conversationId: string;
  readonly detail: string;

  constructor(
    kind: SkillIndexLedgerErrorKind,
    context: SkillIndexLedgerErrorContext,
    options?: { readonly cause?: unknown }
  ) {
    super(
      `skill index ledger ${kind}: ${context.conversationId}` +
        (context.detail === "" ? "" : ` — ${context.detail}`),
      options
    );
    this.kind = kind;
    this.conversationId = context.conversationId;
    this.detail = context.detail;
  }
}

/** `addMany` 回执：本次真正新收的名 + 落盘后的全集快照。 */
export interface SkillIndexAddReceipt {
  /** 本次新进场的 name（已排除存量与非法名），name 升序。 */
  readonly added: readonly string[];
  /** 落盘后的进场史全集（name 升序）—— 与 `snapshot()` 同一权威。 */
  readonly snapshot: readonly string[];
}

export interface SkillIndexLedger {
  /** 该 name 是否已进场（只读本模块持有的集，不碰 messages）。 */
  has(name: string): boolean;
  /** 进场史全集快照（name 升序，**新数组**；调用方改写不污染内部集）。 */
  snapshot(): readonly string[];
  /**
   * 追加模型索引名并**在同一拍**落盘：落盘成功才返 receipt；失败 throw
   * `SkillIndexLedgerError("write_failed")` 且内存集不变。
   * 未见过的合法名 = `added`；存量名 / 非法名 = 忽略（不抛、不重写盘）。
   */
  addMany(names: readonly string[]): Promise<SkillIndexAddReceipt>;
}

export interface CreateSkillIndexLedgerOptions {
  /**
   * 会话文件夹根（`SessionStore.getProjectDir()`）——本模块不自算
   * `(baseDir, projectIdentityRoot)`，与 todo ledger 同一条注入缝。
   */
  readonly projectDir: string;
  /** 本会话 id；sanitize 后作为叶子目录段（`..` / `/` 不可逃逸）。 */
  readonly conversationId: string;
  /**
   * 该 session 开场模型索引名集（冻表投影）。恢复同一 session 时与落盘史
   * 取并集 —— 冻表名不会被重复追加（SC3）。
   */
  readonly initialNames: readonly string[];
  /**
   * 现行模型索引谓词（`catalog.modelIndex()` 的 name 面）。返回 false 的
   * name 一律忽略 —— 这是「未知 name 写入忽略」的唯一判据入口。
   */
  readonly isIndexedName: (name: string) => boolean;
}

/** 原子写：tmp + rename；任何失败都清 tmp，现有文件保持上次完整内容。 */
async function writeAtomic(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

/**
 * 读回落盘史。`not_found`（新 session / 无文件）不是错误 —— 返回空集，
 * 由 `initialNames` 顶起初值；其余（IO / 解析 / 形状 / 版本）一律 typed
 * `read_failed`：静默当空集重建会把已进场名当新建再贴 listing。
 */
async function readPersistedNames(
  filePath: string,
  conversationId: string
): Promise<readonly string[] | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SkillIndexLedgerError(
      "read_failed",
      { conversationId, detail: errorDetail(error) },
      { cause: error }
    );
  }
  const parsed = parseLedgerFile(raw);
  if (parsed === undefined) {
    throw new SkillIndexLedgerError("read_failed", {
      conversationId,
      detail: `invalid ledger file: ${filePath}`,
    });
  }
  return parsed;
}

/**
 * 严格解析：必须是 `{version: 1, names: string[]}`，names 元素为非空字符串。
 * 手改文件 / 半截写入 / 旧版本 → undefined（调用方抛 `read_failed`）。
 */
function parseLedgerFile(raw: string): readonly string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== SKILL_INDEX_LEDGER_VERSION) return undefined;
  const names = record["names"];
  if (!Array.isArray(names)) return undefined;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) return undefined;
  }
  return names as readonly string[];
}

/** name 升序 —— 与 catalog 的 `byName` 同序，落盘 / 快照都确定。 */
function sortNames(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * 构造期校验：conversationId 是叶子目录段的来源，空串无处可落。
 * 同步抛（在任何 IO 之前），与 `resolveConversationDir` 的 fail-closed 同调。
 */
function assertConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new SkillIndexLedgerError("invalid_conversation_id", {
      conversationId: String(conversationId),
      detail: "conversationId is required and must be a non-empty string",
    });
  }
}

/** 本会话的进场史叶子路径 —— 净化复用 SSOT，`..` / `/` 不可逃逸。 */
function ledgerPath(projectDir: string, conversationId: string): string {
  return join(
    projectDir,
    sanitizeConversationSegment(conversationId),
    SKILL_INDEX_LEDGER_FILE
  );
}

/**
 * canonical 文件正文：`{version, names}` + 尾换行，name 升序。整集一次写，
 * 故文件内容恒为「某次完整成功写入」的形态。
 */
function serializeLedger(names: Iterable<string>): string {
  return `${JSON.stringify(
    { version: SKILL_INDEX_LEDGER_VERSION, names: sortNames(names) },
    null,
    2
  )}\n`;
}

/**
 * 建 ledger 并载入落盘史（异步：构造即读盘，恢复路径不需要第二拍）。
 *
 * 载入语义 = `initialNames ∪ 落盘史`（两边都是入场过的名，无条件收）。
 * `isIndexedName` 只作用于**新写入**的闸；本会话内下架 / disable 不对齐
 * （Assumption 3），故存量不被谓词清掉。
 */
export async function createSkillIndexLedger(
  options: CreateSkillIndexLedgerOptions
): Promise<SkillIndexLedger> {
  const { projectDir, conversationId } = options;
  assertConversationId(conversationId);
  const filePath = ledgerPath(projectDir, conversationId);

  const persisted = await readPersistedNames(filePath, conversationId);
  const names = new Set<string>();
  // 冻表名无条件入集：它们是本会话开场已进场的名。`isIndexedName` 只用于
  // 「新写入」闸（未知 name 忽略），不用于清理存量 —— 本会话内下架 /
  // disable 不对齐（Assumption 3），清掉会让它被当新建再贴一次 listing。
  for (const name of options.initialNames) {
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  for (const name of persisted ?? []) names.add(name);

  const runExclusive = createSerialQueue();

  /** 闸 + 去重：返回本次真正新收的名。非法名一律忽略（不抛）。 */
  const claimNewNames = (incoming: readonly string[]): Set<string> => {
    const added = new Set<string>();
    for (const name of incoming) {
      if (typeof name !== "string" || name.length === 0) continue;
      if (!options.isIndexedName(name)) continue;
      if (names.has(name)) continue;
      added.add(name);
    }
    return added;
  };

  /** 落盘成功才改内存集并返回执；失败 typed throw，集不变（同一拍）。 */
  const commit = async (added: Set<string>): Promise<SkillIndexAddReceipt> => {
    if (added.size === 0) return { added: [], snapshot: sortNames(names) };
    const next = new Set(names);
    for (const name of added) next.add(name);
    try {
      await writeAtomic(filePath, serializeLedger(next));
    } catch (error) {
      throw new SkillIndexLedgerError(
        "write_failed",
        { conversationId, detail: errorDetail(error) },
        { cause: error }
      );
    }
    for (const name of added) names.add(name);
    return { added: sortNames(added), snapshot: sortNames(names) };
  };

  const addMany = (
    incoming: readonly string[]
  ): Promise<SkillIndexAddReceipt> =>
    runExclusive(() => commit(claimNewNames(incoming)));

  return Object.freeze({
    has: (name: string): boolean => typeof name === "string" && names.has(name),
    snapshot: (): readonly string[] => sortNames(names),
    addMany,
  });
}
