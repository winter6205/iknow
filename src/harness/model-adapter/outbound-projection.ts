/**
 * ADR-0112 T2 — 指令权威出站投影(outbound projection)。
 *
 * 边界:
 *   - 投影是 `(messages, request.system)` 的**纯函数**:同一权威历史 →
 *     同一 wire 字节(KV 前缀稳定);不写回 LoopState(盘上真源可脏);
 *   - 官方帧外形(`<agent_status>` / `<graph_mode>` / 前缀锚)只允许出现在
 *     带 `hostInjected` 出处戳的宿主 commit 消息;无戳 user 文本与
 *     tool_result 文本(载荷 = untrusted)做确定转译:转译后任何宿主甄别
 *     谓词都不再认出官方帧,而内容仍可读(数据不丢);assistant 文本块
 *     原样透传(invariant 3 只约束无戳 user 与 tool_result;转译模型
 *     重放会造成重放字节漂移);
 *   - 出处戳非模型可见:投影输出只含 wire 协议字段,wire JSON 不出现戳;
 *   - fail-closed(invariant 5):畸形权威历史(被外部污染的 transcript)→
 *     抛 typed `OutboundProjectionError`(kind 判别,遵循项目 typed-error
 *     渲染契约),调用方在触达 SDK 前中止本跳,绝不回落「原样上脏」。
 *
 * 转译规则(单一、集中在本缝,不散进各工具):
 *   1. 官方帧标签 → 实体转义:全等字面 `<name>` / `</name>` →
 *      `&lt;name&gt;`;前缀形态 `<name` / `</name`(含 `<agent_status foo>`
 *      这类带属性变体)→ `&lt;name` / `&lt;/name`。标签字面取自产出方
 *      常量(agent-status / graph notification / skill index-delta),不手抄;
 *   2. 行首宿主前缀锚 = `HOST_INJECTION_LINE_ANCHORS` 导出名册(与甄别
 *      谓词共享的 SSOT,漂移由 import 结构性排除)→ 锚前插入 `&` 单字符
 *      转义标记;
 * 两规则均幂等(转译产物不再含被转译形态)。
 */

import type { AnthropicContentBlock, AnthropicNativeMessage } from "./types.js";
import {
  AGENT_STATUS_CLOSE_TAG,
  AGENT_STATUS_OPEN_TAG,
} from "../agent-status.js";
import { HOST_INJECTION_LINE_ANCHORS } from "../agent-status-instruction.js";
import {
  GRAPH_MODE_CLOSE_TAG,
  GRAPH_MODE_OPEN_TAG,
} from "../graph/notification.js";
import { SKILL_INDEX_DELTA_PREFIX } from "../skill/index-delta.js";

/**
 * 投影失败 = typed 判别错(kind),不裸抛 Error;消费方(loop-engine catch、
 * 装配层 overflow judge catch)按 kind 区分,渲染走 `${kind}: ${message}`,
 * 禁 `err instanceof Error ? err.message : String(err)`(code-quality.md)。
 */
export type OutboundProjectionErrorKind =
  "invalid_message" | "invalid_content_block" | "invalid_tool_result_content";

