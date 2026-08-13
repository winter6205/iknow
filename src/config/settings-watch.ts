/**
 * settings.json 文件级热更新 —— 纯函数 watcher 模块（T1）。
 *
 * 监听两个 settings 文件：user 级 `~/.iknow/settings.json` + project 级
 * `<cwd>/.iknow/settings.json`。两者任一变化（修改 / 首次创建）→ 合并去重后
 * 以 `onChange({ path, reason })` 通知。**不解析文件内容**（env 解析归
 * EnvLoader / loadIknowEnv），本模块只做「文件系统事件 → 节流回调」。
 *
 * 技术（plans/settings-hot-reload.md T1，无新 npm 依赖，Node 内置 fs）：
 *   - **主路径**：`fs.watch(dir, { recursive: false })` —— 事件驱动，实测毫秒级
 *     到达，可靠覆盖「创建」（rename）+「修改」（change）两事件。
 *   - **回退路径**：`fs.watchFile(path, { interval: 500 })` —— 轮询兜底，仅在
 *     主路径不可用时激活（`.iknow` 目录尚不存在 → fs.watch 抛 ENOENT），等用户
 *     首次创建目录 / 文件。两条通道**择一**（单活动通道）：同一物理变化不会双报
 *     （reviewer minor 4 根因：双通道各报一次会破坏「多次连续 write → 一次
 *     onChange」的去重验收）。
 *
 * 事件语义（对齐计划回调签名）：
 *   - `reason: "change"` —— 文件内容变化（write / touch）；
 *   - `reason: "rename"` —— 文件创建 / 替换（create / rename 事件、watchFile
 *     从「不存在 → 存在」的跃迁）。
 *   单通道下每个物理变化只上报一次（100ms debounce 合并同窗口内的重复触发）。
 *
 * 启动期语义：
 *   - 文件 / 目录都不存在 → 不抛错，照常注册 watcher 等用户创建（计划 T1）；
 *   - 用户创建的目录在 watcher 启动后才出现 → fs.watch 首次 ENOENT 报错由
 *     内部捕获（不冒泡），watchFile 轮询负责上报首次创建。
 *
 * 生命周期：
 *   - `stop()`：关闭全部 `fs.watch` + `fs.watchFile`，幂等可重复调；停后
 *     onChange 不再触发。
 *   - onChange 回调内抛错被捕获（不阻断后续事件，fire-and-forget 语义）。
 */

import {
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** watchFile 轮询间隔（跨平台一致；fs.watch 事件路径不依赖它）。 */
const WATCH_FILE_INTERVAL_MS = 500;
/** debounce 窗口：编辑器原子保存多次 writeFile 只触发一次 onChange。 */
export const DEBOUNCE_MS = 100;

export type WatchReason = "change" | "rename";

export interface SettingsChangeEvent {
  /** 变化的 settings 文件绝对路径（user 或 project）。 */
  readonly path: string;
  /** "change" = 内容变化；"rename" = 创建 / 替换。 */
  readonly reason: WatchReason;
}

export interface WatchSettingsOptions {
  /** 项目根（project 级 settings 的 `cwd/.iknow/settings.json`）。 */
  readonly cwd?: string;
  /** 用户 home（user 级 settings 的 `home/.iknow/settings.json`）。 */
  readonly home?: string;
  readonly onChange: (event: SettingsChangeEvent) => void;
}

export interface SettingsWatcher {
  /** 幂等：可重复调；停后 onChange 不再触发。 */
  readonly stop: () => void;
}

/**
 * 归一化「目录 fs.watch 事件类型」→ 计划回调 reason。
 * dir watch 对创建发 `rename`、对写入发 `change`；rename/change 之外的
 * 类型（Linux 偶发）→ "change"（保守内容变化语义）。
 */
function dirEventReason(eventType: string | Buffer): WatchReason {
  const t = typeof eventType === "string" ? eventType : eventType.toString();
  return t === "rename" ? "rename" : "change";
}

/**
 * 归一化「watchFile 两代 stat 对比」→ 计划回调 reason。
 *  - 从不存在 → 存在（首次创建 / 原子替换）→ "rename"；
 *  - 存在且内容变了（mtime 或 size）→ "change"。
 *  - 初始注册回显（两代同为缺失 / 同为既存但无实质变化）→ undefined（丢弃）。
 */
function statChangeReason(curr: Stats, prev: Stats): WatchReason | undefined {
  const currExists = curr.size > 0 || curr.mtimeMs > 0;
  const prevExists = prev.size > 0 || prev.mtimeMs > 0;
  if (currExists !== prevExists) return currExists ? "rename" : "change";
  if (!currExists) return undefined; // 两代都缺失：注册回显 / 空态轮询
  // 两代都存在 → 仅当 mtime 或 size 实际变化才报（touch 命中的是 mtime）。
  if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) return "change";
  return undefined;
}

