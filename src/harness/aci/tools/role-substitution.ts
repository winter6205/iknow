/**
 * ADR-0117 tool-role substitution refusal ("替岗拒绝").
 *
 * Role split on the ACI table (docs/CONTEXT.md 工具职分): `bash` runs
 * processes, ACI `grep` searches text content, the symbol tool surface
 * answers code-structure questions. A call that impersonates another role
 * is refused fail-closed and the receipt points ONLY at the proper-role
 * tool. This is deliberately NOT the permission hard-wall (ADR-0068): the
 * gate lives in the tool handlers and carries none of the
 * `VIOLATION_PREFIXES` tokens — the pinned `[role_substitution]` prefix
 * here is the SSOT for that message shape.
 *
 * Pure predicates + frozen tables (capability-gate.ts module shape); the
 * bash/grep handlers compose them at their entry points:
 *   - bash arm: on an `ok` security parse, any top-level segment region —
 *     text between `;` / `&&` / `||` / `|` operator tokens, the parse-facts
 *     restatement of the segment model the old text splitter computed —
 *     whose leading depth-0 command node has a first argv word in the
 *     grep family → refuse. Substitution bodies and nested scopes
 *     (depth > 0) are out of the population (the old `firstToken` never
 *     saw inside `$( … )` either), a region whose first content is not a
 *     command node abstains, and a node led by a non-argv word (a prefix
 *     assignment, a leading redirect) abstains — the same T21
 *     `commandTokenRun` semantics the root-find fold carries. Every
 *     non-`ok` verdict and the pre-parse `vetoed` arm stay SILENT
 *     (`docs/shell-parse-non-ok-consumer-contracts.md`, SC-S4-1); the one
 *     admitted relaxation — an `unknown-syntax` command the user then
 *     approves — is tagged `expected-relaxation` citing ADR-0117's
 *     not-a-hard-wall scope (SC-S4-7), never waved through.
 *     First-token only — no source-extension heuristics (operator
 *     constraint; ADR-0117 "Why not 源码扩展名拦 bash").
 *   - grep arm: structure-shaped pattern (definition-syntax table) + no
 *     fallback trajectory evidence → refuse. Evidence is the session
 *     trajectory (ctx.messages), never self-report, and strictly PRIOR:
 *     the window ends before the assistant message carrying the current
 *     call's tool_use, so a same-wave sibling symbol dispatch (the model
 *     hedging grep alongside find_symbol in one turn) is current intent,
 *     not a completed consultation — it does not exempt. E2 = a prior
 *     tool_use of a query-side symbol tool (usage fallback class 2
 *     "unknown symbol"); E3 = a prior tool_result from a symbol-tool call
 *     carrying the LSP readable-failure sentinel (class 3 "language
 *     server unavailable"). Class 1 ("non-code content") is carried by the
 *     predicates not firing (content-shaped pattern / non-code scope).
 *     ctx.messages absent → fail closed (skill.ts precedent).
 */

import { firstToken } from "../../permission/hard-walls.js";
import {
  parseForSecurity,
  segmentCutRegions,
  segmentRegionLeader,
  type FactSpan,
  type SecurityParseOk,
} from "../../permission/shell-parse.js";
import { ToolExecutionError } from "../../errors.js";
import { isLspFailureSentinel } from "./lsp.js";
import type { AnthropicNativeMessage } from "../../model-adapter/types.js";

/** Refusal-message prefix for both arms (ADR-0117 Decision 1). */
export const ROLE_SUBSTITUTION_PREFIX = "[role_substitution]";

/**
 * Frozen table: shell command names owned by the ACI `grep` role. A bash
 * segment starting with one of these is the substitution bash must not
 * perform. `firstToken` already lowercases and strips directories, so
 * `/usr/bin/grep` matches too.
 */
export const GREP_FAMILY_TOKENS: ReadonlyArray<string> = Object.freeze([
  "grep",
  "egrep",
  "fgrep",
  "rg",
]);

/**
 * Frozen table: query-side symbol tools (CONTEXT 符号工具面 10 查).
 * E2 evidence = a strictly-prior tool_use of one of these; a completed
 * consultation proves the model went to the proper-role surface first.
 */
export const SYMBOL_QUERY_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
  "find_symbol",
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_hover",
  "get_diagnostics_for_file",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
]);

