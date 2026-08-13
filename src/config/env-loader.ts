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
 *
 * opts.cwd / opts.home 透传给 `loadIknowEnv(cwd, undefined, home)` 与
 * `watchSettings`（测试注入 tmp 路径隔离，生产缺省 = process.cwd() / HOME）。
 *
 * 与 settings-watch 同纪律：不解析文件内容（env 解析归 loadIknowEnv），
 * 本模块只做「缓存 + 订阅 + 生命周期」编排。
 */

import { loadIknowEnv, type IknowEnv } from "./env.js";
import { watchSettings, type SettingsWatcher } from "./settings-watch.js";

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
  /** 关 watcher + 清引用，幂等。 */
  stop(): void;
}

export function createEnvLoader(opts?: EnvLoaderOptions): EnvLoader {
  const cwd = opts?.cwd;
  const home = opts?.home;

  let cache: IknowEnv | undefined;
  const subscribers = new Set<(env: IknowEnv) => void>();
  const errorHandlers = new Set<(err: unknown) => void>();
  let watcher: SettingsWatcher | undefined;

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

  const notifyError = (err: unknown): void => {
    for (const fn of [...errorHandlers]) {
      try {
        fn(err);
      } catch {
        // 同上：错误处理器自身抛错不影响其它处理器 / 后续事件。
      }
    }
  };

  watcher = watchSettings({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(home !== undefined ? { home } : {}),
    onChange: () => {
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
      return () => {
        subscribers.delete(fn);
      };
    },
    onError: (fn) => {
      errorHandlers.add(fn);
    },
    stop: () => {
      watcher?.stop();
      watcher = undefined;
      subscribers.clear();
      errorHandlers.clear();
    },
  };
}
