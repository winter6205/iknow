/**
 * runtime-capability-memory-gate T2: the runtime capability persist gate.
 *
 * Spec: specs/runtime-capability-memory-gate.md (Boundaries Does — persist 前
 * 闸; Classifier fixtures). ADR-0086.
 *
 * A runtime capability observation ("web_search is down in this sandbox",
 * "there is no real outbound network here") describes the environment of one
 * moment. Stored as durable memory and later recalled, it outranks the live
 * tool result and stops the model from trying the tool at all. The authority
 * for such facts is the tool result of the turn, never the memory library.
 *
 * Pure, deterministic, zero-LLM: the same predicate serves `memory_save`
 * (typed rejection), the extract / dream persist path (drop the candidate),
 * the GC capability sweep (soft-disable an old row) and the three read-side
 * filters (prefetch / recall / catalog), so one verdict covers every entry
 * point.
 */

/** Stable reason token carried by the save-path rejection message. */
export const CAPABILITY_OBSERVATION_REASON = "capability_observation";

/**
 * Tool / connectivity surfaces whose availability an observation might claim.
 * Product-specific names only: a bare "tool" / "web" would also match policy
 * text that merely mentions the surface, and that text must stay writable.
 */
const CAPABILITY_SUBJECTS = [
  "web_search",
  "web_fetch",
  "websearch",
  "webfetch",
  "web search",
  "web fetch",
  "search tool",
  "web tool",
  "browser",
  "internet",
  "outbound",
  "dns",
  "ssrf",
  "network",
  "proxy",
  "出网",
  "联网",
  "外网",
  "网络",
  "浏览器",
  "搜索工具",
  "网络工具",
  "web 工具",
] as const;

/**
 * Intrinsic capability predicates: unavailability that cannot be read as a
 * process rule ("is unavailable", "cannot reach the network", "没有真实出网").
 * Deliberately excludes generic failure words ("fails", "timeout"): a retry
 * policy is a fact worth keeping, while "is unavailable" is a snapshot of one
 * environment. These fire on a capability subject alone.
 */
const INTRINSIC_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnot\s+available\b/i,
  /\bunavailable\b/i,
  /\bunreachable\b/i,
  /\bnot\s+reachable\b/i,
  /\bcan(?:'t|not)\s+(?:be\s+)?(?:reach|access|use|call|connect|resolve|browse|search|fetch)/i,
  /\bno\s+(?:real\s+)?(?:outbound|internet|network|web|dns|proxy|connectivity)\b/i,
  /\bwithout\s+(?:internet|network|outbound|web|dns|connectivity)\b/i,
  /\boffline\b/i,
  /不可用/,
  /不能用/,
  /无法(?:访问|使用|调用|连接|解析|联网|上网|出网|获取|搜索|抓取)/,
  /不能(?:访问|使用|调用|连接|解析|联网|上网|出网|获取|搜索|抓取)/,
  /没有(?:真实)?(?:出网|外网|联网|网络|互联网|网络访问)/,
  /不(?:能|可)(?:联网|上网|出网)/,
  /无(?:法)?(?:联网|上网|出网)/,
];

/**
 * Ambiguous policy verbs: the same vocabulary a product rule uses ("禁用浏览器
 * 工具" in CI, "生产网络策略……拦截入站"). A sentence carrying one of these is a
 * capability snapshot only when it also names the environment it describes —
 * the footing below — so policy / convention text stays writable
 * (spec Assumption 3). Without footing, `disable`/`block`/`restrict` say
 * nothing about any particular environment.
 */
const AMBIGUOUS_POLICY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bdisabl(?:e|ed|ing)\b/i,
  /\bblock(?:s|ed|ing)\b/i,
  /\brestrict(?:s|ed|ing)\b/i,
  /被(?:禁用|拦截|阻断|屏蔽|限制)/,
  /禁用/,
  /拦截/,
  /屏蔽/,
  /限制/,
];

/**
 * Environment footing: an explicit "the environment I am in right now" marker.
 * Only these turn an ambiguous policy verb into an environment snapshot; a
 * bare capability noun (`network`, `browser`) is a subject, not a footing.
 */
const FOOTING_PATTERNS: ReadonlyArray<RegExp> = [
  /本环境/,
  /此环境/,
  /当前环境/,
  /此刻/,
  /沙箱/,
  /沙盒/,
  /\bsandbox(?:ed)?\b/i,
  /\bthis\s+(?:environment|sandbox|machine|host|container|box)\b/i,
  /\bin\s+this\s+(?:environment|sandbox|machine|host|container|box)\b/i,
  /\bfrom\s+this\s+(?:environment|sandbox|machine|host|container|box)\b/i,
  /\bhere\b/i,
];

/**
 * Return a human-readable reason when the draft is a runtime capability /
 * environment-availability observation, or null when it may be persisted.
 *
 * A segment (sentence / line) must carry both a capability subject and an
 * availability predicate, so a product-policy `constraint` ("隔离 ON 时 mutate
 * 须先建 worktree") and a test-command convention pass while "this sandbox has
 * no DNS, so web_search is unavailable" is rejected.
 *
 * The draft's `type` is deliberately not an input: relabeling a capability
 * observation as `constraint` must not buy it a way into the store, and the
 * read side (prefetch / recall / catalog) filters whole stored entries whose
 * `type` should carry no weight either. The write paths that parse a `type`
 * (memory_save, ingest) therefore cannot reach a different verdict with it.
 */
export function detectCapabilityObservation(input: {
  title: string;
  body: string;
}): string | null {
  for (const segment of segments(`${input.title}\n${input.body}`)) {
    const subject = findCapabilitySubject(segment);
    if (subject === null) continue;
    const predicate = findUnavailabilityPredicate(segment);
    if (predicate === null) continue;
    return `runtime capability observation about "${subject}" ("${predicate}"): the live tool result is authoritative, not memory`;
  }
  return null;
}

/**
 * Read-side form of the same predicate: true when this entry must not be
 * handed to the model (prefetch / recall / catalog). One definition for all
 * read sites so they cannot drift apart on a future classifier change.
 */
export function isCapabilityObservationEntry(entry: {
  readonly title: string;
  readonly body: string;
}): boolean {
  return detectCapabilityObservation(entry) !== null;
}

/**
 * Split on sentence / line boundaries (not on commas: a Chinese sentence often
 * puts the capability subject and its predicate on either side of "，").
 */
function segments(text: string): ReadonlyArray<string> {
  return text.split(/[\n。！？!?；;]+|\.\s+/);
}

function findCapabilitySubject(text: string): string | null {
  const lower = text.toLowerCase();
  for (const subject of CAPABILITY_SUBJECTS) {
    if (lower.includes(subject)) return subject;
  }
  return null;
}

/**
 * Match an availability predicate against one segment: an intrinsic predicate
 * always counts, an ambiguous policy verb only with environment footing in the
 * same segment.
 */
function findUnavailabilityPredicate(text: string): string | null {
  for (const pattern of INTRINSIC_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  if (!FOOTING_PATTERNS.some((pattern) => pattern.test(text))) return null;
  for (const pattern of AMBIGUOUS_POLICY_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}
