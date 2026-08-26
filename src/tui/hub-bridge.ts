/**
 * src/tui/hub-bridge.ts
 *
 * #343 T6-A 迁移：从 archive/tui-ink/src/hub-bridge.ts 迁回 src/tui/。逻辑与
 * 原版一致（#146 TUI ↔ SessionHub 桥接 α 直连）；仅文件头注释更新为本次迁移
 * 说明。纯 TS 模块，无 ink / OpenTUI 依赖。
 *
 * 职责：
 *  - 装配 SessionStore（~/.iknow + sha1(cwd)[:12] 命名空间，#120）+ SessionHub；
 *  - lazy create（Q4 裁决）：draft 会话首条消息发出才 createSession 建档，
 *    启动即退出不留空壳（list() 本就过滤无 assistant 文本会话，双保险）；
 *  - postMessage 封装：透传 AbortSignal，回执投影为 TUI 会话状态输入；
 *  - 工具事件归因接缝：postToolUse 钩子在 deps 层触发但不知 conversationId，
 *    以「单会话 in-flight」为准归因；多会话并发时抑制（宁缺勿错归）。
 *
 * #146 决策 4（=9a）：本期不做跨进程文件锁；TUI 分时切换 + 单活跃会话，
 * 进程内冲突面小，跨进程最坏后写覆盖先写丢一个 turn，tmp/rename 不写坏文件。
 */
import { SessionStore } from "../session-api/store/session-store.js";
import { SessionHub } from "../session-api/hub.js";
import type {
  PostMessageResponse,
  WireThinkingOverride,
} from "../session-api/contract.js";
import type { SessionFileV1 } from "../session-api/store/schema.js";
import type { LedgerRewindTarget } from "../session-api/store/index.js";
import type { LoopEngineDeps } from "../harness/index.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type { CompactCallerOpts } from "../session-api/contract.js";
import type { CompactReason } from "../harness/compress/index.js";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import type {
  SubAgentManager,
  SubagentInfo,
} from "../harness/subagent/manager.js";
import type { AutoMemoryHook } from "../harness/memory/index.js";
import type { VerifyConfig } from "../harness/verify/index.js";
import type { GraphAssembly } from "../harness/graph/assembly.js";
import type { VerifyAnswerView } from "../session-api/contract.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import type { IknowEnv, LlmEnv } from "../config/env.js";

/**
 * T3: TUI contextWindow 显示配置默认值（与 loop-engine.ts:152 的
 * `deps.compress.contextWindow` 默认 200000 同源；env var
 * `IKNOW_MODEL_CONTEXT_WINDOW`）。仅作显示，不启用压缩（本计划裁决 5）。
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * T6 (checkpoint-rewind): 双 Esc 回退的 debounce 窗口（间隔 ≤ 此值视为双击，
 * 打开 L3 锚点选择器）。对齐 rewind baseline §1 实测 `foE = 1000ms`
 * （specs/checkpoint-rewind.md 双 Esc 行为）。idle 首次 Esc 只记时间戳不动作。
 * 纯函数 `isDoubleEsc(lastMs, nowMs)` 在该文件导出以便单测 1000ms 边界
 * （999ms 命中 / 1001ms 不命中）。调用点不得内联裸字面量 1000。
 */
export const REWIND_DOUBLE_ESC_WINDOW_MS = 1000;

/** 双 Esc debounce 判定：与上次 Esc 间隔 ≤ 窗口 → 命中（双击）。 */
export function isDoubleEsc(lastMs: number, nowMs: number): boolean {
  return nowMs - lastMs <= REWIND_DOUBLE_ESC_WINDOW_MS;
}

/**
 * in-flight 会话登记簿：postMessage 进出登记；deps.ts 的 postToolUse 钩子
 * 经 soleId() 归因工具事件（恰好一个 in-flight → 该会话；否则 undefined）。
 */
export interface InflightRegistry {
  readonly mark: (conversationId: string) => void;
  readonly unmark: (conversationId: string) => void;
  readonly soleId: () => string | undefined;
  readonly ids: () => ReadonlySet<string>;
}

