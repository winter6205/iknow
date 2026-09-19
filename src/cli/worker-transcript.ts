/**
 * ADR-0102 T3 — 工人 transcript IO 的生产实现（cli 入口注入缝）。
 *
 * 存在理由 = Gate B 方向约束：codec 与 typed-error 词汇住在
 * session-api/store/worker-transcript（复用 SessionFileV1 读路径 = store
 * load/save 缝），而消费者 worker 在 src/harness —— harness 可执行面不得
 * import session-api（tests/harness/public-exports.test.ts 钉死）。所以
 * 装配点放在这里：`__subagent_worker__` dispatch（cli.ts）构造实例、以窄
 * 接口传给 runSubagentWorker。
 *
 * 错误折叠只认一个合法态：`not_found` = 新工人无账 → `absent`；其余 typed
 * kind（io_error / parse_failed / schema_invalid / write_failed）原样上抛
 * —— 损坏的账绝不能被读成无账（否则 fresh seed 会覆盖既有内容）。
 *
 * 路径护栏在工厂入口接线（`isWorkerTranscriptPathSafe` 的调用点）：envelope
 * 是 untrusted 输入面，相对路径 / 空串 typed 拒绝（schema_invalid），不给
 * 「父没算好路径」留静默写到 process.cwd() 的通道。抛错发生在任何 fs 触碰
 * 之前，经 wireWorkerTranscript 原样上抛 → worker 进程 exit 2（协议层崩溃）。
 */
import {
  appendWorkerTranscript,
  isWorkerTranscriptPathSafe,
  loadWorkerTranscript,
  type SessionStoreError,
} from "../session-api/store/index.js";
import type { WorkerTranscriptIOFactory } from "../harness/subagent/worker.js";

export const storeWorkerTranscriptIo: WorkerTranscriptIOFactory = (loc) => {
  if (!isWorkerTranscriptPathSafe(loc.transcriptPath)) {
    throw {
      kind: "schema_invalid",
      conversation_id: loc.taskId,
      field: "transcript_path",
    } satisfies SessionStoreError;
  }
  // WHY: appendWorkerTranscript 是 read-modify-write（读全文件 → 算 next
  // event id → appendFile）且 store 层刻意无锁（架构纪律：锁在装配边界）。
  // worker loop 的 flushPrefix 可被并发回调重入，交错时两批读到同一 head →
  // 重复 event id → schema_invalid → worker exit 2。装配点在此串行化
  // （同主会话 hub serialize queue 对 appendEvents 的保护）。reject 后链
  // 继续（前序错误只回给该调用方，不卡死队列）。
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  return {
    loadMessages: () =>
      serialize(async () => {
        try {
          const file = await loadWorkerTranscript({
            transcriptPath: loc.transcriptPath,
            taskId: loc.taskId,
          });
          return { status: "present", messages: file.messages };
        } catch (err) {
          if ((err as { kind?: string }).kind === "not_found") {
            return { status: "absent" };
          }
          throw err;
        }
      }),
    appendMessages: (events, thinkingMs) =>
      serialize(async () => {
        await appendWorkerTranscript({
          location: { transcriptPath: loc.transcriptPath, taskId: loc.taskId },
          events,
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
          cwd: loc.cwd,
        });
      }),
  };
};
