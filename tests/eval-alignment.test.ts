import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createSession } from "../src/agent-loop/session.ts";
import { IknowAgent } from "../src/agent-loop/loop.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const evalPath = join(
  root,
  "docs/iknow-spec/docs/eval/eval-set.draft.json",
);

interface EvalSample {
  id: string;
  category: string;
  input: string;
  expected: {
    required_tools: string[];
    policies: string[];
    output_properties: string[];
  };
  session_overrides?: {
    caller_role?: "employee" | "manager" | "admin";
    simulate_governance_timeout?: boolean;
  };
}

const raw = JSON.parse(readFileSync(evalPath, "utf8")) as {
  samples: EvalSample[];
  meta: { counts: { total: number; easy: number; hard: number; edge: number } };
};

describe("eval-set structural alignment", () => {
  it("has 32 samples", async () => {
    assert.equal(raw.samples.length, 32);
    assert.equal(raw.meta.counts.total, 32);
  });
});

describe("eval sample agent.answer policies", () => {
  for (const sample of raw.samples) {
    it(`${sample.id}: G2 snapshot_id + hops<=5`, async () => {
      const store = createSeededStore();
      const overrides = sample.session_overrides ?? {};
      const agent = new IknowAgent({
        store,
        session: createSession(overrides.caller_role ?? "employee", {
          simulate_governance_timeout:
            overrides.simulate_governance_timeout ?? false,
        }),
      });
      const ans = await agent.answer(sample.input);

      // every answer has snapshot_id (G2)
      assert.ok(ans.snapshot_id, `${sample.id} missing snapshot_id`);
      // hops_used <= 5
      assert.ok(
        ans.hops_used <= 5,
        `${sample.id} hops_used=${ans.hops_used}`,
      );

      // easy samples: tool_trace includes kb_retrieve
      if (sample.category === "easy") {
        assert.ok(
          ans.tool_trace.includes("kb_retrieve"),
          `${sample.id} easy sample must call kb_retrieve; trace=${ans.tool_trace.join(",")}`,
        );
        // seed rich enough: most easy queries get non-empty chunks / non-empty answer body
        assert.ok(
          ans.text.length > 0,
          `${sample.id} empty text`,
        );
        // prefer non-empty source spans when retrieve hit
        if (!ans.notes?.includes("empty_result")) {
          assert.ok(
            ans.source_spans.length > 0 || ans.tool_trace.includes("kb_retrieve"),
            `${sample.id} expected retrieval path`,
          );
        }
      }

      // hard-001: governance or conflict note
      if (sample.id === "qa-hard-001") {
        assert.ok(
          ans.governance_status === "conflict" ||
            /冲突|治理|conflict/i.test(ans.text) ||
            ans.tool_trace.includes("kb_governance"),
          `${sample.id} expected governance/conflict signal`,
        );
      }

      // edge-002: does not invent 全员持股
      if (sample.id === "qa-edge-002") {
        assert.equal(
          /全员持股计划/.test(ans.text) &&
            !/未|无法|没有|找不到|不存在|确认/.test(ans.text),
          false,
          `${sample.id} must not invent 全员持股 plan as fact`,
        );
        assert.match(
          ans.text,
          /未|无法|没有|找不到|不存在|确认/,
        );
      }

      // edge-004: refuses / permission
      if (sample.id === "qa-edge-004") {
        assert.match(
          ans.text,
          /拒绝|越权|不得|权限|非本企业|permission/i,
        );
      }
    });
  }
});
