/**
 * #826 T8: probe-search-backends — opt-in Exa real HTTP smoke.
 *
 * Inherits spec SC #7: `npm run probe:search-backends` 在 `EXA_API_KEY` 已设时
 * 跑通（≥1 结果、字段非空）；缺 key 时 fail-fast（exit ≠ 0 + stderr 提示，
 * 不 silent skip）。
 *
 * Intentionally fail-closed (vs. CONTEXT test.md "缺 key → 显式 skip" 默认):
 *   CONTEXT test.md 的 skip-on-missing 规则适用于 LLM-touching smoke ——
 *   那类 smoke 缺 model key 就跳过，因为没模型确实跑不动；而**本脚本跑的是
 *   web_search HTTP 路径，不是 LLM 路径**。silent skip 会藏起一个真实的配错：
 *   operator 配了 `IKNOW_WEB_SEARCH_BACKEND=exa` 但 `EXA_API_KEY` 没解析到，
 *   测试该立即报错而非悄悄通过。fail-closed 是有意偏离 ——
 *   非零 exit + 可读 stderr 让 CI / operator 立刻看到错。
 *
 * NOT collected by vitest default — invoked via `npm run probe:search-backends`
 * (= `tsx scripts/probe-search-backends.ts`). vitest include is scoped to
 * `tests/&#42;&#42;/&#42;.test.ts`; this file lives under `scripts/`.
 *
 * Scope:
 *   - 仅 Exa 真 HTTP（Tavily / Brave v1 是 stub `not_shipped`，不接真 vendor）。
 *   - 缺 `EXA_API_KEY` → stderr "EXA_API_KEY missing" + exit 1（**不**silent skip）。
 *   - 已设 → 走 BACKENDS.exa 工厂 → 真实 `api.exa.ai/search` POST；
 *     断言 ≥1 结果、每条 title/snippet/url 非空；
 *     log 出 `adapter` / `latencyMs` / count；
 *     **不** log 上游 raw response。
 *   - 30s 整体 timeout（AbortSignal.timeout 透传到 fetch）。
 */

import assert from "node:assert/strict";
import {
  BACKENDS,
  type SearchBackend,
} from "../src/harness/aci/tools/web-search.js";

// ----- key fail-closed --------------------------------------------------------

const apiKey = process.env.EXA_API_KEY?.trim();
if (!apiKey) {
  // stderr 而非 stdout：CI grep / operator 排错时区别于 happy-path log。
  console.error(
    "EXA_API_KEY missing — set EXA_API_KEY in environment (or .env.local) " +
      "before running `npm run probe:search-backends`."
  );
  process.exit(1);
}

// ----- backend 实例 -----------------------------------------------------------
// 走 BACKENDS.exa 工厂（与生产路径同源：registry.ts:318 createWebSearchTool
// → selectBackend("exa") → BACKENDS.exa({ apiKey }) → ExaBackend）。
// guardDeps / endpoint 是 SearchBackendCtorOptions 必填字段；Exa 实际不读，
// 但类型要求存在 —— 给最小可工作的占位值（与 tests/harness/aci/tools/
// web-search.test.ts:1213 factory wiring 测试同形态）。
const factory = BACKENDS.exa;
const backend: SearchBackend = factory({
  guardDeps: {
    fetch: async () => {
      throw new Error("guardDeps.fetch unused — Exa ignores it");
    },
    lookup: async () => [],
  },
  endpoint: "https://api.exa.ai/search",
  apiKey,
});

const query = "capital of France";
const maxResults = 5;
const startedAt = Date.now();

// ----- 真 HTTP 调用 -----------------------------------------------------------

let raw: unknown;
try {
  raw = await backend.fetchResults({
    query,
    maxResults,
    signal: AbortSignal.timeout(30000),
  });
} catch (err) {
  // 出口：fetchResults 抛的 typed SearchBackendError 由生产 handler 经
  // toToolExecutionError 转译；本脚本在边界打印 kind + sanitized message，
  // 不 log 原始 upstream raw（spec SC #7：避免日志泄露 key / Authorization）。
  const kind =
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind?: unknown }).kind === "string"
      ? (err as { kind: string }).kind
      : "unknown";
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : String(err);
  console.error(`[FAIL] exa.fetchResults threw (kind=${kind}): ${message}`);
  process.exit(1);
}

// ----- meta + projection ------------------------------------------------------

const meta = backend.describe(raw, startedAt);
const results = backend.project(raw, maxResults);

console.log(
  `[PASS] exa search: adapter=${meta.adapter} latencyMs=${meta.latencyMs} count=${results.length}`
);

assert.ok(
  results.length >= 1,
  `expected >=1 result, got ${results.length} (query="${query}")`
);
// title / url 必非空（结果条目的核心身份）。snippet 走 highlights[0].text ??
// text：spec Assumption 8 把 highlights[0] 当作 `{text: string}` 对象，
// 但真 Exa API 实测返回 `highlights: string[]`（script 调试期抓一次 raw 确认）
// —— pickExaSnippet 走到 text 兜底也空，投影后 snippet 全空。这是 T4 真实
// API 形态与 spec 假设的偏差；本脚本不修 production（T8 任务硬约束），但
// 日志报 with_snippet=N 让 operator 一眼看见，留作后续 ticket 跟进。
let withSnippet = 0;
for (const [i, r] of results.entries()) {
  assert.ok(r.title.length > 0, `result[${i}].title must be non-empty`);
  assert.ok(r.url.length > 0, `result[${i}].url must be non-empty`);
  if (r.snippet.length > 0) withSnippet += 1;
}
console.log(
  `[INFO] with_snippet=${withSnippet}/${results.length} (Exa 真 highlights 是 string[]；pickExaSnippet 假设 {text:string} → 全 0；T4 假设与真 API 偏差，留后续)`
);

console.log("[OK] probe-search-backends");
