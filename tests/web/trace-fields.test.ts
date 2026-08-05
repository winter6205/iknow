/**
 * traceFields pure-helper tests (trace inspection panel, web side).
 *
 * The web package has no test framework (same rationale as SessionSidebar.test.ts),
 * so the pure column-selection logic lives in web/src/components/traceFields.ts
 * and is exercised here under root vitest (node env).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  filterFieldsForRecordType,
  filterOptionsForField,
  formatCell,
  formatDateTime,
  rowKeyOf,
  type TraceFieldDef,
} from "../../web/src/components/traceFields.ts";
import type { TraceRecord } from "../../web/src/api/types.ts";

const FIELD_A: TraceFieldDef = {
  key: "started_at",
  jsonlKey: "started_at",
  type: "datetime",
  label: "开始时间",
  recordTypes: ["llm_call", "tool_call", "turn"],
};

const FIELD_B: TraceFieldDef = {
  key: "tool_name",
  jsonlKey: "tool_name",
  type: "string",
  label: "工具名",
  recordTypes: ["tool_call"],
};

const FIELD_C: TraceFieldDef = {
  key: "record_type",
  jsonlKey: "record_type",
  type: "enum",
  label: "类型",
  recordTypes: ["llm_call", "tool_call", "turn", "violation"],
  options: ["llm_call", "tool_call", "turn", "violation"],
};

const FIELD_STATUS: TraceFieldDef = {
  key: "status",
  jsonlKey: "status",
  type: "enum",
  label: "状态",
  recordTypes: ["llm_call", "tool_call", "turn"],
  options: ["ok", "error"],
  tone: "status",
};

const FIELDS: TraceFieldDef[] = [FIELD_C, FIELD_A, FIELD_B, FIELD_STATUS];

describe("filterFieldsForRecordType", () => {
  it("returns all fields when recordType is undefined (全部)", () => {
    const out = filterFieldsForRecordType(FIELDS, undefined);
    assert.deepEqual(
      out.map((f) => f.key),
      ["record_type", "started_at", "tool_name", "status"]
    );
  });

  it("returns only matching fields when a specific record_type is selected", () => {
    const out = filterFieldsForRecordType(FIELDS, "tool_call");
    assert.deepEqual(
      out.map((f) => f.key),
      ["record_type", "started_at", "tool_name", "status"]
    );
  });

  it("excludes fields not applicable to the selected record_type", () => {
    const out = filterFieldsForRecordType(FIELDS, "violation");
    assert.deepEqual(
      out.map((f) => f.key),
      ["record_type"]
    );
  });

  it("returns empty array for an unknown record_type", () => {
    const out = filterFieldsForRecordType(FIELDS, "unknown_type" as never);
    assert.deepEqual(out, []);
  });
});

describe("formatDateTime", () => {
  it("formats a valid ISO datetime as a readable local string", () => {
    const out = formatDateTime("2026-08-01T03:00:00.000Z");
    assert.ok(out.includes("2026"), "year present");
    assert.ok(out.includes("8") || out.includes("08"), "month present");
  });

  it("returns the raw value for invalid ISO datetime", () => {
    assert.equal(formatDateTime("not-a-date"), "not-a-date");
    assert.equal(formatDateTime("abc123"), "abc123");
  });
});

describe("rowKeyOf", () => {
  it("prefers llm_call_id, then tool_call_id, then turn_id", () => {
    assert.equal(
      rowKeyOf({ llm_call_id: "l-1", tool_call_id: "tc-1", turn_id: "t-1" }, 0),
      "l-1"
    );
    assert.equal(rowKeyOf({ tool_call_id: "tc-1", turn_id: "t-1" }, 0), "tc-1");
    assert.equal(rowKeyOf({ turn_id: "t-1" }, 0), "t-1");
  });

  it("falls back to record_type:conversation_id:index when no stable id exists", () => {
    assert.equal(
      rowKeyOf({ record_type: "violation", conversation_id: "c1" }, 3),
      "violation:c1:3"
    );
  });

  it("falls back with placeholder for rows lacking record_type / conversation_id", () => {
    assert.equal(rowKeyOf({}, 5), "::5");
  });
});

describe("filterOptionsForField", () => {
  it("returns the enum options declared on the matching field def", () => {
    assert.deepEqual(filterOptionsForField(FIELDS, "record_type"), [
      "llm_call",
      "tool_call",
      "turn",
      "violation",
    ]);
    assert.deepEqual(filterOptionsForField(FIELDS, "status"), ["ok", "error"]);
  });

  it("returns an empty list when the jsonlKey is unknown", () => {
    assert.deepEqual(filterOptionsForField(FIELDS, "ghost_key"), []);
  });

  it("returns an empty list when the matching def declares no options", () => {
    assert.deepEqual(filterOptionsForField(FIELDS, "tool_name"), []);
    assert.deepEqual(filterOptionsForField(FIELDS, "started_at"), []);
  });
});

describe("formatCell", () => {
  it("renders the neutral placeholder for missing / null / empty values", () => {
    const empty: TraceRecord = {};
    assert.deepEqual(formatCell(empty, FIELD_A), {
      text: "—",
      tone: "neutral",
    });
    assert.deepEqual(formatCell({ status: null }, FIELD_STATUS), {
      text: "—",
      tone: "neutral",
    });
    assert.deepEqual(formatCell({ tool_name: "" }, FIELD_B), {
      text: "—",
      tone: "neutral",
    });
  });

  it("applies ok/error tones via the declared tone field (no jsonlKey matching)", () => {
    assert.deepEqual(formatCell({ status: "ok" }, FIELD_STATUS), {
      text: "ok",
      tone: "ok",
    });
    assert.deepEqual(formatCell({ status: "error" }, FIELD_STATUS), {
      text: "error",
      tone: "error",
    });
  });

  it("keeps enum cells without a tone declaration neutral", () => {
    assert.deepEqual(formatCell({ record_type: "turn" }, FIELD_C), {
      text: "turn",
      tone: "neutral",
    });
  });

  it("formats datetime values as readable local strings", () => {
    const out = formatCell({ started_at: "2026-08-01T03:00:00.000Z" }, FIELD_A);
    assert.equal(out.tone, "neutral");
    assert.ok(out.text.includes("2026"), "year present");
    assert.notEqual(out.text, "2026-08-01T03:00:00.000Z", "was formatted");
  });

  it("passes plain values through as strings", () => {
    assert.deepEqual(formatCell({ tool_name: "kb_search" }, FIELD_B), {
      text: "kb_search",
      tone: "neutral",
    });
  });
});
