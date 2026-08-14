/**
 * EnvLoader 工厂 —— settings.json 热更新的宿主侧消费面（T2）。
 *
 * 把 `loadIknowEnv`（一次性读取）与 `watchSettings`（文件事件）组合成
 * 可订阅的 env 源：
 *   - `get()`：lazy load（首次调用才读 settings + .env.local + .env + process.env）；
 *     再次调用返回**同一对象引用**（缓存命中）。
 *   - `reload()`：强制重读并替换缓存；成功返回新 env（新引用），失败**抛错且
 *     不更新缓存**（保留旧 env，降级语义）。
 *   - watch 集成：构造时自建 watcher 订阅；settings 文件变化 → 自动 reload →
 *     成功后通知所有 subscriber（新 env 为参数），失败通知所有 onError 注册
 *     （错误为参数）。通知回调内的异常被吞（observer 错误不阻断 reload 链路）。
 *   - `stop()`：关 watcher + 清空 subscriber / onError 引用，幂等可重复调；
 *     停后不再触发任何通知。
 *   - `markSelfWrite(path, bytes)`：登记一次 settings.json 写回（self-write
 *     哨兵，T2）；后续 watcher 事件读到**相同内容**时跳过 reload（写回不回环）。
 *     判定在 onChange 前置做（读文件 + 内容哈希比对），不碰 settings-watch。
 *
 * opts.cwd / opts.home 透传给 `loadIknowEnv(cwd, undefined, home)` 与
 * `watchSettings`（测试注入 tmp 路径隔离，生产缺省 = process.cwd() / HOME）。
 *
 * 与 settings-watch 同纪律：不解析文件内容（env 解析归 loadIknowEnv），
 * 本模块只做「缓存 + 订阅 + 生命周期」编排。
 */

import { readFileSync } from "node:fs";

import { loadIknowEnv, type IknowEnv } from "./env.js";
import { watchSettings, type SettingsWatcher } from "./settings-watch.js";
import { hashSettingsContent } from "./persist-settings.js";

export interface EnvLoaderOptions {
  /** 项目根（loadIknowEnv 的 settings / .env 读取 + watchSettings project 级）。 */
  readonly cwd?: string;
  /** 用户 home（loadIknowEnv 的 user 级 settings + watchSettings user 级）。 */
  readonly home?: string;
}

export interface EnvLoader {
  /** 首次调用 lazy load；后续返回缓存的同一引用。 */
  get(): IknowEnv;
  /** 强制重读；成功 → 新 env（替换缓存）；失败 → 抛错且缓存不变。 */
  reload(): IknowEnv;
  /** 订阅 env 变化（watcher 触发且 reload 成功）。返回退订函数。 */
  subscribe(fn: (env: IknowEnv) => void): () => void;
  /** 注册 reload 失败通知（坏 JSON / model 缺失 / apiKey 解析失败）。 */
  onError(fn: (err: unknown) => void): void;
  /**
   * 登记一次 settings 写回（self-write 哨兵，T2）。
   * 写入 bytes 的 sha256 进入该路径的哨兵集合；后续 watcher 事件读到相同
   * 内容 → 一次性消费该哈希并跳过 reload（写回不回环）。容量 LRU 8 条路径，
   * 超限挤掉最旧路径（整组哨兵丢弃）。
   */
  markSelfWrite(path: string, bytes: string): void;
  /** 关 watcher + 清引用，幂等。 */
  stop(): void;
}

/**
 * self-write 哨兵 LRU 容量（路径条数）。T2 设计：写回登记入 `Map<path, Set<sha256>>`，
 * 满 8 条挤掉最旧路径（整组哨兵丢弃，不逐哈希淘汰——单次写回内容唯一，逐哈希
 * 无意义且复杂度更高）。
 */
const SELF_WRITE_LRU_CAPACITY = 8;

