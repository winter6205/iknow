/**
 * src/tui/token-speed.ts
 *
 * Pure per-turn generation-speed state. The TUI supplies timestamps and owns
 * the repaint timer. While output arrives, live speed (`~N tok/s`) uses
 * estimated output tokens in a rolling one-second window; an empty window
 * holds the last rate instead of dropping to zero. The weighted turn average
 * — the sum of the calls' output tokens divided by the sum of their
 * generation durations — replaces the live rate when the turn ends;
 * first-token wait and tool execution stay outside the denominator.
 */
import type { HarnessStreamEvent } from "../harness/stream.js";

export const TOKEN_SPEED_WINDOW_MS = 1_000;

export type TokenSpeedPhase = "idle" | "generating" | "tool" | "done";

export type OutputDeltaKind =
  "text_delta" | "thinking_delta" | "tool_input_delta";

export interface TokenSpeedReading {
  readonly value: number;
  readonly estimated: boolean;
}

interface TokenSpeedSample {
  readonly at: number;
  readonly tokens: number;
}

export interface TokenSpeedState {
  readonly phase: TokenSpeedPhase;
  readonly turnFinished: boolean;
  readonly firstOutputAt: number | null;
  readonly lastOutputAt: number | null;
  readonly outputChars: number;
  readonly estimatedOutputTokens: number;
  readonly window: readonly TokenSpeedSample[];
  readonly live: TokenSpeedReading | null;
  readonly completedOutputTokens: number;
  readonly completedGenerationMs: number;
  readonly hasEstimatedCall: boolean;
  readonly toolCallSeen: boolean;
  readonly lastBoundaryEvent: "agent_status" | "env_snapshot" | null;
}

export const ZERO_TOKEN_SPEED_READING: TokenSpeedReading = Object.freeze({
  value: 0,
  estimated: false,
});

export const INITIAL_TOKEN_SPEED_STATE: TokenSpeedState = Object.freeze({
  phase: "idle" as const,
  turnFinished: false,
  firstOutputAt: null,
  lastOutputAt: null,
  outputChars: 0,
  estimatedOutputTokens: 0,
  window: Object.freeze([] as TokenSpeedSample[]),
  live: null,
  completedOutputTokens: 0,
  completedGenerationMs: 0,
  hasEstimatedCall: false,
  toolCallSeen: false,
  lastBoundaryEvent: null,
});

export function beginTokenSpeedTurn(): TokenSpeedState {
  return INITIAL_TOKEN_SPEED_STATE;
}

function resetCurrentCall(
  state: TokenSpeedState,
  phase: TokenSpeedPhase
): TokenSpeedState {
  return {
    ...state,
    phase,
    firstOutputAt: null,
    lastOutputAt: null,
    outputChars: 0,
    estimatedOutputTokens: 0,
    window: [],
    live: null,
    toolCallSeen: false,
    lastBoundaryEvent: null,
  };
}

function estimateTokensForLength(length: number): number {
  if (length <= 0) return 0;
  return Math.max(1, Math.floor((length + 3) / 4));
}

/**
 * The measurable live rate of the current call, or `null` when there is none
 * yet. `null` means "no sample to publish" — the caller keeps the previous
 * reading (the held live rate, or the turn average) instead of writing a
 * hard zero into the state.
 */
function liveReading(
  state: TokenSpeedState,
  now: number
): TokenSpeedReading | null {
  const firstOutputAt = state.firstOutputAt;
  if (firstOutputAt === null) return null; // EXIT: no output yet → no measurable rate
  const end = Math.max(now, firstOutputAt);
  const start = Math.max(firstOutputAt, end - TOKEN_SPEED_WINDOW_MS);
  const elapsedMs = end - start;
  if (elapsedMs <= 0) return null; // EXIT: zero-length window → no measurable rate yet
  let tokens = 0;
  for (const sample of state.window) {
    if (sample.at >= start && sample.at <= end) tokens += sample.tokens;
  }
  // An empty window means output paused: hold the last rate, never 0.
  if (tokens === 0) return null; // EXIT: paused output → hold the last rate
  const value = (tokens / elapsedMs) * 1_000;
  return {
    value: Number.isFinite(value) ? value : 0,
    estimated: true,
  };
}

function estimatedEndAt(state: TokenSpeedState, now: number): number {
  if (state.toolCallSeen && state.lastOutputAt !== null) {
    return state.lastOutputAt;
  }
  return now;
}

function addCompletedMeasurement(
  state: TokenSpeedState,
  outputTokens: number,
  generationMs: number,
  estimated: boolean
): TokenSpeedState {
  const completedOutputTokens = state.completedOutputTokens + outputTokens;
  const completedGenerationMs = state.completedGenerationMs + generationMs;
  if (
    !Number.isFinite(completedOutputTokens) ||
    !Number.isFinite(completedGenerationMs)
  ) {
    return { ...state, hasEstimatedCall: true };
  }
  return {
    ...state,
    completedOutputTokens,
    completedGenerationMs,
    hasEstimatedCall: state.hasEstimatedCall || estimated,
  };
}

function exactMeasurement(
  outputTokens: number | undefined,
  generationMs: number | undefined
): { outputTokens: number; generationMs: number } | undefined {
  if (
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0 &&
    typeof generationMs === "number" &&
    Number.isFinite(generationMs) &&
    generationMs > 0
  ) {
    return { outputTokens, generationMs };
  }
  return undefined;
}

