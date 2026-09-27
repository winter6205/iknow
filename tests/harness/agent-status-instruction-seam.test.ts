/**
 * specs/agent-status-instruction-echo.md roster-completeness lock for the
 * injection seams, plus the zero-LLM grep surface.
 *
 * 1. SEAM enumeration: read the loop-engine source and locate every
 *    `encodeUserText(` injection-seam production site; each call site must hit
 *    the registered roster (classified by argument expression + forward
 *    assignment window), so a new seam not on the roster goes red. Except for
 *    the operator's raw-text entry (effectiveUserText), every injection seam's
 *    ACTUAL produced text must be classified as injected by
 *    `isHostInjectedUserText`.
 * 2. grep assertion: the discrimination module imports no adapter surface
 *    (nothing touches an LLM) — model-adapter is allowed only as a type-only
 *    wire-type import.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAgentStatusText } from "../../src/harness/agent-status.ts";
import {
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  renderGraphModeChangeNotification,
} from "../../src/harness/graph/notification.ts";
import { SKILL_INDEX_DELTA_PREFIX } from "../../src/harness/skill/index-delta.ts";
import {
  LOOP_DETECTED_TEXT,
  VALIDATION_LOOP_DETECTED_TEXT,
} from "../../src/harness/tool-loop-detect.ts";
import { buildCompactPrompt } from "../../src/harness/compress/full-compact.ts";
import { MCP_RECONNECT_NOTIFICATION_TEMPLATE } from "../../src/harness/loop-engine.ts";
import {
  COMPACT_REQUEST_INJECTION_PREFIX,
  COMPACT_SUMMARY_INJECTION_PREFIX,
  LOOP_DETECTED_INJECTION_PREFIX,
  MCP_RECONNECT_INJECTION_PREFIX,
  STOP_SUMMARY_INJECTION_PREFIX,
  isHostInjectedUserText,
} from "../../src/harness/agent-status-instruction.ts";

const REPO_ROOT = join(__dirname, "..", "..");
const loopEngineSource = readFileSync(
  join(REPO_ROOT, "src/harness/loop-engine.ts"),
  "utf8"
);
const instructionModuleSource = readFileSync(
  join(REPO_ROOT, "src/harness/agent-status-instruction.ts"),
  "utf8"
);

// -- SEAM enumeration -----------------------------------------------------------

interface SeamSite {
  /** The call site's argument expression (extracted with paren balancing). */
  readonly arg: string;
  /** Forward assignment window when the argument is a bare `text`. */
  readonly window: string;
}

/** Extract the argument expressions and forward windows of all `adapter.encodeUserText(` call sites. */
function enumerateEncodeUserTextSites(source: string): ReadonlyArray<SeamSite> {
  const sites: SeamSite[] = [];
  const needle = "encodeUserText(";
  let from = 0;
  for (;;) {
    const idx = source.indexOf(needle, from);
    if (idx < 0) return sites;
    const open = idx + needle.length - 1; // position of '('
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const arg = source.slice(open + 1, end).trim();
    sites.push({
      arg,
      window: source.slice(Math.max(0, idx - 600), idx),
    });
    from = end + 1;
  }
}

/**
 * Roster registration: call site → (classification label, a sample of the text
 * the seam actually produces). Matching uses exact argument forms or the
 * assignment-source identifier in the forward window; a new seam matching no
 * rule → red.
 */
const ROSTER_RULES: ReadonlyArray<{
  readonly label: string;
  readonly match: (site: SeamSite) => boolean;
  readonly sample: () => string;
}> = [
  {
    label: "agent_status 栏",
    match: (s) => s.arg === "snapshot.text",
    sample: () => buildAgentStatusText({ lastTool: "idle", openTodoLines: [] }),
  },
  {
    label: "graph mode change",
    match: (s) =>
      s.arg === "text" &&
      s.window.includes("renderGraphModeChangeNotification"),
    sample: () => renderGraphModeChangeNotification("on"),
  },
  {
    label: "graph mode presence",
    match: (s) => s.arg === "IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION",
    sample: () => IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  },
  {
    label: "MCP 重连通知",
    match: (s) =>
      s.arg === "text" &&
      s.window.includes("MCP_RECONNECT_NOTIFICATION_TEMPLATE"),
    sample: () =>
      MCP_RECONNECT_NOTIFICATION_TEMPLATE.replace("<server>", "gh").replace(
        "<tools>",
        "a, b"
      ),
  },
  {
    label: "skill index delta",
    match: (s) => s.arg === "text" && s.window.includes("delta.text"),
    sample: () => `${SKILL_INDEX_DELTA_PREFIX}\n- foo — desc`,
  },
  {
    label: "compact request（buildCompactPrompt）",
    match: (s) => s.arg === "buildCompactPrompt()",
    sample: () => buildCompactPrompt(),
  },
  {
    // ADR-0112: runFullCompact's adapter view (outside the compress bounded
    // context, stamped by the host commit side); its produced text shares the
    // same seam and roster entry as buildCompactPrompt.
    label: "compact request（runFullCompact adapter 视图）",
    match: (s) => s.arg === "compactPromptText",
    sample: () => buildCompactPrompt(),
  },
  {
    label: "stop summary request（SUMMARY_PROMPT）",
    match: (s) => s.arg.startsWith("SUMMARY_PROMPT("),
    sample: () =>
      `${STOP_SUMMARY_INJECTION_PREFIX} what was done in this conversation and why it ended (stop reason: aborted). Keep it concise.`,
  },
  {
    label: "loop detected",
    match: (s) => s.arg === "LOOP_DETECTED_TEXT",
    sample: () => LOOP_DETECTED_TEXT,
  },
  {
    // Narrow validation-stall fuse: separate site, separate text, same
    // "LOOP_DETECTED:" prefix anchor.
    label: "validation loop detected",
    match: (s) => s.arg === "VALIDATION_LOOP_DETECTED_TEXT",
    sample: () => VALIDATION_LOOP_DETECTED_TEXT,
  },
];

