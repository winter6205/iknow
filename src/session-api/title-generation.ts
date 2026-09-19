/**
 * ADR-0113 (session-list-title T4): lite model 无工具标题生成模块。
 *
 * 职责边界（spec Contract / ADR-0113 §2）：
 *   - 一次无工具文本补全（复用 `CompactAdapter` 的结构形状 —— 与 full compact
 *     同一 step(state, 冻结空请求, signal) posture，tools 键缺席 = 不下发）；
 *   - 不进 Loop Engine、不进 harness loop、不挡主回合（fire-and-forget 由
 *     hub 侧收口，本模块是纯异步函数）；
 *   - 失败（adapter 抛错 / 空响应 / 超时）一律返回 undefined，永不 reject —
 *     调用方据此保留 extractTitle 占位。
 *
 * 真实装配入口 `buildLiteTitleGenerator`：只消费 `env.llm.liteModel`
 * （T2 已保证非法配置态 = 键缺席，这里不再判空路由）。
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../harness/model-adapter/types.js";
import type { CompactAdapter } from "../harness/compress/index.js";
import { createRealAnthropicAdapter } from "../harness/model-adapter/anthropic-adapter.js";
import {
  wireModelFromRoute,
  type IknowEnv,
  type LiteModelEnv,
  type LlmEnv,
} from "../config/env.js";
import {
  isTurnQuery,
  messageText,
  shouldSeedTaskFocus,
} from "./turn-projection.js";

/** 标题长度上限 —— 与 `extractTitle` 的 80 对齐（SSOT: store/schema.ts）。 */
export const MAX_TITLE_CHARS = 80;
/**
 * 首条 user 文本的「过短」阈值：低于该长度时要求已有助手文本才值得
 * 烧一次 lite（spec Does 5「过短则等已有助手后再生成」）。
 */
export const TOO_SHORT_QUERY_CHARS = 8;
/** 生成调用的客户端上限；超时 = 静默放弃（占位保留），不重试。 */
export const DEFAULT_TITLE_TIMEOUT_MS = 30_000;
/** prompt 内最多带的 user 查询条数 / 每条截断长度。 */
const MAX_QUERIES_IN_PROMPT = 5;
const MAX_QUERY_CHARS_IN_PROMPT = 200;
const MAX_ASSISTANT_CHARS_IN_PROMPT = 500;
/** 标题是一次性短文本：max_tokens 给足单行标签即可，压低误触发面。 */
const TITLE_MAX_OUTPUT_TOKENS = 64;

/** 生成输入：会话内实质 user 查询 + 最近一次助手可见文本（可空串）。 */
export type TitleSource = {
  readonly userQueries: ReadonlyArray<string>;
  readonly assistantText: string;
};

/**
 * hub 注入的生成器依赖（SessionHubOptions.titleGenerator）。
 * 契约：resolve 出候选标题原文（hub 侧统一 sanitize 后才落盘）；
 * 失败 / 超时 / 无结果 → resolve undefined；永不 reject（但 hub
 * 仍防御性 catch，覆盖测试 stub 等非常规实现）。
 */
export type TitleGenerator = (
  source: TitleSource
) => Promise<string | undefined>;

/**
 * 清洗模型输出为单行列表标题：换行/连续空白压成单空格、trim、去成对引号
 * 包装（模型常见回声式包裹「」/""/""）、截断到 80。全空白 → ""（调用方
 * 视为失败，占位保留）。
 */
export function sanitizeSessionTitle(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  for (const [open, close] of [
    ["「", "」"],
    ["“", "”"],
    ['"', '"'],
    ["《", "》"],
  ]) {
    if (t.length > 2 && t.startsWith(open) && t.endsWith(close)) {
      t = t.slice(open.length, t.length - close.length).trim();
      break;
    }
  }
  return t.slice(0, MAX_TITLE_CHARS).trim();
}

/** 构造单次补全的 prompt（用户查询 + 可选助手文本 + 输出约束）。 */
export function buildTitlePrompt(source: TitleSource): string {
  const queries = source.userQueries
    .slice(0, MAX_QUERIES_IN_PROMPT)
    .map((q) => q.slice(0, MAX_QUERY_CHARS_IN_PROMPT));
  const lines = [
    "根据以下会话内容生成一个简短的主题标签，用于会话列表一行扫读。",
    "要求：单行；不超过 20 个字；名词短语优先；不加标点结尾；不要前缀（如「标题：」）；只输出标签本身。",
    "用户提问：",
    ...queries.map((q, i) => `${i + 1}. ${q}`),
  ];
  const assistant = source.assistantText.trim();
  if (assistant.length > 0) {
    lines.push(
      `助手回复：${assistant.slice(0, MAX_ASSISTANT_CHARS_IN_PROMPT)}`
    );
  }
  return lines.join("\n");
}

