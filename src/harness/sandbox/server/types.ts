/**
 * ADR-0045 — sandbox 执行面 server 化的消息合同 SSOT。
 *
 * 两型协议：
 *   1. 短生命周期 request/response（前台 + verify）: `exec(req): Promise<ExecResponse>`
 *      等子进程退出、取一次性结果。
 *   2. 长生命周期 task-handle（后台）: `spawn(req): Promise<SpawnResponse>`
 *      同步 resolve task_id;返回的 handle 暴露 stdout/stderr/exit/stopped
 *      事件(AsyncIterable) + stop control message。
 *
 * 4 类故障路径(ADR-0045 §4,overflow 已合并进 truncateByCodePoint 契约)
 * 的 typed-error 判别联合定义在此;server 内部一致抛 typed error,client
 * 按 kind 分支。本文件只锁形状,handler 实现见 ./index.ts。
 */
import type { BwrapFence } from "../bwrap.js";

/** 短生命周期 exec request — 等子进程退出后一次性返回结果。 */
export interface ExecRequest {
  readonly kind: "exec";
  readonly fence: BwrapFence;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** 缺省 DEFAULT_MAX_OUTPUT_CODE_POINTS (12_000)。≤0 / 非整数 → RangeError。 */
  readonly maxOutputCodePoints?: number;
  /** 缺省 2_000 ms。负数 → RangeError;0 = 立刻 SIGKILL 不发 SIGTERM。 */
  readonly killGraceMs?: number;
}

export interface ExecResponse {
  /** 信号终止时由 SIGNAL_EXIT_CODES 映射(128 + signal number);exit 缺失落 1。 */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 长生命周期 spawn request — 同步 resolve task_id;handle 持续 emit 事件。 */
export interface SpawnRequest {
  readonly kind: "spawn";
  readonly fence: BwrapFence;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** 缺省 2_000 ms(SIGTERM→SIGKILL 升级宽限);负数 → RangeError。 */
  readonly killGraceMs?: number;
  /** 占位符形态( #406 roundtrip)—— 落盘用,真值由 caller 还原后传 fence。 */
  readonly recordCommand?: string;
  /** session 标识(透传到 manager.state 内存 Map;同 ADR-0021 D1.4 语义)。 */
  readonly conversationId?: string;
}

/** spawn 一次性响应 —— 同步 resolve,客户端拿到 task_id 后立即返回。 */
export interface SpawnResponse {
  readonly task_id: string;
  readonly log_path: string;
}

/** 长生命周期 task event stream(AsyncIterable)。kind 决定形态。 */
export type SandboxTaskEvent =
  | {
      readonly kind: "stdout";
      readonly chunk: string;
    }
  | {
      readonly kind: "stderr";
      readonly chunk: string;
    }
  | {
      readonly kind: "exit";
      readonly exit_code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly kind: "stopped";
      readonly signal: NodeJS.Signals | null;
    };

/**
 * 长生命周期 handle —— 协议层抽象把 kill 升级的中间状态封装,client 只
 * 经 stop() 触发,SIGTERM→SIGKILL 升级由 handle 内部实现。pid 物理
 * 所有权仍在 host(server 同进程,故 host = server)。
 */
export interface SandboxTaskHandle {
  readonly task_id: string;
  readonly log_path: string;
  /**
   * AsyncIterable:event stream (stdout/stderr/exit/stopped)。
   *
   * Single-consumer 契约:每次调用返回一个新的 AsyncIterable;同一 handle
   * 上多次调用 `events()` 会**抢事件** —— 后到的 consumer 会跳过早于它
   * 入队的 stdout/stderr,且 close sentinel 只能被一个 consumer 看到。
   * 设计取舍:同进程 router 形态下 consumer 一一对应(bash tool 后台
   * 单例),无 share 需求;若未来需要 broadcast,加显式 broadcast operator
   * 而非悄悄放宽本契约。
   */
  events(): AsyncIterable<SandboxTaskEvent>;
  /** control message:SIGTERM → graceMs → SIGKILL(缺省 2_000 ms)。幂等。 */
  stop(graceMs?: number): Promise<void>;
}

/** 内部:队列元素判别联合 —— SandboxTaskEvent 或 close sentinel。 */
export type QueuedTaskEvent = SandboxTaskEvent | { readonly kind: "close" };

/**
 * 4 类故障路径的 typed error(ADR-0045 §4 / §5,移除 kind 后剩余)。
 *
 * catch 契约:client 必先识别 kind 分支;`${kind}: ${context}` 渲染;
 * 禁止 `err instanceof Error ? err.message : String(err)` 落 `[object
 * Object]`(code-quality.md typed-error catch 契约)。
 *
 * 设计取舍:
 *   - `empty_task_id` 删除 —— task_id 由 server 端 randomBytes 生成,
 *     caller 无法传入,union 列出即死代码面。
 *   - `overflow` 删除 —— output 截断由 truncateByCodePoint 承载(沿用
 *     runner.ts:84-89 契约),不抛 typed error(ADR-0045 §2.1 语义已
 *     如此,§4 表格对齐)。
 */
export type SandboxServerError =
  /** empty:request 帧缺 fence / cwd 空 → 不 spawn 直接抛。 */
  | { kind: "empty_request"; context: string }
  /** negative:maxOutputCodePoints / killGraceMs 越界。RangeError 透传 truncateByCodePoint 契约。 */
  | { kind: "negative_argument"; context: string; cause: unknown }
  /** exception:子进程退出未回执 / server 不可达(跨进程化未来场景) —— typed fail-loud,不降级。 */
  | {
      kind: "server_unreachable";
      context: string;
      cause?: unknown;
    }
  /** exception:accept 后子进程异常退出未回执 —— typed fail-loud + orphan 进程组 reap(stale-reap.ts:184 纪律)。 */
  | {
      kind: "orphan_process_group";
      context: string;
      pgid?: number;
    };

/** 工具:渲染 typed-error 字面量 `${kind}: ${context}`(code-quality.md catch 契约)。 */
export function renderSandboxServerError(err: SandboxServerError): string {
  return `${err.kind}: ${err.context}`;
}
