/**
 * #502 T2 — task registry 落盘层:BackgroundTaskRecord 类型 + 纯 fs 操作。
 *
 * 落盘形状按 ADR-0021 定稿:每个 task 一个 `<task_id>.json`,字段名用
 * snake_case(owner_pid / conversation_id / exit_code / created_at)——
 * 落盘 JSON 键名以 ADR 词条为准,与 session store 惯例一致
 * (conversation_id 是 wire 字段;host 侧内存态用 camelCase 不落盘)。
 *
 * typed-error 判别联合 BackgroundTaskError,kind 契约(code-quality.md):
 *  - empty_task_id / task_not_found / schema_invalid / io_failure 按 kind
 *    判别;非法态 / 合法态由调用方区分(io_failure = 真故障,not_found 对
 *    status 外的路径是合法态可区分)。渲染 `${kind}: ${context}`。
 * 分层:registry 是纯 fs 层,不知道 child process / status 机;manager 持有
 * 内存 Map 并驱动状态迁移。spawn 写 json(log_path 已知)由 manager 完成,
 * 本层 save 接受完整 record 落盘。
 */
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** ADR-0021 定稿 task 状态机字面量。 */
export type BackgroundTaskStatus = "running" | "exited" | "killed";

/**
 * 落盘记录(ADR-0021):字段名 snake_case = wire 契约,与 task_id 格式
 * (`bg-` + 12 hex)一并构成 bash_output / bash_stop 入参的唯一对应。
 * exit_code 缺省 null(running 态),终态后填充自然退出码。
 */
export interface BackgroundTaskRecord {
  readonly task_id: string;
  readonly command: string;
  readonly owner_pid: number;
  readonly conversation_id: string;
  readonly pgid: number;
  readonly status: BackgroundTaskStatus;
  readonly exit_code: number | null;
  readonly created_at: string;
  readonly log_path: string;
}

/**
 * typed-error 判别联合。带 optional cause 供 debug 排查真实故障根因;
 * 渲染统一 `${kind}: ${context}`(code-quality.md typed-error catch 契约)。
 */
export type BackgroundTaskError =
  | { kind: "empty_task_id"; context: string }
  | { kind: "task_not_found"; context: string }
  | { kind: "schema_invalid"; context: string; cause?: unknown }
  | { kind: "io_failure"; context: string; cause?: unknown };

/** 渲染 helper:typed-error 统一形态(测试与 catch 契约共用)。 */
export function renderTaskError(err: BackgroundTaskError): string {
  return `${err.kind}: ${err.context}`;
}

/** logger 由 registry/manager 注入(T3/T4 工具侧可换实现;零默认 = 静默)。 */
export interface BackgroundTaskLog {
  (msg: string): void;
}

export interface BackgroundRegistry {
  /** 保存一条记录(新建或更新);目录不存在时 mkdir -p。 */
  readonly save: (record: BackgroundTaskRecord) => Promise<void>;
  /** 按 task_id 读取记录;不存在 / 非法分别抛 typed-error。 */
  readonly load: (taskId: string) => Promise<BackgroundTaskRecord>;
  /** 列出全部 task_id(仅 *.json 文件名)。 */
  readonly list: () => Promise<readonly string[]>;
  /** 删除记录文件。 */
  readonly remove: (taskId: string) => Promise<void>;
}

export interface BackgroundRegistryOptions {
  readonly tasksDir: string;
  /** 落盘失败 / 风险事件日志(缺省静默)。 */
  readonly log?: BackgroundTaskLog;
}

export function createBackgroundRegistry(
  opts: BackgroundRegistryOptions
): BackgroundRegistry {
  const tasksDir = opts.tasksDir;
  const log = opts.log ?? (() => undefined);

  function filePath(taskId: string): string {
    return join(tasksDir, `${taskId}.json`);
  }

  async function save(record: BackgroundTaskRecord): Promise<void> {
    if (record.task_id.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: "save",
      } satisfies BackgroundTaskError;
    }
    try {
      await mkdir(tasksDir, { recursive: true });
      await writeFile(
        filePath(record.task_id),
        JSON.stringify(record, null, 2),
        "utf8"
      );
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      log(`background registry save failed: ${cause}`);
      throw {
        kind: "io_failure",
        context: `save ${record.task_id}`,
        cause,
      } satisfies BackgroundTaskError;
    }
  }

  async function load(taskId: string): Promise<BackgroundTaskRecord> {
    if (taskId.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: "load",
      } satisfies BackgroundTaskError;
    }
    let raw: string;
    try {
      raw = await readFile(filePath(taskId), "utf8");
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw {
          kind: "task_not_found",
          context: taskId,
        } satisfies BackgroundTaskError;
      }
      throw {
        kind: "io_failure",
        context: `load ${taskId}`,
        cause,
      } satisfies BackgroundTaskError;
    }
    try {
      return JSON.parse(raw) as BackgroundTaskRecord;
    } catch (err) {
      throw {
        kind: "schema_invalid",
        context: `parse ${taskId}`,
        cause: err instanceof Error ? err.message : String(err),
      } satisfies BackgroundTaskError;
    }
  }

  async function list(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await readdir(tasksDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      const cause = err instanceof Error ? err.message : String(err);
      log(`background registry list failed: ${cause}`);
      throw {
        kind: "io_failure",
        context: "list",
        cause,
      } satisfies BackgroundTaskError;
    }
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((n) => n.slice(0, -5));
  }

  async function remove(taskId: string): Promise<void> {
    if (taskId.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: "remove",
      } satisfies BackgroundTaskError;
    }
    try {
      await unlink(filePath(taskId));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw {
          kind: "task_not_found",
          context: taskId,
        } satisfies BackgroundTaskError;
      }
      throw {
        kind: "io_failure",
        context: `remove ${taskId}`,
        cause,
      } satisfies BackgroundTaskError;
    }
  }

  return Object.freeze({ save, load, list, remove });
}