export function createInflightRegistry(): InflightRegistry {
  const inflight = new Set<string>();
  return Object.freeze({
    mark: (conversationId: string): void => {
      inflight.add(conversationId);
    },
    unmark: (conversationId: string): void => {
      inflight.delete(conversationId);
    },
    soleId: (): string | undefined =>
      inflight.size === 1 ? [...inflight][0] : undefined,
    ids: (): ReadonlySet<string> => new Set(inflight),
  });
}

export interface TuiPostResult {
  readonly conversationId: string;
  readonly finalText: string;
  readonly stopReason: PostMessageResponse["turn"]["answer"]["stopReason"];
  readonly turnCount: number;
  readonly jsonMode: boolean;
  /** T3: 最近一次成功模型调用的 token usage（wire 字段缺席 → null，与 RunResult 同语义）。 */
  readonly lastUsage: TokenUsage | null;
  /** B1: Ctrl+C 打断反馈 —— cancelled 时存在（true=checkpoint 已保存 /
   *  false=无新内容未落盘）；非 cancelled 缺席（undefined）。 */
  readonly interrupted?: boolean;
  /** T3 (#458 包2): 本回合 verify 闭环终态
   *  (passed/failed/unstable/escalated)。verifyConfig 缺席 / abort /
   *  disabled → 字段缺席（与 resp.turn.answer.verify byte-stable 同模式）。
   *  TUI 据此判断是否渲染 VerifyBanner，缺席 → 静默不渲染。 */
  readonly verify?: VerifyAnswerView;
}

export interface TuiBridge {
  readonly hub: SessionHub;
  readonly store: SessionStore;
  /** draft → 建档并返回新 conversation_id；已建档 → 原样返回。 */
  readonly ensureSession: (
    conversationId: string | undefined
  ) => Promise<string>;
  /** 发一条消息跑一个 turn（透传 signal 支持 Ctrl+C 打断前台）。
   *  thinking: T2 每回合覆盖 harness 的 thinking 控制臂（与 SessionHub.postMessage
   *  的 wire 字段同形；缺省 → 沿用 ensureDeps 的缓存配置）。 */
  readonly postMessage: (opts: {
    readonly conversationId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
    readonly thinking?: WireThinkingOverride;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }) => Promise<TuiPostResult>;
  readonly listSessions: () => ReturnType<SessionHub["listSessions"]>;
  readonly loadSessionFile: (conversationId: string) => Promise<SessionFileV1>;
  /** 手动压缩会话（/compact）。返回 `{ compacted, cancelled? }`,`compacted`
   *  true = 实际发生裁剪;false = 未达压缩阈值或 #548 中途取消 — 后者
   *  `cancelled:true`,app 层据此区分。signal/onStream 透传到
   *  SessionHub.compactSession → runFullCompact,让 /compact 支持 progress
   *  事件 + 中途取消(Claude Code 体感)。observer 已带 compaction_cancelled
   *  事件,但 pre-aborted signal 路径 observer 不触发(early-return at
   *  full-compact.ts:262);`cancelled` 字段是兜底字段,覆盖所有取消路径。 */
  readonly compactSession: (
    conversationId: string,
    opts?: CompactCallerOpts
  ) => Promise<{
    readonly compacted: boolean;
    readonly cancelled?: boolean;
    /** plan T2:触发判据分类标识(4 选 1);T4 文案分支依据。 */
    readonly reason: CompactReason;
  }>;
  /** continue_pending T4: skip-append 续跑。reload/谓词在 hub；投影同 postMessage。 */
  readonly continueSession: (
    conversationId: string,
    opts?: CompactCallerOpts
  ) => Promise<TuiPostResult>;
  /** 回退：#624 把持久化 head 指到事件 id（null = 空 transcript）。 */
  readonly rewindSession: (
    conversationId: string,
    head: string | null
  ) => Promise<SessionFileV1>;
  /** 当前 head 链上的用户锚点（跳过分支不列出）。 */
  readonly listRewindTargets: (
    conversationId: string
  ) => Promise<ReadonlyArray<LedgerRewindTarget>>;
  readonly inflight: InflightRegistry;
  /** T3: 上下文窗口容量（tokens）。仅显示用，不触发压缩。 */
  readonly contextWindow: number;
  /** 子代理状态只读投影（#358 T7 同真值）：无 manager → 空数组。 */
  readonly listSubagents: () => ReadonlyArray<SubagentInfo>;
}

