/**
 * scripts/bench-transcript-baseline.ts
 *
 * Reproducible baseline for the TUI transcript render path: one entry
 * for measuring message count N, total chars, RSS, and the
 * cost of one setSessions-style turn-end update plus the derivations ChatView
 * runs when the messages reference changes.
 *
 * Deterministic synthetic transcript (seeded LCG, no IO, no model). Run:
 *   npm run bench:transcript -- [turns]   (default turns = 400)
 *   tsx scripts/bench-transcript-baseline.ts [turns]
 *
 * Sections printed (JSON, one per line):
 *  - size: N / total chars / RSS before and after construction
 *  - setSessions: {...prev, [id]: turnFinished(...)} updater with a
 *    freshly-hydrated (deep-copied) message array — the app.tsx turn-end shape
 *  - full_derivation: the four O(N·blocks) memos ChatView re-runs whenever the
 *    messages reference changes (statusMap / resultTextMap / activitySegments
 *    / activity-block fold lines) and one viewport mount-window selection.
 *  - incremental_derivation: the same steady-state turn-end update routed
 *    through the incremental tool index (append-extend instead of full scan).
 *  - scroll_reselect: viewport mount-window re-selection at a shifted
 *    scrollTop with unchanged heights (the scroll-commit hot path).
 */
import {
  createDraftSession,
  turnFinished,
  userMessageEchoed,
  type TuiSessionState,
} from "../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../src/harness/model-adapter/types.js";
import {
  toolResultStatusMap,
  toolResultTextMap,
} from "../src/tui/tool-summary.js";
import {
  orderedTurnActivitySegments,
  toolUseIdsOf,
} from "../src/tui/turn-activity.js";
import {
  buildActivityBlockFoldLines,
  makeThinkingMsAtVisibleFromSource,
} from "../src/tui/turn-fold-lines.js";
import { selectViewportMountWindow } from "../src/tui/transcript-viewport.js";
import { syncToolIndex } from "../src/tui/tool-result-index.js";

const ACTIVE = "bench-session";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function filler(rnd: () => number, targetChars: number): string {
  const words = [
    "transcript",
    "viewport",
    "mount",
    "index",
    "fold",
    "activity",
    "height",
    "spacer",
    "overscan",
    "scroll",
  ];
  const parts: string[] = [];
  let n = 0;
  while (n < targetChars) {
    const word = words[Math.floor(rnd() * words.length)]!;
    parts.push(word);
    n += word.length + 1;
  }
  return parts.join(" ");
}

interface TurnData {
  readonly messages: AnthropicNativeMessage[];
  readonly thinkingMs: Array<number | null>;
}

function buildTurns(turns: number): TurnData {
  const rnd = lcg(42);
  const messages: AnthropicNativeMessage[] = [];
  const thinkingMs: Array<number | null> = [];
  for (let t = 0; t < turns; t++) {
    const query = `query ${t}: ${filler(rnd, 120)}`;
    messages.push({ role: "user", content: [{ type: "text", text: query }] });
    thinkingMs.push(null);
    const resultChars = 400 + Math.floor(rnd() * 1600);
    messages.push({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: filler(rnd, 200),
          signature: `sig-${t}`,
        },
        { type: "text", text: `lead ${t}: ${filler(rnd, 200)}` },
        {
          type: "tool_use",
          id: `toolu_bench_${t}`,
          name: "bash",
          input: { command: `echo ${t}` },
        },
      ],
    });
    thinkingMs.push(1200 + Math.floor(rnd() * 3000));
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_bench_${t}`,
          content: filler(rnd, resultChars),
          is_error: rnd() < 0.05,
        },
      ],
    });
    thinkingMs.push(null);
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${t}: ${filler(rnd, 400)}` }],
    });
    thinkingMs.push(null);
  }
  return { messages, thinkingMs };
}

function totalChars(messages: ReadonlyArray<AnthropicNativeMessage>): number {
  let n = 0;
  for (const m of messages) {
    for (const b of m.content) {
      const c = b as { text?: string; content?: unknown; thinking?: string };
      if (typeof c.text === "string") n += c.text.length;
      if (typeof c.thinking === "string") n += c.thinking.length;
      if (typeof c.content === "string") n += c.content.length;
    }
  }
  return n;
}

/** Fresh per-message object copies: the shape loadSessionFile produces each
 *  turn (new array, new objects, content-identical for the old prefix). */
