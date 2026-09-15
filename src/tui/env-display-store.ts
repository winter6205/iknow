/**
 * src/tui/env-display-store.ts
 *
 * env 派生显示快照（当前模型路由串 + thinking 基线）的**框架无关**可观察
 * 存储：CLI/env 解析结果的唯一发布口，React 侧经
 * `useSyncExternalStore(store.subscribe, store.get)` 消费。
 *
 * 为什么要有这一层：/model 与 /effort 可在会话中途改写路由与基线，显示层
 * （context-bar 的 `{model} · {effort}` 前缀）必须跟着变，但改动的来源在
 * session-api 回调里、不在 React 树内。把「当前值 + 变更通知」抽成纯 store
 * 后，TUI 无需把 env 快照塞进 props 逐层传递（props 传递会波及整条组件链，
 * 且 env 变更只影响一处显示）。同形先例见 src/cli/stream-draft.ts。
 *
 * 无 React / 无 fd 依赖，纯值 + Set 状态，可独立单测。
 */

import type { DefaultThinkingShape } from "./thinking-gate.js";

/**
 * 发布入参（omit-version 形状）：publish 与工厂初值共用同一形状 —— 序号由
 * store 唯一分配，调用方不自编号。命名导出供调用方（宿主装配 / 测试夹具）
 * 标注变量，避免各处内联重复声明同一对象形状后漂移。
 */
export interface EnvDisplaySeed {
  readonly model: string | undefined;
  readonly defaultThinking: DefaultThinkingShape | undefined;
}

/** 已发布快照：display 所需的全部派生值 + 发布序号。 */
export interface EnvDisplaySnapshot {
  /** 当前模型路由串（env.llm.model SSOT）。 */
  readonly model: string | undefined;
  /** thinking 基线（env.llm.thinking / thinkingEffort 投影）。 */
  readonly defaultThinking: DefaultThinkingShape | undefined;
  /** 单调递增发布计数（观测/调试用；不参与渲染决策）。 */
  readonly version: number;
}

export interface EnvDisplayStore {
  /**
   * 当前快照。**未 publish 过变化时必须返回同一对象身份** ——
   * `useSyncExternalStore` 以 Object.is 比较 getSnapshot 返回值，若每次现造
   * 新对象会被判成「快照已变」→ 触发重渲染 → 再取快照 → 无限循环
   * （React 会以 "getSnapshot should be cached" 告警并可能死循环）。
   * 故快照只在 publish 时重建，get 只回读。
   */
  get(): EnvDisplaySnapshot;
  /** 订阅变更；返回退订函数（幂等：重复调用无害）。 */
  subscribe(listener: () => void): () => void;
  /** 替换快照并同步通知订阅者。 */
  publish(snapshot: EnvDisplaySeed): void;
}

/** 工厂：initial 为 omit-version 形状，version 从 0 起。 */
export function createEnvDisplayStore(
  initial: EnvDisplaySeed
): EnvDisplayStore {
  // 快照存储单元：publish 时整体替换，get 只读同一引用（身份稳定）。
  let current: EnvDisplaySnapshot = {
    model: initial.model,
    defaultThinking: initial.defaultThinking,
    version: 0,
  };
  const listeners = new Set<() => void>();

  return {
    get(): EnvDisplaySnapshot {
      return current;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      // 幂等退订：React 在 StrictMode / 依赖变化下可能重复调用 cleanup，且
      // cleanup 可能晚于 listener 被触发，重复 delete 必须无害（Set.delete
      // 本身幂等，闭包标志位只为语义显式，不依赖 Set 实现细节）。
      let unsubscribed = false;
      return (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        listeners.delete(listener);
      };
    },

    publish(snapshot: {
      readonly model: string | undefined;
      readonly defaultThinking: DefaultThinkingShape | undefined;
    }): void {
      // 序号由 store 唯一分配（发布方不自编号）：即使字段同值也推进 —— 序号
      // 变化本身是「有新发布」的信号，消费方无需自行 diff 字段。
      current = {
        model: snapshot.model,
        defaultThinking: snapshot.defaultThinking,
        version: current.version + 1,
      };
      // 先复制再遍历（快照语义）：listener 在通知中自退订 / 移除尚未轮到的
      // listener / 新增订阅，都不得改动**本次**投递集合 —— 边遍历边改
      // Set 会让「尚未轮到者被跳过」或「新订阅者收到在途发布」，
      // 前者会静默丢通知（React 侧即 stale UI）。新增订阅者从下次 publish
      // 起生效（本用例已在测试中钉死）。
      const pending = Array.from(listeners);
      for (const listener of pending) {
        try {
          listener();
        } catch {
          // swallow：显示层 listener 多为 React 通知回调，抛异常不得反向
          // 破坏数据生产者，也不得阻断后续 listener（同 stream-draft 的
          // D3 隔离契约）。TUI 不得因一次显示刷新失败而崩溃或丢帧。
        }
      }
    },
  };
}

/** 未接线快照：字段恒空。冻结 + 模块级单例 —— 身份恒定是
 * useSyncExternalStore 的硬要求，实例化在模块加载期一次完成。 */
const EMPTY_ENV_DISPLAY_SNAPSHOT: EnvDisplaySnapshot = Object.freeze({
  model: undefined,
  defaultThinking: undefined,
  version: 0,
});

/**
 * 未接线的惰性 store（`envDisplay?` 可选 prop 的统一兜底）：读值恒空、
 * 订阅永不触发 —— 与「env 从未变化」渲染等价。与工厂同文件导出，消费方
 * （TuiApp / ContextBar）不做第二份实现：快照形状或 store 契约变更时，
 * 兜底与正式实现只能在同一处漂移。
 */
export const EMPTY_ENV_DISPLAY_STORE: EnvDisplayStore = Object.freeze({
  get: () => EMPTY_ENV_DISPLAY_SNAPSHOT,
  subscribe: () => (): void => {},
  publish: (): void => {},
});
