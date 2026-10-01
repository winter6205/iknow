/**
 * ADR-0135 / spec #1170 SC11: the security-interruption record survives a
 * real store round-trip, and a malformed one is rejected rather than
 * projected as a clean stop.
 *
 * Exercised against a real SessionStore over a real temp directory (per the
 * testing policy's session-evidence rule): the assertion that matters is what
 * a later reader actually loads, not what the writer was handed.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveProjectSessionDir, SessionStore } from "../../src/session-api/store/index.ts";
import { knownTurnOutcome } from "../../src/session-api/contract.ts";
import type { SecurityInterruptionRecord } from "../../src/session-api/store/index.ts";

let baseDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-security-interruption-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/**
 * Seed a conversation with one real user message, so its event (`e0`) is on
 * the active head chain — an outcome anchored to a turn that is not on the
 * chain never projects, which is ADR-0126's existing rule rather than
 * something this test should work around.
 */
async function seedConversation(id: string): Promise<void> {
  await store.save({
    id,
    file: {
      conversation_id: id,
      messages: [{ role: "user", content: "hello" }],
      turnCount: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      schemaVersion: 1,
    } as never,
  });
}

const FULL_INTERRUPTION: SecurityInterruptionRecord = {
  tier: "mid",
  tool: "bash",
  confirmedViolations: 3,
  cleanup: [
    // A worker whose signal went out: a request, not a proven stop.
    { kind: "subagent", id: "worker-1", state: "stop_requested", cleanup: { state: "not_started" } },
    // A background job whose group was observed gone.
    {
      kind: "background_task",
      id: "bg-1",
      state: "confirmed_stopped",
      cleanup: { state: "confirmed_stopped", pgid: 4242, task_id: "bg-1" },
    },
    // A background job whose teardown could not be confirmed — recorded, not
    // dropped, so a reviewer sees it may still be running.
    {
      kind: "background_task",
      id: "bg-2",
      state: "unconfirmed",
      reason: "observation_expired",
      cleanup: {
        state: "unconfirmed",
        reason: "observation_expired",
        pgid: 77,
        detail: "process group still alive when the bounded observation ended",
        task_id: "bg-2",
      },
    },
  ],
};

describe("SessionOutcomeRecord security interruption (ADR-0135)", () => {
  it("round-trips the cause and every per-item cleanup verdict through a real store", async () => {
    const id = "conv-roundtrip";
    await seedConversation(id);
    await store.appendOutcome({
      id,
      turnId: "e0",
      stopReason: "cancelled",
      securityInterruption: FULL_INTERRUPTION,
    });

    // Read through a FRESHLY constructed store: durability, not a cache.
    const reopened = new SessionStore(baseDir, process.cwd());
    const evidence = await reopened.projectTurnOutcomes(id);
    const record = evidence.outcomes.get("e0");
    assert.ok(record !== undefined, "the outcome record is on disk");
    assert.equal(record?.stopReason, "cancelled");
    assert.deepEqual(record?.securityInterruption, FULL_INTERRUPTION);

    // The persisted bytes carry it too, so a reviewer reading the raw JSONL
    // (and T8's trace work) can see the same facts.
    const raw = await readFile(join(baseDir, "projects", dirName(), id, `${id}.jsonl`), "utf8");
    assert.match(raw, /"securityInterruption"/);
    assert.match(raw, /"confirmedViolations":3/);
    assert.match(raw, /"observation_expired"/);
  });

  it("a plain cancelled turn (user Ctrl+C) carries no security cause", async () => {
    const id = "conv-plain-cancel";
    await seedConversation(id);
    await store.appendOutcome({ id, turnId: "e0", stopReason: "cancelled" });
    const evidence = await store.projectTurnOutcomes(id);
    const record = evidence.outcomes.get("e0");
    assert.equal(record?.stopReason, "cancelled");
    assert.equal(
      record?.securityInterruption,
      undefined,
      "the two cancelled reasons stay distinguishable"
    );
    // The projection agrees.
    const view = knownTurnOutcome("cancelled");
    assert.equal(view.terminal === "known" && view.securityInterruption, undefined);
  });

  it("refuses a security cause attached to a non-cancelled stop", async () => {
    const id = "conv-bad-reason";
    await seedConversation(id);
    await assert.rejects(
      store.appendOutcome({
        id,
        turnId: "e0",
        stopReason: "completed",
        securityInterruption: FULL_INTERRUPTION,
      }),
      (err: unknown) =>
        (err as { kind?: string }).kind === "schema_invalid" &&
        (err as { field?: string }).field === "outcome",
      "a completed stop cannot claim a security cause"
    );
  });

  it("rejects a tampered on-chain record whose cleanup claim contradicts its evidence", async () => {
    const id = "conv-tampered";
    await seedConversation(id);
    // Write an outcome whose item claims `confirmed_stopped` while its own
    // evidence says no teardown was ever started. A reader must not get a
    // clean stop out of that — a persisted claim a reviewer acts on has to be
    // internally consistent.
    const path = join(baseDir, "projects", dirName(), id, `${id}.jsonl`);
    await appendFile(
      path,
      JSON.stringify({
        type: "outcome",
        turnId: "e0",
        stopReason: "cancelled",
        securityInterruption: {
          tier: "mid",
          tool: "bash",
          confirmedViolations: 3,
          cleanup: [
            {
              kind: "background_task",
              id: "bg-bogus",
              state: "confirmed_stopped",
              cleanup: { state: "not_started" },
            },
          ],
        },
      }) + "\n",
      "utf8"
    );
    // The parse loop rejects an unrecognized record shape with
    // schema_invalid / "type" — the same treatment any other malformed tail
    // record gets. The point is that it is NOT projected.
    await assert.rejects(
      store.projectTurnOutcomes(id),
      (err: unknown) => (err as { kind?: string }).kind === "schema_invalid",
      "an inconsistent cleanup claim is rejected, not projected"
    );
  });

  it("rejects a cleanup item that is not a well-formed record", async () => {
    const id = "conv-bad-item";
    await seedConversation(id);
    const path = join(baseDir, "projects", dirName(), id, `${id}.jsonl`);
    await appendFile(
      path,
      JSON.stringify({
        type: "outcome",
        turnId: "e0",
        stopReason: "cancelled",
        securityInterruption: {
          tier: "mid",
          tool: "bash",
          confirmedViolations: 3,
          // A claimed stop with no process identity at all.
          cleanup: [{ kind: "background_task", id: "bg-1", state: "confirmed_stopped" }],
        },
      }) + "\n",
      "utf8"
    );
    await assert.rejects(
      store.projectTurnOutcomes(id),
      (err: unknown) => (err as { kind?: string }).kind === "schema_invalid"
    );
  });
});

/** The project slug dir under the pool root (mirrors resolveProjectSessionDir). */
function dirName(): string {
  return basename(resolveProjectSessionDir(baseDir, process.cwd()));
}