export interface CreateTuiBridgeOptions {
  /** 会话池根目录；缺省 ~/.iknow（与 serve 同款 resolveServeDataDir）。 */
  readonly dataDir?: string;
  /** harness deps（产品路径传 buildTuiDeps 结果；测试注入 stub deps）。 */
  readonly deps: LoopEngineDeps;
  readonly defaultJsonMode?: boolean;
  readonly traceOut?: string;
  /** in-flight 登记簿（deps.ts 的 soleInflightId 同源，归因一致）。 */
  readonly inflight: InflightRegistry;
  /** subagentManager 由 buildTuiDeps 经 buildHarnessEngine SSOT 装配，
   *  hub-bridge 透传给 SessionHub。缺省 undefined → 无 manager 路径（drain 返空）。 */
  readonly subagentManager?: SubAgentManager;
  /**
   * auto-memory T4 / ADR-0030 D1:自动记忆钩子。与 subagentManager 同路
   * (buildTuiDeps → buildHarnessEngine SSOT 装配) 透传给 SessionHub。
   * 缺席(默认 OFF)→ hub 不调,行为逐字节不变。
   */
  readonly autoMemory?: AutoMemoryHook;
  /** #128 T8: 验证闭环配置。缺席 = 透明关闭 (postMessage 走原 run, SC7)。 */
  readonly verifyConfig?: VerifyConfig;
  /**
   * D-α T5:graph 装配快照句柄（buildTuiDeps 透出）。TUI 自己 build engine,
   * hub 只拿成品 deps —— 句柄必须由这里交进去,否则 `/graph` 翻了 holder 也
   * 进不了下一次装配。缺席 = 本入口未接 overlay。
   */
  readonly graphAssembly?: GraphAssembly;
  /** T3: 上下文窗口容量（tokens）。缺省 `DEFAULT_CONTEXT_WINDOW = 200_000`。 */
  readonly contextWindow?: number;
  /** T2: LLM env 覆盖源，透传给 SessionHub（override 路径重建 adapter 时用，
   *  不回退 process.env）。与 SessionHub 构造 opts 的 overrideEnv 同形。 */
  readonly overrideEnv?: { readonly llm: LlmEnv };
  /**
   * settings-hot-reload（T3）:env 源，透传给 SessionHub.envProvider。
   * T4 由 run.tsx 注入 EnvLoader.get（首次 lazy load + 缓存命中）。
   * 缺省 → hub 内部 loadIknowEnv（行为零变化）。
   */
  readonly envProvider?: () => IknowEnv;
  /** settings-hot-reload（T3）:env 变化回调，透传给 SessionHub.onEnvChange。
   *  T4 由 run.tsx 注入 EnvLoader.subscribe 链路，驱动 TUI 显示层刷新。 */
  readonly onEnvChange?: (env: IknowEnv) => void;
}

