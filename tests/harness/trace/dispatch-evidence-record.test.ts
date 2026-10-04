/**
 * Final SDK-request evidence carried by the llm_call row.
 *
 * The observable is the row on disk: parsed from a real JSONL file written by
 * the production `createJsonlTraceService` into a real temporary pool, with
 * every referenced body dereferenced from `<pool>/blobs/<sha>` and compared to
 * the production masker output of the value the adapter actually emitted. The
 * oracle is the emitted object, never a value recomputed by the writer.
 *
 * Contracts:
 * 1. one entry per governed invocation, in emission order
 * 2. per-invocation identity survives content reuse: two entries with the
 *    same body keep distinct `invocationId` over ONE stored body file
 * 3. a changed body addresses a different ref and never overwrites the old one
 * 4. `system` / `tools` keys are ABSENT (not null) when the evidence omitted them
 * 5. an injected body-write fault counts trace health, withholds the row
 *    instead of claiming complete evidence, and never re-dispatches
 * 6. the pre-existing `messages` field keeps its exact {role, content:{sha,
 *    bytes}} ref shape when both channels are present
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import {
  createOutputMask,
  currentSecretValues,
} from "../../../src/harness/sandbox/index.ts";
import {
  setActiveExtraSecrets,
  clearActiveExtraSecrets,
} from "../../../src/harness/sandbox/env-isolation.ts";
import { TRACE_BODY_REPRESENTATION } from "../../../src/shared/trace-body-contract.ts";
import type { TraceBodyRef } from "../../../src/shared/trace-body-contract.ts";
import type {
  DispatchEvidenceEntry,
  DispatchEvidenceInput,
  LlmCallRecord,
} from "../../../src/harness/trace/types.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import type { LoopAdapter } from "../../../src/harness/loop-engine.ts";
import type {
  LoopState,
  SdkDispatchEvidence,
} from "../../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import { parseJsonl } from "./_fixtures.ts";

const SECRET = "sk-live-dispatch-evidence";
const tmpDirs: string[] = [];

beforeEach(() => {
  setActiveExtraSecrets([SECRET]);
});

afterEach(() => {
  clearActiveExtraSecrets();
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function poolDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-dispatch-evidence-"));
  tmpDirs.push(dir);
  return dir;
}

/** The masker the writer itself uses — the oracle for a stored body. */
const productionMask = (text: string): string =>
  createOutputMask(currentSecretValues()).mask(text);

function maskedBody(value: unknown): string {
  return productionMask(JSON.stringify(value) ?? "null");
}

function bodySha(value: unknown): string {
  return createHash("sha256").update(maskedBody(value), "utf8").digest("hex");
}

function readStoredBody(pool: string, ref: TraceBodyRef): string {
  return readFileSync(join(pool, "blobs", ref.sha), "utf8");
}

