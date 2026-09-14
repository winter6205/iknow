/**
 * last-read ledger（ADR-0084 / specs/aci-file-search-surface.md D1）。
 *
 * 「本 conversation 看过的规范 path」登记表。`write_file` 只在目标**已存在
 * 且 size>0** 时查表：账上没有 → typed 失败、不写盘。新建与空文件免检。
 *
 * 生命周期与 store 正交：
 *   - **进程内存**，键为 conversationId，**不落盘**（resume / 进程重启 → 空表，
 *     spec SC13）。当前生产装配（registry 自建）里表随 registry 同寿：没有任何
 *     生产 caller 调 `destroy` —— 该 API 是给宿主 / 测试的缝，会话 reset 或
 *     shutdown 要清表时由宿主自己接。
 *   - **无 conversationId → 不建桶**。`ledgerFor(undefined)` 返回 `undefined`，
 *     `record` 无处可落 —— 这是与 `graph/ledger.ts` 匿名共享桶模式的显式
 *     例外：spec 要求无 id 的非空 `write_file` fail-closed，且**禁止隐式
 *     进程级全局表**。read_file / 白名单 bash 无 id 仍可执行，只是不入账。
 *
 * 账本只存**规范 path**（调用方用与写入侧同一个 `resolveWithinRoot` 口径
 * 解析后的绝对路径）。本模块不做 path 解析、不 import loop-engine /
 * build-engine / 工具 handler —— 单点职责是分桶与集合判定。
 */

/** 单会话账本：规范 path 的集合。 */
export interface LastReadLedger {
  /** 该规范 path 是否已入账。 */
  readonly has: (canonicalPath: string) => boolean;
  /** 入账一条规范 path（幂等）。 */
  readonly record: (canonicalPath: string) => void;
  /** 测试可观察：已入账条数。 */
  readonly size: () => number;
  /** 清空集合。宿主在会话 reset / 结束时的清表缝；当前生产装配不调用。 */
  readonly destroy: () => void;
}

export function createLastReadLedger(): LastReadLedger {
  const paths = new Set<string>();
  const ledger: LastReadLedger = {
    has: (canonicalPath) => paths.has(canonicalPath),
    record: (canonicalPath) => {
      paths.add(canonicalPath);
    },
    size: () => paths.size,
    destroy: () => {
      paths.clear();
    },
  };
  return Object.freeze(ledger);
}

/**
 * 多会话账本解析器。`ledgerFor` 第一次拿某 conversationId 时懒创建一份；
 * 同一 id 多次取拿回同一对象。
 *
 * `undefined` conversationId → **`undefined`**（不建匿名桶）：调用方据此
 * 对非空 `write_file` fail-closed，同时让无 id 的 read / bash 保持可执行。
 * 这条与 `graph/ledger.ts` 的匿名共享桶相反，是 spec D1 的显式要求。
 */
export interface LastReadLedgerHost {
  /** 取一份账本；同 id 多次取拿回同一对象；`undefined` → `undefined`。 */
  readonly ledgerFor: (
    conversationId: string | undefined
  ) => LastReadLedger | undefined;
  /** 清掉单会话账本。宿主 reset 缝；id 不存在 → no-op。 */
  readonly destroy: (conversationId: string) => void;
  /** 清掉全部账本。宿主 shutdown 缝；进程退出时进程内存自然消失。 */
  readonly destroyAll: () => void;
  /** 测试可观察：当前已创建的会话账本数量。 */
  readonly size: () => number;
}

export function createLastReadLedgerHost(): LastReadLedgerHost {
  const byConv = new Map<string, LastReadLedger>();
  const host: LastReadLedgerHost = {
    ledgerFor: (conversationId) => {
      if (conversationId === undefined) return undefined;
      let ledger = byConv.get(conversationId);
      if (ledger === undefined) {
        ledger = createLastReadLedger();
        byConv.set(conversationId, ledger);
      }
      return ledger;
    },
    destroy: (conversationId) => {
      const ledger = byConv.get(conversationId);
      if (ledger !== undefined) {
        ledger.destroy();
        byConv.delete(conversationId);
      }
    },
    destroyAll: () => {
      for (const ledger of byConv.values()) {
        ledger.destroy();
      }
      byConv.clear();
    },
    size: () => byConv.size,
  };
  return Object.freeze(host);
}
