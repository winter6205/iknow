/**
 * #502 T6 — /proc 进程度量读取（pure，无状态，无 IO 副作用）。
 *
 * 单一来源（SSOT）：manager.spawn 的 starttime 读取、stale-reap 的 pgid 复用
 * 校验、测试 helper 三处共用同一实现 —— code-review 修复收敛（#502/#503
 * review-repair：逐字节同形重复改 imports 共享）。纯函数：不做进程治理判断、
 * 不缓存、不抛错（读不到 → undefined，由调用方走保守政策）。
 */
import { readFileSync } from "node:fs";

/**
 * 读 /proc/<pid>/stat 第 22 字段（starttime）：suffix 空格分词 index 19
 * （已验证：node suffix[19] === awk $22）。目录 / 文件不可读 → undefined。
 * 调用方语义：
 *   - manager spawn：记录进程组 leader 的 starttime，供 reap 防 pgid 复用误杀；
 *   - stale-reap：把当前 pgid-leader 的 starttime 与 registry record 存的
 *     starttime 比较，mismatch → 只标 dead 绝不误杀复用组。
 */
export function readProcStartTime(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const suffix = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    const v = Number(suffix[19]);
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