function storedBodyFiles(pool: string): string[] {
  const dir = join(pool, "blobs");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function evidenceOf(
  row: Record<string, unknown>
): ReadonlyArray<DispatchEvidenceEntry> {
  return (
    (row["dispatch_evidence"] as DispatchEvidenceEntry[] | undefined) ?? []
  );
}

const MESSAGES_A = [{ role: "user", content: [{ type: "text", text: "go" }] }];
const MESSAGES_B = [
  { role: "user", content: [{ type: "text", text: "go on" }] },
];
const SYSTEM_TEXT = "you are the harness, key sk-live-dispatch-evidence";
const TOOLS = [{ name: "bash", description: "run a command" }];

function baseLlmCall(): LlmCallRecord {
  return {
    startedAt: "2026-10-03T00:00:00.000Z",
    endedAt: "2026-10-03T00:00:01.000Z",
    durationMs: 1000,
    stream: true,
    messagesCaptured: true,
    status: "ok",
  };
}

describe("llm_call row carries one evidence entry per governed invocation", () => {
  it("stores each body in the session pool, dereferencing to the masker output", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-dispatch",
    });
    const evidence: DispatchEvidenceInput[] = [
      {
        invocationId: "inv-1",
        stream: true,
        messages: MESSAGES_A,
        system: SYSTEM_TEXT,
        tools: TOOLS,
      },
      { invocationId: "inv-2", stream: true, messages: MESSAGES_B },
    ];
    const id = await trace.recordLlmCall({
      ...baseLlmCall(),
      dispatchEvidence: evidence,
    });
    assert.equal(typeof id, "string");

    const rows = parseJsonl(join(dir, "conv-dispatch.jsonl"));
    const entries = evidenceOf(rows[0]!);
    assert.equal(entries.length, 2);
    // Emission order, not sorted order.
    assert.deepEqual(
      entries.map((e) => e.invocationId),
      ["inv-1", "inv-2"]
    );
    assert.deepEqual(
      entries.map((e) => e.stream),
      [true, true]
    );
    // Each ref addresses a complete trace-permitted body, and the bytes behind
    // the address are the masker output of the emitted value — the secret is
    // masked inside the retained body, never stored raw.
    for (const [entry, emitted] of [
      [entries[0]!, MESSAGES_A],
      [entries[1]!, MESSAGES_B],
    ] as const) {
      assert.equal(entry.messages.representation, TRACE_BODY_REPRESENTATION);
      assert.equal(readStoredBody(dir, entry.messages), maskedBody(emitted));
      assert.equal(
        entry.messages.bytes,
        Buffer.byteLength(maskedBody(emitted), "utf8")
      );
    }
    const [first] = entries;
    assert.equal(readStoredBody(dir, first!.system!), maskedBody(SYSTEM_TEXT));
    assert.equal(readStoredBody(dir, first!.tools!), maskedBody(TOOLS));
  });

  it("two invocations with identical bodies keep distinct identity over one stored file", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-shared-body",
    });
    await trace.recordLlmCall({
      ...baseLlmCall(),
      dispatchEvidence: [
        { invocationId: "inv-a", stream: true, messages: MESSAGES_A },
        { invocationId: "inv-b", stream: true, messages: MESSAGES_A },
      ],
    });

    const rows = parseJsonl(join(dir, "conv-shared-body.jsonl"));
    const [left, right] = evidenceOf(rows[0]!);
    assert.notEqual(left!.invocationId, right!.invocationId);
    // Content identity is shared; invocation identity is not.
    assert.equal(left!.messages.sha, right!.messages.sha);
    assert.deepEqual(storedBodyFiles(dir), [left!.messages.sha]);
  });

  it("a changed body addresses a different ref and leaves the earlier body intact", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-changed-body",
    });
    await trace.recordLlmCall({
      ...baseLlmCall(),
      dispatchEvidence: [
        { invocationId: "inv-a", stream: false, messages: MESSAGES_A },
        { invocationId: "inv-b", stream: false, messages: MESSAGES_B },
      ],
    });

    const rows = parseJsonl(join(dir, "conv-changed-body.jsonl"));
    const [left, right] = evidenceOf(rows[0]!);
    assert.notEqual(left!.messages.sha, right!.messages.sha);
    assert.equal(left!.messages.sha, bodySha(MESSAGES_A));
    // The first body survives unchanged — content addressing never overwrites.
    assert.equal(readStoredBody(dir, left!.messages), maskedBody(MESSAGES_A));
    assert.equal(readStoredBody(dir, right!.messages), maskedBody(MESSAGES_B));
  });

  it("omits the system / tools keys entirely when the evidence omitted them", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-sparse",
    });
    await trace.recordLlmCall({
      ...baseLlmCall(),
      dispatchEvidence: [
        { invocationId: "inv-sparse", stream: false, messages: MESSAGES_A },
      ],
    });

    const rows = parseJsonl(join(dir, "conv-sparse.jsonl"));
    const [entry] = evidenceOf(rows[0]!);
    // Absent, not null and not an empty body: a reader must not have to guess
    // whether an empty system instruction was sent. `outcome` is pinned here
    // too — an entry never exists without its own settled verdict.
    assert.equal(Object.hasOwn(entry!, "system"), false);
    assert.equal(Object.hasOwn(entry!, "tools"), false);
    assert.deepEqual(Object.keys(entry!).sort(), [
      "invocationId",
      "messages",
      "outcome",
      "stream",
    ]);
    assert.equal(storedBodyFiles(dir).length, 1);
  });

  it("keeps the pre-existing messages ref shape byte-identical when both channels are present", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-both",
    });
    await trace.recordLlmCall({
      ...baseLlmCall(),
      messages: [{ role: "user", content: "plain body" }],
      dispatchEvidence: [
        { invocationId: "inv-both", stream: true, messages: MESSAGES_A },
      ],
    });

    const rows = parseJsonl(join(dir, "conv-both.jsonl"));
    const row = rows[0]!;
    const messages = row["messages"] as Array<{
      role: unknown;
      content: Record<string, unknown>;
    }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, "user");
    assert.deepEqual(Object.keys(messages[0]!.content).sort(), [
      "bytes",
      "sha",
    ]);
    // The content-level `{kind, v}` wrapper is untouched by the new channel.
    const contentBody = readFileSync(
      join(dir, "blobs", messages[0]!.content["sha"] as string),
      "utf8"
    );
    assert.deepEqual(JSON.parse(contentBody), { kind: "str", v: "plain body" });
    assert.equal(evidenceOf(row).length, 1);
  });

  it("counts an unwritable body through trace health and withholds the row", async () => {
    const dir = poolDir();
    const trace = createJsonlTraceService({
      filePath: dir,
      conversationId: "conv-unwritable",
    });
    // Fault injection point: `blobs` exists as a regular file, so the writer's
    // mkdir of the body directory fails and no body can be retained.
    writeFileSync(join(dir, "blobs"), "not a directory", "utf8");

    const id = await trace.recordLlmCall({
      ...baseLlmCall(),
      dispatchEvidence: [
        { invocationId: "inv-lost", stream: true, messages: MESSAGES_A },
      ],
    });
    // No inline fallback: no id, no row claiming complete evidence, and the
    // failure is reported as a trace-health count (ADR-0136 D9).
    assert.equal(id, undefined);
    assert.equal(trace.traceWriteFailures, 1);
    const file = join(dir, "conv-unwritable.jsonl");
    const rows = existsSync(file) ? parseJsonl(file) : [];
    assert.deepEqual(
      rows.filter((r) => r["record_type"] === "llm_call"),
      []
    );
  });
});