/**
 * Full symbol surface (10 query + 5 mutate, CONTEXT 符号工具面). A failure
 * sentinel arriving under one of these calls is E3 evidence: the language
 * server demonstrably did not answer, so grep-with-failure is the usage
 * fallback, not substitution.
 */
export const SYMBOL_TOOL_NAMES: ReadonlyArray<string> = Object.freeze([
  ...SYMBOL_QUERY_TOOL_NAMES,
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
]);

/**
 * Frozen table: definition-syntax shapes a grep pattern must not be asked
 * to answer (code-structure questions). Identifier-coupled so a plain
 * content word in prose ("classification of parts") does not fire on its
 * own; the residual false-positive cost ("class of X" style prose) is the
 * trade-off ADR-0117 records and comparison tree B measures. The separator
 * class accepts real whitespace AND regex-escaped spellings (`\s+`, `\w`)
 * because the model writes structure queries as regex source.
 */
const SEP = String.raw`(?:\s|\\[A-Za-z]|[*+?])+`;

function keywordSyntax(keywordAndSeparator: string): RegExp {
  return new RegExp(
    String.raw`\b${keywordAndSeparator}[A-Za-z_$][A-Za-z0-9_$]*`
  );
}

export const GREP_STRUCTURE_SHAPE_PATTERNS: ReadonlyArray<RegExp> =
  Object.freeze([
    keywordSyntax(String.raw`function${SEP}`),
    keywordSyntax(String.raw`class${SEP}`),
    keywordSyntax(String.raw`interface${SEP}`),
    new RegExp(String.raw`\btype${SEP}[A-Za-z_$][A-Za-z0-9_$]*${SEP}?[=<]`),
    keywordSyntax(String.raw`enum${SEP}`),
    keywordSyntax(String.raw`struct${SEP}`),
    new RegExp(
      String.raw`\bimpl(?:${SEP}<[^>]*>)?${SEP}([A-Za-z_$][A-Za-z0-9_$]*${SEP}for${SEP})?[A-Za-z_$]`
    ),
    new RegExp(String.raw`\bdef${SEP}[A-Za-z_][A-Za-z0-9_]*`),
    new RegExp(String.raw`\bnamespace${SEP}[A-Za-z_][A-Za-z0-9_.]*`),
    new RegExp(
      String.raw`\bexport${SEP}?(default${SEP})?(async${SEP})?(function|class|const|let|var|type|interface|enum)\b`
    ),
    // Anchored definition shape: a pattern starting with the line anchor `^`
    // that couples an identifier to a call/param opener (`\(` or a class
    // containing code punctuation). Modifier-keyword languages (TS/Java
    // methods) carry no function/class keyword, so the table above misses
    // them — real-model trace tempt-1078-t01 #2 decided a case on
    // `^\s*(public |private |protected |static |async )*load\s*\(`.
    new RegExp(
      String.raw`^\^[\s\S]*?[A-Za-z_$][A-Za-z0-9_$]*${SEP}?(?:\\\(|\[[^\]]*[<(:?=]\])`
    ),
    // Modifier-group definition shape (conjunction, order-independent):
    // the pattern text carries BOTH a parenthesized language-modifier keyword
    // AND an identifier coupled to a definition opener. The modifier group is
    // regex-source signature — content searches spell neither half, and a
    // prose hit on "public" without the coupling stays content. Real-model
    // traces tempt-1078-t01 wrote the same query in three shapes
    // (`(public |private )*load\s*(`, `(^|\s)(async\s+)?load\s*[(=]`,
    // `((public|private|…)\s+)*#?load\s*(\(|=|:)`), so neither half may assume
    // a fixed group position, a trailing quantifier, or the absence of regex
    // plumbing (`(`, `|`, `#?`, `\s*`) between the name and its opener.
    new RegExp(
      String.raw`^(?=[\s\S]*[(][^)]*\b(?:public|private|protected|static|async|readonly|export|declare|abstract|final|override)\b[^)]*[)])` +
        String.raw`(?=[\s\S]*[A-Za-z_$][A-Za-z0-9_$]*(?:${SEP}|[(]|\|[)])*?(?:\\\(|\[[^\]]*[<(:?=]\]))`
    ),
  ]);

/**
 * Frozen table: extensions whose files are non-code content (usage
 * fallback class 1). Only docs/config text is exempt from the structure
 * question — a glob mixing in a code extension stays under the gate.
 */
