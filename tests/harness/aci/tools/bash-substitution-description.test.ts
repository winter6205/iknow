/**
 * STATIC lock on the model-facing `bash` description's substitution paragraph.
 *
 * ADR-0125 makes this text the documented channel surface for the substitution
 * walls, so a deleted sentence here silently removes the only guidance the model
 * gets about shapes the permission layer refuses. Each case pins one contract
 * statement by substring: the three sanctioned channels (`<<<SECRET_N>>>`
 * placeholder, redirect-to-file, fixed-filename) and the walls they route
 * around.
 *
 * The guidance cases pin the "use X when…" form; the imperative blocklist stays
 * owned by d9-description-guard.test.ts, which this file does not duplicate.
 *
 * Isolation: the description is assembled at factory time and createBashTool
 * probes the host for bubblewrap there (bash.ts), so the probe is mocked to a
 * no-op and stays deterministic on a host without bwrap — the same pattern the
 * guard documents. The handler is never invoked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/harness/sandbox/runner.js")
    >();
  return { ...actual, requireBwrap: () => {} };
});

import { createBashTool } from "../../../../src/harness/aci/tools/bash.js";
import { FENCE_WRITE_GUIDANCE } from "../../../../src/harness/aci/tools/helpers.js";

const desc = createBashTool("/tmp/root").description;

/** One contract statement per row; the label is what a red run names. */
const REQUIRED_SUBSTRINGS: ReadonlyArray<readonly [string, string]> = [
  ["secret placeholder channel", "<<<SECRET_N>>>"],
  ["redirect-to-file idiom", "redirect-to-file"],
  ["fixed-filename idiom", "fixed-filename"],
  ["substitution walls", "Substitution walls"],
  ["command-substitution shape", "$(...)"],
  ["command-substitution wall", "command substitution"],
  ["backtick form", "backtick"],
  ["nesting cap", "third nesting level"],
  ["parameter-expansion buckets", "three buckets"],
  ["secret name bucket", "secret-shaped name"],
  ["process-substitution shape", "<(...)"],
  ["process-substitution wall", "process substitution"],
  ["combo wall receiver", "interpreter receiver"],
  ["heredoc body judged as code", "judged as code"],
  ["inert quoted text", "quoted text is data"],
];

describe("bash description — substitution walls and sanctioned channels (STATIC)", () => {
  it.each(REQUIRED_SUBSTRINGS)("carries the %s", (_label, needle) => {
    expect(desc).toContain(needle);
  });

  // The channels are guidance, in the "use X when…" form: each of the three
  // appears with its own trigger verb, so a rewrite into a refusal list goes red.
  // Case-insensitive by regex, because the placeholder keeps its literal case.
  it.each([
    ["placeholder", /use the `<<<SECRET_N>>>` placeholder when/i],
    ["redirect-to-file", /use the redirect-to-file idiom when/i],
    ["fixed-filename", /use the fixed-filename idiom when/i],
  ])("the %s channel is phrased as positive guidance", (_label, phrase) => {
    expect(desc).toMatch(phrase);
  });

  // Concrete spellings of the two file idioms — the label alone would let a
  // rewrite drop the example the model copies from.
  it("keeps the file idioms' command spelling", () => {
    expect(desc).toContain("> $TMPDIR/out.txt");
    expect(desc).toContain("grep -f $TMPDIR/patterns.txt");
  });

  // The lock reads the assembled, model-visible string, so a description that
  // drops the shared fence/write paragraph is a red run too.
  it("keeps the fence write guidance it is assembled with", () => {
    expect(desc).toContain(FENCE_WRITE_GUIDANCE);
  });
});
