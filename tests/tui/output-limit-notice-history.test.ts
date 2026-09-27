/**
 * tests/tui/output-limit-notice-history.test.ts
 *
 * spec `specs/model-output-truncation.md` SC8 / SC11 — the TUI's session-state
 * data path for an output-limit-truncated turn, and the invariant that the
 * durable notice is a projection of the turn outcome, never conversation
 * content fed back as model history.
 *
 * `attachSession` reads the last settled turn's terminal outcome off the loaded
 * file (`lastTurnOutcome`, ADR-0126) and derives BOTH `lastStopReason` and
 * `outputLimitNotice` from it; the messages array is copied verbatim from the
 * transcript. So the notice can surface in the sticky lane without ever being
 * part of an assistant message — which is what these checks pin, using the SSOT
 * `OUTPUT_LIMIT_NOTICE` constant imported from contract.ts (the same bytes the
 * hub projects onto the wire and the TUI lane renders).
 *
 * bun:test, no OpenTUI / model boot — a pure-data focused check per the task.
 */
import { describe, expect, test } from "bun:test";
import {
  attachSession,
  createDraftSession,
  turnFinished,
  turnStarted,
  type TuiLoadedSessionFile,
} from "../../src/tui/session-state.js";
import {
  OUTPUT_LIMIT_NOTICE,
  knownTurnOutcome,
} from "../../src/session-api/contract.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const msg = (
  text: string,
  role: "user" | "assistant" = "user"
): AnthropicNativeMessage => ({
  role,
  content: [{ type: "text", text }],
});

function file(overrides?: Partial<SessionFileV1>): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    conversation_id: "conv-notice",
    messages: [
      msg("write a long answer"),
      msg("partial committed text", "assistant"),
    ],
    jsonMode: false,
    turnCount: 1,
    updatedAt: now,
    title: "write a long answer",
    cwd: "/tmp/proj",
    sanitized_at: now,
    ...overrides,
  };
}

/** Every text block across every message, concatenated — the model-facing corpus. */
function allMessageText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  return messages
    .flatMap((m) =>
      m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    )
    .join("\n");
}

describe("attachSession — durable notice from the last settled outcome", () => {
  test("known truncation outcome → notice + lastStopReason present, notice NOT in messages (SC8)", () => {
    const loaded: TuiLoadedSessionFile = {
      ...file(),
      lastTurnOutcome: knownTurnOutcome("nonSuccessStop", "truncation"),
    };
    const attached = attachSession(loaded);
    expect(attached.outputLimitNotice).toBe(OUTPUT_LIMIT_NOTICE);
    expect(attached.lastStopReason).toBe("nonSuccessStop");
    // The committed partial assistant text is preserved as history content.
    expect(allMessageText(attached.messages)).toContain(
      "partial committed text"
    );
    // The notice is a projection, never message content (never re-sent to the model).
    expect(allMessageText(attached.messages)).not.toContain(
      OUTPUT_LIMIT_NOTICE
    );
  });

  test("unknown outcome → neither notice nor stop label (SC11 fail-quiet)", () => {
    const loaded: TuiLoadedSessionFile = {
      ...file(),
      lastTurnOutcome: { terminal: "unknown" },
    };
    const attached = attachSession(loaded);
    expect(attached.outputLimitNotice).toBeUndefined();
    expect(attached.lastStopReason).toBeUndefined();
  });

  test("file loaded without outcome evidence → treated as unknown (SC11)", () => {
    const attached = attachSession(file());
    expect(attached.outputLimitNotice).toBeUndefined();
    expect(attached.lastStopReason).toBeUndefined();
  });

  test("known non-truncation stop (refusal) → stop reason kept, no notice", () => {
    const loaded: TuiLoadedSessionFile = {
      ...file(),
      lastTurnOutcome: knownTurnOutcome("nonSuccessStop", "refusal"),
    };
    const attached = attachSession(loaded);
    expect(attached.lastStopReason).toBe("nonSuccessStop");
    expect(attached.outputLimitNotice).toBeUndefined();
  });
});

describe("turnFinished — live turn owns the notice slot", () => {
  test("settled truncation turn carries the notice; next turn without one clears it", () => {
    const started = turnStarted(createDraftSession());
    const truncated = turnFinished(started, {
      conversationId: "conv-notice",
      messages: [msg("q"), msg("partial committed text", "assistant")],
      turnCount: 1,
      updatedAt: new Date().toISOString(),
      jsonMode: false,
      stopReason: "nonSuccessStop",
      outputLimitNotice: OUTPUT_LIMIT_NOTICE,
    });
    expect(truncated.outputLimitNotice).toBe(OUTPUT_LIMIT_NOTICE);
    expect(truncated.lastStopReason).toBe("nonSuccessStop");

    // A following turn that did not truncate omits the field → the previous
    // turn's notice is cleared (unlike thinkingMs / workspaceRoot, which keep).
    const cleared = turnFinished(truncated, {
      conversationId: "conv-notice",
      messages: [msg("q2"), msg("fresh full answer", "assistant")],
      turnCount: 2,
      updatedAt: new Date().toISOString(),
      jsonMode: false,
      stopReason: "completed",
    });
    expect(cleared.outputLimitNotice).toBeUndefined();
    expect(allMessageText(cleared.messages)).not.toContain(OUTPUT_LIMIT_NOTICE);
  });
});