export const GREP_NON_CODE_SCOPE_EXTENSIONS: ReadonlyArray<string> =
  Object.freeze([
    "md",
    "markdown",
    "json",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "txt",
    "rst",
    "csv",
    "ini",
    "cfg",
    "conf",
  ]);

/**
 * Bash arm predicate: return the first grep-family token found leading any
 * top-level segment region, or undefined. Region = text between `ok`-parse
 * operator tokens (`;` / `&&` / `||` / `|`), so pipeline tails
 * (`cat f | grep x`) are caught while a newline inside one region is not a
 * boundary (the B3b registered divergence, pinned in
 * `role-substitution-boundaries.test.ts`). A region's leader is its first
 * depth-0 command node: substitution bodies and nested scopes never lead,
 * a region whose content before that node is more than whitespace abstains
 * (a redirect, `!`, or comment led the segment — `firstToken` named that
 * word, never grep), and a node led by a non-argv word (a prefix
 * assignment) abstains on the same T21 `commandTokenRun` semantics the
 * root-find fold carries. The cut set and the leader derivation are the
 * shared `shell-parse` projection (`segmentCutRegions` /
 * `segmentRegionLeader`), also used by `bash-read-extract.ts`.
 */
export function detectBashGrepSubstitution(
  command: string
): string | undefined {
  const parse = parseForSecurity(command);
  // Non-`ok` arm: the gate stays silent for every verdict
  // (`unknown-syntax` / `malformed` / `aborted` / `over-cap` /
  // `parser-unavailable`) and the pre-parse `vetoed` — it refuses by
  // recognizing a segment-leading grep word and sees inside no shape it
  // cannot parse (SC-S4-1; docs/shell-parse-non-ok-consumer-contracts.md).
  // No splitter fallback stands behind this answer. The registered
  // relaxation — an `unknown-syntax` command the user then APPROVES, where
  // silence replaces a possible recognition — stays tagged
  // `expected-relaxation` citing ADR-0117's not-a-hard-wall scope
  // (SC-S4-7), never waved through.
  if (parse.kind !== "ok") return undefined;
  for (const region of segmentCutRegions(parse)) {
    const token = regionLeadingGrep(parse, region);
    if (token !== undefined) return token;
  }
  return undefined;
}

/**
 * The grep-family token leading ONE region, or undefined: the region's
 * first non-blank content must be a depth-0 command node whose own first
 * argv word starts that node (both abstention arms keep today's
 * `firstToken` answer), and that word must name the grep family.
 */
function regionLeadingGrep(
  parse: SecurityParseOk,
  region: FactSpan
): string | undefined {
  const leader = segmentRegionLeader(parse, region);
  if (leader === undefined) return undefined;
  const token = firstToken(leader.lead.text);
  return GREP_FAMILY_TOKENS.includes(token) ? token : undefined;
}

/** Bash arm refusal text: points only to the proper-role tools. */
export function bashSubstitutionRefusal(token: string): string {
  return (
    `${ROLE_SUBSTITUTION_PREFIX} bash must not substitute for "${token}" — ` +
    `text search goes through the ACI grep tool; code-structure questions ` +
    `go through the symbol tools (find_symbol).`
  );
}

/** Does this grep pattern query definition syntax (structure-shaped)? */
export function isStructureShapedPattern(pattern: string): boolean {
  return GREP_STRUCTURE_SHAPE_PATTERNS.some((re) => re.test(pattern));
}

/**
 * Is the call explicitly scoped to non-code content? Collects every
 * `.ext` token from `glob` plus a trailing extension on `path`; the call
 * is exempt only when the set is non-empty and wholly non-code
 * (fail-closed on mixed or code-only scopes).
 */
export function isNonCodeScopedCall(input: {
  readonly path?: unknown;
  readonly glob?: unknown;
}): boolean {
  const extensions: string[] = [];
  if (typeof input.glob === "string") {
    // Both `*.ext` and brace-choice spellings `*.{ext1,ext2}` name scopes.
    for (const match of input.glob.matchAll(
      /\.([A-Za-z0-9]+)|\.\{([^{}]+)\}/g
    )) {
      if (match[1] !== undefined) {
        extensions.push(match[1].toLowerCase());
      } else {
        for (const item of match[2]!.split(",")) {
          extensions.push(item.trim().toLowerCase());
        }
      }
    }
  }
  if (typeof input.path === "string") {
    const trailing = /\.([A-Za-z0-9]+)$/.exec(input.path);
    if (trailing !== null) extensions.push(trailing[1]!.toLowerCase());
  }
  if (extensions.length === 0) return false;
  return extensions.every((ext) =>
    GREP_NON_CODE_SCOPE_EXTENSIONS.includes(ext)
  );
}

