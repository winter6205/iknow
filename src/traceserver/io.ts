/**
 * Shared read-side IO error helpers (traceserver bounded context).
 *
 * 从 reader.ts / sessions.ts 各一份重复的 isEnoent / wrapIoError 抽取而来
 * (Standards Medium: 重复代码)。ENOENT 语义是读侧的公共契约:
 *   - 文件/目录被删(读时消失)-> 调用方按场景静默降级(空段 / 跳过该文件);
 *   - 其它 IO 错误 -> 统一 wrap 成 TraceReadError,由 http.ts 映射 500,
 *     不把底层 fs 细节泄漏到 wire(serve.ts:157-166 继承)。
 * 两个 reader 模块都 import 本模块,消除各自私有副本。
 */
import { TraceReadError } from "./types.js";

/** 判断 err 是否为 ENOENT(ENOENT 是读侧静默降级信号,不抛错)。 */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * 把未知 IO 错误包装成 TraceReadError(保留 code,不泄漏原始 message)。
 * 错误 message 不携带 fs 细节,http.ts 映射 500 时不会把路径/权限等信息
 * 暴露到响应体。
 */
export function wrapIoError(err: unknown): TraceReadError {
  const code =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "IO";
  return new TraceReadError(`trace file read failed: ${code}`);
}
