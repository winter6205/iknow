/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chat-view-compact-follow.test.tsx
 *
 * Projection-follow on transcript replacement: the stale itemHeights /
 * scrollTop / quantization cursor reset is keyed on the transcript
 * **projection identity**, with three explicit signals — conversationId
 * change, head object change, or the messages array shrinking (appends
 * never shrink).
 *  - a compact replaces the projection head → the TUI jumps to the new
 *    projection bottom and the old-height window is gone;
 *  - a rewind returns a prefix: the head object survives reference reuse,
 *    so the shrink signal alone must fire the reset;
 *  - an append that keeps the head object (the reference-reuse rehydration
 *    shape) must NOT move a scrolled-up viewport — pure appends never reset.
 */
import { expect, test } from "bun:test";
import { act, useEffect, useRef, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ChatView, type ChatViewHandle } from "../../src/tui/chat-view.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  attachSession,
  sessionCompacted,
  sessionRewound,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

const COLS = 60;
const ROWS = 12;

function msg(role: "user" | "assistant", text: string): AnthropicNativeMessage {
  return { role, content: [{ type: "text", text }] };
}

function makeMessages(n: number): AnthropicNativeMessage[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? msg("user", `msg-${String(i).padStart(3, "0")} question`)
      : msg("assistant", `reply-${String(i).padStart(3, "0")} body`)
  );
}

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "test",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-10T00:00:00.000Z",
    jsonMode: false,
  };
  return attachSession(file);
}

interface ChatApi {
  /** Apply a projection replacement exactly like the app turn-end / compact path. */
  replaceSession(fn: (prev: TuiSessionState) => TuiSessionState): void;
  getHandle(): ChatViewHandle | null;
}

interface HarnessProps {
  readonly initial: TuiSessionState;
  readonly register: (api: ChatApi) => void;
}

function Harness(props: HarnessProps): ReturnType<typeof ChatView> {
  const [session, setSession] = useState<TuiSessionState>(props.initial);
  const chatRef = useRef<ChatViewHandle>(null);
  useEffect(() => {
    props.register({
      replaceSession: (fn) => {
        act(() => {
          setSession((prev) => fn(prev));
        });
      },
      getHandle: () => chatRef.current,
    });
  });
  return (
    <ChatView
      ref={chatRef}
      session={session}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
    />
  );
}

async function renderChat(initial: TuiSessionState): Promise<{
  setup: Awaited<ReturnType<typeof testRender>>;
  api: ChatApi;
}> {
  const holder: { api: ChatApi | null } = { api: null };
  const setup = await testRender(
    <Harness
      initial={initial}
      register={(api) => {
        holder.api = api;
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  if (holder.api === null) throw new Error("harness register never ran");
  return { setup, api: holder.api };
}

function maxScrollTop(handle: ChatViewHandle): number {
  const sb = handle.scrollbox;
  if (sb === null) throw new Error("scrollbox not mounted");
  return Math.max(0, sb.scrollHeight - sb.viewport.height);
}

test("compact head replacement: TUI follows the new projection bottom", async () => {
  const { setup, api } = await renderChat(sessionWith(makeMessages(24)));
  const handle = api.getHandle()!;
  const sb = handle.scrollbox!;
  // Scroll to the top of the old projection: stale heights / position live there.
  await act(async () => {
    sb.scrollTop = 0;
  });
  await setup.waitForVisualIdle();
  expect(sb.getRenderable("tmsg-0")).toBeDefined();
  expect(sb.scrollTop).toBe(0);

  // Compact: the new projection replaces the head (summary + short tail).
  api.replaceSession((prev) =>
    sessionCompacted(prev, {
      messages: [
        msg("user", "COMPACTED-SUMMARY of the earlier conversation"),
        ...prev.messages.slice(-4),
      ],
      turnCount: 2,
      updatedAt: "2026-08-10T01:00:00.000Z",
      jsonMode: false,
    })
  );
  await setup.waitForVisualIdle();

  // Follow the new bottom instead of staying at the stale offset, and the
  // scroll document is the NEW projection (5 messages fit one screen).
  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(sb.getRenderable("tmsg-23")).toBeUndefined();
  expect(setup.captureCharFrame()).toContain("COMPACTED-SUMMARY");
  await setup.renderer.destroy();
});

test("append keeping the head reference does not move a scrolled-up viewport", async () => {
  const { setup, api } = await renderChat(sessionWith(makeMessages(24)));
  const handle = api.getHandle()!;
  const sb = handle.scrollbox!;
  await act(async () => {
    sb.scrollTop = 0;
  });
  await setup.waitForVisualIdle();
  const topBefore = sb.scrollTop;

  // Turn-end shape after reference reuse: same head object, grown array.
  api.replaceSession((prev) =>
    sessionCompacted(prev, {
      messages: [...prev.messages, msg("assistant", "brand-new reply body")],
      turnCount: prev.turnCount,
      updatedAt: "2026-08-10T01:00:00.000Z",
      jsonMode: false,
    })
  );
  await setup.waitForVisualIdle();

  // No head replacement → no projection reset: the user position is kept.
  expect(sb.scrollTop).toBe(topBefore);
  expect(sb.getRenderable("tmsg-0")).toBeDefined();
  await setup.renderer.destroy();
});

test("rewind to a prefix (head object survives) resets via the shrink signal", async () => {
  const { setup, api } = await renderChat(sessionWith(makeMessages(24)));
  const handle = api.getHandle()!;
  const sb = handle.scrollbox!;
  // Sit at the bottom of the old projection first: without the shrink
  // signal the reset would never fire and this position would go stale
  // beyond the shortened document's max scroll.
  await act(async () => {
    sb.scrollTop = maxScrollTop(handle);
  });
  await setup.waitForVisualIdle();
  const deepBefore = sb.scrollTop;
  expect(sb.getRenderable("tmsg-23")).toBeDefined();

  // Rewind: loadSessionFile returns a prefix; reference reuse keeps every
  // surviving message object, so `messages[0]` is unchanged.
  api.replaceSession((prev) =>
    sessionRewound(prev, {
      messages: prev.messages.slice(0, 12),
      turnCount: 6,
      updatedAt: "2026-08-10T02:00:00.000Z",
      jsonMode: false,
    })
  );
  await setup.waitForVisualIdle();

  expect(sb.scrollTop).toBe(maxScrollTop(handle));
  expect(sb.scrollTop).toBeLessThan(deepBefore);
  expect(sb.getRenderable("tmsg-23")).toBeUndefined();
  expect(sb.getRenderable("tmsg-11")).toBeDefined();
  await setup.renderer.destroy();
});