/** The operator's raw-text entry: not an injection seam, the one legal call site outside the roster. */
const USER_TEXT_ENTRY = "effectiveUserText";

describe("SEAM 名册完备性锁（loop-engine encodeUserText 全集）", () => {
  const sites = enumerateEncodeUserTextSites(loopEngineSource);

  it("枚举到非零调用点（防提取式失效导致空集假绿）", () => {
    assert.ok(sites.length >= 9, `仅枚举到 ${sites.length} 个调用点`);
  });

  for (const [i, site] of sites.entries()) {
    it(`调用点 #${i}（arg=${JSON.stringify(site.arg).slice(0, 48)}）挂名册或为原文入口`, () => {
      if (site.arg === USER_TEXT_ENTRY) return; // operator-typed raw text, not an injection
      const rule = ROSTER_RULES.find((r) => r.match(site));
      assert.ok(
        rule !== undefined,
        `未登记的注入缝（新缝不挂名册即红）：arg=${site.arg}`
      );
      assert.equal(
        isHostInjectedUserText(rule.sample()),
        true,
        `名册谓词漏判：${rule.label}`
      );
    });
  }

  it("每个已登记名册缝至少有一个实际调用点（防僵尸条目）", () => {
    for (const rule of ROSTER_RULES) {
      assert.ok(
        sites.some((s) => rule.match(s)),
        `名册条目无对应调用点：${rule.label}`
      );
    }
  });

  it("名册前缀常量与产出方模板不漂移", () => {
    assert.ok(
      MCP_RECONNECT_NOTIFICATION_TEMPLATE.startsWith(
        MCP_RECONNECT_INJECTION_PREFIX
      )
    );
    assert.ok(LOOP_DETECTED_TEXT.startsWith(LOOP_DETECTED_INJECTION_PREFIX));
    assert.ok(
      buildCompactPrompt().startsWith(COMPACT_REQUEST_INJECTION_PREFIX)
    );
    // SUMMARY_PROMPT is not exported: pin its literal head from the loop-engine source
    assert.match(
      loopEngineSource,
      new RegExp(
        `SUMMARY_PROMPT[\\s\\S]{0,80}\`${STOP_SUMMARY_INJECTION_PREFIX}`
      )
    );
    // The compact-produced summary (a user message persisted into prior) is on the roster too
    const compactSource = readFileSync(
      join(REPO_ROOT, "src/harness/compress/full-compact.ts"),
      "utf8"
    );
    assert.ok(compactSource.includes(COMPACT_SUMMARY_INJECTION_PREFIX));
    assert.equal(
      isHostInjectedUserText(
        `${COMPACT_SUMMARY_INJECTION_PREFIX} that ran out of context.`
      ),
      true
    );
  });
});

// -- zero adapter import grep ---------------------------------------------------

describe("甄别模块零 adapter import（SC2 无任何 LLM 参与）", () => {
  const importStatements = instructionModuleSource
    .split("\n")
    .filter((l) => /^import\b/.test(l) || /^\s+from\b/.test(l));

  it("不 import 任何 adapter / model / LLM 实现面", () => {
    for (const line of importStatements) {
      assert.doesNotMatch(
        line,
        /anthropic-adapter|stub-model|model-adapter\/(?!types)/i
      );
      assert.doesNotMatch(line, /\bAdapter\b/);
    }
  });

  it("model-adapter 相关 import 仅允许 type-only wire 类型", () => {
    // Collect real import statements line by line so the word "import" appearing in comments cannot pollute the match.
    const adapterPathImports = instructionModuleSource
      .split("\n")
      .filter(
        (l) => /^import\b/.test(l) && /from\s+"[^"]*model-adapter[^"]*"/.test(l)
      );
    for (const stmt of adapterPathImports) {
      assert.match(stmt, /^import\s+type\s/);
      assert.match(stmt, /model-adapter\/types\.js/);
    }
  });

  it("LoopEngineDeps 引用面 sanity（类型导入不携带运行时 adapter 依赖）", () => {
    // This test file imports loop-engine only for the MCP template constant and types;
    // the discrimination module's own source must never import loop-engine (cycle guard).
    assert.doesNotMatch(instructionModuleSource, /from\s+"[^"]*loop-engine/);
    assert.doesNotMatch(instructionModuleSource, /from\s+"[^"]*session-api/);
    assert.doesNotMatch(
      instructionModuleSource,
      /from\s+"[^"]*\/tui\/|src\/tui/
    );
  });
});