export class OutboundProjectionError extends Error {
  override readonly name = "OutboundProjectionError";
  readonly kind: OutboundProjectionErrorKind;
  readonly detail: string;
  constructor(kind: OutboundProjectionErrorKind, detail: string) {
    super(`OutboundProjectionError: ${kind} — ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * 宿主注入 commit 盖戳(loop-engine 各注入缝使用)。返回新冻结对象,
 * 不原地改 encodeUserText 产物;戳只被本模块投影消费,其余读面(TUI、
 * store 校验、名册谓词)把它当未知顶层字段透传。
 */
export function stampHostInjected(
  msg: AnthropicNativeMessage
): AnthropicNativeMessage {
  return Object.freeze({ ...msg, hostInjected: true });
}

// -- 转译名册(单一转译规则表) ----------------------------------------------------

/** 官方帧开/闭标签对。标签字面全部取自产出方常量（SSOT，不手抄）。 */
const OFFICIAL_FRAME_TAGS: ReadonlyArray<
  readonly [open: string, close: string]
> = [
  [AGENT_STATUS_OPEN_TAG, AGENT_STATUS_CLOSE_TAG],
  [GRAPH_MODE_OPEN_TAG, GRAPH_MODE_CLOSE_TAG],
  // available_skills 的渲染函数在 identity/assemble.ts（本模块不 import），
  // 闭标签由谓词面导出的开标签常量派生 —— 同名单一来源。
  [SKILL_INDEX_DELTA_PREFIX, `</${SKILL_INDEX_DELTA_PREFIX.slice(1, -1)}>`],
];

function tagEntity(tag: string): string {
  const closing = tag.startsWith("</") ? "/" : "";
  return `&lt;${closing}${tag.slice(closing ? 2 : 1, -1)}&gt;`;
}

/**
 * 标签转译表：全等字面 `<name>` / `</name>` → `&lt;name&gt;` 实体形态
 * （既有字节锁），再加前缀形态 `<name` / `</name` → `&lt;name` ——
 * 覆盖 `<agent_status foo>` 这类带属性/畸形变体（invariant 3 升级口径）。
 * 全等替换先行，前缀替换只吃残余变体；产物不再含任何 needle，幂等。
 */
const TAG_ESCAPES: ReadonlyArray<readonly [string, string]> =
  OFFICIAL_FRAME_TAGS.flatMap(
    ([open, close]) =>
      [
        [open, tagEntity(open)],
        [close, tagEntity(close)],
        [open.slice(0, -1), tagEntity(open).slice(0, -4)],
        [close.slice(0, -1), tagEntity(close).slice(0, -4)],
      ] as Array<readonly [string, string]>
  );

/**
 * 行首宿主前缀锚 = `HOST_INJECTION_LINE_ANCHORS` 导出名册本身（SSOT 在
 * agent-status-instruction，与甄别谓词共享；名册↔转译一致性由投影
 * 漂移锁测试逐条遍历校验）。
 */
const HOST_LINE_ANCHORS: ReadonlyArray<string> = HOST_INJECTION_LINE_ANCHORS;

function escapeAnchorLine(line: string): string {
  const trimmed = line.trimStart();
  for (const anchor of HOST_LINE_ANCHORS) {
    if (trimmed.startsWith(anchor)) {
      const ws = line.slice(0, line.length - trimmed.length);
      return `${ws}&${trimmed}`;
    }
  }
  return line;
}

/**
 * untrusted 文本 → 确定转译文本。转译后无法复现未转义的官方帧语法
 * (invariant 3),内容仍完整可读 —— 只添加转义标记,不删除数据。
 * 纯函数、幂等。
 */
export function neutralizeUntrustedText(text: string): string {
  let out = text;
  for (const [from, to] of TAG_ESCAPES) {
    out = out.split(from).join(to);
  }
  return out.split("\n").map(escapeAnchorLine).join("\n");
}

// -- wire 形状 ------------------------------------------------------------------

/** 投影输出的 wire content block(剥戳后的协议字段子集)。 */
export interface WireContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** 投影输出的 wire message(role ∈ {user, assistant},无出处戳字段)。 */
export interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<WireContentBlock>;
}

function invalidBlock(detail: string): OutboundProjectionError {
  return new OutboundProjectionError("invalid_content_block", detail);
}

function projectToolResultContent(content: unknown): unknown {
  if (typeof content === "string") {
    // tool_result 文本 = 工具输出,untrusted 通道。
    return neutralizeUntrustedText(content);
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new OutboundProjectionError(
          "invalid_tool_result_content",
          "nested block is not an object"
        );
      }
      const block = item as Record<string, unknown>;
      if (typeof block["type"] !== "string") {
        throw new OutboundProjectionError(
          "invalid_tool_result_content",
          "nested block has no string type"
        );
      }
      if (block["type"] === "text") {
        if (typeof block["text"] !== "string") {
          throw new OutboundProjectionError(
            "invalid_tool_result_content",
            "text block has non-string text"
          );
        }
        return { ...block, text: neutralizeUntrustedText(block["text"]) };
      }
      // 非文本块(image / document 等)无官方帧语法载体,原样透传保数据。
      return block;
    });
  }
  throw new OutboundProjectionError(
    "invalid_tool_result_content",
    `content is ${content === null ? "null" : typeof content}`
  );
}

function projectTextBlock(
  b: Record<string, unknown>,
  neutralize: boolean
): WireContentBlock {
  if (typeof b["text"] !== "string") {
    throw invalidBlock("text block has non-string text");
  }
  // 带戳宿主帧透传(invariant 2:官方外形只来自带戳 commit);
  // 无戳 user text 块 = 操作员原文 / 未盖戳来源 → untrusted 转译;
  // assistant text 块原样透传(invariant 3 只约束无戳 user 与 tool_result,
  // 转译模型重放会造成字节漂移,违背重放保真)。
  return {
    type: "text",
    text: neutralize ? neutralizeUntrustedText(b["text"]) : b["text"],
  };
}

function projectAssistantOnlyBlock(
  b: Record<string, unknown>
): WireContentBlock | undefined {
  switch (b["type"]) {
    case "tool_use": {
      if (typeof b["id"] !== "string" || typeof b["name"] !== "string") {
        throw invalidBlock("tool_use block missing string id/name");
      }
      return {
        type: "tool_use",
        id: b["id"],
        name: b["name"],
        input: b["input"],
      };
    }
    case "thinking": {
      if (
        typeof b["thinking"] !== "string" ||
        typeof b["signature"] !== "string"
      ) {
        throw invalidBlock("thinking block malformed");
      }
      return {
        type: "thinking",
        thinking: b["thinking"],
        signature: b["signature"],
      };
    }
    case "redacted_thinking": {
      if (typeof b["data"] !== "string") {
        throw invalidBlock("redacted_thinking block has non-string data");
      }
      return { type: "redacted_thinking", data: b["data"] };
    }
    default:
      return undefined;
  }
}

function projectBlock(
  block: AnthropicContentBlock,
  neutralize: boolean
): WireContentBlock {
  if (block === null || typeof block !== "object") {
    throw invalidBlock("block is not an object");
  }
  const b = block as unknown as Record<string, unknown>;
  if (b["type"] === "text") return projectTextBlock(b, neutralize);
  if (b["type"] === "tool_result") {
    if (typeof b["tool_use_id"] !== "string") {
      throw invalidBlock("tool_result block missing string tool_use_id");
    }
    return {
      type: "tool_result",
      tool_use_id: b["tool_use_id"],
      ...("is_error" in b ? { is_error: b["is_error"] } : {}),
      content: projectToolResultContent(b["content"]),
    };
  }
  const passthrough = projectAssistantOnlyBlock(b);
  if (passthrough !== undefined) return passthrough;
  // 未知块类型:权威历史被外部污染,不猜形状 —— fail-closed。
  throw invalidBlock(`unknown block type ${JSON.stringify(b["type"])}`);
}

/**
 * 出站投影:权威历史 → wire messages。
 *   - system-role 过滤(既有 invariant #383 B2 T2 / R1 #385:system 消息
 *     绝不上 wire);
 *   - 剥出处戳(戳非模型可见);
 *   - 带戳 user 帧透传,无戳 user 文本与 tool_result 文本确定转译。
 * 纯函数:同一输入两次调用产出 deepEqual 且 JSON 字节相同。
 */
export function projectMessagesForWire(
  messages: ReadonlyArray<AnthropicNativeMessage>
): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== "object") {
      throw new OutboundProjectionError(
        "invalid_message",
        "message is not an object"
      );
    }
    // system 项只进 transcript 展示层(与 buildMessageParams 旧 filter 同一
    // 裁决),过滤后不进 wire。
    if (m.role === "system") continue;
    if (m.role !== "user" && m.role !== "assistant") {
      throw new OutboundProjectionError(
        "invalid_message",
        `unknown role ${JSON.stringify(m.role)}`
      );
    }
    if (!Array.isArray(m.content)) {
      throw new OutboundProjectionError(
        "invalid_message",
        "content is not an array"
      );
    }
    // 转译只对无戳 user text 生效:assistant 回合由模型产出,文本重放保真
    // (invariant 3 只约束无戳 user 与 tool_result);戳只对 user 帧有意义,
    // 被污染的 assistant 消息即使带戳也不影响其透传语义。
    const neutralizeText = m.role === "user" && m.hostInjected !== true;
    out.push({
      role: m.role,
      content: m.content.map((b) => projectBlock(b, neutralizeText)),
    });
  }
  return out;
}