/** Project a tool_result block's content to plain text (skill.ts shape). */
function resultBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        (part as { text?: unknown }).text !== undefined
          ? String((part as { text: unknown }).text)
          : ""
      )
      .join("\n");
  }
  return "";
}

/** tool_use ids grouped by symbol-surface membership (single scan). */
function collectSymbolCallIds(
  messages: ReadonlyArray<AnthropicNativeMessage>
): { readonly query: Set<string>; readonly symbol: Set<string> } {
  const query = new Set<string>();
  const symbol = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (SYMBOL_TOOL_NAMES.includes(block.name)) symbol.add(block.id);
      if (SYMBOL_QUERY_TOOL_NAMES.includes(block.name)) query.add(block.id);
    }
  }
  return { query, symbol };
}

/**
 * Messages strictly before the assistant message carrying
 * `currentToolUseId` — the evidence window for the grep arm. No id → the
 * whole snapshot (direct handler calls in tests); id absent from the
 * snapshot → empty (fail closed).
 */
function priorWindow(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  currentToolUseId: string | undefined
): ReadonlyArray<AnthropicNativeMessage> {
  if (currentToolUseId === undefined) return messages;
  const index = messages.findIndex((message) =>
    message.content.some(
      (block) => block.type === "tool_use" && block.id === currentToolUseId
    )
  );
  return index < 0 ? [] : messages.slice(0, index);
}

/**
 * Grep arm evidence predicate (trajectory only, never self-report):
 *   E2 = a tool_use of a query-side symbol tool;
 *   E3 = a tool_result answering a symbol-tool call whose text is an LSP
 *        readable-failure sentinel (isLspFailureSentinel).
 * `undefined` messages → false (fail closed, skill.ts precedent).
 *
 * The scan window is strictly prior to the current call: when
 * `currentToolUseId` is given (the executor always sets ctx.toolUseId),
 * only messages before the one carrying that tool_use count, so same-wave
 * sibling symbol dispatches cannot exempt a concurrent grep. An id that
 * is not present in the snapshot leaves an empty window (fail closed).
 */
export function hasFallbackTrajectoryEvidence(
  messages: ReadonlyArray<AnthropicNativeMessage> | undefined,
  currentToolUseId?: string
): boolean {
  if (messages === undefined) return false;
  const window = priorWindow(messages, currentToolUseId);
  const { query, symbol } = collectSymbolCallIds(window);
  if (query.size > 0) return true;
  return window.some((message) =>
    message.content.some(
      (block) =>
        block.type === "tool_result" &&
        symbol.has(block.tool_use_id) &&
        isLspFailureSentinel(resultBlockText(block.content))
    )
  );
}

/** Grep arm refusal text: points only to find_symbol. */
export function grepSubstitutionRefusal(pattern: string): string {
  return (
    `${ROLE_SUBSTITUTION_PREFIX} grep must not substitute for the symbol ` +
    `tools on a code-structure pattern ("${pattern}") — use find_symbol; ` +
    `grep stays correct after a symbol-tool failure recorded in this ` +
    `session's trajectory.`
  );
}

/**
 * Bash arm gate entry (thrown here so the handler stays a single call —
 * the S5 complexity budget of bash.ts's handler is already at baseline).
 */
export function assertNoBashGrepSubstitution(command: string): void {
  const token = detectBashGrepSubstitution(command);
  if (token !== undefined) {
    throw new ToolExecutionError(bashSubstitutionRefusal(token));
  }
}

/** Grep arm gate entry; same extraction rationale as the bash arm. */
export function assertNoGrepSubstitution(
  input: unknown,
  messages: ReadonlyArray<AnthropicNativeMessage> | undefined,
  currentToolUseId?: string
): void {
  const pattern = (input as { readonly pattern?: unknown } | null)?.pattern;
  if (typeof pattern !== "string") return;
  if (!isStructureShapedPattern(pattern)) return;
  if (
    isNonCodeScopedCall(input as { path?: unknown; glob?: unknown }) ||
    hasFallbackTrajectoryEvidence(messages, currentToolUseId)
  ) {
    return;
  }
  throw new ToolExecutionError(grepSubstitutionRefusal(pattern));
}