/**
 * 为单个 settings 文件建立事件上报（两通道：目录 fs.watch + watchFile 轮询）。
 *
 * 每个物理写入经 `debouncedEmit` 合并：任一通道先到 → 进入 100ms debounce；
 * 窗口内后续触发被吞。窗口结束以**首次**触发的事件发送一次 onChange。
 */
function watchOneFile(
  filePath: string,
  dirPath: string,
  onChange: (event: SettingsChangeEvent) => void
): { readonly close: () => void } {
  const fileResolved = resolve(filePath);
  const dirResolved = resolve(dirPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: SettingsChangeEvent | undefined;
  let closed = false;

  const debouncedEmit = (reason: WatchReason): void => {
    if (closed) return;
    if (timer !== undefined) return; // 窗口内：吞掉后续（去重）
    pending = { path: fileResolved, reason };
    timer = setTimeout(() => {
      timer = undefined;
      const event = pending;
      pending = undefined;
      if (closed || event === undefined) return;
      try {
        onChange(event);
      } catch {
        // fire-and-forget：回调内抛错不阻断后续事件（计划 T1）。
      }
    }, DEBOUNCE_MS);
  };

  // 单活动通道设计（reviewer minor 4 根因修复）：每文件同一物理变化只走**一条**
  // 通道，避免「同一次 write 被双通道各报一次」破坏去重。
  //   - 目录存在 → fs.watch 事件驱动（主路径，实测毫秒级可靠：write→change、
  //     create→rename）；
  //   - 目录缺失 → fs.watch ENOENT 捕获，改由 watchFile 轮询兜底（用户首次
  //     创建目录/文件时上报，不抛错，计划 T1 启动期语义）。
  // 两条通道是「择一」而非「冗余并联」：watchFile 只在 fs.watch 不可用时激活，
  // 故同一物理变化不会双报。慢 fs.watch 场景由 waitForEvents 超时兜底
  // （测试 SETTLE_MS ≥750ms）。
  const listenerRef = (curr: Stats, prev: Stats): void => {
    const reason = statChangeReason(curr, prev);
    if (reason === undefined) return;
    debouncedEmit(reason);
  };
  let dirWatcher: FSWatcher | undefined;
  try {
    dirWatcher = watch(
      dirResolved,
      { recursive: false },
      (eventType, filename) => {
        // filename 为 null 或非本文件 → 忽略（同目录其它文件变化不触发）。
        if (filename === null) return;
        if (resolve(dirResolved, filename.toString()) !== fileResolved) return;
        debouncedEmit(dirEventReason(eventType));
      }
    );
  } catch {
    // 目录缺失 → 走 watchFile 兜底通道（首次创建上报）。
    dirWatcher = undefined;
    watchFile(fileResolved, { interval: WATCH_FILE_INTERVAL_MS }, listenerRef);
  }

  return {
    close: () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        pending = undefined;
      }
      try {
        dirWatcher?.close();
      } catch {
        // watcher 已关闭时 close() 幂等（可能已随 stop 释放）。
      }
      // watchFile 仅在兜底路径注册；unwatchFile 幂等（未注册时 no-op）。
      unwatchFile(fileResolved, listenerRef);
    },
  };
}

export function watchSettings(opts: WatchSettingsOptions): SettingsWatcher {
  const cwd = resolve(opts.cwd ?? process.cwd());
  // SSOT 对齐 settings.ts:332 用 os.homedir()（process.env.HOME 在 HOME 未设时
  // 为 undefined，回退 process.cwd() 会与 project 文件重复、漏掉真实 user 文件）。
  const home = resolve(opts.home ?? homedir());
  const paths = [
    { file: join(home, ".iknow", "settings.json"), dir: join(home, ".iknow") },
    { file: join(cwd, ".iknow", "settings.json"), dir: join(cwd, ".iknow") },
  ];
  const handles = paths.map(({ file, dir }) =>
    watchOneFile(file, dir, opts.onChange)
  );
  return {
    stop: () => {
      for (const h of handles) h.close();
    },
  };
}
