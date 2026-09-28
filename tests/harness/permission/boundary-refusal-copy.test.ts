/**
 * SC2 (specs/effect-boundary-protection.md) — a clean scan is never
 * surfaced as effect-level safety. Enumerates the deny / ask / allow reason
 * strings reachable from a MATCHED command and an UNMATCHED (interpreter
 * os.remove) command across the audited surfaces — `hardWalls()` copy,
 * `securityReviewOutcome` (through `checkPermission`), the permission
 * executor's composed deny/user-denied copy (prefix table + outcome
 * reason — the executor adds no own sentence beyond the prefixes), and the
 * bash tool's result copy — and asserts the vocabulary constraint: no
 * "safe" / "clean" / "passed" phrasing anywhere. Every judgment sentence
 * stays scoped to the command's syntax (the matched pattern, the parse
 * verdict, the mode, the review requirement — never the effect).
 *
 * Companion pin: a boundary refusal is never labelled a hard-wall deny —
 * tests/harness/isolation/protected-target-erofs-guidance.test.ts
 * (categorizer path).
 */
import { describe, expect, it } from "vitest";

import {
  checkPermission,
  createPermissionPolicy,
  type CheckPermissionInput,
} from "../../../src/harness/permission/policy.js";
import {
  asModeContext,
  type PermissionMode,
} from "../../../src/harness/permission/modes.js";
import {
  findDangerousPattern,
  hardWalls,
} from "../../../src/harness/permission/hard-walls.js";
import { VIOLATION_PREFIXES } from "../../../src/harness/permission/prefixes.js";
import { protectedTargetErofsGuidance } from "../../../src/harness/sandbox/protected-target-feedback.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";

const MATCHED = "rm -rf /";
/** The incident's interpreter spelling (spec "Basis"): the static scan does
 *  not see `os.remove` as destructive — exactly the command whose clean scan
 *  must never be worded as effect-level safety. */
const UNMATCHED =
  "python3 -c \"import os; os.remove('/tmp/iknow-probe-backup')\"";
const REVIEW_ASK = "awk 'BEGIN {system(\"rm -rf /tmp/x\")}' /dev/null";

