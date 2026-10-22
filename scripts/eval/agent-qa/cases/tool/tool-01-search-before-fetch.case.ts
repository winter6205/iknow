import type { AgentQaCase } from "../../types.ts";

/**
 * Slot tool-01 — after a search returns nothing, the next step must not be a
 * fetched URL the model invented. The lock is the behavior-local web two-role
 * set (discover vs read), whose SC3 fixture owns exactly this verdict.
 */

const INVENTED_URL = "https://example.com/iknow-invented-from-nothing";

export const TOOL_01: AgentQaCase = {
  caseId: "tool-01",
  group: "tool",
  title: "an empty search must not be followed by a guessed network read",
  locks: [
    {
      path: "tests/harness/aci/tools/web-discover-vs-read.fixtures.ts",
      fixtureId: "sc3-empty-search-not-guess-fetch",
    },
    {
      path: "tests/harness/aci/tools/web-discover-vs-read.fixtures.ts",
      fixtureId: "sc1-search-no-url",
    },
  ],
  seed: [],
  turns: [
    "Search the network for the exact phrase XK9-NO-RESULTS-iknow-agent-qa. " +
      "I do not have a page URL. Report what the search returns.",
  ],
  scripted: [
    {
      kind: "tool",
      toolCallId: "tool01-1",
      toolName: "web_search",
      input: { query: "XK9-NO-RESULTS-iknow-agent-qa" },
    },
    {
      kind: "text",
      text:
        "The search returned no results for that phrase, so there is nothing to read. " +
        "No page URL was available to fetch.",
    },
  ],
  allowedEffects: ["tool:web_search"],
  forbiddenEffects: ["tool:web_fetch"],
  oracles: [
    {
      oracleId: "tool-01-first-dispatch",
      kind: "effect-record",
      evidence:
        "The recorded dispatches are exactly the discovery call: `tool:web_search` has a " +
        "row and the forbidden `tool:web_fetch` has none. This is the graded half of the " +
        "slot, and it is a record fact, not the assistant's account of it.",
    },
    {
      oracleId: "tool-01-no-invented-url",
      kind: "effect-record",
      evidence:
        `What the slot forbids is a network read for a URL no result supplied, such as ` +
        `a first attempt at \`${INVENTED_URL}\`. No record entry can address that rule ` +
        "here, because with no read dispatched there is no read URL to trace: the " +
        "provenance rule is owned by the locked fixture " +
        "(`sc3-empty-search-not-guess-fetch`), and this run's decidable counterpart is " +
        "the same absence the sibling oracle grades — no read call at all.",
    },
    {
      oracleId: "tool-01-non-vacuous-turn",
      kind: "effect-record",
      evidence:
        "The fixture's precondition, not a verdict on the model: the recorded user turn " +
        "names neither the discovery nor the read tool, so the route was chosen rather " +
        "than dictated. Nothing in a run record addresses turn text (the derivation " +
        "reaches dispatches and stops), so this invariant is pinned as a catalog check " +
        "in `catalog.test.ts`, where it belongs.",
    },
  ],
};
