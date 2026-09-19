/**
 * spec agent-status-instruction-echo T2「名册完备性锁」+ SC2 grep 面 / SC5。
 *
 * 1. SEAM 枚举：读 loop-engine 源，找全部 `encodeUserText(` 注入缝产出点；
 *    每个调用点必须命中已登记名册（按实参表达式 + 前向赋值窗分类），
 *    新注入缝不挂名册即红。除操作员原文入口（effectiveUserText）外，
 *    每个注入缝的**实际产出文本**必须被 `isHostInjectedUserText` 判注入。
 * 2. grep 断言：甄别模块零 adapter import（SC2「无任何 LLM 参与」）——
 *    model-adapter 只允许 type-only 的 wire 类型导入。
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
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.ts";
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

// -- SEAM 枚举 ----------------------------------------------------------------

interface SeamSite {
  /** 调用点实参表达式（配平括号提取）。 */
  readonly arg: string;
  /** 实参为裸 `text` 时的前向赋值窗。 */
  readonly window: string;
}

/** 提取全部 `adapter.encodeUserText(` 调用点的实参表达式与前向窗。 */
function enumerateEncodeUserTextSites(source: string): ReadonlyArray<SeamSite> {
  const sites: SeamSite[] = [];
  const needle = "encodeUserText(";
  let from = 0;
  for (;;) {
    const idx = source.indexOf(needle, from);
    if (idx < 0) return sites;
    const open = idx + needle.length - 1; // '(' 的位置
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
 * 名册登记：调用点 →（分类标签, 该缝实际产出文本的样本）。
 * 匹配规则按实参精确式或前向窗中的赋值源标识；新缝不匹配任何规则 → 红。
 */
const ROSTER_RULES: ReadonlyArray<{
  readonly label: string;
  readonly match: (site: SeamSite) => boolean;
  readonly sample: () => string;
}> = [
  {
    label: "agent_status 栏",
    match: (s) => s.arg === "snapshot.text",
    sample: () =>
      buildAgentStatusText({ lastTool: "idle", openTodoLines: [] }),
  },
  {
    label: "graph mode change",
    match: (s) => s.arg === "text" && s.window.includes("renderGraphModeChangeNotification"),
    sample: () => renderGraphModeChangeNotification("on"),
  },
  {
    label: "graph mode presence",
    match: (s) => s.arg === "IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION",
    sample: () => IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  },
  {
    label: "MCP 重连通知",
    match: (s) => s.arg === "text" && s.window.includes("MCP_RECONNECT_NOTIFICATION_TEMPLATE"),
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
    // ADR-0112 T2:runFullCompact 的 adapter 视图（compress 有界上下文外、
    // 宿主 commit 方盖戳）；产出文本与 buildCompactPrompt 同缝同名册。
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
];

/** 操作员原文入口：非注入缝，名册之外唯一合法调用点。 */
const USER_TEXT_ENTRY = "effectiveUserText";

describe("SEAM 名册完备性锁（loop-engine encodeUserText 全集）", () => {
  const sites = enumerateEncodeUserTextSites(loopEngineSource);

  it("枚举到非零调用点（防提取式失效导致空集假绿）", () => {
    assert.ok(sites.length >= 9, `仅枚举到 ${sites.length} 个调用点`);
  });

  for (const [i, site] of sites.entries()) {
    it(`调用点 #${i}（arg=${JSON.stringify(site.arg).slice(0, 48)}）挂名册或为原文入口`, () => {
      if (site.arg === USER_TEXT_ENTRY) return; // 操作员键入原文，非注入
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
    assert.ok(buildCompactPrompt().startsWith(COMPACT_REQUEST_INJECTION_PREFIX));
    // SUMMARY_PROMPT 未导出：从 loop-engine 源钉其字面头部
    assert.match(
      loopEngineSource,
      new RegExp(`SUMMARY_PROMPT[\\s\\S]{0,80}\`${STOP_SUMMARY_INJECTION_PREFIX}`)
    );
    // compact 产物摘要（持久进 prior 的 user 消息）同样在名册内
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

// -- SC2：零 adapter import grep ----------------------------------------------

describe("甄别模块零 adapter import（SC2 无任何 LLM 参与）", () => {
  const importStatements = instructionModuleSource
    .split("\n")
    .filter((l) => /^import\b/.test(l) || /^\s+from\b/.test(l));

  it("不 import 任何 adapter / model / LLM 实现面", () => {
    for (const line of importStatements) {
      assert.doesNotMatch(line, /anthropic-adapter|stub-model|model-adapter\/(?!types)/i);
      assert.doesNotMatch(line, /\bAdapter\b/);
    }
  });

  it("model-adapter 相关 import 仅允许 type-only wire 类型", () => {
    // 逐行收集真实 import 语句，避免注释里的“import”字样污染匹配。
    const adapterPathImports = instructionModuleSource
      .split("\n")
      .filter(
        (l) =>
          /^import\b/.test(l) &&
          /from\s+"[^"]*model-adapter[^"]*"/.test(l)
      );
    for (const stmt of adapterPathImports) {
      assert.match(stmt, /^import\s+type\s/);
      assert.match(stmt, /model-adapter\/types\.js/);
    }
  });

  it("LoopEngineDeps 引用面 sanity（类型导入不携带运行时 adapter 依赖）", () => {
    // 本测试文件自身 import loop-engine 仅为 MCP 模板常量与类型；
    // 甄别模块自身源码不得出现对 loop-engine 的 import（防成环）。
    assert.doesNotMatch(instructionModuleSource, /from\s+"[^"]*loop-engine/);
    assert.doesNotMatch(instructionModuleSource, /from\s+"[^"]*session-api/);
    assert.doesNotMatch(instructionModuleSource, /from\s+"[^"]*\/tui\/|src\/tui/);
  });
});