function finishCall(
  state: TokenSpeedState,
  now: number,
  outputTokens?: number,
  generationMs?: number
): TokenSpeedState {
  if (state.phase !== "generating") return state;

  let completed = state;
  const exact = exactMeasurement(outputTokens, generationMs);
  if (exact !== undefined) {
    completed = addCompletedMeasurement(
      state,
      exact.outputTokens,
      exact.generationMs,
      false
    );
  } else if (state.firstOutputAt !== null && state.estimatedOutputTokens > 0) {
    const generationMs = estimatedEndAt(state, now) - state.firstOutputAt;
    completed =
      generationMs > 0
        ? addCompletedMeasurement(
            state,
            state.estimatedOutputTokens,
            generationMs,
            true
          )
        : { ...state, hasEstimatedCall: true };
  } else if (state.firstOutputAt !== null) {
    completed = { ...state, hasEstimatedCall: true };
  }
  return resetCurrentCall(completed, state.toolCallSeen ? "tool" : "done");
}

function startCall(state: TokenSpeedState, now: number): TokenSpeedState {
  if (state.phase === "generating" && state.firstOutputAt === null) {
    return { ...state, lastBoundaryEvent: null };
  }
  const completed =
    state.phase === "generating"
      ? finishCall(state, estimatedEndAt(state, now))
      : state;
  return resetCurrentCall(completed, "generating");
}

function markToolCall(state: TokenSpeedState, now: number): TokenSpeedState {
  const started =
    state.phase === "idle" || state.phase === "tool" || state.phase === "done"
      ? startCall(state, now)
      : state;
  return { ...started, toolCallSeen: true, lastBoundaryEvent: null };
}

function ingestOutput(
  state: TokenSpeedState,
  text: string,
  now: number
): TokenSpeedState {
  if (text.length === 0 || state.turnFinished) return state;
  const started =
    state.phase === "idle" || state.phase === "tool" || state.phase === "done"
      ? startCall(state, now)
      : state;
  const outputChars = started.outputChars + text.length;
  const estimatedOutputTokens = estimateTokensForLength(outputChars);
  const tokens = estimatedOutputTokens - started.estimatedOutputTokens;
  const firstOutputAt = started.firstOutputAt ?? now;
  const window = [
    ...started.window,
    ...(tokens > 0 ? [{ at: now, tokens }] : []),
  ].filter((sample) => sample.at >= now - TOKEN_SPEED_WINDOW_MS);
  const next: TokenSpeedState = {
    ...started,
    phase: "generating",
    firstOutputAt,
    lastOutputAt: now,
    outputChars,
    estimatedOutputTokens,
    window,
    live: started.live,
    lastBoundaryEvent: null,
  };
  return { ...next, live: liveReading(next, now) ?? started.live }; // EXIT: first fragment at elapsed 0 → keep the previous reading
}

function transitionBoundary(
  state: TokenSpeedState,
  now: number,
  eventType: "agent_status" | "env_snapshot"
): TokenSpeedState {
  if (
    eventType === "env_snapshot" &&
    state.lastBoundaryEvent === "agent_status"
  ) {
    return state;
  }
  const completed =
    state.phase === "generating"
      ? finishCall(state, estimatedEndAt(state, now))
      : state;
  return {
    ...resetCurrentCall(completed, "generating"),
    lastBoundaryEvent: eventType,
  };
}

function transitionContextUsage(
  state: TokenSpeedState,
  event: Extract<HarnessStreamEvent, { type: "context_usage" }>,
  now: number
): TokenSpeedState {
  if (event.phase === "pre_call") return startCall(state, now);
  if (event.phase === "post_call") {
    return finishCall(state, now, event.usage.outputTokens, event.generationMs);
  }
  return state.lastBoundaryEvent === null
    ? state
    : { ...state, lastBoundaryEvent: null };
}

export function transitionTokenSpeed(
  state: TokenSpeedState,
  event: HarnessStreamEvent,
  now: number
): TokenSpeedState {
  if (state.turnFinished) return state;
  switch (event.type) {
    case "context_usage":
      return transitionContextUsage(state, event, now);
    case "agent_status":
    case "env_snapshot":
      return transitionBoundary(state, now, event.type);
    case "tool_call_start":
      return markToolCall(state, now);
    case "text_delta":
    case "thinking_delta":
      return ingestOutput(state, event.text, now);
    case "tool_input_delta":
      return ingestOutput(state, event.partialJson, now);
    default:
      return state;
  }
}

export function refreshTokenSpeed(
  state: TokenSpeedState,
  now: number
): TokenSpeedState {
  if (state.phase !== "generating" || state.firstOutputAt === null) {
    return state;
  }
  const live = liveReading(state, now);
  if (live === null) return state; // EXIT: no measurable sample → keep the held rate / turn average
  return { ...state, live };
}

export function finishTokenSpeedTurn(
  state: TokenSpeedState = INITIAL_TOKEN_SPEED_STATE,
  now: number
): TokenSpeedState {
  if (state.turnFinished) return state;
  const settled =
    state.phase === "generating"
      ? finishCall(state, estimatedEndAt(state, now))
      : state;
  return {
    ...resetCurrentCall(settled, "done"),
    turnFinished: true,
  };
}

function completedReading(state: TokenSpeedState): TokenSpeedReading {
  if (state.completedGenerationMs <= 0) {
    // EXIT: no measurable generation duration → zero (or an estimated zero)
    return state.hasEstimatedCall
      ? { value: 0, estimated: true }
      : ZERO_TOKEN_SPEED_READING;
  }
  const value =
    (state.completedOutputTokens / state.completedGenerationMs) * 1_000;
  return {
    value: Number.isFinite(value) ? value : 0,
    estimated: state.hasEstimatedCall,
  };
}

export function readTokenSpeed(state: TokenSpeedState): TokenSpeedReading {
  if (state.phase === "generating") {
    // EXIT: no live sample yet (new call) → keep the weighted turn average instead of flashing 0
    return state.live ?? completedReading(state);
  }
  return completedReading(state);
}
