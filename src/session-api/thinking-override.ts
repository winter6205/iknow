/**
 * Per-turn thinking override for the Session API (T2 / #complexity anti-drift).
 *
 * Pure module, no I/O:
 *   - `parseThinkingOverride`: wire parse + value-range validation of the
 *     optional `thinking` field on POST /messages. Invalid values throw
 *     ValidationError (wire surface fails loud, no silent fallback).
 *   - `withThinkingOverride`: per-turn one-shot deps rebuild — the override
 *     only replaces `adapter`; registry / executor / maxTurns / timeoutMs
 *     are reused from the cached deps.
 *
 * hub.ts / http.ts stay thin: they call into these functions only.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  buildThinkingParams,
  createRealAnthropicAdapter,
  type LoopEngineDeps,
} from "../harness/index.js";
import { loadIknowEnv, type LlmEnv } from "../config/env.js";
import { ValidationError } from "../shared/errors.js";

/** Wire override shape (contract.ts PostMessageRequest.thinking). */
export interface ThinkingOverride {
  readonly mode: "off" | "adaptive";
  readonly effort?: "" | "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Parse + validate the optional wire `thinking` field.
 *   - missing / undefined → undefined (no override, cached deps path)
 *   - mode must be "off" | "adaptive" (string); else ValidationError
 *   - effort when present must be in "" | low | medium | high | xhigh | max
 *
 * Wire surface: invalid values throw ValidationError (400), never fall back.
 */
export function parseThinkingOverride(
  raw: unknown
): ThinkingOverride | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("thinking must be an object", {
      field: "thinking",
    });
  }
  const o = raw as Record<string, unknown>;
  const mode = o.mode;
  if (mode !== "off" && mode !== "adaptive") {
    throw new ValidationError("thinking.mode must be 'off' or 'adaptive'", {
      field: "thinking.mode",
    });
  }
  const effort = o.effort;
  if (effort === undefined) {
    return { mode };
  }
  if (
    typeof effort !== "string" ||
    !["", "low", "medium", "high", "xhigh", "max"].includes(effort)
  ) {
    throw new ValidationError(
      "thinking.effort must be one of '', 'low', 'medium', 'high', 'xhigh', 'max'",
      { field: "thinking.effort" }
    );
  }
  return { mode, effort: effort as ThinkingOverride["effort"] };
}

/**
 * Build per-turn deps with a one-shot adapter that carries the override.
 * The override only replaces `adapter`; executor / registry / maxTurns /
 * timeoutMs are taken from `deps` unchanged. `env` is injected so callers
 * (and tests) can pin the LLM config instead of re-reading process.env.
 */
export function withThinkingOverride(opts: {
  readonly deps: LoopEngineDeps;
  readonly override: ThinkingOverride;
  readonly env?: { readonly llm: LlmEnv };
}): LoopEngineDeps {
  const { deps, override } = opts;
  const env = opts.env ?? loadIknowEnv();
  if (!env.llm.apiKey) {
    throw new ValidationError(
      `LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${env.llm.apiKeyEnv}); set the key.`
    );
  }
  const client = new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
  });
  const adapter = createRealAnthropicAdapter({
    client,
    model: env.llm.model,
    maxTokens: env.llm.maxOutputTokens,
    temperature: env.llm.temperature,
    thinking: buildThinkingParams({
      thinking: override.mode,
      thinkingEffort: override.effort ?? "",
    }),
  });
  return {
    adapter,
    executor: deps.executor,
    registry: deps.registry,
    maxTurns: deps.maxTurns,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  };
}
