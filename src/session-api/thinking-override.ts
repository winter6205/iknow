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
  withTransportRetry,
  translateAnthropicTransportFault,
  type LoopEngineDeps,
} from "../harness/index.js";
import { loadIknowEnv, type LlmEnv } from "../config/env.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import { ValidationError } from "../shared/errors.js";
import {
  THINKING_EFFORT_VALUES,
  type ThinkingEffortWire,
  type WireThinkingOverride,
} from "./contract.js";

/** Wire override shape — re-exported from contract.ts (SSOT; M1). */
export type ThinkingOverride = WireThinkingOverride;

/**
 * Type guard over the SSOT value list. A plain `.includes()` on the readonly
 * tuple would reject `string` (parameter type is the narrow union), so this
 * guard keeps the single-source-of-values contract while accepting the raw
 * wire string for validation.
 */
function isThinkingEffortWire(v: string): v is ThinkingEffortWire {
  return (THINKING_EFFORT_VALUES as readonly string[]).includes(v);
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
  // Validation values come from the SSOT readonly array in contract.ts (M1);
  // no second hard-coded list lives here.
  if (typeof effort !== "string" || !isThinkingEffortWire(effort)) {
    throw new ValidationError(
      "thinking.effort must be one of '', 'low', 'medium', 'high', 'xhigh', 'max'",
      { field: "thinking.effort" }
    );
  }
  return { mode, effort };
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
    // settings-model-extension：key 来源 = settings.llm.apiKey（字面或 ${VAR}）。
    throw new ValidationError(LLM_API_KEY_MISSING_MESSAGE);
  }
  const client = new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
  });
  const adapter = withTransportRetry(
    createRealAnthropicAdapter({
      client,
      model: env.llm.model,
      maxTokens: env.llm.maxOutputTokens,
      temperature: env.llm.temperature,
      thinking: buildThinkingParams({
        thinking: override.mode,
        thinkingEffort: override.effort ?? "",
      }),
    }),
    { translate: translateAnthropicTransportFault }
  );
  return {
    adapter,
    executor: deps.executor,
    registry: deps.registry,
    maxTurns: deps.maxTurns,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  };
}
