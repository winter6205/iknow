/**
 * System-level invariant 3 (context-metrics verification plan): persistence
 * isolation of the projected occupancy (ADR-0008 D6).
 *
 * The projected reading may exist in the `context_usage` stream event and in
 * the TUI state — nowhere else. This case drives one synthetic image-bearing
 * turn through the production composition root (`SessionHub`) over a real
 * `SessionStore`, reads the result back with a FRESHLY constructed store, and
 * inspects both the session JSONL and the per-session trace JSONL.
 *
 * Certified boundary:
 *  - `file.lastUsage` is the confirmed post-call usage only (exactly the four
 *    usage fields);
 *  - no projected value and no projection vocabulary appears anywhere in the
 *    session JSONL, in the published `native_state` bodies, or in the trace's
 *    `llm_call` records;
 *  - the projection never edits the conversation: the persisted messages are
 *    the real user payload (text + image verbatim) and the real assistant
 *    reply.
 *
 * Why the number check is a structured scan rather than a raw grep: a small
 * integer occurs by chance inside UUIDs and ISO timestamps, so a substring
 * search for it is not a sound oracle. Walking every persisted value covers
 * every position a token count could occupy; the projection vocabulary is
 * still checked on the raw text.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  parseSessionJsonl,
  resolveConversationTraceFilePath,
  SESSION_JSONL_EXT,
  SessionStore,
  type SessionNativeStateRecord,
} from "../../src/session-api/store/index.ts";
import { encodeUserContent } from "../../src/harness/model-adapter/anthropic-adapter.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type {
  AnthropicContentBlock,
  TokenUsage,
} from "../../src/harness/model-adapter/types.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";

/** Confirmed API usage the scripted adapter reports for the one call. */
const CONFIRMED_USAGE: TokenUsage = {
  inputTokens: 12_345,
  outputTokens: 678,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
};

/** Keys a projection would have to introduce to leak into persisted state.
 *  `source` is deliberately absent: real content blocks carry a `source` key
 *  (the image block's base64 source), and the projected reading's own
 *  `source:"projected"` value is covered by the raw-text check below. */
const PROJECTION_KEYS = new Set([
  "occupancy",
  "projectedNext",
  "projected_next",
  "projected",
]);

/** The `context_usage` variants, for the stream collection below. */
type ContextUsageEvent = Extract<HarnessStreamEvent, { type: "context_usage" }>;

/** PNG signature + IHDR so the pixel estimator reads 512x512 from the header;
 *  the payload itself stays short (no filler), keeping the persisted bytes
 *  small and the projected number far from any byte count. */
function syntheticPngBase64(width: number, height: number): string {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    6,
    0,
    0,
    0,
  ]).toString("base64");
}

const IMAGE_BASE64 = syntheticPngBase64(512, 512);
const USER_TEXT = "look at this";

const USER_MESSAGE: AnthropicContentBlock[] = [
  { type: "text", text: USER_TEXT },
  {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: IMAGE_BASE64 },
  } as AnthropicContentBlock,
];

let dataDir: string;
let projectRoot: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "iknow-test-"));
  projectRoot = await mkdtemp(join(tmpdir(), "iknow-test-root-"));
});

