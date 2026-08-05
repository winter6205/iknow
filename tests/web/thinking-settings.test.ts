/**
 * thinking-settings.ts pure-helper tests (T5).
 *
 * Mirrors tests/web/SessionSidebar.test.ts style: vitest describe/it +
 * node:assert/strict, root vitest (node env). The web package has no test
 * framework (spec A8/A10 forbid adding one).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  DEFAULT_THINKING_SETTINGS,
  EFFORT_LABELS,
  EFFORT_OPTIONS,
  parseThinkingSettings,
  serializeThinkingSettings,
  THINKING_STORAGE_KEY,
  toWireOverride,
  type ThinkingEffort,
  type ThinkingSettings,
} from "../../web/src/lib/thinking-settings.ts";

describe("parseThinkingSettings", () => {
  it("returns defaults for null input", () => {
    assert.deepEqual(parseThinkingSettings(null), DEFAULT_THINKING_SETTINGS);
  });

  it("returns defaults for empty string", () => {
    assert.deepEqual(parseThinkingSettings(""), DEFAULT_THINKING_SETTINGS);
  });

  it("returns defaults when JSON is malformed", () => {
    assert.deepEqual(
      parseThinkingSettings("{not json"),
      DEFAULT_THINKING_SETTINGS
    );
    assert.deepEqual(
      parseThinkingSettings("undefined"),
      DEFAULT_THINKING_SETTINGS
    );
  });

  it("returns defaults when payload is not a plain object", () => {
    assert.deepEqual(parseThinkingSettings("42"), DEFAULT_THINKING_SETTINGS);
    assert.deepEqual(
      parseThinkingSettings('"hello"'),
      DEFAULT_THINKING_SETTINGS
    );
    assert.deepEqual(parseThinkingSettings("true"), DEFAULT_THINKING_SETTINGS);
    assert.deepEqual(
      parseThinkingSettings("[1,2,3]"),
      DEFAULT_THINKING_SETTINGS
    );
    assert.deepEqual(parseThinkingSettings("null"), DEFAULT_THINKING_SETTINGS);
  });

  it("accepts disabled + empty effort", () => {
    assert.deepEqual(parseThinkingSettings('{"enabled":false,"effort":""}'), {
      enabled: false,
      effort: "",
    });
  });

  it("accepts every effort tier verbatim", () => {
    for (const effort of EFFORT_OPTIONS) {
      const out = parseThinkingSettings(
        JSON.stringify({ enabled: true, effort })
      );
      assert.equal(out.enabled, true);
      assert.equal(out.effort, effort);
    }
  });

  it("falls back to default effort when value is unknown", () => {
    const out = parseThinkingSettings('{"enabled":true,"effort":"gigantic"}');
    assert.deepEqual(out, { enabled: true, effort: "" });
  });

  it("falls back to default effort when value is the wrong type", () => {
    const out = parseThinkingSettings('{"enabled":true,"effort":3}');
    assert.deepEqual(out, { enabled: true, effort: "" });
  });

  it("falls back to default enabled when value is non-boolean", () => {
    const out = parseThinkingSettings('{"enabled":"yes","effort":"high"}');
    assert.deepEqual(out, { enabled: false, effort: "high" });
  });

  it("ignores unknown extra fields", () => {
    const out = parseThinkingSettings(
      '{"enabled":true,"effort":"max","model":"opus","garbage":null}'
    );
    assert.deepEqual(out, { enabled: true, effort: "max" });
  });

  it("uses defaults when fields are missing entirely", () => {
    const out = parseThinkingSettings("{}");
    assert.deepEqual(out, DEFAULT_THINKING_SETTINGS);
  });
});

describe("serializeThinkingSettings", () => {
  it("round-trips with parseThinkingSettings", () => {
    for (const effort of EFFORT_OPTIONS) {
      const settings: ThinkingSettings = { enabled: true, effort };
      assert.deepEqual(
        parseThinkingSettings(serializeThinkingSettings(settings)),
        settings
      );
    }
    assert.deepEqual(
      parseThinkingSettings(
        serializeThinkingSettings(DEFAULT_THINKING_SETTINGS)
      ),
      DEFAULT_THINKING_SETTINGS
    );
  });

  it("emits exactly enabled + effort fields", () => {
    const raw = serializeThinkingSettings({ enabled: true, effort: "high" });
    assert.deepEqual(JSON.parse(raw), { enabled: true, effort: "high" });
  });
});

describe("toWireOverride", () => {
  it("emits mode='off' when disabled", () => {
    assert.deepEqual(toWireOverride({ enabled: false, effort: "high" }), {
      mode: "off",
    });
  });

  it("emits mode='adaptive' + effort when enabled (non-empty effort)", () => {
    assert.deepEqual(toWireOverride({ enabled: true, effort: "medium" }), {
      mode: "adaptive",
      effort: "medium",
    });
  });

  it("emits mode='adaptive' + effort='' when enabled with auto", () => {
    // Wire contract permits effort ""; explicit empty beats omission for testability.
    assert.deepEqual(toWireOverride({ enabled: true, effort: "" }), {
      mode: "adaptive",
      effort: "",
    });
  });

  it("emits every effort tier when enabled", () => {
    const expected: Record<
      ThinkingEffort,
      { mode: "adaptive"; effort: ThinkingEffort }
    > = {
      "": { mode: "adaptive", effort: "" },
      low: { mode: "adaptive", effort: "low" },
      medium: { mode: "adaptive", effort: "medium" },
      high: { mode: "adaptive", effort: "high" },
      xhigh: { mode: "adaptive", effort: "xhigh" },
      max: { mode: "adaptive", effort: "max" },
    };
    for (const effort of EFFORT_OPTIONS) {
      assert.deepEqual(
        toWireOverride({ enabled: true, effort }),
        expected[effort]
      );
    }
  });
});

describe("EFFORT_LABELS", () => {
  it("defines a label for every effort tier", () => {
    assert.deepEqual(EFFORT_LABELS, {
      "": "auto",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });
});

describe("EFFORT_OPTIONS", () => {
  it("starts with the auto tier then ascending effort", () => {
    assert.deepEqual(
      [...EFFORT_OPTIONS],
      ["", "low", "medium", "high", "xhigh", "max"]
    );
  });
});

describe("THINKING_STORAGE_KEY", () => {
  it("is the iknow:thinking namespaced localStorage key", () => {
    assert.equal(THINKING_STORAGE_KEY, "iknow:thinking");
  });
});
