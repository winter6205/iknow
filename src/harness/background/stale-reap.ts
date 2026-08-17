/**
 * #502 T6 — 启动 stale 清扫:回收 owner_pid 已死的后台任务进程组。
 *
 * ADR-0021 D1.5 语义:iknow 进程是物理锚 —— 进程异常退出(SIGKILL / crash)
 * 后遗留的后台任务进程组没有 owner 治理,下次启动在这里统一回收。
 *
 * 只处理 owner-dead 记录(APROC owner 判定:`/proc/<pid>` 存在 + stat 可读 =
 * alive;否则 dead)。owner-alive 记录跳过 —— 另一个存活的 iknow 进程的 live
 * task,绝不跨进程误 kill。
 *
 * pgid-reuse 加固(ADR-0021 D1.5):kill 前把 `/proc/<pgid-leader>/stat` 的
 * starttime 与 registry record 存的 starttime 比较:
 *   - record 有 starttime 且 mismatch → pgid 已被内核回收后复用给新组,
 *     只标 dead、绝不 kill(复用组的进程是无关进程,误杀不可接受)。
 *   - record 无 starttime(旧版本 record)→ 保守政策:跳过记录、保留 json、
 *     记日志 —— 宁漏不误杀。
 *   - record 有 starttime 且 current 一致 / 读不到(current 组已消失)→
 *     SIGKILL 进程组(ESRCH 吞掉)+ 标 dead。
 *
 * 决不 throw:missing tasksDir / broken json / 落盘失败 → 跳过该条(skipped)
 * 或 best-effort 继续,log 呈现。返回 summary 供调用方展示 / 断言。
 */
import { readFileSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";

import type { BackgroundTaskRecord, BackgroundTaskLog } from "./registry.js";
import { createBackgroundRegistry } from "./registry.js";
import type { BackgroundTaskError } from "./registry.js";

export interface ReapStaleTasksOptions {
  readonly tasksDir: string;
  /** 风险事件日志(缺省静默)。 */
  readonly log?: BackgroundTaskLog;
}

export interface ReapSummary {
  /** 已回收(进程组已 kill + json 标 dead)的 task_id 列表。 */
  readonly reaped: readonly string[];
  /** 本趟跳过(owner alive / 无 starttime / broken json 等)的 task_id 列表。 */
  readonly skipped: readonly string[];
}

/** /proc/<pid> 存在 + stat 可读 = 存活(doesn't distinguish zombie/defunct,
 *  zombie 也仍有 stat —— 保守判 alive,等 OS 回收)。 */
function isPidAlive(pid: number): boolean {
  try {
    return existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

/** 读 /proc/<pid>/stat 第 22 字段(starttime):suffix 空格分词 index 19
 *  (已验证:node suffix[19] === awk $22)。读不到 → undefined。 */
function readProcStartTime(pid: number): number | undefined {
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

/** 一条记录本趟分类 → 计入 reaped / skipped / 不计入(已收敛)。 */
type ReapAction = "reaped" | "skipped" | "none";

async function markDead(
  registry: ReturnType<typeof createBackgroundRegistry>,
  rec: BackgroundTaskRecord,
  taskId: string,
  log: BackgroundTaskLog
): Promise<void> {
  const next: BackgroundTaskRecord = {
    ...rec,
    status: "dead",
  };
  try {
    await registry.save(next);
  } catch (err) {
    log(
      `background reap: mark dead save failed: ${
        (err as BackgroundTaskError).context
      } — ${taskId}`
    );
  }
}

/** 日志卫生:向既有 log 文件追加 reap marker 行。文件不存在 → 吞错误(不创建)。 */
async function appendReapMarker(rec: BackgroundTaskRecord): Promise<void> {
  if (!existsSync(rec.log_path)) return;
  try {
    await appendFile(
      rec.log_path,
      `\n[reap ${new Date().toISOString()}] status=dead task_id=${rec.task_id} pgid=${rec.pgid}\n`,
      "utf8"
    );
  } catch {
    /* 追加失败不阻断回收流程 */
  }
}

export async function reapStaleTasks(
  opts: ReapStaleTasksOptions
): Promise<ReapSummary> {
  const log = opts.log ?? (() => undefined);
  const registry = createBackgroundRegistry({
    tasksDir: opts.tasksDir,
    log,
  });
  const reaped: string[] = [];
  const skipped: string[] = [];

  let taskIds: readonly string[];
  try {
    taskIds = await registry.list();
  } catch (err) {
    // missing 目录 list 返回 [] 不 throw;readdir 其它失败(路径是文件等)
    // → 记日志 + 空 summary,启动清扫永不 crash。
    log(
      `background reap: list failed: ${(err as BackgroundTaskError).context}`
    );
    return { reaped, skipped };
  }

  for (const taskId of taskIds) {
    const action = await handleRecord(registry, taskId, log);
    if (action === "reaped") reaped.push(taskId);
    else if (action === "skipped") skipped.push(taskId);
    // "none" → 已收敛(already_dead),既不计入 reaped 也不计入 skipped,
    // 保持 mtime 不变,zero json changes。
  }

  return { reaped, skipped };
}

/**
 * 处理一条记录。返回本趟分类:
 *   - "reaped":owner_dead + starttime 一致 → 杀组 + 标 dead;
 *             owner_dead + starttime_mismatch → 标 dead,不 kill。
 *   - "skipped":owner_alive / 无 starttime / 落盘失败可恢复 / broken json。
 *   - "none":已 dead 的记录(json 收敛完毕,不再改写 —— 幂等门)。
 */
async function handleRecord(
  registry: ReturnType<typeof createBackgroundRegistry>,
  taskId: string,
  log: BackgroundTaskLog
): Promise<ReapAction> {
  let rec: BackgroundTaskRecord;
  try {
    rec = await registry.load(taskId);
  } catch (err) {
    log(
      `background reap: load ${taskId} failed: ${
        (err as BackgroundTaskError).context
      } — skipped`
    );
    return "skipped";
  }

  // 幂等门:已 dead 记录是上一趟(或本趟)的成果,json 已收敛 —— 不再改写
  // (保持 mtime 不变,zero json changes)。
  if (rec.status === "dead") {
    log(`background reap: already dead, skip ${taskId}`);
    return "none";
  }

  if (isPidAlive(rec.owner_pid)) {
    log(`background reap: owner alive, skip ${taskId}`);
    return "skipped";
  }

  // 无 starttime(旧版本 record)→ 保守政策:跳过、保留 json、记日志。
  if (rec.starttime === undefined) {
    log(
      `background reap: no starttime, conservative skip ${taskId} (pgid ${rec.pgid})`
    );
    return "skipped";
  }

  const currentStart = readProcStartTime(rec.pgid);
  if (currentStart !== undefined && currentStart !== rec.starttime) {
    // pgid 已被内核回收复用给新组 —— 只标 dead,绝不 kill 无关进程。
    log(
      `background reap: starttime mismatch pgid ${rec.pgid} (${rec.starttime} != ${currentStart}) — mark dead only, no kill`
    );
    await markDead(registry, rec, taskId, log);
    await appendReapMarker(rec);
    return "reaped";
  }

  // owner dead + starttime 一致(或 current 读不到=组已消失,ESRCH 无害)。
  // SIGKILL 整组(物理回收,不确定性最低)。ESRCH 吞掉。
  try {
    process.kill(-rec.pgid, "SIGKILL");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      log(`background reap: kill group ${rec.pgid} failed: ${String(err)}`);
    }
  }
  await markDead(registry, rec, taskId, log);
  await appendReapMarker(rec);
  return "reaped";
}