afterEach(async () => {
  await Promise.all([
    rm(dataDir, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]);
});

/** Every numeric leaf and every object key under `value`, values at any depth. */
function walk(
  value: unknown,
  onNumber: (n: number, path: string) => void,
  onKey: (k: string, path: string) => void,
  path = "$"
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    onNumber(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => walk(entry, onNumber, onKey, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      onKey(key, `${path}.${key}`);
      walk(entry, onNumber, onKey, `${path}.${key}`);
    }
  }
}

/** Parse a JSONL file into records (blank lines skipped). */
function parseLines(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function collectedProjections(
  events: ReadonlyArray<ContextUsageEvent>
): number[] {
  const values: number[] = [];
  for (const event of events) {
    if (event.phase === "projected") {
      values.push(event.occupancy.tokens);
    }
    if (event.projectedNext !== undefined) {
      values.push(event.projectedNext.tokens);
    }
  }
  return values;
}

describe("projected occupancy never leaves the display path (ADR-0008 D6)", () => {
  it("persists the confirmed usage and the real messages only, in session and trace", async () => {
    // Premise: the temp roots really are outside the repository and inside the
    // OS temporary directory.
    const tmpPrefix = resolve(tmpdir()) + sep;
    assert.ok(
      resolve(dataDir).startsWith(tmpPrefix),
      `session root must be under os.tmpdir(), got ${dataDir}`
    );

    const store = new SessionStore(dataDir, projectRoot);
    // The derived project directory is the real write target: assert it too,
    // before anything is written.
    assert.ok(
      resolve(store.getProjectDir()).startsWith(tmpPrefix),
      `project session dir must be under os.tmpdir(), got ${store.getProjectDir()}`
    );
    const base = makeDeps([
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
        usage: CONFIRMED_USAGE,
      }),
    ]);
    const deps = {
      ...base,
      adapter: {
        ...base.adapter,
        // The production block encoder; without it the hub refuses the image
        // payload before it reaches the engine.
        encodeUserContent: (blocks: ReadonlyArray<AnthropicContentBlock>) =>
          encodeUserContent(blocks),
      },
    };
    const hub = new SessionHub({
      store,
      deps,
      workspaceRoot: projectRoot,
      // Truthy switch only: the hub derives the real path as
      // `<projectDir>/<conversationId>/trace.jsonl`.
      traceOut: dataDir,
    });
    await hub.bindWorkspace(projectRoot);
    const { session } = await hub.createSession();
    const conversationId = session.conversation_id;

    const events: ContextUsageEvent[] = [];
    await hub.postMessage({
      conversationId,
      text: USER_TEXT,
      content: [
        { type: "text", text: USER_TEXT },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: IMAGE_BASE64,
          },
        },
      ],
      onStream: (event) => {
        if (event.type === "context_usage") events.push(event);
      },
    });

    // Premise: this turn really produced both a projected beat and a confirmed
    // one; otherwise the isolation assertions below would be vacuous.
    const projected = events.filter((e) => e.phase === "projected");
    const confirmed = events.filter((e) => e.phase !== "projected");
    assert.ok(
      projected.length > 0,
      "the image-bearing turn emits a projection"
    );
    // The image-bearing request can never be measured, so its pre-call beat is
    // the projected variant (no `usage`).
    assert.equal(events[0]!.phase, "projected");
    assert.equal(
      "usage" in events[0]!,
      false,
      "the projected pre-call carries no usage object"
    );
    assert.equal(confirmed.length, 1, "one confirmed post-call beat");
    assert.equal(confirmed[0]!.phase, "post_call");
    assert.equal(confirmed[0]!.usage, CONFIRMED_USAGE);
    const projections = collectedProjections(events);
    assert.ok(projections.length > 0);
    for (const value of projections) {
      assert.ok(
        Number.isInteger(value) && value > 0,
        `projected reading is a positive integer (${value})`
      );
    }
    // Premise for the value scan: the projection is a real token count the
    // persisted state could plausibly have absorbed (not 0 / 1).
    assert.ok(
      Math.min(...projections) > 100,
      `projection must be a distinctive count, got ${projections.join(",")}`
    );

    // Read back through a store that never wrote this conversation.
    const fresh = new SessionStore(dataDir, projectRoot);
    const file = await fresh.load(conversationId);

    // 1. File-level usage is the confirmed usage only, with no projection key.
    assert.deepEqual(file.lastUsage, CONFIRMED_USAGE);
    assert.deepEqual(
      Object.keys(file.lastUsage ?? {}).sort(),
      [
        "cacheCreationInputTokens",
        "cacheReadInputTokens",
        "inputTokens",
        "outputTokens",
      ],
      "lastUsage carries exactly the four usage fields"
    );

    // 2. The conversation is the real one, untouched by the projection.
    assert.equal(file.messages.length, 2);
    assert.equal(file.messages[0]!.role, "user");
    assert.deepEqual(file.messages[0]!.content, USER_MESSAGE);
    assert.equal(file.messages[1]!.role, "assistant");
    assert.deepEqual(file.messages[1]!.content, [
      { type: "text", text: "done" },
    ]);

    // 3. No projected value or projection vocabulary anywhere in the JSONL.
    const jsonlPath = join(
      store.getProjectDir(),
      conversationId,
      `${conversationId}${SESSION_JSONL_EXT}`
    );
    const rawSession = await readFile(jsonlPath, "utf8");
    assert.equal(
      rawSession.includes("projected"),
      false,
      "the session JSONL must not carry the projection vocabulary"
    );
    const sessionRecords = parseSessionJsonl(rawSession);
    for (const record of sessionRecords.records) {
      walk(
        record,
        (n, path) =>
          assert.equal(
            projections.includes(n),
            false,
            `projected value ${n} persisted at session ${path}`
          ),
        (k, path) =>
          assert.equal(
            PROJECTION_KEYS.has(k),
            false,
            `projection key '${k}' persisted at session ${path}`
          )
      );
    }

    // 4. The published saved-state bodies carry only the real messages.
    const nativeStates = sessionRecords.records.filter(
      (r): r is SessionNativeStateRecord => r.type === "native_state"
    );
    assert.ok(nativeStates.length > 0, "the turn published saved state");
    for (const record of nativeStates) {
      const snapshot = await fresh.readPublishedNativeStateBody({
        id: conversationId,
        bodySha: record.bodySha,
      });
      // A boundary snapshot is a prefix of the real history — never an extra,
      // projected or synthesized entry.
      assert.deepEqual(
        snapshot.messages,
        file.messages.slice(0, snapshot.messages.length),
        `native_state (${record.boundary}) carries the real messages only`
      );
      walk(
        snapshot,
        (n, path) =>
          assert.equal(
            projections.includes(n),
            false,
            `projected value ${n} persisted in native_state ${record.boundary} at ${path}`
          ),
        (k, path) =>
          assert.equal(
            PROJECTION_KEYS.has(k),
            false,
            `projection key '${k}' published in native_state ${record.boundary} at ${path}`
          )
      );
    }
    const lastState = nativeStates.at(-1)!;
    const lastSnapshot = await fresh.readPublishedNativeStateBody({
      id: conversationId,
      bodySha: lastState.bodySha,
    });
    assert.deepEqual(
      lastSnapshot.messages,
      file.messages,
      "the terminal saved state is the full real history"
    );

    // 5. The trace has no projected marker and no projected count in its
    //    `llm_call` records.
    const tracePath = resolveConversationTraceFilePath({
      projectDir: store.getProjectDir(),
      conversationId,
    });
    const rawTrace = await readFile(tracePath, "utf8");
    assert.equal(
      rawTrace.includes("projected"),
      false,
      "the trace must not carry the projection vocabulary"
    );
    const llmCalls = parseLines(rawTrace).filter(
      (record): record is Record<string, unknown> =>
        typeof record === "object" &&
        record !== null &&
        (record as { record_type?: unknown }).record_type === "llm_call"
    );
    assert.equal(llmCalls.length, 1, "one model call is traced");
    const call = llmCalls[0]!;
    // The traced accounting is the confirmed usage (ADR-0008 exactness).
    assert.equal(call["input_tokens"], CONFIRMED_USAGE.inputTokens);
    assert.equal(call["output_tokens"], CONFIRMED_USAGE.outputTokens);
    walk(
      call,
      (n, path) =>
        assert.equal(
          projections.includes(n),
          false,
          `projected value ${n} persisted in llm_call at ${path}`
        ),
      (k, path) =>
        assert.equal(
          PROJECTION_KEYS.has(k),
          false,
          `projection key '${k}' persisted in llm_call at ${path}`
        )
    );
    for (const value of Object.values(call)) {
      assert.notEqual(value, "projected");
    }
  });
});
