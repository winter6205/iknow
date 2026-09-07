/**
 * 活图账本（live-graph-phase1 T1）。
 *
 * 权威来自 `docs/adr/0047-live-graph-session-authority.md`：长程图的"已
 * 完成不重演"由 host 持有的活图状态保证，不靠模型对 transcript 的记忆。本
 * 模块是 harness/graph 的单点权威（bounded-context-guardian 边界：
 * session-api / cli 只持有/销毁，不实现账本逻辑）。
 *
 * ## 生命周期（spec SC1–SC4 / ADR-0051）
 *
 *   1. **创建**：第一次 `run_graph` 的 `nodes` 通过 `validateGraph` 之后
 *      调 `ensure()`；之前 `exists()` 为 false。验证失败不创建 —— 拓扑非法
 *      不留任何账本痕迹。
 *   2. **overlay 关不毁**：关掉 graph mode 后再开，同一会话仍是同一张账本
 *      —— `LiveGraphLedger` 与 `GraphModeContext` 平行挂在 session runtime
 *      上，不是 `GraphAssembly` 的快照。
 *   3. **reset / 会话结束销毁**：`destroy()` 清空已冻结集合与会话存在标志。
 *      `/reset`（CLI） / `resetSession`（hub） / 进程退出 / `hub.shutdown`
 *      调它。销毁后旧 id 可重新提交并真 spawn。
 *   4. **compact 不扔**：账本是 in-process 对象，compact 只重写 transcript
 *      不动它；冻结集合原样保留。
 *
 * ## 冻结语义（T1 种子，T2 完整合并）
 *
 * `freeze(id, status)` 只接受 `done` 与 `failed` —— `skipped` 与从未跑过的
 * id 不冻结（spec Glossary：NodeOutcome 冻结 = 最后一次结局为 done 或
 * failed）。`isFrozen(id)` 是 `run_graph` handler 在 spawn 前的 typed 拒绝
 * 依据（零 spawn，与拓扑非法同一类别）。
 *
 * ## 进程死亡与跨进程 resume
 *
 * 账本不写 JSONL（spec ASSUMPTIONS #9）。进程死后从 transcript resume 不
 * 重建账本 —— 新的会话对象从空账本开始；旧会话的冻结语义随旧进程消亡
 * 释放，这是产品行为而非 bug。
 *
 * ## 多会话 hub
 *
 * `LiveGraphLedgerHost` 是按 conversationId 解析账本的薄包装 —— 一个
 * hub 持有的多会话账本由它统一创建/销毁；CLI / 一次性调用等单会话入口
 * 用同一个 host 但只对一个 id 写。
 *
 * 边界：本模块不 import loop-engine / build-engine / session-api。
 */

/** 终态 —— 冻结依据（spec Glossary）。 */
export type FrozenTerminal = "done" | "failed";

/** 结算可传的全部状态；非终态一律不冻。对齐 `NodeStatus` 的运行态子集。 */
export type SettleStatus = FrozenTerminal | "skipped" | "running" | "pending";

/** 账本单点强制：只有终态进冻结集合（spec Glossary，调用方不各自过滤）。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "failed"]);

export interface LiveGraphLedger {
  /** 账本是否已创建（第一次 `ensure()` 之后为 true，销毁后回 false）。 */
  readonly exists: () => boolean;
  /**
   * 第一次调用创建账本（推迟到 `validateGraph` 通过之后）；之后调用是
   * 幂等 no-op。验证失败路径绝不应调它 —— spec SC1 关键边界。
   */
  readonly ensure: () => void;
  /**
   * 记录一次结算的终态。`done` / `failed` 冻结；`skipped`（含其它非终态
   * 值）静默忽略（spec Glossary：skipped 不冻）。同 id 多次 freeze 后写以
   * 末次状态为准（fallback 收敛，便于后续 `back-edge` 等回写场景）。
   *
   * `output` 是 T2 剩余子图合并的数据流：status 为 done 且传入 string 时
   * 记进产出表（`outputOf` 可读）；failed / skipped / 未传 → 清掉旧产出，
   * 保证产出与末次状态一致。
   *
   * 接受完整结算状态集而非仅终态：handler 拿到 `GraphNodeResult.status`
   * 直传即可，"skipped 不冻" 由账本单点强制，不靠调用方各自过滤。
   */
  readonly freeze: (
    id: string,
    status: FrozenTerminal | "skipped" | "running" | "pending",
    output?: string
  ) => void;
  /** 该 id 是否因 done/failed 终态被冻结 —— handler 用它做 typed 拒绝。 */
  readonly isFrozen: (id: string) => boolean;
  /** 该 id 的冻结状态；未冻结返回 undefined。剩余子图合并用它区分 done / failed。 */
  readonly statusOf: (id: string) => FrozenTerminal | undefined;
  /**
   * 该 id 冻结为 done 时记录的产出；未冻结或非 done 返回 undefined。
   * T2 剩余子图合并的数据源：第二段提交省略已 done 的上游时，host 用它
   * 把上游产出写进下游节点 task（spec SC5「B 能读到 A 的产出」）。
   */
  readonly outputOf: (id: string) => string | undefined;
  /** 快照：当前冻结的全部 id（顺序按首次 freeze 的顺序，稳定测试断言）。 */
  readonly frozenIds: () => ReadonlyArray<string>;
  /** 销毁：清空冻结集合与会话存在标志。会话结束 / reset 调它。 */
  readonly destroy: () => void;
}

