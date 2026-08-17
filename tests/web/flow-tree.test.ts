/**
 * flowTree pure-helper tests (FlowTree projection, web side).
 *
 * Exercises the JSONL-record → TraceEvent projection (lib/flowTree.ts) that
 * drives the FlowTree layout. The web package has no test framework; pure
 * helpers live under web/src and are exercised here under root vitest (node
 * env), same as trace-fields.test.ts.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  recordsToEvents,
  fmtDur,
  statusTone,
  isErr,
  STATIONS,
  type TraceEvent,
} from "../../web/src/lib/flowTree.ts";

const iso = (h: number, m: number, s: number) =>
  `2026-08-01T03:0${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;

describe("recordsToEvents", () => {
  it("projects a chronological timeline and assigns turns from turn rows", () => {
    const events = recordsToEvents([
      {
        conversation_id: "c1",
        record_type: "llm_call",
        llm_call_id: "l1",
        started_at: iso(0, 1, 1),
        ended_at: iso(0, 1, 5),
        duration_ms: 4000,
        status: "ok",
      },
      {
        conversation_id: "c1",
        record_type: "turn",
        turn_id: "t1",
        turn_index: 0,
        llm_call_ids: ["l1"],
        started_at: iso(0, 1, 0),
        ended_at: iso(0, 1, 6),
        duration_ms: 6000,
        decision: "completed",
        status: "ok",
      },
      {
        conversation_id: "c1",
        record_type: "tool_call",
        tool_call_id: "x1",
        tool_name: "list_files",
        tool_kind: "ok",
        parent_llm_call_id: "l1",
        started_at: iso(0, 2, 1),
        ended_at: iso(0, 2, 3),
        duration_ms: 2000,
        status: "ok",
      },
    ]);
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => e.idx),
      [0, 1, 2]
    );
    // Chronological: the turn row (started_at earliest) sorts first → session
    // station; llm/tool rows follow, resolved into turn 0 via llm_call_ids.
    assert.equal(events[0].station, "session");
    assert.equal(events[0].label, "回合 1");
    assert.equal(events[1].station, "llm");
    assert.equal(events[1].turn, 0);
    assert.equal(events[2].station, "tool");
    assert.equal(events[2].turn, 0);
  });

  it("resolves turns from llm_call_ids / parent_llm_call_id across two turns", () => {
    const events = recordsToEvents([
      {
        record_type: "llm_call",
        llm_call_id: "l1",
        started_at: iso(0, 1, 1),
        status: "ok",
      },
      {
        record_type: "turn",
        turn_index: 0,
        llm_call_ids: ["l1"],
        started_at: iso(0, 1, 0),
        status: "ok",
      },
      {
        record_type: "llm_call",
        llm_call_id: "l2",
        started_at: iso(0, 2, 1),
        status: "ok",
      },
      {
        record_type: "turn",
        turn_index: 1,
        llm_call_ids: ["l2"],
        started_at: iso(0, 2, 0),
        status: "ok",
      },
      {
        record_type: "tool_call",
        tool_call_id: "x2",
        parent_llm_call_id: "l2",
        started_at: iso(0, 2, 2),
        status: "ok",
      },
    ]);
    const byId = new Map(events.map((e) => [e.label, e]));
    assert.equal(events.filter((e) => e.turn === 0).length, 2);
    assert.equal(events.filter((e) => e.turn === 1).length, 3);
    // tool_call resolves to turn 1 via its parent llm_call
    const tool = events.find((e) => e.station === "tool")!;
    assert.equal(tool.turn, 1);
  });

  it("sorts descending wire rows into chronological order", () => {
    const events = recordsToEvents([
      {
        conversation_id: "c1",
        record_type: "llm_call",
        started_at: iso(0, 2, 0),
        status: "ok",
        duration_ms: 100,
      },
      {
        conversation_id: "c1",
        record_type: "llm_call",
        started_at: iso(0, 1, 0),
        status: "ok",
        duration_ms: 200,
      },
    ]);
    assert.equal(events[0].durationMs, 200);
    assert.equal(events[1].durationMs, 100);
  });

  it("maps record_type to the correct station", () => {
    const events = recordsToEvents([
      { record_type: "session", started_at: iso(0, 1, 0), status: "ok" },
      { record_type: "llm_call", started_at: iso(0, 1, 1), status: "ok" },
      { record_type: "tool_call", started_at: iso(0, 1, 2), status: "ok" },
      { record_type: "sandbox_cmd", started_at: iso(0, 1, 3), status: "ok" },
      { record_type: "violation", started_at: iso(0, 1, 4), status: "error" },
    ]);
    assert.deepEqual(
      events.map((e) => e.station),
      ["session", "llm", "tool", "sandbox", "violation"]
    );
  });

  it("maps the three subagent record types to the subagent station", () => {
    const events = recordsToEvents([
      {
        record_type: "subagent_spawn",
        started_at: iso(0, 1, 0),
        status: "ok",
      },
      {
        record_type: "subagent_stop",
        started_at: iso(0, 1, 1),
        status: "ok",
        final_state: "completed",
      },
      {
        record_type: "subagent_state_change",
        started_at: iso(0, 1, 2),
        status: "ok",
        to_state: "running",
      },
    ]);
    assert.deepEqual(
      events.map((e) => e.station),
      ["subagent", "subagent", "subagent"]
    );
  });

  it("derives subagent status from final_state / to_state", () => {
    const completed = recordsToEvents([
      {
        record_type: "subagent_stop",
        started_at: iso(0, 1, 0),
        status: "ok",
        final_state: "completed",
      },
    ])[0];
    assert.equal(completed.status, "ok");

    const failedStop = recordsToEvents([
      {
        record_type: "subagent_stop",
        started_at: iso(0, 1, 0),
        status: "ok",
        final_state: "failed",
        reason: "timeout",
      },
    ])[0];
    assert.equal(failedStop.status, "error");

    const failedChange = recordsToEvents([
      {
        record_type: "subagent_state_change",
        started_at: iso(0, 1, 0),
        status: "ok",
        to_state: "failed",
      },
    ])[0];
    assert.equal(failedChange.status, "error");

    const runningChange = recordsToEvents([
      {
        record_type: "subagent_state_change",
        started_at: iso(0, 1, 0),
        status: "ok",
        to_state: "running",
      },
    ])[0];
    assert.equal(runningChange.status, "ok");
  });

  it("honours wire status=error on subagent rows", () => {
    const events = recordsToEvents([
      {
        record_type: "subagent_spawn",
        started_at: iso(0, 1, 0),
        status: "error",
      },
    ]);
    assert.equal(events[0].status, "error");
  });

  it("labels subagent records with lifecycle text", () => {
    const events = recordsToEvents([
      {
        record_type: "subagent_spawn",
        started_at: iso(0, 1, 0),
        status: "ok",
      },
      {
        record_type: "subagent_spawn",
        started_at: iso(0, 1, 1),
        status: "ok",
        task_preview: "修复 flaky test",
      },
      {
        record_type: "subagent_stop",
        started_at: iso(0, 1, 2),
        status: "ok",
        final_state: "completed",
      },
      {
        record_type: "subagent_stop",
        started_at: iso(0, 1, 3),
        status: "ok",
        final_state: "failed",
      },
      {
        record_type: "subagent_state_change",
        started_at: iso(0, 1, 4),
        status: "ok",
        from_state: "starting",
        to_state: "running",
      },
    ]);
    assert.deepEqual(
      events.map((e) => e.label),
      [
        "子代理 spawn",
        "修复 flaky test",
        "子代理 stop · completed",
        "子代理 stop · failed",
        "子代理状态 starting→running",
      ]
    );
  });

  it("strips subagent structural keys from the detail fields", () => {
    const events = recordsToEvents([
      {
        record_type: "subagent_stop",
        subagent_id: "s1",
        task_id: "t1",
        parent_turn_id: "p1",
        origin: "parent",
        final_state: "failed",
        started_at: iso(0, 1, 0),
        status: "ok",
        reason: "timeout",
        summary: "reproduced in 2 steps",
      },
      {
        record_type: "subagent_state_change",
        subagent_id: "s1",
        task_id: "t1",
        origin: "parent",
        from_state: "running",
        to_state: "failed",
        started_at: iso(0, 1, 1),
        status: "ok",
      },
    ]);
    const stopFields = events[0].fields;
    assert.equal(stopFields["subagent_id"], undefined);
    assert.equal(stopFields["task_id"], undefined);
    assert.equal(stopFields["parent_turn_id"], undefined);
    assert.equal(stopFields["origin"], undefined);
    assert.equal(stopFields["final_state"], undefined);
    // payload detail is preserved, not deduplicated away
    assert.equal(stopFields["reason"], "timeout");
    assert.equal(stopFields["summary"], "reproduced in 2 steps");
    const changeFields = events[1].fields;
    assert.equal(changeFields["from_state"], undefined);
    assert.equal(changeFields["to_state"], undefined);
    assert.equal(changeFields["record_type"], undefined);
  });

  it("places subagent events chronologically alongside other stations", () => {
    const events = recordsToEvents([
      {
        record_type: "llm_call",
        llm_call_id: "l1",
        started_at: iso(0, 1, 1),
        status: "ok",
      },
      {
        record_type: "subagent_spawn",
        subagent_id: "s1",
        started_at: iso(0, 1, 2),
        status: "ok",
        task_preview: "多回合排查",
      },
      {
        record_type: "subagent_state_change",
        subagent_id: "s1",
        started_at: iso(0, 1, 3),
        status: "ok",
        to_state: "running",
      },
      {
        record_type: "subagent_stop",
        subagent_id: "s1",
        started_at: iso(0, 1, 4),
        status: "ok",
        final_state: "completed",
      },
      {
        record_type: "tool_call",
        parent_llm_call_id: "l1",
        tool_name: "grep",
        started_at: iso(0, 1, 5),
        status: "ok",
      },
    ]);
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => e.idx),
      [0, 1, 2, 3, 4]
    );
    assert.deepEqual(
      events.map((e) => e.station),
      ["llm", "subagent", "subagent", "subagent", "tool"]
    );
    assert.equal(events[1].label, "多回合排查");
    assert.ok(events.every((e) => e.turn === 0));
  });

  it("routes a permission-denied violation to the permission station with denied status", () => {
    const events = recordsToEvents([
      {
        record_type: "violation",
        started_at: iso(0, 1, 0),
        status: "error",
        decision: "deny",
        reason: "path outside workspace",
      },
    ]);
    assert.equal(events[0].station, "permission");
    assert.equal(events[0].status, "denied");
  });

  it("routes non-permission violations to the violation station", () => {
    const events = recordsToEvents([
      {
        record_type: "violation",
        started_at: iso(0, 1, 0),
        status: "error",
        detail: "blocked",
      },
    ]);
    assert.equal(events[0].station, "violation");
    assert.equal(events[0].status, "error");
  });

  it("marks tool failures as error from tool_kind", () => {
    const events = recordsToEvents([
      {
        record_type: "tool_call",
        tool_name: "rm",
        tool_kind: "execution_failed",
        started_at: iso(0, 1, 0),
      },
    ]);
    assert.equal(events[0].status, "error");
  });

  it("derives llm label from model_actual (fallback model_requested)", () => {
    const events = recordsToEvents([
      {
        record_type: "llm_call",
        started_at: iso(0, 1, 0),
        status: "ok",
        model_actual: "claude-sonnet-4",
      },
    ]);
    assert.equal(events[0].label, "LLM · claude-sonnet-4");
  });

  it("strips structural keys from the detail fields", () => {
    const events = recordsToEvents([
      {
        record_type: "llm_call",
        llm_call_id: "l1",
        conversation_id: "c1",
        started_at: iso(0, 1, 0),
        ended_at: iso(0, 1, 1),
        duration_ms: 1000,
        status: "ok",
        stream: true,
        model_actual: "claude-sonnet-4",
      },
    ]);
    const fields = events[0].fields;
    assert.equal(fields["record_type"], undefined);
    assert.equal(fields["started_at"], undefined);
    assert.equal(fields["duration_ms"], undefined);
    assert.equal(fields["stream"], true);
    assert.equal(fields["model_actual"], "claude-sonnet-4");
  });
});

describe("fmtDur", () => {
  it("renders ms under one second, seconds above", () => {
    assert.equal(fmtDur(8), "8ms");
    assert.equal(fmtDur(3800), "3.8s");
  });
});

describe("statusTone / isErr", () => {
  it("maps statuses to ok / warn / danger tone", () => {
    assert.equal(statusTone("ok"), "ok");
    assert.equal(statusTone("warn"), "warn");
    assert.equal(statusTone("denied"), "danger");
    assert.equal(statusTone("error"), "danger");
  });

  it("treats error and denied as error", () => {
    assert.equal(isErr("error"), true);
    assert.equal(isErr("denied"), true);
    assert.equal(isErr("ok"), false);
    assert.equal(isErr("warn"), false);
  });
});

describe("STATIONS", () => {
  it("declares the 7 FlowTree stations in spec order", () => {
    assert.deepEqual(
      STATIONS.map((s) => s.id),
      [
        "session",
        "llm",
        "tool",
        "sandbox",
        "permission",
        "violation",
        "subagent",
      ]
    );
  });

  it("labels the subagent station with the UI string", () => {
    const subagentStation = STATIONS.find((s) => s.id === "subagent");
    assert.equal(subagentStation?.label, "子代理");
  });
});
