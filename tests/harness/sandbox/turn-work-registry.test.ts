/**
 * Turn-owned work registry (ADR-0135 / #1170 T7): a security interruption
 * cancels only the workers and finite background jobs the interrupted turn
 * itself launched, and reports bounded per-item cleanup evidence.
 *
 * Boundary classes covered:
 *  - normal: registration, enumeration, one cancel per owned item
 *  - ownership isolation: another turn's item is a different registry
 *  - failure: cancel route absent / cancel call throws → unconfirmed, never
 *    a fabricated stop
 *  - truthful evidence: a stop request is reported as a request; only the
 *    bounded observation's own verdict becomes confirmed_stopped
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createTurnWorkRegistry,
  extractOwnedTaskId,
} from "../../../src/harness/sandbox/turn-work-registry.js";

describe("createTurnWorkRegistry", () => {
  it("registers workers and background jobs and enumerates them in insertion order", () => {
    const reg = createTurnWorkRegistry({});
    assert.equal(reg.isEmpty(), true);
    reg.registerSubagent("task-a");
    reg.registerSubagent("task-b");
    reg.registerBackgroundTask("bg-1");
    assert.deepEqual(reg.owned(), [
      { kind: "subagent", id: "task-a" },
      { kind: "subagent", id: "task-b" },
      { kind: "background_task", id: "bg-1" },
    ]);
    assert.equal(reg.isEmpty(), false);
  });

  it("a repeated registration of the same id cancels once", async () => {
    const cancelled: string[] = [];
    const reg = createTurnWorkRegistry({
      cancelSubagent: (id) => {
        cancelled.push(id);
        return true;
      },
    });
    reg.registerSubagent("task-a");
    reg.registerSubagent("task-a");
    const report = await reg.cancelOwned();
    assert.deepEqual(cancelled, ["task-a"]);
    assert.equal(report.length, 1);
  });

  it("a subagent whose in-flight child was signalled is a stop request, not a confirmed stop", async () => {
    const reg = createTurnWorkRegistry({ cancelSubagent: () => true });
    reg.registerSubagent("task-a");
    const [report] = await reg.cancelOwned();
    assert.equal(report?.kind, "subagent");
    assert.equal(report?.id, "task-a");
    // The subagent plane reports "a signal went out"; disappearance is never
    // proven there, so it must not claim confirmed_stopped.
    assert.equal(report?.state, "stop_requested");
  });

  it("a subagent with no in-flight child reports unconfirmed, not a stop", async () => {
    const reg = createTurnWorkRegistry({ cancelSubagent: () => false });
    reg.registerSubagent("task-a");
    const [report] = await reg.cancelOwned();
    assert.equal(report?.state, "unconfirmed");
    assert.match(report?.reason ?? "", /no in-flight child/);
  });

  it("absent or throwing cancel routes report unconfirmed with the reason", async () => {
    const noRoute = createTurnWorkRegistry({});
    noRoute.registerSubagent("task-a");
    const [first] = await noRoute.cancelOwned();
    assert.equal(first?.state, "unconfirmed");
    assert.match(first?.reason ?? "", /no_subagent_cancel_route/);

    const throwing = createTurnWorkRegistry({
      cancelSubagent: () => {
        throw new Error("manager exploded");
      },
      cancelBackgroundTask: async () => {
        throw new Error("registry exploded");
      },
    });
    throwing.registerBackgroundTask("bg-1");
    const [second] = await throwing.cancelOwned();
    assert.equal(second?.state, "unconfirmed");
    assert.match(second?.reason ?? "", /registry exploded/);
  });

  it("a background job carries the plane's bounded cleanup evidence verbatim", async () => {
    const reg = createTurnWorkRegistry({
      cancelBackgroundTask: async (id) =>
        id === "bg-1"
          ? { state: "confirmed_stopped", pgid: 4242, task_id: "bg-1" }
          : {
              state: "unconfirmed",
              reason: "observation_expired",
              pgid: 7,
              detail: "group still alive",
              task_id: id,
            },
    });
    reg.registerBackgroundTask("bg-1");
    reg.registerBackgroundTask("bg-2");
    const report = await reg.cancelOwned();
    assert.equal(report[0]?.state, "confirmed_stopped");
    assert.deepEqual(report[0]?.cleanup, {
      state: "confirmed_stopped",
      pgid: 4242,
      task_id: "bg-1",
    });
    assert.equal(report[1]?.state, "unconfirmed");
    assert.equal(
      (report[1]?.cleanup as { reason?: string } | undefined)?.reason,
      "observation_expired"
    );
  });

  it("a background route that never observed a teardown reports stop_requested", async () => {
    const reg = createTurnWorkRegistry({
      cancelBackgroundTask: async () => ({ state: "not_started" }),
    });
    reg.registerBackgroundTask("bg-1");
    const [report] = await reg.cancelOwned();
    assert.equal(report?.state, "stop_requested");
    assert.deepEqual(report?.cleanup, { state: "not_started" });
  });

  it("cancelOwned is idempotent: a second call reports nothing left to cancel", async () => {
    const cancelled: string[] = [];
    const reg = createTurnWorkRegistry({
      cancelSubagent: (id) => {
        cancelled.push(id);
        return true;
      },
    });
    reg.registerSubagent("task-a");
    assert.equal((await reg.cancelOwned()).length, 1);
    assert.equal((await reg.cancelOwned()).length, 0);
    assert.deepEqual(cancelled, ["task-a"]);
  });
});

describe("extractOwnedTaskId", () => {
  it("reads task_id from a JSON object payload and from executor content blocks", () => {
    assert.equal(extractOwnedTaskId({ task_id: "bg-1" }), "bg-1");
    assert.equal(
      extractOwnedTaskId([
        { type: "text", text: JSON.stringify({ task_id: "task-a" }) },
      ]),
      "task-a"
    );
  });

  it("returns undefined for payloads with no task identity", () => {
    assert.equal(extractOwnedTaskId({ code: 0, stdout: "" }), undefined);
    assert.equal(extractOwnedTaskId("plain text"), undefined);
    assert.equal(extractOwnedTaskId([{ type: "text", text: "not json" }]), undefined);
    assert.equal(extractOwnedTaskId(undefined), undefined);
  });
});
