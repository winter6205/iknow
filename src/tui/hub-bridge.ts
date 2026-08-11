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
import type { PostMessageResponse } from "../session-api/contract.js";
import type { SessionFileV1 } from "../session-api/store/schema.js";
import { rewindFile } from "../session-api/store/index.js";
import type { LoopEngineDeps } from "../harness/index.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import { resolveServeDataDir } from "../session-api/serve.js";

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
}

export interface TuiBridge {
  readonly hub: SessionHub;
  readonly store: SessionStore;
  /** draft → 建档并返回新 conversation_id；已建档 → 原样返回。 */
  readonly ensureSession: (
    conversationId: string | undefined
  ) => Promise<string>;
  /** 发一条消息跑一个 turn（透传 signal 支持 Ctrl+C 打断前台）。 */
  readonly postMessage: (opts: {
    readonly conversationId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }) => Promise<TuiPostResult>;
  readonly listSessions: () => ReturnType<SessionHub["listSessions"]>;
  readonly loadSessionFile: (conversationId: string) => Promise<SessionFileV1>;
  /** 手动压缩会话（/compact）。返回是否实际发生裁剪（false = 无需压缩）。 */
  readonly compactSession: (conversationId: string) => Promise<boolean>;
  /** 回退到更早 turn（/rewind / 双 Esc）：load → rewindFile → store.save →
   *  返回更新文件。错误复用 SessionStore 既有 typed kinds，不新造。 */
  readonly rewindSession: (
    conversationId: string,
    keepTurns: number
  ) => Promise<SessionFileV1>;
  readonly inflight: InflightRegistry;
  /** T3: 上下文窗口容量（tokens）。仅显示用，不触发压缩。 */
  readonly contextWindow: number;
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
  /** T3: 上下文窗口容量（tokens）。缺省 `DEFAULT_CONTEXT_WINDOW = 200_000`。 */
  readonly contextWindow?: number;
}

export function createTuiBridge(opts: CreateTuiBridgeOptions): TuiBridge {
  const store = new SessionStore(resolveServeDataDir(opts.dataDir));
  const hub = new SessionHub({
    store,
    deps: opts.deps,
    defaultJsonMode: opts.defaultJsonMode ?? false,
    traceOut: opts.traceOut,
  });

  const bridge: TuiBridge = {
    hub,
    store,
    ensureSession: async (conversationId) => {
      if (conversationId !== undefined) return conversationId;
      const created = await hub.createSession();
      return created.session.conversation_id;
    },
    postMessage: async ({ conversationId, text, signal, onStream }) => {
      opts.inflight.mark(conversationId);
      try {
        const resp = await hub.postMessage({
          conversationId,
          text,
          signal,
          onStream,
        });
        return {
          conversationId: resp.session.conversation_id,
          finalText: resp.turn.answer.finalText,
          stopReason: resp.turn.answer.stopReason,
          turnCount: resp.session.turn_count,
          jsonMode: resp.session.json_mode,
          // T3: wire 字段缺席等价 null（与 RunResult.lastUsage 语义一致）。
          lastUsage: resp.turn.answer.lastUsage ?? null,
        };
      } finally {
        opts.inflight.unmark(conversationId);
      }
    },
    listSessions: () => hub.listSessions(),
    loadSessionFile: (conversationId) => store.load(conversationId),
    compactSession: async (conversationId) => {
      const res = await hub.compactSession(conversationId);
      return res.compacted;
    },
    // 与 compactSession 同纪律：load → rewindFile → save 直链。store.load /
    // store.save 与 hub 的 serialize 队列共用同一 per-conversation 队列入口
    // 无冲突面（rewind 走 store 裸 IO；hub 的 postMessage/compact 写盘走
    // serialize 队列——load 读到的是队内已落盘的权威文件，save 由 rewindFile
    // 纯截断产出）。错误复用既有 typed kinds（not_found / parse_failed /
    // schema_invalid / write_failed / io_error），不新造。
    rewindSession: async (conversationId, keepTurns) => {
      const file = await store.load(conversationId);
      const rewound = rewindFile(file, keepTurns);
      await store.save({ id: conversationId, file: rewound });
      return rewound;
    },
    inflight: opts.inflight,
    contextWindow: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  };
  return Object.freeze(bridge);
}
