/**
 * Offline invariant half of the subagent-output-handoff golden set.
 * Deterministic, no key needed. This file does not re-exercise the fold or
 * paging mechanics — tests/subagent/pad-final-text.test.ts and
 * tests/subagent/subagent-result.test.ts own those. Its job is the shared
 * witness: the incident-4 / paged scenario shape both halves bind to, and
 * the retrieval contract the fixture encodes against the ALREADY-committed
 * production behavior (folded `truncated:true` receipts, the pad-relative
 * `final.md` path, the paged reader, and the arm-B wording the A/B seam
 * derives arm-A from).
 */
import { describe, expect, it } from "vitest";

import {
  FINAL_TEXT_PAD_NAME,
  projectParentVisibleEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import { IKNOW_COORDINATOR_TEXT } from "../../src/harness/identity/assemble.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import { createSubAgentResultTool } from "../../src/harness/subagent/subagent-result-tool.ts";
import {
  ARM_A_COORDINATOR_PARENTHETICAL,
  ARM_A_SPAWN_TAIL,
  ARM_A_WAIT_SENTENCE,
  ARM_B_COORDINATOR_PARENTHETICAL,
  ARM_B_SPAWN_TAIL,
  ARM_B_WAIT_SENTENCE,
  EXPECTED_TMP_PATH,
  INCIDENT_REPORTS,
  INCIDENT_REPORT_UNITS,
  INCIDENT_WITNESSES,
  PAGED_REPORT,
  SCENE_PNG_BASE64,
  armSwap,
  validateIncident4Shape,
  validatePagedShape,
} from "./subagent-output-handoff.fixtures.ts";

/** The description getters only read capacity; no lifecycle is exercised. */
function managerForDescription(): SubAgentManager {
  return { getCapacity: () => 3 } as unknown as SubAgentManager;
}

function spawnTool() {
  return createSpawnSubAgentTool({ manager: managerForDescription() });
}

function waitFieldDescription(tool: ReturnType<typeof spawnTool>): string {
  const props = tool.inputSchema.properties as Record<
    string,
    { description?: string }
  >;
  return props.wait?.description ?? "";
}

describe("subagent-output-handoff golden fixture — offline invariants", () => {
  it("incident-4 shape holds: 4 reports, distinct tail witnesses, sizes in range", () => {
    expect(validateIncident4Shape()).toEqual([]);
    expect(INCIDENT_REPORTS).toHaveLength(4);
    expect(INCIDENT_WITNESSES).toHaveLength(4);
  });

  it("each incident report is exactly the incident size class", () => {
    for (const r of INCIDENT_REPORTS) {
      expect(r.body.length).toBe(INCIDENT_REPORT_UNITS);
    }
  });

  it("the committed projection folds each report into a truncated short handoff that cannot carry the witness", () => {
    for (const r of INCIDENT_REPORTS) {
      // The worker turns its final text into both summary and result, so the
      // projection input mirrors that shape for the fixture body.
      const projected = projectParentVisibleEnvelope({
        status: "ok",
        summary: r.body,
        result: r.body,
      });
      expect(projected.truncated).toBe(true);
      expect(projected.totalLength).toBe(INCIDENT_REPORT_UNITS);
      expect(projected.result.length).toBeLessThan(r.body.length);
      expect(projected.result).not.toContain(r.witness);
    }
  });

  it("the retrieval path the fixture encodes is the production pad name", () => {
    expect(EXPECTED_TMP_PATH).toBe(FINAL_TEXT_PAD_NAME);
  });

  it("paged-report shape holds: tail witness beyond the first window and page", () => {
    expect(validatePagedShape()).toEqual([]);
    expect(PAGED_REPORT.body).toContain(PAGED_REPORT.witness);
  });

  it("image control fixture is a decodable non-empty PNG payload", () => {
    const bytes = Buffer.from(SCENE_PNG_BASE64, "base64");
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("A/B seam premise: the live production wording is arm-B, so arm-A derives by swap", () => {
    const tool = spawnTool();
    expect(tool.description).toContain(ARM_B_SPAWN_TAIL);
    expect(tool.description).not.toContain(ARM_A_SPAWN_TAIL);
    expect(waitFieldDescription(tool)).toContain(ARM_B_WAIT_SENTENCE);
    expect(waitFieldDescription(tool)).not.toContain(ARM_A_WAIT_SENTENCE);
    expect(IKNOW_COORDINATOR_TEXT).toContain(ARM_B_COORDINATOR_PARENTHETICAL);
    expect(IKNOW_COORDINATOR_TEXT).not.toContain(
      ARM_A_COORDINATOR_PARENTHETICAL
    );
    // Deriving arm-A must actually change the text (the swap is the seam).
    expect(
      armSwap(tool.description, ARM_B_SPAWN_TAIL, ARM_A_SPAWN_TAIL, "x")
    ).not.toBe(tool.description);
  });

  it("the committed result-tool description carries the retrieval contract the fixture encodes", () => {
    const resultTool = createSubAgentResultTool({
      manager: managerForDescription(),
    });
    expect(resultTool.description).toContain("tmp_path");
    expect(resultTool.description).toContain("next_offset");
    const props = resultTool.inputSchema.properties as Record<
      string,
      { type?: string }
    >;
    expect(props.task_id?.type).toBe("string");
    expect(props.tmp_path?.type).toBe("string");
    expect(props.offset?.type).toBe("integer");
  });

  it("arm-B segment swap is reversible back to the committed text", () => {
    const tool = spawnTool();
    const armA = armSwap(
      tool.description,
      ARM_B_SPAWN_TAIL,
      ARM_A_SPAWN_TAIL,
      "spawn tail"
    );
    expect(
      armSwap(armA, ARM_A_SPAWN_TAIL, ARM_B_SPAWN_TAIL, "spawn tail")
    ).toBe(tool.description);
  });
});
