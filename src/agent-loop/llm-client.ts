/**
 * OpenAI-compatible chat/completions client (tool_calls protocol).
 * Used by LlmIknowAgent against 9router / OpenAI-style gateways.
 */
import { NetworkError, ValidationError } from "../shared/errors.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmChatResult {
  content?: string;
  tool_calls?: LlmToolCall[];
}

/** Injectable chat surface for unit tests (no network). */
export interface LlmChatClient {
  chat(
    messages: LlmMessage[],
    tools: LlmToolDef[],
  ): Promise<LlmChatResult>;
  /**
   * Optional context window size in tokens (history budgeting).
   * OpenAiCompatibleLlmClient sets this; mocks may omit it.
   */
  readonly contextWindowTokens?: number;
}

export interface OpenAiCompatibleLlmClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  contextWindowTokens?: number;
}

/**
 * OpenAI-compatible POST /chat/completions with tools (openai_tools).
 */
export class OpenAiCompatibleLlmClient implements LlmChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  readonly contextWindowTokens: number;

  constructor(opts: OpenAiCompatibleLlmClientOptions) {
    if (!opts.apiKey) {
      throw new ValidationError("llm apiKey is required");
    }
    if (!opts.baseUrl) {
      throw new ValidationError("llm baseUrl is required");
    }
    if (!opts.model) {
      throw new ValidationError("llm model is required");
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.contextWindowTokens = opts.contextWindowTokens ?? 1_000_000;
  }

  async chat(
    messages: LlmMessage[],
    tools: LlmToolDef[],
  ): Promise<LlmChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(serializeMessage),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new NetworkError(
          `llm HTTP ${res.status}: ${raw.slice(0, 200)}`,
          { status: res.status },
        );
      }
      let json: {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: LlmToolCall[];
          };
        }>;
      };
      try {
        json = JSON.parse(raw) as typeof json;
      } catch (parseErr) {
        const detail =
          parseErr instanceof Error ? parseErr.message : String(parseErr);
        throw new NetworkError(
          `llm response is not valid JSON (${detail}): ${raw.slice(0, 120)}`,
        );
      }
      if (!Array.isArray(json.choices) || json.choices.length === 0) {
        throw new NetworkError(
          "llm response missing or empty choices array",
        );
      }
      const msg = json.choices[0]?.message;
      if (!msg || typeof msg !== "object") {
        throw new NetworkError("llm response missing choices[0].message");
      }
      const content =
        typeof msg.content === "string" && msg.content.length > 0
          ? msg.content
          : undefined;
      const tool_calls =
        Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
          ? msg.tool_calls.map(normalizeToolCall)
          : undefined;
      return { content, tool_calls };
    } catch (err) {
      if (err instanceof NetworkError || err instanceof ValidationError) {
        throw err;
      }
      if (isAbortError(err)) {
        throw new NetworkError(
          `llm request timed out after ${this.timeoutMs}ms`,
          { timeoutMs: this.timeoutMs, cause: "AbortError" },
        );
      }
      const m = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`llm request failed: ${m}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function serializeMessage(m: LlmMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role };
  if (m.content !== undefined && m.content !== null) {
    // Empty tool results still need a non-empty string for some gateways.
    if (m.role === "tool" && m.content === "") {
      out.content = "[empty tool result]";
    } else {
      out.content = m.content;
    }
  } else if (m.role === "assistant" && m.tool_calls?.length) {
    out.content = null;
  } else if (m.role === "tool") {
    out.content = "[empty tool result]";
  }
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls;
  }
  if (m.tool_call_id) {
    out.tool_call_id = m.tool_call_id;
  }
  if (m.name) {
    out.name = m.name;
  }
  return out;
}

function normalizeToolCall(tc: LlmToolCall): LlmToolCall {
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.function?.name ?? "",
      arguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
    },
  };
}