export function createLiveGraphLedger(): LiveGraphLedger {
  let created = false;
  // 用 Map 而非 Record 既保插入顺序又让 isFrozen O(1)；不存 `frozen` 布尔
  // —— 末次 status 由"是否在 map 里"即可推断，status 字段留给 T2 失败回写
  // 等场景扩展。
  const frozen = new Map<string, FrozenTerminal>();
  // T2:已冻结 done 节点的产出快照(spec SC5「B 能读到 A 的产出」)。
  // 只在 freeze 调用方传入 output 且 status === "done" 时写。
  const outputs = new Map<string, string>();
  const ledger: LiveGraphLedger = {
    exists: () => created,
    ensure: () => {
      if (created) return;
      created = true;
    },
    freeze: (id, status, output) => {
      if (!created) return;
      if (!TERMINAL_STATUSES.has(status)) return;
      frozen.set(id, status as FrozenTerminal);
      if (status === "done" && typeof output === "string") {
        outputs.set(id, output);
      } else {
        outputs.delete(id);
      }
    },
    isFrozen: (id) => frozen.has(id),
    statusOf: (id) => frozen.get(id),
    outputOf: (id) => outputs.get(id),
    frozenIds: () => [...frozen.keys()],
    destroy: () => {
      created = false;
      frozen.clear();
      outputs.clear();
    },
  };
  return Object.freeze(ledger);
}

/**
 * 多会话账本解析器（hub 用）。`ledgerFor` 在第一次拿某 conversationId
 * 时懒创建一份；同一 id 多次取拿回同一对象。`destroy` 清掉一份会话
 * 账本（reset）；`destroyAll` 清掉全部（hub.shutdown / 进程退出）。
 *
 * 单会话入口（CLI / 直调 handler 的测试）也用同一个 host，但通常
 * `destroyAll` 由进程退出兜底（无显式 shutdown 钩子仍能让对象 GC）。
 *
 * `undefined` conversationId（tool handler 在 `ctx.conversationId` 缺席
 * 的 stub / 直调路径）落到一份共享的"匿名"账本 —— 行为可观测、不
 * 静默丢冻结语义，与 spec SC1 "未交节点无账本" 兼容：host 默认未实例化
 * 时工具不调账本逻辑，匿名账本仅在 host 实例化且 handler 真跑过来时才
 * 触及。
 */
export interface LiveGraphLedgerHost {
  /** 取一份账本；同 id 多次取拿回同一对象。`undefined` 落到共享匿名账本。 */
  readonly ledgerFor: (conversationId: string | undefined) => LiveGraphLedger;
  /** 销毁单会话账本（reset / 会话结束）。id 不存在 → no-op。 */
  readonly destroy: (conversationId: string) => void;
  /** 销毁全部账本（hub.shutdown / 进程退出）。 */
  readonly destroyAll: () => void;
  /** 测试可观察：当前已创建的会话账本数量（不计匿名单例）。 */
  readonly size: () => number;
}

export function createLiveGraphLedgerHost(): LiveGraphLedgerHost {
  const byConv = new Map<string, LiveGraphLedger>();
  const anonymous = createLiveGraphLedger();
  const host: LiveGraphLedgerHost = {
    ledgerFor: (conversationId) => {
      if (conversationId === undefined) return anonymous;
      let ledger = byConv.get(conversationId);
      if (ledger === undefined) {
        ledger = createLiveGraphLedger();
        byConv.set(conversationId, ledger);
      }
      return ledger;
    },
    destroy: (conversationId) => {
      const ledger = byConv.get(conversationId);
      if (ledger !== undefined) {
        ledger.destroy();
        byConv.delete(conversationId);
      }
    },
    destroyAll: () => {
      for (const ledger of byConv.values()) {
        ledger.destroy();
      }
      byConv.clear();
      anonymous.destroy();
    },
    size: () => byConv.size,
  };
  return Object.freeze(host);
}
