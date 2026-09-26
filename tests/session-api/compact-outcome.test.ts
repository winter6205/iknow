/**
 * ADR-0126: `compactSession` is a history projection like `getSession`, so it
 * must read the persisted turn outcomes instead of synthesizing a terminal
 * state. Both exits are covered with a REAL SessionStore in an isolated temp
 * dir (never mocked): the no-shrink exit re-projects the pre-compaction
 * messages, the success exit re-projects the messages it just saved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/index.ts";
import {
  OUTPUT_LIMIT_NOTICE,
  type TurnDto,
} from "../../src/session-api/contract.ts";
import { createNoAskUser } from "../../src/harness/permission/index.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";

let baseDir: string;
let store: SessionStore;
let hub: SessionHub;

const userMsg = (text: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistantMsg = (text: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

/** Persist a session of `turns` user/assistant pairs with a real store save,
 *  so the event ids are the store's own (e0..e{2n-1}). */
async function seedSession(
  id: string,
  turns: number,
  truncatedTurn: number | undefined
): Promise<void> {
  const messages: AnthropicNativeMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(userMsg(`q${i}`), assistantMsg(`a${i}`));
  }
  await store.save({
    id,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages,
      jsonMode: false,
      turnCount: turns,
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "q0",
      cwd: process.cwd(),
      sanitized_at: "2026-01-01T00:00:00.000Z",
      checkpoints: [],
      workspaceRoot: process.cwd(),
    },
  });
  if (truncatedTurn !== undefined) {
    // The terminal event of turn `truncatedTurn` is its head-chain anchor.
    await store.appendOutcome({
      id,
      turnId: `e${truncatedTurn * 2 + 1}`,
      stopReason: "nonSuccessStop",
      supplierDetail: "truncation",
    });
  }
}

const answerOf = (turn: TurnDto | undefined) => {
  assert.ok(turn, "expected a projected turn");
  return turn.answer;
};

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-compact-outcome-"));
  store = new SessionStore(baseDir, process.cwd());
  // No `deps`: compactSession takes the placeholder (pure truncation) branch,
  // which is the only branch that needs no model call.
  hub = new SessionHub({ store, askUser: createNoAskUser() });
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("compactSession projects persisted turn outcomes (ADR-0126)", () => {
  it("no-shrink exit keeps a recorded output-limit stop instead of completed", async () => {
    const id = "compact-outcome-noshrink";
    // Below keepRecent → nothing to truncate → compacted:false, and the
    // returned turns are the pre-compaction messages re-projected.
    await seedSession(id, 1, 0);

    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(false);
    const answer = answerOf(res.turns[0]);
    expect(answer.stopReason).toBe("nonSuccessStop");
    expect(answer.stopReason).not.toBe("completed");
    expect(answer.outcome).toEqual({
      terminal: "known",
      stopReason: "nonSuccessStop",
      supplierDetail: "truncation",
    });
    expect(answer.outputLimitNotice).toBe(OUTPUT_LIMIT_NOTICE);
    // Same evidence a reopen sees.
    expect(res.turns).toEqual((await hub.getSession(id)).turns);
  });

  it("success exit projects the saved chain as its own evidence (no synthesized completed)", async () => {
    const id = "compact-outcome-saved";
    // Above keepRecent → the placeholder path really shrinks and saves.
    await seedSession(id, 5, 0);

    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(true);
    const { outcomes } = await store.projectTurnOutcomes(id);
    // ADR-0126: a turn whose terminal outcome is not recorded is unknown, and
    // never a synthesized completion.
    for (const turn of res.turns) {
      if (outcomes.size === 0) {
        expect(turn.answer.outcome).toEqual({ terminal: "unknown" });
        expect(turn.answer.stopReason).toBeUndefined();
      }
      expect(turn.answer.stopReason).not.toBe("completed");
    }
    // The compaction response and a reopen of what it saved are one projection.
    expect(res.turns).toEqual((await hub.getSession(id)).turns);
  });
});
