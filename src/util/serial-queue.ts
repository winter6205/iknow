/**
 * 串行队列 — 会话数据文件写路径的进程内唯一锁层（中立底层工具）。
 *
 * 存在理由：transcript / skill-index ledger 等会话数据文件的 append 都是
 * read-modify-write（读全文件 → 算下一状态 → 写回），而 store 层刻意无锁
 * —— 架构纪律是「锁在装配边界」（对照 session-store.ts `appendEvents` 的
 * hub serialize queue 注释、ADR-0110 单写者契约）。各装配点手写 Promise 链
 * 曾出现两份逐字节同构的实现，收敛到此单一来源。
 *
 * 语义：
 *  - 严格 FIFO：任务按入队顺序开始执行，不并发交叠；
 *  - 前序 reject 只回给该调用方，不卡链：`then(task, task)` 让后序任务在
 *    前序失败时照常执行（失败不污染队列）。
 *
 * 注意：队列只保证「不交叠」，不提供重入安全 —— 在任务内部 await 同队列
 * 的后续任务会死锁，fire-and-forget 入队则安全（排到当前任务之后）。
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
}
