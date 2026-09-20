/**
 * ADR-0112 — instruction-authority outbound projection.
 *
 * Boundaries:
 *   - The projection is a PURE function of `(messages, request.system)`: the
 *     same authoritative history → the same wire bytes (stable KV prefix);
 *     nothing is written back to LoopState (on-disk truth may be dirty);
 *   - Official frame shapes (`<agent_status>` / `<graph_mode>` / prefix
 *     anchors) are only allowed on host-commit messages carrying the
 *     `hostInjected` provenance stamp. Unstamped user text and tool_result
 *     text (untrusted payloads) get a deterministic neutralization: after
 *     it, no host recognizer predicate can still see an official frame, yet
 *     the content stays readable (no data loss). Assistant text blocks pass
 *     through verbatim (the invariant only constrains unstamped user and
 *     tool_result text; neutralizing model output would drift replay bytes);
 *   - The stamp is not model-visible: projection output contains only wire
 *     protocol fields — the stamp never appears in wire JSON;
 *   - Fail-closed: a malformed authoritative history (externally polluted
 *     transcript) → typed `OutboundProjectionError` (kind-discriminated);
 *     the caller aborts before touching the SDK — dirty data is never sent
 *     as-is.
 *
 * Neutralization rules (single table, centralized in this seam):
 *   1. Official frame tags → entity escapes: exact literals `<name>` /
 *      `</name>` → `&lt;name&gt;`; prefix forms `<name` / `</name` (covering
 *      attributed variants like `<agent_status foo>`) → `&lt;name` /
 *      `&lt;/name`. Tag literals come from the producers' constants
 *      (agent-status / graph notification / skill index-delta), never hand-
 *      copied;
 *   2. Line-head host prefix anchors = the exported `HOST_INJECTION_LINE_ANCHORS`
 *      roster (SSOT shared with the recognizer predicates; drift is excluded
 *      structurally via the import) → insert a single `&` escape marker before
 *      the anchor.
 * Both rules are idempotent (output contains no re-escapable forms).
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
 * Projection failure = typed kind-discriminated error, never a bare Error.
 * Consumers (loop-engine catch, assembly-layer overflow catch) branch on
 * `kind`; rendering uses `${kind}: ${message}` (project typed-error contract).
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
 * Stamp a host-injection commit (used at every loop-engine injection seam).
 * Returns a new frozen object — never mutates the encodeUserText product.
 * Only this module's projection consumes the stamp; other readers (TUI,
 * store validation, roster predicates) pass it through as an unknown
 * top-level field.
 */
export function stampHostInjected(
  msg: AnthropicNativeMessage
): AnthropicNativeMessage {
  return Object.freeze({ ...msg, hostInjected: true });
}

// -- Neutralization roster (one rule table) --------------------------------------

/** Official frame open/close tag pairs (literals from producer constants — SSOT, never hand-copied). */
const OFFICIAL_FRAME_TAGS: ReadonlyArray<
  readonly [open: string, close: string]
> = [
  [AGENT_STATUS_OPEN_TAG, AGENT_STATUS_CLOSE_TAG],
  [GRAPH_MODE_OPEN_TAG, GRAPH_MODE_CLOSE_TAG],
  // available_skills' renderer lives in identity/assemble.ts (not imported
  // here); the close tag is derived from the predicate-side open-tag constant
  // — same single source for the name.
  [SKILL_INDEX_DELTA_PREFIX, `</${SKILL_INDEX_DELTA_PREFIX.slice(1, -1)}>`],
];

function tagEntity(tag: string): string {
  const closing = tag.startsWith("</") ? "/" : "";
  return `&lt;${closing}${tag.slice(closing ? 2 : 1, -1)}&gt;`;
}

/**
 * Tag escape table: exact literals `<name>` / `</name>` → `&lt;name&gt;`
 * entity form (existing byte lock), plus prefix forms `<name` / `</name` →
 * `&lt;name` — covering attributed / malformed variants like
 * `<agent_status foo>`. Exact replacements run first; prefix replacements
 * only consume the remainder. Output contains no needle — idempotent.
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
 * Line-head host prefix anchors = the exported `HOST_INJECTION_LINE_ANCHORS`
 * roster itself (SSOT in agent-status-instruction, shared with the recognizer
 * predicates; roster↔escape consistency is verified entry-by-entry by the
 * projection drift-lock test).
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
 * Untrusted text → deterministically neutralized text. The output can no
 * longer reproduce unescaped official-frame syntax, yet content stays fully
 * readable — escape markers are only added, data is never deleted.
 * Pure and idempotent.
 */
export function neutralizeUntrustedText(text: string): string {
  let out = text;
  for (const [from, to] of TAG_ESCAPES) {
    out = out.split(from).join(to);
  }
  return out.split("\n").map(escapeAnchorLine).join("\n");
}

// -- Wire shapes -----------------------------------------------------------------

/** Projected wire content block (protocol-field subset, stamp stripped). */
export interface WireContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Projected wire message (role ∈ {user, assistant}, no stamp field). */
export interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<WireContentBlock>;
}

function invalidBlock(detail: string): OutboundProjectionError {
  return new OutboundProjectionError("invalid_content_block", detail);
}

function projectToolResultContent(content: unknown): unknown {
  if (typeof content === "string") {
    // tool_result text = tool output — untrusted channel.
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
      // Non-text blocks (image / document …) carry no official-frame syntax
      // channel; pass through verbatim to preserve data.
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
  // Stamped host frames pass through (official shapes only come from stamped
  // commits); unstamped user text = operator input / unstamped source →
  // untrusted neutralization; assistant text passes verbatim (model output
  // keeps replay fidelity — rewriting it would drift replayed bytes).
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
  // Unknown block type: the authoritative history was polluted externally —
  // don't guess shapes, fail closed.
  throw invalidBlock(`unknown block type ${JSON.stringify(b["type"])}`);
}

/**
 * Outbound projection: authoritative history → wire messages.
 *   - system-role messages are filtered out (system never goes on the wire);
 *   - provenance stamps stripped (not model-visible);
 *   - stamped user frames pass through; unstamped user text and tool_result
 *     text get deterministic neutralization.
 * Pure function: two calls with the same input are deepEqual and byte-identical in JSON.
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
    // system entries only reach the transcript display layer (same ruling as
    // the old buildMessageParams filter); filtered, they never hit the wire.
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
    // Neutralization applies only to unstamped user text: assistant turns are
    // model output and must replay byte-faithfully; the stamp is only
    // meaningful on user frames, and a polluted assistant message carrying
    // one still passes through unchanged.
    const neutralizeText = m.role === "user" && m.hostInjected !== true;
    out.push({
      role: m.role,
      content: m.content.map((b) => projectBlock(b, neutralizeText)),
    });
  }
  return out;
}