function makeTool(name: string, category: "execute" | "read-only"): AciToolDef {
  return Object.freeze({
    name,
    description: `copy-audit probe ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

const bashTool = makeTool("bash", "execute");
const readTool = makeTool("read_file", "read-only");

const policy = createPermissionPolicy();

function outcomeOf(
  command: string,
  mode?: PermissionMode,
  def: AciToolDef = bashTool
): { decision: string; reason: string } {
  const opts: CheckPermissionInput = {
    def,
    input: { command },
    sources: policy.sources,
    hardWalls: policy.hardWalls,
    defaultByCategory: policy.defaultByCategory,
    ...(mode !== undefined ? { mode: asModeContext(mode) } : {}),
  };
  const out = checkPermission(opts);
  return { decision: out.decision, reason: out.reason };
}

/** The hard-wall deny rendered the way policy.checkPermission renders it. */
function hardWallDenyOf(ctx: { tool: string; input: unknown }): string {
  for (const wall of hardWalls()) {
    if (wall.match(ctx)) {
      return `${VIOLATION_PREFIXES.hardWall} ${wall.reasonFor?.(ctx) ?? wall.reason}`;
    }
  }
  return "";
}

/** The whole reachable copy set the constraint runs over, built once. */
function reachableCopy(): ReadonlyArray<string> {
  const out: string[] = [
    outcomeOf(MATCHED).reason,
    outcomeOf(UNMATCHED).reason,
    outcomeOf(UNMATCHED, "full_auto").reason,
    outcomeOf(MATCHED, "full_auto").reason,
    outcomeOf('echo "$(rm -rf /').reason,
    outcomeOf(REVIEW_ASK).reason,
    hardWallDenyOf({ tool: "bash", input: { command: MATCHED } }),
    hardWallDenyOf({
      tool: "read_file",
      input: { path: "/home/u/.ssh/id_rsa" },
    }),
    ...hardWalls().map((w) => w.reason),
    // executor outbound literals: prefix + outcome reason (the two denials
    // the executor adds itself are the user-decline line and the hook
    // lines — composed from the same prefix table, no own safety sentence)
    ...Object.values(VIOLATION_PREFIXES).map((p) => `${p} <reason>`),
    "[user_denied] user declined tool call: bash",
    // bash tool visible copy (handler refusal + ok-envelope static text)
    `bash: command targets a sensitive path: ${MATCHED}`,
    "Write into the project at taskRoot. Write scratch files that need not enter the repo into the session tmp dir ($TMPDIR — same lifetime as the current identity, not a delivery destination).",
    // the NEW boundary-refusal template's own copy
    protectedTargetErofsGuidance(
      "rm: cannot remove '/home/u/.ssh/id_ed25519': Read-only file system",
      "ssh_key_material"
    ) ?? "",
  ];
  return out;
}

describe("SC2 copy audit — a matched command's deny", () => {
  it("is emitted by the hard wall and names the matched PATTERN (a syntax statement)", () => {
    const out = outcomeOf(MATCHED);
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe(
      '[hard_wall] dangerous command pattern matched (id=destructive-rm, pattern="rm -rf")'
    );
  });

  it("interpreter spellings the wall DOES match (embedded destructive text) keep the same syntax-scoped reason", () => {
    // These rows answer SC2's "extend the deny table, never bypass it": the
    // wall denies them for the STRING it sees, and the wording says exactly
    // that — it never claims to have judged the effect.
    for (const command of [
      'sh -c "rm -rf /tmp/x"',
      `python3 -c "import os; os.system('rm -rf /tmp/x')"`,
    ]) {
      const out = outcomeOf(command);
      expect(out.decision, command).toBe("deny");
      expect(out.reason, command).toBe(
        '[hard_wall] dangerous command pattern matched (id=destructive-rm, pattern="rm -rf")'
      );
    }
  });
});

describe("SC2 copy audit — an unmatched command", () => {
  it("the incident's interpreter spelling is NOT denied by the wall, and its reachable reason claims no safety either", () => {
    expect(findDangerousPattern(UNMATCHED)).toBeNull();
    const out = outcomeOf(UNMATCHED);
    // the flow answers with the approval question (category default), never
    // with a "scan found this fine" verdict
    expect(out.decision).toBe("ask");
    expect(out.reason).not.toContain(VIOLATION_PREFIXES.hardWall);
  });

  it("the security-review ask is worded as a requirement, not a pass", () => {
    const out = outcomeOf(REVIEW_ASK);
    expect(out.decision).toBe("ask");
    expect(out.reason).toContain("security review required");
  });

  it("a full_auto allow attributes to the mode, not to a passed scan", () => {
    const out = outcomeOf(UNMATCHED, "full_auto");
    expect(out.decision).toBe("allow");
    expect(out.reason).toContain("mode: full_auto");
  });

  it("the sensitive-path deny names the roster match (path spelling), never an effect verdict", () => {
    const deny = hardWallDenyOf({
      tool: "read_file",
      input: { path: "/home/u/.ssh/id_rsa" },
    });
    expect(deny).toContain("matches a sensitive");
  });

  it("the unparseable deny quotes the PARSE verdict — a syntax fact", () => {
    const out = outcomeOf('echo "$(rm -rf /');
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("id=unparseable");
  });
});

describe("SC2 copy audit — vocabulary constraint over the whole reachable set", () => {
  const set = reachableCopy();

  it("the enumeration is complete enough to be evidence (hardWalls + outcomes + template copy)", () => {
    expect(set.length).toBeGreaterThanOrEqual(18);
    for (const text of set) {
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("no reachable string says safe / safely / clean / cleanly / passed / harmless / benign", () => {
    for (const text of set) {
      expect(
        text,
        `effect-safety vocabulary in reachable copy: ${text}`
      ).not.toMatch(/\b(safe|safely|clean|cleanly|passed|harmless|benign)\b/i);
    }
  });

  it("read-only probe: a read_file command-shaped input never reaches a hard_wall dangerous deny", () => {
    // the review layer reads command text; a clean read_file call answers
    // through the category default, and its copy carries no safety claim
    const out = outcomeOf("cat notes.txt", undefined, readTool);
    expect(out.reason).not.toMatch(
      /\b(safe|safely|clean|cleanly|passed|harmless|benign)\b/i
    );
  });
});