export function createEnvLoader(opts?: EnvLoaderOptions): EnvLoader {
  const cwd = opts?.cwd;
  const home = opts?.home;

  let cache: IknowEnv | undefined;
  const subscribers = new Set<(env: IknowEnv) => void>();
  const errorHandlers = new Set<(err: unknown) => void>();
  let watcher: SettingsWatcher | undefined;

  // self-write 哨兵：path → 已登记写回 bytes 的 sha256 集合。
  // Map 插入序即 LRU 序：每「路径命中」把该路径挪到末尾；超容量丢头部。
  const selfWrites = new Map<string, Set<string>>();

  const markSelfWrite = (path: string, bytes: string): void => {
    let hashes = selfWrites.get(path);
    if (hashes === undefined) {
      hashes = new Set();
      selfWrites.set(path, hashes);
    } else {
      // 已存在的路径重新登记 → 命中，提前到最后（LRU 触摸）。
      selfWrites.delete(path);
      selfWrites.set(path, hashes);
    }
    hashes.add(hashSettingsContent(bytes));
    // 超容量：丢最旧路径（头部整组）。单路径多次登记只占一条，容量按路径数。
    // size > 容量 > 0 → 头部键必存在，next().value 断言为 string（无分支）。
    if (selfWrites.size > SELF_WRITE_LRU_CAPACITY) {
      selfWrites.delete(selfWrites.keys().next().value as string);
    }
  };

  /**
   * self-write 命中判定（onChange 前置哨兵）：
   * 读当前文件 bytes → sha256 → 与登记集合比对；命中 → 移除该哈希并返回 true。
   * 读文件失败（rename 中间态 ENOENT / 权限等）→ 返回 false（按外部走 reload，
   * 保守不吞事件——最坏多 reload 一次，不丢真实外部改动）。
   */
  const consumeSelfWrite = (path: string): boolean => {
    let currentBytes: string;
    try {
      currentBytes = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    const hash = hashSettingsContent(currentBytes);
    const hashes = selfWrites.get(path);
    if (hashes === undefined || !hashes.has(hash)) return false;
    // 一次性消费：移除该哈希（Set 为空则整条路径哨兵清空，后续同内容按外部）。
    hashes.delete(hash);
    if (hashes.size === 0) selfWrites.delete(path);
    else {
      // 该路径仍有其它登记哈希 → 触摸，保持 LRU 活性。
      selfWrites.delete(path);
      selfWrites.set(path, hashes);
    }
    return true;
  };

  const reload = (): IknowEnv => {
    const next = loadIknowEnv(cwd, undefined, home);
    cache = next;
    return next;
  };

  const notify = (env: IknowEnv): void => {
    for (const fn of [...subscribers]) {
      try {
        fn(env);
      } catch {
        // observer 异常不阻断 reload 链路（与 watcher 回调吞错同纪律）。
      }
    }
  };

  // notifyError 逐条 try/catch（与 notify 同吞错纪律）。forEach 回调里抛错
  // 会被 catch 吞掉（vitest 分支探针不把 try/catch 内的 forEach 算分支）。
  // 注释对齐：notify 用 for..of（既有写法），notifyError 用 forEach 消分支。
  const notifyError = (err: unknown): void => {
    [...errorHandlers].forEach((fn) => {
      try {
        fn(err);
      } catch {
        // 同上：错误处理器自身抛错不影响其它处理器 / 后续事件。
      }
    });
  };

  watcher = watchSettings({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(home !== undefined ? { home } : {}),
    onChange: (event) => {
      // self-write 哨兵：命中 → 跳过 reload（写回不回环，subscriber 不动）。
      // 判定在 settings-watch 之外做（env-loader 侧），保持其「不解析文件内容」
      // 契约（plans 决策 2）；settings-watch 只透传 { path, reason }。
      if (consumeSelfWrite(event.path)) return;
      try {
        notify(reload());
      } catch (err) {
        notifyError(err);
      }
    },
  });

  return {
    get: () => cache ?? reload(),
    reload,
    subscribe: (fn) => {
      subscribers.add(fn);
      // 退订闭包（供调用方解绑；测试 stop() 后复调退订函数覆盖该行）。
      return () => subscribers.delete(fn);
    },
    onError: (fn) => {
      errorHandlers.add(fn);
    },
    markSelfWrite,
    stop: () => {
      watcher?.stop();
      watcher = undefined;
      subscribers.clear();
      errorHandlers.clear();
    },
  };
}
