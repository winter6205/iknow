/**
 * SC13 replay half: the transcript a truncated tool_use turn produces must
 * reload through a FRESH SessionStore as an API-valid chain — every returned
 * tool_use id already carries its output-limit result, so the orphan-tool-use
 * repair has nothing to do and the turn stays one human turn with its
 * nonSuccessStop / truncation outcome.
 *
 * Real loop engine + real store + real filesystem in an isolated temp dir; only
 * the model is stubbed at the adapter boundary.
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  closeoutOrphanToolUses,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import { projectMessagesToTurns } from "../../src/session-api/hub.ts";
import { run } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;

const toolResultIds = (msgs: ReadonlyArray<AnthropicNativeMessage>): string[] =>
  msgs
    .flatMap((m) => [...m.content])
    .filter((b) => b.type === "tool_result")
    .map((b) => (b as { tool_use_id: string }).tool_use_id);

const toolUseIds = (msgs: ReadonlyArray<AnthropicNativeMessage>): string[] =>
  msgs
    .flatMap((m) => [...m.content])
    .filter((b) => b.type === "tool_use")
    .map((b) => (b as { id: string }).id);

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-truncation-replay-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("truncated tool_use transcript replays with valid pairing", () => {
  it("a fresh store reloads it unchanged, repairs nothing, and projects one failed turn", async () => {
    const echo = createStubTool({ name: "echo", next: (input) => input });
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: ["partial answer cut off"],
          toolCalls: [
            { id: "toolu_a", name: "echo", input: { value: "ping" } },
            { id: "toolu_b", name: "echo", input: { value: "pong" } },
          ],
          supplierStop: "truncation",
        }),
      ],
    });

    const committed: AnthropicNativeMessage[][] = [];
    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      commitMessages: async (messages) => {
        committed.push([...messages]);
      },
    });
    assert.equal(result.stopReason, "nonSuccessStop");
    assert.equal(
      (result as { supplierDetail?: string }).supplierDetail,
      "truncation"
    );

    const id = `truncation-replay-${Date.now()}-${Math.floor(
      Math.random() * 1e6
    )}`;
    const file: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: result.messages,
      jsonMode: false,
      turnCount: result.turnCount,
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "go",
      cwd: "/tmp/test",
      sanitized_at: "2026-01-01T00:00:00.000Z",
      checkpoints: [],
    };
    await store.save({ id, file });
    const head = await store.readHead(id);
    assert.ok(head !== null, "the turn's terminal event is the outcome anchor");
    await store.appendOutcome({
      id,
      turnId: head,
      stopReason: result.stopReason,
      ...(result.supplierDetail !== undefined
        ? { supplierDetail: result.supplierDetail }
        : {}),
    });

    // A freshly constructed store re-reads the actual persisted JSONL.
    const reopened = new SessionStore(baseDir, process.cwd());
    const loaded = await reopened.load(id);
    assert.deepEqual(
      loaded.messages,
      result.messages,
      "reload adds no message: the closeout was already persisted"
    );
    assert.deepEqual(toolUseIds(loaded.messages), ["toolu_a", "toolu_b"]);
    assert.deepEqual(
      toolResultIds(loaded.messages),
      ["toolu_a", "toolu_b"],
      "every returned tool_use id carries exactly one result"
    );

    // The repair projection stays silent on this pair (it is the crash path).
    assert.deepEqual(
      closeoutOrphanToolUses(loaded.messages),
      loaded.messages,
      "orphan closeout must not fire on a paired truncated turn"
    );

    // Outcome resolution against the active chain.
    const evidence = await reopened.projectTurnOutcomes(id);
    assert.deepEqual(evidence.messageEventIds, ["e0", "e1", "e2"]);
    const recorded = evidence.outcomes.get(head)!;
    assert.equal(recorded.stopReason, "nonSuccessStop");
    assert.equal(recorded.supplierDetail, "truncation");

    // The synthetic protocol message does not open a new human turn.
    const turns = projectMessagesToTurns(
      loaded.messages,
      undefined,
      undefined,
      evidence
    );
    assert.equal(turns.length, 1, "one query message → one projected turn");
    assert.equal(turns[0]!.answer.stopReason, "nonSuccessStop");
    assert.equal(turns[0]!.answer.outcome?.terminal, "known");
    assert.equal(
      (turns[0]!.answer.outcome as { supplierDetail?: string }).supplierDetail,
      "truncation"
    );
  });

  it("a crash before the closeout still falls back on the existing orphan repair", async () => {
    // The exemption is pairing-driven, not stop-reason driven: an assistant
    // message with unclosed tool_uses keeps the pre-existing repair path.
    const id = `truncation-crash-${Date.now()}`;
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "partial answer cut off" },
          { type: "tool_use", id: "toolu_a", name: "echo", input: {} },
        ],
      },
    ];
    const file: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages,
      jsonMode: false,
      turnCount: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "go",
      cwd: "/tmp/test",
      sanitized_at: "2026-01-01T00:00:00.000Z",
      checkpoints: [],
    };
    await store.save({ id, file });

    const reopened = new SessionStore(baseDir, process.cwd());
    const loaded = await reopened.load(id);
    assert.equal(
      loaded.messages.length,
      3,
      "the repair backfills the missing result on reload"
    );
    assert.deepEqual(toolResultIds(loaded.messages), ["toolu_a"]);
  });
});
