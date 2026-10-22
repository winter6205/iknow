/**
 * tests/tui/token-speed.test.ts
 *
 * Fake-clock tests for per-turn generation speed. The reducer owns no timers,
 * so each live, completed, and interrupted-call reading is deterministic.
 */
import { describe, expect, test } from "bun:test";
import {
  INITIAL_TOKEN_SPEED_STATE,
  beginTokenSpeedTurn,
  finishTokenSpeedTurn,
  readTokenSpeed,
  refreshTokenSpeed,
  transitionTokenSpeed,
} from "../../src/tui/token-speed.js";

const TEN_TOKENS = "a".repeat(40);

function preCall() {
  return {
    type: "context_usage" as const,
    phase: "pre_call" as const,
    source: "measured" as const,
    usage: {
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
  };
}

function postCall(outputTokens: number, generationMs: number) {
  return {
    type: "context_usage" as const,
    phase: "post_call" as const,
    source: "measured" as const,
    usage: {
      inputTokens: 100,
      outputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
    generationMs,
  };
}

function agentStatus() {
  return {
    type: "agent_status" as const,
    lastTool: "Bash",
    openTodoLines: [],
  };
}

function envSnapshot() {
  return {
    type: "env_snapshot" as const,
    snapshot: {
      cwd: "/synthetic/workspace",
      gitBranch: "test-branch",
      gitStatus: null,
      dirtyCount: 0,
      diffPreview: null,
      degradeReason: null,
    },
  };
}

describe("per-turn token speed", () => {
  test("starts at a permanent zero reading and waits at zero before output", () => {
    expect(readTokenSpeed(INITIAL_TOKEN_SPEED_STATE)).toEqual({
      value: 0,
      estimated: false,
    });

    const waiting = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      preCall(),
      100
    );
    expect(readTokenSpeed(waiting)).toEqual({ value: 0, estimated: false });
  });

  test("empty text, thinking, and tool-input deltas do not change state or time", () => {
    const emptyEvents = [
      { type: "text_delta", text: "" },
      { type: "thinking_delta", text: "" },
      { type: "tool_input_delta", id: "tool-empty", partialJson: "" },
    ] as const;
    const waiting = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      preCall(),
      100
    );
    let live = transitionTokenSpeed(INITIAL_TOKEN_SPEED_STATE, preCall(), 200);
    live = transitionTokenSpeed(
      live,
      { type: "text_delta", text: TEN_TOKENS },
      1_000
    );
    live = transitionTokenSpeed(
      live,
      { type: "thinking_delta", text: TEN_TOKENS },
      1_500
    );

    for (const startState of [INITIAL_TOKEN_SPEED_STATE, waiting, live]) {
      let state = startState;
      for (const event of emptyEvents) {
        const before = state;
        const previousReading = readTokenSpeed(before);
        const previousWindow = before.window;
        state = transitionTokenSpeed(state, event, 99_999);
        expect(state).toBe(before);
        expect(readTokenSpeed(state)).toEqual(previousReading);
        expect(state.window).toBe(previousWindow);
        expect(state.firstOutputAt).toBe(before.firstOutputAt);
        expect(state.lastOutputAt).toBe(before.lastOutputAt);
      }
    }

    let afterEmptyWaiting = waiting;
    for (const event of emptyEvents) {
      afterEmptyWaiting = transitionTokenSpeed(
        afterEmptyWaiting,
        event,
        99_999
      );
    }
    expect(afterEmptyWaiting.firstOutputAt).toBeNull();
    const firstOutput = transitionTokenSpeed(
      afterEmptyWaiting,
      { type: "text_delta", text: TEN_TOKENS },
      100_000
    );
    expect(firstOutput.firstOutputAt).toBe(100_000);
    expect(firstOutput.lastOutputAt).toBe(100_000);
    expect(firstOutput.window).toHaveLength(1);
  });

  test("uses a rolling one-second rate while output is arriving, then the completed call average", () => {
    let state = transitionTokenSpeed(INITIAL_TOKEN_SPEED_STATE, preCall(), 0);
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      1_000
    );
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      1_500
    );
    expect(readTokenSpeed(state)).toEqual({ value: 40, estimated: true });

    state = transitionTokenSpeed(state, postCall(24, 500), 1_500);
    expect(readTokenSpeed(state)).toEqual({ value: 48, estimated: false });
  });

  test("expires old output from the live window while retaining recent output", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "text_delta", text: TEN_TOKENS },
      1_000
    );
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      1_500
    );
    expect(readTokenSpeed(state)).toEqual({ value: 40, estimated: true });

    state = refreshTokenSpeed(state, 2_100);
    // The 1,000 ms sample is outside the window; the 1,500 ms sample remains.
    expect(readTokenSpeed(state)).toEqual({ value: 10, estimated: true });
  });

  test("weights calls by generation duration when neither call has a pre-call beat", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "text_delta", text: TEN_TOKENS },
      1_000
    );
    state = transitionTokenSpeed(state, postCall(20, 1_000), 2_000);
    // No pre_call or status boundary is available. The next output fragment
    // opens the next call; the average is (20 + 30) / (1000 + 3000) seconds.
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      9_000
    );
    state = transitionTokenSpeed(state, postCall(30, 3_000), 12_000);
    expect(readTokenSpeed(state)).toEqual({ value: 12.5, estimated: false });
  });

  test("keeps the approximate marker when weighting exact and estimated calls", () => {
    let state = transitionTokenSpeed(INITIAL_TOKEN_SPEED_STATE, preCall(), 0);
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      100
    );
    state = transitionTokenSpeed(state, postCall(20, 1_000), 1_100);
    expect(readTokenSpeed(state)).toEqual({ value: 20, estimated: false });

    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      2_000
    );
    state = finishTokenSpeedTurn(state, 3_000);
    // Exact 20/1s plus estimated 10/1s yields an approximate 15 tok/s.
    expect(readTokenSpeed(state)).toEqual({ value: 15, estimated: true });
  });

  test("tool input generated after tool_call_start remains part of the model call", () => {
    let state = transitionTokenSpeed(INITIAL_TOKEN_SPEED_STATE, preCall(), 0);
    state = transitionTokenSpeed(
      state,
      { type: "tool_call_start", id: "tool-1", name: "read_file" },
      100
    );
    state = transitionTokenSpeed(
      state,
      { type: "tool_input_delta", id: "tool-1", partialJson: TEN_TOKENS },
      1_000
    );
    state = transitionTokenSpeed(
      state,
      { type: "tool_input_delta", id: "tool-1", partialJson: TEN_TOKENS },
      1_500
    );
    expect(readTokenSpeed(state)).toEqual({ value: 40, estimated: true });

    state = transitionTokenSpeed(state, postCall(20, 1_000), 2_000);
    expect(state.phase).toBe("tool");
    expect(readTokenSpeed(state)).toEqual({ value: 20, estimated: false });
  });

  test("an expired live window holds the last rate and settlement keeps the whole-call average", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "text_delta", text: TEN_TOKENS },
      1_000
    );
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      2_000
    );
    expect(readTokenSpeed(refreshTokenSpeed(state, 4_000))).toEqual({
      value: 20,
      estimated: true,
    });

    state = finishTokenSpeedTurn(state, 5_000);
    expect(readTokenSpeed(state)).toEqual({ value: 5, estimated: true });
  });

  test("holds the completed average while the turn waits for the next call's first token", () => {
    let state = transitionTokenSpeed(INITIAL_TOKEN_SPEED_STATE, preCall(), 0);
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      100
    );
    state = transitionTokenSpeed(state, postCall(20, 1_000), 1_100);
    expect(readTokenSpeed(state)).toEqual({ value: 20, estimated: false });

    // The next call opens with no output yet: the bar keeps the number shown
    // during the pause instead of dropping to zero.
    const waiting = transitionTokenSpeed(state, preCall(), 3_000);
    expect(waiting.phase).toBe("generating");
    expect(waiting.firstOutputAt).toBeNull();
    expect(readTokenSpeed(waiting)).toEqual({ value: 20, estimated: false });
  });

  test("tool execution time is excluded when a call has no usage beat", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "tool_call_start", id: "tool-1", name: "read_file" },
      0
    );
    state = transitionTokenSpeed(
      state,
      { type: "tool_input_delta", id: "tool-1", partialJson: TEN_TOKENS },
      1_000
    );
    state = transitionTokenSpeed(
      state,
      { type: "tool_input_delta", id: "tool-1", partialJson: TEN_TOKENS },
      1_500
    );
    // The next model boundary arrives after a long tool run. The reducer uses
    // the last generated tool-input fragment as the estimated end of decode.
    state = transitionTokenSpeed(state, agentStatus(), 20_000);
    state = finishTokenSpeedTurn(state, 21_000);
    expect(readTokenSpeed(state)).toEqual({ value: 40, estimated: true });
  });

  test("zero-duration estimates do not invent a minimum elapsed millisecond", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "text_delta", text: TEN_TOKENS },
      1_000
    );
    state = finishTokenSpeedTurn(state, 1_000);
    expect(readTokenSpeed(state)).toEqual({ value: 0, estimated: true });
  });

  test("a model boundary can start a call whose response has no output delta", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      agentStatus(),
      100
    );
    state = transitionTokenSpeed(state, postCall(20, 1_000), 1_100);
    expect(readTokenSpeed(state)).toEqual({ value: 20, estimated: false });
    expect(transitionTokenSpeed(state, postCall(20, 1_000), 1_200)).toBe(state);
  });

  test("an environment snapshot boundary opens a measured model call", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      envSnapshot(),
      100
    );
    expect(state.phase).toBe("generating");

    state = transitionTokenSpeed(state, postCall(20, 1_000), 1_100);
    expect(readTokenSpeed(state)).toEqual({ value: 20, estimated: false });
  });

  test("a paired environment snapshot does not repeat the agent-status boundary", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "text_delta", text: TEN_TOKENS },
      100
    );
    state = transitionTokenSpeed(state, agentStatus(), 1_100);
    expect(state.completedOutputTokens).toBe(10);
    expect(state.completedGenerationMs).toBe(1_000);
    expect(state.lastBoundaryEvent).toBe("agent_status");

    const paired = transitionTokenSpeed(state, envSnapshot(), 1_110);
    expect(paired).toBe(state);
    expect(paired.completedOutputTokens).toBe(10);
    expect(paired.completedGenerationMs).toBe(1_000);
  });

  test("cumulative character estimation does not round every tiny chunk up", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "text_delta", text: "a" },
      1_000
    );
    for (const now of [1_100, 1_200, 1_300]) {
      state = transitionTokenSpeed(
        state,
        { type: "thinking_delta", text: "a" },
        now
      );
    }
    state = finishTokenSpeedTurn(state, 1_400);
    // Four single-character deltas make one estimated token, not four.
    expect(readTokenSpeed(state)).toEqual({ value: 2.5, estimated: true });
  });

  test("turn reset clears the prior average and finish is idempotent against late events", () => {
    let state = transitionTokenSpeed(INITIAL_TOKEN_SPEED_STATE, preCall(), 0);
    state = transitionTokenSpeed(state, postCall(20, 1_000), 1_000);
    expect(readTokenSpeed(state)).toEqual({ value: 20, estimated: false });

    state = beginTokenSpeedTurn();
    expect(readTokenSpeed(state)).toEqual({ value: 0, estimated: false });
    state = transitionTokenSpeed(
      state,
      { type: "text_delta", text: TEN_TOKENS },
      3_000
    );
    const finished = finishTokenSpeedTurn(state, 4_000);
    expect(finishTokenSpeedTurn(finished, 5_000)).toBe(finished);
    expect(
      transitionTokenSpeed(
        finished,
        { type: "text_delta", text: TEN_TOKENS },
        6_000
      )
    ).toBe(finished);
  });

  test("invalid provider timing falls back to the estimated whole-call reading", () => {
    let state = transitionTokenSpeed(
      INITIAL_TOKEN_SPEED_STATE,
      { type: "text_delta", text: TEN_TOKENS },
      1_000
    );
    state = transitionTokenSpeed(
      state,
      {
        ...postCall(Number.NaN, Number.POSITIVE_INFINITY),
      },
      2_000
    );
    expect(readTokenSpeed(state)).toEqual({ value: 10, estimated: true });
  });
});