export function createTuiBridge(opts: CreateTuiBridgeOptions): TuiBridge {
  const store = new SessionStore(resolveServeDataDir(opts.dataDir));
  const hub = new SessionHub({
    store,
    deps: opts.deps,
    defaultJsonMode: opts.defaultJsonMode ?? false,
    traceOut: opts.traceOut,
    // subagentManager 由 buildTuiDeps 经 buildHarnessEngine SSOT 装配，
    // hub-bridge 透传给 SessionHub。
    subagentManager: opts.subagentManager,
    // auto-memory T4:自动记忆钩子同路透传(缺席 = 关)。
    ...(opts.autoMemory ? { autoMemory: opts.autoMemory } : {}),
    // #128 T8: verifyConfig 由 run.tsx 装配 (settings.verify 段) 透传。
    // command 缺失时 (含 verify 段缺失) 由 runClassifier 接管 (subagentManager
    // 在场);缺席 = 不包裹 run (仅未接线路径)。
    verifyConfig: opts.verifyConfig,
    // D-α T5: 每条 postMessage 前拍一次 graph 装配快照（SC3 与 chat 同语义）。
    ...(opts.graphAssembly ? { graphAssembly: opts.graphAssembly } : {}),
    // T2: LLM env 覆盖源 —— TUI 启动期校验过的 env 透到 override 路径，
    // 避免 override 重建 adapter 时回退到 process.env（reviewer blocker）。
    ...(opts.overrideEnv ? { overrideEnv: opts.overrideEnv } : {}),
    // settings-hot-reload（T3）:env 源 + 变化回调透传（缺省 → 行为零变化）。
    ...(opts.envProvider ? { envProvider: opts.envProvider } : {}),
    ...(opts.onEnvChange ? { onEnvChange: opts.onEnvChange } : {}),
  });

  const toPostResult = (resp: PostMessageResponse): TuiPostResult => ({
    conversationId: resp.session.conversation_id,
    finalText: resp.turn.answer.finalText,
    stopReason: resp.turn.answer.stopReason,
    turnCount: resp.session.turn_count,
    jsonMode: resp.session.json_mode,
    lastUsage: resp.turn.answer.lastUsage ?? null,
    interrupted: resp.turn.answer.interrupted,
    ...(resp.turn.answer.verify !== undefined
      ? { verify: resp.turn.answer.verify }
      : {}),
  });

  const bridge: TuiBridge = {
    hub,
    store,
    ensureSession: async (conversationId) => {
      if (conversationId !== undefined) return conversationId;
      const created = await hub.createSession();
      return created.session.conversation_id;
    },
    postMessage: async ({
      conversationId,
      text,
      signal,
      thinking,
      onStream,
    }) => {
      opts.inflight.mark(conversationId);
      try {
        const resp = await hub.postMessage({
          conversationId,
          text,
          signal,
          onStream,
          ...(thinking !== undefined ? { thinking } : {}),
        });
        return toPostResult(resp);
      } finally {
        opts.inflight.unmark(conversationId);
      }
    },
    listSessions: () => hub.listSessions(),
    loadSessionFile: (conversationId) => store.load(conversationId),
    compactSession: async (conversationId, compactOpts) => {
      const res = await hub.compactSession(
        conversationId,
        compactOpts !== undefined
          ? {
              ...(compactOpts.signal !== undefined
                ? { signal: compactOpts.signal }
                : {}),
              ...(compactOpts.onStream !== undefined
                ? { onStream: compactOpts.onStream }
                : {}),
            }
          : undefined
      );
      // cancelled 透传 — TUI app 据此区分"未达阈值"与"用户中途取消" (Low #1 兜底)。
      // reason 透传 — plan T2 触发判据分类标识,T4 据此分文案(详见 plans/
      // compress-trigger-gate.md T4 acceptance 的「TUI 文案」分支)。
      return {
        compacted: res.compacted,
        reason: res.reason,
        ...(res.cancelled ? { cancelled: true } : {}),
      };
    },
    continueSession: async (conversationId, continueOpts) => {
      opts.inflight.mark(conversationId);
      try {
        const resp = await hub.continueSession(conversationId, continueOpts);
        return toPostResult(resp);
      } finally {
        opts.inflight.unmark(conversationId);
      }
    },
    // #622 T5: rewind 改走 hub.rewindSession —— 与 postMessage/compact 同
    // 一条 per-conversation serialize 队列（此前绕开队列直调 store 裸 IO
    // 的纪律随 rewindFile 截断语义一起退役）。hub 侧落点是
    // #624: hub.rewindSession(id, head) → store.rewindToHead，不截断文件。
    // store.load 取回投影（closeout 自愈后的权威视图）供 TUI 渲染。
    rewindSession: async (conversationId, head) => {
      await hub.rewindSession(conversationId, head);
      return store.load(conversationId);
    },
    listRewindTargets: async (conversationId) => {
      const { targets } = await hub.listRewindTargets(conversationId);
      return targets;
    },
    inflight: opts.inflight,
    contextWindow: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    // #358 T7: 子代理只读投影。无 manager（ask surface / 旧产品路径） → 空。
    listSubagents: () => opts.subagentManager?.listSubagents() ?? [],
  };
  return Object.freeze(bridge);
}