/**
 * 触发闸（spec Does 5 / 语义 (e)），纯函数：从一次 run 的全量 messages +
 * 最终助手文本推导生成输入；不满足条件返回 undefined（调用方本轮跳过，
 * 下一 completed 回合再判）。
 *
 * - 只取真 user 查询（`isTurnQuery` 滤掉 tool_result / drain / status 等
 *   机器注入 user 消息）；
 * - 寒暄过滤与 `shouldSeedTaskFocus` 同一套闸（SSOT: turn-projection.ts）；
 * - 全部提问都是寒暄 → undefined（不单独烧 lite）；
 * - 首条实质提问 < TOO_SHORT_QUERY_CHARS 且无助手文本 → undefined（过短：
 *   等已有助手文本后再判定）。
 */
export function collectTitleSource(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  assistantText: string
): TitleSource | undefined {
  const queries: string[] = [];
  for (const msg of messages) {
    if (!isTurnQuery(msg)) continue;
    const text = messageText(msg).trim();
    if (text.length === 0) continue;
    if (!shouldSeedTaskFocus(text)) continue;
    queries.push(text);
  }
  if (queries.length === 0) return undefined;
  if (
    queries[0].length < TOO_SHORT_QUERY_CHARS &&
    assistantText.trim().length === 0
  ) {
    return undefined;
  }
  return { userQueries: queries, assistantText };
}

/**
 * 真实 lite 补全的 TitleGenerator 工厂：一次 `step(冻结单消息 state,
 * 冻结空请求, signal)`（请求不含 tools 键 —— adapter 侧条件展开即不下发），
 * 带客户端超时。所有失败分支收敛为 undefined，永不 reject。
 */
export function createLiteTitleGenerator(opts: {
  readonly adapter: CompactAdapter;
  readonly timeoutMs?: number;
}): TitleGenerator {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS;
  return async (source) => {
    const prompt = buildTitlePrompt(source);
    const state: LoopState = Object.freeze({
      messages: Object.freeze([opts.adapter.encodeUserText(prompt)]),
      turnCount: 0,
    });
    const request = Object.freeze({});
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const adapterP = (async (): Promise<string | undefined> => {
      try {
        const result: AssistantTurnResult = await opts.adapter.step(
          state,
          request,
          controller.signal
        );
        const text = (result.projection.texts ?? []).join(" ").trim();
        return text.length > 0 ? text : undefined;
      } catch {
        // EXIT: adapter 抛错（网络 / 协议 / abort）→ 与超时同形态：undefined。
        return undefined;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    const timeoutP = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
      // fire-and-forget 调用不应把进程钉在事件循环上。
      timer.unref?.();
    });
    return Promise.race([adapterP, timeoutP]);
  };
}

/**
 * host 装配缝：`env.llm.liteModel` → 真实 TitleGenerator。非流式单臂、
 * 无 thinking（标题不需要推理链）；client 与主模型同 HOME 认证，仅路由
 * 三元组（baseUrl/apiKey/headers）来自 lite。SDK 0.115 无 close API，
 * client 随 generator 闭包存活，宿主退出即释放。
 */
export function buildLiteTitleGenerator(
  lite: LiteModelEnv,
  opts?: { readonly timeoutMs?: number }
): TitleGenerator {
  const client = new Anthropic({
    apiKey: lite.apiKey,
    baseURL: lite.baseUrl,
    // headers 缺席 → 不传显式 undefined 键（与 createAdapterFromEnv 同纪律）。
    ...(lite.headers !== undefined ? { defaultHeaders: lite.headers } : {}),
  });
  const adapter = createRealAnthropicAdapter({
    client,
    model: wireModelFromRoute(lite.model),
    maxTokens: TITLE_MAX_OUTPUT_TOKENS,
    stream: false,
  });
  return createLiteTitleGenerator({ adapter, timeoutMs: opts?.timeoutMs });
}

/**
 * host 装配缝（serve.ts / tui/hub-bridge.ts 共用）：按「envProvider 优先、
 * 静态 env 兜底」的既有双源形态解析 lite，返回可直接 spread 进
 * SessionHubOptions 的碎片。lite 缺席 → 空对象（`titleGenerator` 键不
 * 出现，hub 永不触发）。分支收敛在本函数内，宿主装配函数零新增复杂度。
 */
export function liteTitleGeneratorOptions(sources: {
  readonly envProvider?: () => IknowEnv;
  readonly env?: { readonly llm: LlmEnv };
}): { readonly titleGenerator?: TitleGenerator } {
  const env =
    sources.envProvider !== undefined ? sources.envProvider() : sources.env;
  const lite = env?.llm.liteModel;
  return lite !== undefined
    ? { titleGenerator: buildLiteTitleGenerator(lite) }
    : {};
}