interface EngineRun {
  readonly dir: string;
  readonly rows: Array<Record<string, unknown>>;
  /** Number of adapter.step invocations that reported evidence. */
  readonly attempts: number;
  /** Trace-health count observed after the run. */
  readonly failures: number;
  /** Every value the adapter actually reported, in emission order. */
  readonly emitted: ReadonlyArray<SdkDispatchEvidence>;
}

/**
 * Adapter double that reports what the engine handed it and then answers with
 * the scripted result. The engine, the trace writer and the pool stay real; only
 * the model boundary and the evidence emission are stubbed (the real adapter's
 * emission is pinned in tests/harness/model-adapter/dispatch-evidence.test.ts).
 */
function observingAdapter(opts: {
  readonly emitted: Array<SdkDispatchEvidence>;
  readonly onAttempt?: (evidence: SdkDispatchEvidence) => void;
}): LoopAdapter {
  const inner = createStubModel({
    responses: [
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  let minted = 0;
  return {
    ...inner,
    streamMode: true,
    async step(
      state: LoopState,
      request: {
        tools?: unknown;
        system?: string;
        onDispatch?: (evidence: SdkDispatchEvidence) => void;
      },
      signal?: AbortSignal
    ) {
      minted += 1;
      const evidence: SdkDispatchEvidence = {
        invocationId: `inv-${minted}`,
        stream: true,
        messages: state.messages,
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(Array.isArray(request.tools) ? { tools: request.tools } : {}),
      };
      opts.emitted.push(evidence);
      // The real adapter reports through the observer before dispatch; a
      // double that skipped it would test nothing about the wiring.
      request.onDispatch?.(evidence);
      opts.onAttempt?.(evidence);
      return inner.step(state, request, signal);
    },
  };
}

async function engineRun(opts: {
  readonly conversationId: string;
  readonly onAttempt?: (dir: string, evidence: SdkDispatchEvidence) => void;
}): Promise<EngineRun> {
  const dir = poolDir();
  const trace = createJsonlTraceService({
    filePath: dir,
    conversationId: opts.conversationId,
  });
  const emitted: Array<SdkDispatchEvidence> = [];
  const adapter = observingAdapter({
    emitted,
    ...(opts.onAttempt !== undefined
      ? { onAttempt: (e) => opts.onAttempt!(dir, e) }
      : {}),
  });
  await run("go", {
    adapter,
    executor: { executeAll: async () => [] },
    registry: createRegistry([
      createStubTool({ name: "bash", next: () => ({}) }),
    ]),
    maxTurns: 5,
    system: async () => SYSTEM_TEXT,
    trace,
  });
  return {
    dir,
    rows: parseJsonl(join(dir, `${opts.conversationId}.jsonl`)),
    attempts: emitted.length,
    failures: trace.traceWriteFailures,
    emitted,
  };
}

describe("loop-engine attaches its governed invocation evidence to the row", () => {
  it("writes one entry per invocation whose body is the request the engine sent", async () => {
    const { dir, rows, attempts, emitted } = await engineRun({
      conversationId: "engine-evidence",
    });
    assert.equal(attempts, 1);
    const llmRow = rows.find((r) => r["record_type"] === "llm_call")!;
    const entries = evidenceOf(llmRow);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.invocationId, emitted[0]!.invocationId);
    assert.equal(entries[0]!.stream, true);
    // Dereferenced off disk and compared with the production masker output of
    // the value the adapter reported — not a value recomputed by the writer.
    assert.equal(
      readStoredBody(dir, entries[0]!.messages),
      maskedBody(emitted[0]!.messages)
    );
    assert.equal(
      readStoredBody(dir, entries[0]!.system!),
      maskedBody(emitted[0]!.system!)
    );
    // The secret is masked inside the retained body, never stored raw.
    assert.equal(
      readStoredBody(dir, entries[0]!.system!).includes(SECRET),
      false
    );
  });

  it("an unwritable body pool fails trace health once, writes no llm_call row, and never re-dispatches", async () => {
    const { rows, attempts, failures } = await engineRun({
      conversationId: "engine-evidence-fault",
      onAttempt: (dir) => {
        // Storage-fault injection at dispatch time: `blobs` is occupied by a
        // regular file, so no body of this call can be retained. The messages
        // channel is the first to hit it; the evidence-only channels are proven
        // to withhold the row in the writer-level test above.
        writeFileSync(join(dir, "blobs"), "not a directory", "utf8");
      },
    });
    assert.equal(
      attempts,
      1,
      "evidence failure must not cause a second dispatch"
    );
    assert.equal(failures, 1);
    assert.deepEqual(
      rows.filter((r) => r["record_type"] === "llm_call"),
      []
    );
    // The turn survived: trace stays best-effort and non-throwing.
    assert.ok(rows.some((r) => r["record_type"] === "turn"));
  });
});