function rehydrate(
  messages: ReadonlyArray<AnthropicNativeMessage>
): AnthropicNativeMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => ({ ...b })),
  })) as AnthropicNativeMessage[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function emit(label: string, samples: number[], digits = 3): void {
  process.stdout.write(
    JSON.stringify({
      section: label,
      median_ms: +median(samples).toFixed(digits),
    }) + "\n"
  );
}

function timed(label: string, iters: number, fn: () => unknown): void {
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  emit(label, samples);
}

function rssMb(): number {
  return +(process.memoryUsage().rss / 1024 / 1024).toFixed(1);
}

function main(): void {
  const turns = Number(process.argv[2] ?? 400);
  const rss0 = rssMb();
  const { messages, thinkingMs } = buildTurns(turns);
  const chars = totalChars(messages);
  const seed = turnFinished(createDraftSession(), {
    conversationId: ACTIVE,
    messages,
    turnCount: turns,
    updatedAt: "2026-09-01T00:00:00.000Z",
    jsonMode: false,
    stopReason: "completed",
  });
  const rss1 = rssMb();
  process.stdout.write(
    JSON.stringify({
      section: "size",
      turns,
      messages_n: messages.length,
      total_chars: chars,
      rss_mb_before: rss0,
      rss_mb_after: rss1,
    }) + "\n"
  );

  const fresh = rehydrate(messages);
  const record: Record<string, TuiSessionState> = { [ACTIVE]: seed };

  // One app.tsx turn-end setSessions: Record spread + turnFinished with a
  // re-hydrated file + the instant echo that follows on the next send.
  timed("setSessions_turn_end", 21, () => {
    const prev = record[ACTIVE]!;
    record[ACTIVE] = turnFinished(prev, {
      conversationId: ACTIVE,
      messages: fresh,
      turnCount: prev.turnCount,
      updatedAt: prev.updatedAt,
      jsonMode: prev.jsonMode,
      stopReason: "completed",
    });
  });
  timed("setSessions_user_echo", 21, () => {
    const prev = record[ACTIVE]!;
    record[ACTIVE] = userMessageEchoed(prev, `echo ${performance.now()}`);
  });
  // Undo the echo so later sections index the same base list.
  record[ACTIVE] = seed;

  const current = record[ACTIVE]!;
  const visible = current.messages.filter(
    (m) =>
      !(
        m.role === "user" &&
        m.content.length === 1 &&
        m.content[0]?.type === "tool_result"
      )
  );

  timed("full_derivation_statusMap", 9, () => {
    toolResultStatusMap(current.messages);
  });
  timed("full_derivation_resultTextMap", 9, () => {
    toolResultTextMap(current.messages);
  });
  timed("full_derivation_activitySegments", 9, () => {
    orderedTurnActivitySegments(visible, 0);
  });
  timed("full_derivation_toolUseIds", 9, () => {
    toolUseIdsOf(visible);
  });
  const thinkingMsAtVisible = makeThinkingMsAtVisibleFromSource(
    thinkingMs,
    visible.map((_, i) => i)
  );
  timed("full_derivation_foldLines", 9, () => {
    buildActivityBlockFoldLines({
      messages: visible,
      visibleCount: visible.length,
      thinkingMsAtVisible,
    });
  });

  let index = syncToolIndex(null, current.messages);
  timed("incremental_index_cold_build", 1, () => {
    index = syncToolIndex(null, current.messages);
  });
  const appended = [...current.messages, ...rehydrate(fresh.slice(-1))];
  timed("incremental_index_append_extend", 21, () => {
    index = syncToolIndex(index, appended);
  });
  const appendedNoTool = [
    ...appended,
    {
      role: "assistant",
      content: [{ type: "text", text: "no tools here" }],
    } satisfies AnthropicNativeMessage,
  ];
  timed("incremental_index_no_tool_append_identity", 21, () => {
    const before = index;
    index = syncToolIndex(index, appendedNoTool);
    if (index.statusMap !== before.statusMap) {
      throw new Error("expected stable statusMap reference");
    }
  });

  const viewportMessages = visible;
  const heights = new Array<number>(viewportMessages.length).fill(6);
  const scrollSamples: number[] = [];
  for (let i = 0; i < 101; i++) {
    const t0 = performance.now();
    selectViewportMountWindow(viewportMessages, {
      scrollTop: 200 + i * 3,
      viewportHeight: 40,
      heights,
    });
    scrollSamples.push(performance.now() - t0);
  }
  emit("viewport_select_scroll_reselect", scrollSamples, 4);
  process.stdout.write(
    JSON.stringify({ section: "rss_final_mb", rss_mb: rssMb() }) + "\n"
  );
}

main();
