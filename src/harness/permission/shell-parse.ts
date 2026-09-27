/**
 * The unified shell parse foundation: one synchronous entry that classifies a
 * command string into a closed set of verdicts, and nothing else. No wall reads
 * a verdict yet, and no verdict here denies a command.
 */

import { createRequire } from "node:module";

const requireBinding = createRequire(import.meta.url);

/**
 * The cap counts UTF-8 bytes, not string indices — the unit that both bounds
 * retained memory and matches the parser's own offsets — and it is measured
 * before a parser exists, so an over-cap command is never tokenized at all.
 */
const CAP_BYTES = 65_536;

/** Frozen: the public entry is defined as this value, and nothing else may vary it. */
const PARSE_BUDGET_MICROS = 200_000;

/** Bounded, keyed by the exact command string, process-local, never persisted. */
const MEMO_CAPACITY = 64;

export type SecurityParseVerdict =
  | "ok"
  | "unknown-syntax"
  | "malformed"
  | "aborted"
  | "over-cap"
  | "parser-unavailable";

export type ParseFoundationState = "UNINITIALIZED" | "READY" | "UNAVAILABLE";

export type VetoClass =
  | "control-character"
  | "unicode-whitespace-or-zero-width"
  | "backslash-whitespace";

export type WordQuoteKind = "none" | "single" | "double" | "ansi-c";

export type SubstitutionKind =
  "dollar-paren" | "backtick" | "procsub-in" | "procsub-out";

export type InertWhy = "single-quoted" | "comment" | "heredoc-body";

export interface FactSpan {
  readonly start: number;
  readonly end: number;
}

export interface WordFact {
  readonly text: string;
  readonly quoteKind: WordQuoteKind;
  readonly value?: string;
  readonly span: FactSpan;
}

export interface CommandFact {
  readonly index: number;
  readonly argv: readonly WordFact[];
  readonly span: FactSpan;
  readonly parentId?: number;
  readonly depth: number;
}

export interface SubstitutionFact {
  readonly kind: SubstitutionKind;
  readonly span: FactSpan;
  readonly innerCommandIndex: number | null;
  readonly ownerCommandIndex: number | null;
}

export interface ExpansionFact {
  readonly name: string | null;
  readonly span: FactSpan;
  readonly ownerCommandIndex: number | null;
}

export interface RedirectFact {
  readonly fd?: string;
  readonly op: string;
  readonly target: WordFact;
  readonly span: FactSpan;
  readonly ownerCommandIndex: number | null;
  readonly bodySpan?: FactSpan;
  readonly delimiterQuoted?: boolean;
}

export interface HeredocFact {
  readonly bodySpan: FactSpan;
  readonly delimiterQuoted: boolean;
  readonly receiverCommandIndex: number | null;
}

export interface InertFact {
  readonly span: FactSpan;
  readonly why: InertWhy;
  readonly ownerCommandIndex?: number;
  readonly delimiterQuoted?: boolean;
}

export interface SecurityParseOkFacts {
  readonly words: readonly WordFact[];
  readonly commands: readonly CommandFact[];
  readonly substitutions: readonly SubstitutionFact[];
  readonly expansions: readonly ExpansionFact[];
  readonly redirects: readonly RedirectFact[];
  readonly heredocs: readonly HeredocFact[];
  readonly inert: readonly InertFact[];
}

export interface SecurityParseOk extends SecurityParseOkFacts {
  readonly kind: "ok";
  readonly text: string;
  readonly nodeTypes: Readonly<Record<string, number>>;
}

export interface SecurityParseUnknownSyntax {
  readonly kind: "unknown-syntax";
  readonly text: string;
  readonly nodeTypes: Readonly<Record<string, number>>;
  readonly unmodelled: readonly string[];
}

export interface SecurityParseMalformed {
  readonly kind: "malformed";
  readonly reason: string;
}

export interface SecurityParseAborted {
  readonly kind: "aborted";
  readonly reason: string;
}

export interface SecurityParseOverCap {
  readonly kind: "over-cap";
  readonly reason: string;
}

export interface SecurityParseVetoed {
  readonly kind: "vetoed";
  readonly class: VetoClass;
  readonly reason: string;
}

export interface SecurityParseUnavailable {
  readonly kind: "parser-unavailable";
}

export type SecurityParseResult =
  | SecurityParseOk
  | SecurityParseUnknownSyntax
  | SecurityParseMalformed
  | SecurityParseAborted
  | SecurityParseOverCap
  | SecurityParseVetoed
  | SecurityParseUnavailable;

/**
 * The legacy scanner's per-pattern record, declared structurally for the same
 * reason `ShellBinding` is: a named reference to `hard-walls.ts` here would put
 * this module in that file's import graph, and Stage 1 adds the edge in the
 * other direction.
 */
interface DangerScanHit {
  readonly id: string;
  readonly pattern: string;
}

/** The one role-filled argument of the degrade seam; it has no default. */
export type LegacyDangerScan = (command: string) => DangerScanHit | null;

interface SecurityScanParsed {
  readonly kind: "parsed";
  readonly degraded: false;
  readonly result: SecurityParseResult;
}

interface SecurityScanLegacyHit {
  readonly kind: "legacy-hit";
  readonly degraded: true;
  readonly hit: DangerScanHit;
}

interface SecurityScanLegacyClean {
  readonly kind: "legacy-clean";
  readonly degraded: true;
}

interface SecurityScanLegacyThrew {
  readonly kind: "legacy-threw";
  readonly degraded: true;
  readonly errorName: string;
  readonly reason: string;
}

export type SecurityScanOutcome =
  | SecurityScanParsed
  | SecurityScanLegacyHit
  | SecurityScanLegacyClean
  | SecurityScanLegacyThrew;

/** The grammar handle, exactly as the binding package hands it over the require edge. */
export interface ShellGrammar {
  readonly name: string;
}

export interface ShellSyntaxNode {
  readonly hasError: boolean;
}

export interface ShellFactNode extends ShellSyntaxNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly childCount: number;
  readonly isNamed: boolean;
  child(index: number): ShellFactNode | null;
  childForFieldName(field: string): ShellFactNode | null;
  fieldNameForChild(index: number): string | null;
}

export interface ShellTreeCursor {
  readonly nodeType: string;
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoParent(): boolean;
}

export interface ShellTree {
  readonly rootNode: ShellSyntaxNode;
  walk(): ShellTreeCursor;
}

export interface ShellParser {
  setLanguage(language: ShellGrammar): void;
  setTimeoutMicros(micros: number): void;
  parse(input: string): ShellTree | null;
}

/**
 * Declared structurally, never by referencing the binding package's own types:
 * any static reference would tie this module to a package it must not need
 * until the first parse. The only coupling lives behind the createRequire call
 * inside the loader function.
 */
export interface ShellBinding {
  readonly Parser: new () => ShellParser;
  readonly grammar: ShellGrammar;
}

export type ParseBindingLoader = () => ShellBinding;

export interface TreeBuilderSpy {
  onSetTimeoutMicros(budgetMicros: number): void;
  onParse(): void;
  armNextParseThrow(error: Error): void;
}

/**
 * The modelled roster: every node type `tree-sitter-bash` publishes in
 * node-types.json except the two whose content this foundation refuses to
 * model (`regex`, `extglob_pattern`). A type outside this set is
 * `unknown-syntax` — an ask, never a deny — so a grammar upgrade that adds a
 * node type cannot mass-deny.
 */
const MODELLED_NODE_TYPES: ReadonlySet<string> = new Set([
  "!",
  "!=",
  '"',
  "#",
  "##",
  "$",
  "$(",
  "$((",
  "$[",
  "$`",
  "${",
  "%",
  "%%",
  "%=",
  "&",
  "&&",
  "&=",
  "&>",
  "&>>",
  "(",
  "((",
  ")",
  "))",
  "*",
  "**",
  "**=",
  "*=",
  "+",
  "++",
  "+=",
  ",",
  ",,",
  "-",
  "--",
  "-=",
  "-a",
  "-o",
  "..",
  "/",
  "/#",
  "/%",
  "//",
  "/=",
  ":",
  ":+",
  ":-",
  ":=",
  ":?",
  ";",
  ";&",
  ";;",
  ";;&",
  "<",
  "<&",
  "<&-",
  "<(",
  "<<",
  "<<-",
  "<<<",
  "<<=",
  "<=",
  "=",
  "==",
  "=~",
  ">",
  ">&",
  ">&-",
  ">(",
  ">=",
  ">>",
  ">>=",
  ">|",
  "?",
  "@",
  "A",
  "E",
  "K",
  "L",
  "P",
  "Q",
  "U",
  "[",
  "[[",
  "]",
  "]]",
  "^",
  "^=",
  "^^",
  "_expression",
  "_primary_expression",
  "_statement",
  "`",
  "``",
  "a",
  "ansi_c_string",
  "arithmetic_expansion",
  "array",
  "binary_expression",
  "brace_expression",
  "c_style_for_statement",
  "case",
  "case_item",
  "case_statement",
  "command",
  "command_name",
  "command_substitution",
  "comment",
  "compound_statement",
  "concatenation",
  "declaration_command",
  "declare",
  "do",
  "do_group",
  "done",
  "elif",
  "elif_clause",
  "else",
  "else_clause",
  "esac",
  "expansion",
  "export",
  "fi",
  "file_descriptor",
  "file_redirect",
  "for",
  "for_statement",
  "function",
  "function_definition",
  "heredoc_body",
  "heredoc_content",
  "heredoc_end",
  "heredoc_redirect",
  "heredoc_start",
  "herestring_redirect",
  "if",
  "if_statement",
  "in",
  "k",
  "list",
  "local",
  "negated_command",
  "number",
  "parenthesized_expression",
  "pipeline",
  "postfix_expression",
  "process_substitution",
  "program",
  "raw_string",
  "readonly",
  "redirected_statement",
  "select",
  "simple_expansion",
  "special_variable_name",
  "string",
  "string_content",
  "subscript",
  "subshell",
  "ternary_expression",
  "test_command",
  "test_operator",
  "then",
  "translated_string",
  "typeset",
  "u",
  "unary_expression",
  "unset",
  "unset_command",
  "unsetenv",
  "until",
  "variable_assignment",
  "variable_assignments",
  "variable_name",
  "while",
  "while_statement",
  "word",
  "{",
  "|",
  "|&",
  "|=",
  "||",
  "}",
  "~",
]);

/**
 * The bare-operator anonymous tokens of the roster above, spelled as the
 * cursor surfaces them (measured: a bare `||` arrives as two `|` leaves).
 * The leaf whitelist of `commandlessOperatorBody`; the roster itself is
 * untouched, because this predicate is the only path by which an `ERROR`
 * tree is graded `ok`.
 */
const BARE_OPERATOR_TOKENS: ReadonlySet<string> = new Set([
  ";",
  ";;",
  "&&",
  "||",
  "|",
  "&",
  ">",
  ">>",
  "<",
]);

interface VetoRule {
  readonly probe: RegExp;
  readonly reason: (command: string) => string;
}

const CONTROL_CHARACTER_VETO: VetoRule = {
  probe: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/,
  reason: () =>
    "解析分歧字符（control-character）：命令含控制字符（制表符、换行、回车除外），连解析都不做，直接硬拒",
};

/**
 * The class definitions are the Unicode categories Zs, Zl, Zp and Cf. `Zs`
 * cannot be used as a property class directly because it contains U+0020,
 * bash's own word separator; the enumerated ranges are `Zs` without it. `Cf`
 * covers the zero-width joiners, BOM included.
 */
const UNICODE_WHITESPACE_VETO: VetoRule = {
  probe: /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\p{Zl}\p{Zp}\p{Cf}]/u,
  reason: () =>
    "解析分歧字符（unicode-whitespace-or-zero-width）：命令含 Unicode 空白/零宽字符（非断行空格、零宽字符、BOM 等），词法切分与 bash 不一致，连解析都不做，直接硬拒",
};

const BACKSLASH_WHITESPACE_VETO: VetoRule = {
  probe: /\\[ \t\n\r\f\v]/,
  reason: (command) =>
    `解析分歧字符（backslash-whitespace）：反斜杠紧跟空白，与 bash 的词法不一致，连解析都不做，直接硬拒；改用引号承载该词，例如 ${quotedRewrite(command)}`,
};

/** One entry per divergent shape; a new class must be registered here to exist. */
const VETO_RULES = {
  "control-character": CONTROL_CHARACTER_VETO,
  "unicode-whitespace-or-zero-width": UNICODE_WHITESPACE_VETO,
  "backslash-whitespace": BACKSLASH_WHITESPACE_VETO,
} as const satisfies Record<VetoClass, VetoRule>;

const VETO_ORDER = Object.keys(VETO_RULES) as VetoClass[];

const OVER_CAP_RESULT: SecurityParseOverCap = Object.freeze({
  kind: "over-cap" as const,
  reason: `过长无法分析：命令超过 ${CAP_BYTES} UTF-8 字节上限，未进入解析器`,
});

const MALFORMED_REASON =
  "语法不完整：解析树带有 ERROR/MISSING 节点（如引号未闭合）";

/** A verdict is stored only if producing it required a parse at this budget. */
const MEMOIZED_VERDICTS: ReadonlySet<string> = new Set<
  SecurityParseVerdict | "vetoed"
>(["ok", "malformed", "unknown-syntax"]);

const memo = new Map<string, SecurityParseResult>();

let foundationState: ParseFoundationState = "UNINITIALIZED";
let activeBinding: ShellBinding | null = null;
let bindingLoader: ParseBindingLoader | null = null;
let treeBuilderSpy: TreeBuilderSpy | null = null;
let parserConstructions = 0;

export function parseForSecurity(command: string): SecurityParseResult {
  return parseForSecurityWithBudget(command, PARSE_BUDGET_MICROS);
}

export function parseForSecurityWithBudget(
  command: string,
  budgetMicros: number
): SecurityParseResult {
  const vetoed = vetoResult(command);
  if (vetoed !== null) {
    return vetoed;
  }
  if (Buffer.byteLength(command, "utf8") > CAP_BYTES) {
    return OVER_CAP_RESULT;
  }
  const binding = readyBinding();
  if (binding === null) {
    return { kind: "parser-unavailable" };
  }
  const memoEligible = budgetMicros === PARSE_BUDGET_MICROS;
  const cached = memoEligible ? memoRead(command) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const result = classify(binding, command, budgetMicros);
  if (memoEligible && MEMOIZED_VERDICTS.has(result.kind)) {
    memo.set(command, result);
    memoEvictIfNeeded();
  }
  return result;
}

export function parseFoundationState(): ParseFoundationState {
  return foundationState;
}

const LEGACY_THREW_PREFIX = "旧扫描器自身异常，硬拒该条命令（兜底）：";

/**
 * The only entry that may answer from the legacy text scan, and it answers from
 * there for exactly one reason: a load that never succeeded. Total by
 * construction — every fault of the injected scanner becomes a value.
 */
export function scanWithLegacyDegrade(
  command: string,
  legacyScan: LegacyDangerScan
): SecurityScanOutcome {
  const result = parseForSecurity(command);
  if (result.kind !== "parser-unavailable") {
    return { degraded: false, kind: "parsed", result };
  }
  try {
    const hit = legacyScan(command);
    return hit === null
      ? { degraded: true, kind: "legacy-clean" }
      : { degraded: true, hit, kind: "legacy-hit" };
  } catch (fault) {
    const errorName = faultName(fault);
    return {
      degraded: true,
      errorName,
      kind: "legacy-threw",
      reason: `${LEGACY_THREW_PREFIX}${errorName}`,
    };
  }
}

export function setBindingLoaderForTest(
  loader: ParseBindingLoader | null
): void {
  bindingLoader = loader;
}

export function setTreeBuilderSpyForTest(spy: TreeBuilderSpy | null): void {
  treeBuilderSpy = spy;
}

export function parserConstructionCountForTest(): number {
  return parserConstructions;
}

export function cacheEntryCountForTest(): number {
  return memo.size;
}

function productionBindingLoader(): ShellBinding {
  return {
    Parser: requireBinding("tree-sitter") as unknown as new () => ShellParser,
    grammar: requireBinding("tree-sitter-bash") as unknown as ShellGrammar,
  };
}

/**
 * A failed load is process-terminal: only a binding that never loaded can
 * answer `parser-unavailable`; after READY every runtime fault is `aborted`.
 */
function readyBinding(): ShellBinding | null {
  if (activeBinding !== null) {
    return activeBinding;
  }
  if (foundationState === "UNAVAILABLE") {
    return null;
  }
  try {
    activeBinding = (bindingLoader ?? productionBindingLoader)();
    foundationState = "READY";
    return activeBinding;
  } catch {
    activeBinding = null;
    foundationState = "UNAVAILABLE";
    // The terminal branch is the only place the state degrades, so this line is
    // said once per process — a degrade that stays silent reads as a clean run.
    process.stderr.write(
      "parser-unavailable: shell 解析绑定加载失败，本进程的判定降级为旧文本扫描（此提示仅记一次）\n"
    );
    return null;
  }
}

function vetoResult(command: string): SecurityParseVetoed | null {
  for (const vetoClass of VETO_ORDER) {
    const rule = VETO_RULES[vetoClass];
    if (rule.probe.test(command)) {
      return { class: vetoClass, kind: "vetoed", reason: rule.reason(command) };
    }
  }
  return null;
}

/** Keep the separating space: the hint must read as a same-word rewrite. */
function quotedRewrite(command: string): string {
  return command.replace(
    /\\+[ \t\n\r\f\v]+(\S+)/g,
    (_match, word: string) => ` "${word}"`
  );
}

/**
 * A fresh instance per command, never pooled: a Parser left behind by a
 * cancelled parse produces fabricated ERROR nodes for the next input, so
 * reuse would turn a budget event into a false syntax verdict.
 */
function classify(
  binding: ShellBinding,
  command: string,
  budgetMicros: number
): SecurityParseResult {
  try {
    const parser = new binding.Parser();
    parserConstructions += 1;
    parser.setLanguage(binding.grammar);
    treeBuilderSpy?.onSetTimeoutMicros(budgetMicros);
    parser.setTimeoutMicros(budgetMicros);
    treeBuilderSpy?.onParse();
    const tree = parser.parse(command);
    if (tree === null) {
      return {
        kind: "aborted",
        reason: `解析未在 ${budgetMicros} 微秒预算内完成，该次解析已取消`,
      };
    }
    return verdictOfTree(tree, command);
  } catch (fault) {
    return {
      kind: "aborted",
      reason: `解析过程故障（${faultName(fault)}），按 fail-closed 处理`,
    };
  }
}

function verdictOfTree(tree: ShellTree, command: string): SecurityParseResult {
  // SC-S3-1's dependency: the bare-metachar wall's claim must be modelled, not an ERROR verdict.
  const operatorBody = tree.rootNode.hasError && commandlessOperatorBody(tree);
  if (tree.rootNode.hasError && !operatorBody) {
    return { kind: "malformed", reason: MALFORMED_REASON };
  }
  const facts = readTree(tree);
  if (!operatorBody && facts.unmodelled.length > 0) {
    return {
      kind: "unknown-syntax",
      nodeTypes: facts.nodeTypes,
      text: command,
      unmodelled: facts.unmodelled,
    };
  }
  return {
    ...readFacts(tree, command),
    kind: "ok",
    nodeTypes: facts.nodeTypes,
    text: command,
  };
}

/**
 * True when the tree carries an error but names no command anywhere: the root
 * is `program` — or, for inputs like `;;`, an `ERROR` — and every node is the
 * root itself, an `ERROR` that wraps nothing but bare-operator tokens, or a
 * bare-operator leaf. Whitespace is invisible to the grammar, so the "or
 * whitespace" leaf clause holds on its own; a `MISSING` node surfaces as its
 * token type (e.g. `"`), which the whitelist rejects, and any `word`,
 * `command`, or other named type falls through to `false`, keeping that tree
 * `malformed`.
 */
function commandlessOperatorBody(tree: ShellTree): boolean {
  // The cursor API only declares `walk`; at runtime `rootNode` is the same
  // binding node `readFacts` walks with `child`, so it satisfies the wider
  // fact-node shape the tree itself already carries.
  const root = tree.rootNode as ShellFactNode;
  if (root.type !== "program" && root.type !== "ERROR") {
    return false;
  }
  const count = operatorBodyCount(root);
  return count !== undefined && count > 0;
}

/**
 * Operator tokens under the root, or one `ERROR` level below a `program`
 * root; any other shape answers `undefined`. A bare-operator leaf with no
 * children is a counted operator.
 */
function operatorBodyCount(node: ShellFactNode): number | undefined {
  let operators = 0;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child === null) {
      return undefined;
    }
    if (BARE_OPERATOR_TOKENS.has(child.type)) {
      if (child.childCount > 0) {
        return undefined;
      }
      operators += 1;
    } else if (node.type === "program" && child.type === "ERROR") {
      if (child.childCount === 0) {
        return undefined;
      }
      const under = operatorBodyCount(child);
      if (under === undefined) {
        return undefined;
      }
      operators += under;
    } else {
      return undefined;
    }
  }
  return operators;
}

interface TreeFacts {
  readonly nodeTypes: Record<string, number>;
  readonly unmodelled: string[];
}

/** The cursor is read through `nodeType` only; `currentNode` allocates a node per step. */
function readTree(tree: ShellTree): TreeFacts {
  const nodeTypes: Record<string, number> = {};
  const unmodelled = new Set<string>();
  const cursor = tree.walk();
  for (;;) {
    const nodeType = cursor.nodeType;
    nodeTypes[nodeType] = (nodeTypes[nodeType] ?? 0) + 1;
    if (!MODELLED_NODE_TYPES.has(nodeType)) {
      unmodelled.add(nodeType);
    }
    if (cursor.gotoFirstChild()) {
      continue;
    }
    for (;;) {
      if (cursor.gotoNextSibling()) {
        break;
      }
      if (!cursor.gotoParent()) {
        return { nodeTypes, unmodelled: [...unmodelled].sort() };
      }
    }
  }
}

const WORD_NODE_TYPES: ReadonlySet<string> = new Set([
  "ansi_c_string",
  "arithmetic_expansion",
  "command_substitution",
  "concatenation",
  "expansion",
  "number",
  "process_substitution",
  "raw_string",
  "simple_expansion",
  "string",
  "word",
]);

const EXPANSION_FAMILY_TYPES: ReadonlySet<string> = new Set([
  "arithmetic_expansion",
  "command_substitution",
  "expansion",
  "process_substitution",
  "simple_expansion",
]);

const EXPANSION_SITE_TYPES: ReadonlySet<string> = new Set([
  "arithmetic_expansion",
  "expansion",
  "simple_expansion",
]);

const SUBSTITUTION_SITE_TYPES: ReadonlySet<string> = new Set([
  "command_substitution",
  "process_substitution",
]);

const NESTED_SITE_TYPES: ReadonlySet<string> = new Set([
  ...EXPANSION_FAMILY_TYPES,
  "heredoc_body",
]);

const DEPTH_CONTAINERS: ReadonlySet<string> = new Set([
  "case_item",
  "command_substitution",
  "compound_statement",
  "c_style_for_statement",
  "for_statement",
  "function_definition",
  "if_statement",
  "process_substitution",
  "subshell",
  "while_statement",
]);

const IDENTIFIER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REDIRECT_NODE_TYPES: ReadonlySet<string> = new Set([
  "file_redirect",
  "heredoc_redirect",
  "herestring_redirect",
]);

type BaseRedirect = Omit<RedirectFact, "bodySpan" | "delimiterQuoted">;

interface FactContext {
  readonly depth: number;
  readonly owner: number | null;
  readonly opaque: boolean;
  readonly redirectOwnerStart: number | null;
}

interface FactFrame {
  readonly node: ShellFactNode;
  readonly ctx: FactContext;
}

const TOP_CONTEXT: FactContext = {
  depth: 0,
  opaque: false,
  owner: null,
  redirectOwnerStart: null,
};

interface DraftSubstitution {
  readonly kind: SubstitutionKind;
  readonly span: FactSpan;
  readonly owner: number | null;
}

interface FactDrafts {
  readonly words: WordFact[];
  readonly commands: CommandFact[];
  readonly commandSpans: FactSpan[];
  readonly commandIndexByStart: Map<number, number>;
  readonly substitutions: DraftSubstitution[];
  readonly expansions: ExpansionFact[];
  readonly redirects: RedirectFact[];
  readonly heredocs: HeredocFact[];
  readonly inert: InertFact[];
}

interface FactWalk {
  readonly drafts: FactDrafts;
  readonly text: string;
}

function createWalk(text: string): FactWalk {
  return {
    drafts: {
      commands: [],
      commandIndexByStart: new Map<number, number>(),
      commandSpans: [],
      expansions: [],
      heredocs: [],
      inert: [],
      redirects: [],
      substitutions: [],
      words: [],
    },
    text,
  };
}

function spanOf(node: ShellFactNode): FactSpan {
  return { end: node.endIndex, start: node.startIndex };
}

function textOf(walk: FactWalk, node: ShellFactNode): string {
  const span = spanOf(node);
  return walk.text.slice(span.start, span.end);
}

function pushChildren(stack: ShellFactNode[], node: ShellFactNode): void {
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    if (child !== null) {
      stack.push(child);
    }
  }
}

function readFacts(tree: ShellTree, command: string): SecurityParseOkFacts {
  const walk = createWalk(command);
  walkFacts(walk, tree.rootNode as ShellFactNode);
  return finishFacts(walk);
}

function walkFacts(walk: FactWalk, root: ShellFactNode): void {
  const stack: FactFrame[] = [{ ctx: TOP_CONTEXT, node: root }];
  for (;;) {
    const frame = stack.pop();
    if (frame === undefined) {
      return;
    }
    if (!frame.ctx.opaque) {
      emitNodeFacts(walk, frame.node, frame.ctx);
    }
    const childContext = contextForChildren(walk, frame.node, frame.ctx);
    for (let index = frame.node.childCount - 1; index >= 0; index -= 1) {
      const child = frame.node.child(index);
      if (child !== null) {
        stack.push({ ctx: childContext, node: child });
      }
    }
  }
}

function contextForChildren(
  walk: FactWalk,
  node: ShellFactNode,
  ctx: FactContext
): FactContext {
  return {
    depth: ctx.depth + (DEPTH_CONTAINERS.has(node.type) ? 1 : 0),
    /**
     * An unquoted heredoc body exposes live expansion nodes, but its text is
     * runtime data this parse must not model: nothing below `heredoc_body`
     * yields a word, site, command or redirect fact, and Stage 1 re-parses the
     * body span instead.
     */
    opaque: ctx.opaque || node.type === "heredoc_body",
    owner: ownerForChildren(walk, node, ctx),
    redirectOwnerStart: redirectOwnerStartOf(node, ctx),
  };
}

function redirectOwnerStartOf(
  node: ShellFactNode,
  ctx: FactContext
): number | null {
  if (node.type !== "redirected_statement") {
    return REDIRECT_NODE_TYPES.has(node.type) ? ctx.redirectOwnerStart : null;
  }
  const body = node.childForFieldName("body");
  if (body === null) {
    return null;
  }
  if (body.type === "command") {
    return spanOf(body).start;
  }
  // A list body hoists the redirect out of its chain: in
  // `cd /tmp && bash <<'EOF'` the operator sits after the whole list, and the
  // process bash hands the body to is the LAST command before it. Attributing
  // the redirect there keeps the receiver parse-derived; falling back to the
  // first word (`cd`) or to silence (`null`) would both misprice the body.
  if (body.type === "list") {
    for (let index = body.childCount - 1; index >= 0; index -= 1) {
      const child = body.child(index);
      if (child !== null && child.type === "command") {
        return spanOf(child).start;
      }
    }
  }
  return null;
}

function ownerForChildren(
  walk: FactWalk,
  node: ShellFactNode,
  ctx: FactContext
): number | null {
  if (node.type === "command") {
    return walk.drafts.commandIndexByStart.get(spanOf(node).start) ?? ctx.owner;
  }
  return REDIRECT_NODE_TYPES.has(node.type)
    ? redirectOwner(walk, ctx)
    : ctx.owner;
}

function redirectOwner(walk: FactWalk, ctx: FactContext): number | null {
  const start = ctx.redirectOwnerStart;
  if (start === null) {
    return ctx.owner;
  }
  return walk.drafts.commandIndexByStart.get(start) ?? ctx.owner;
}

function emitNodeFacts(
  walk: FactWalk,
  node: ShellFactNode,
  ctx: FactContext
): void {
  const type = node.type;
  const owner = REDIRECT_NODE_TYPES.has(type)
    ? redirectOwner(walk, ctx)
    : ctx.owner;
  if (type === "command") {
    emitCommandFact(walk, node, ctx);
  } else if (type === "heredoc_redirect") {
    emitHeredocFacts(walk, node, owner);
  } else if (type === "file_redirect" || type === "herestring_redirect") {
    emitRedirectFact(walk, node, owner);
  } else if (SUBSTITUTION_SITE_TYPES.has(type)) {
    emitSubstitutionFact(walk, node, owner);
  } else if (EXPANSION_SITE_TYPES.has(type)) {
    emitExpansionFacts(walk, node, owner);
  } else if (type === "raw_string" || type === "comment") {
    emitInertFact(walk, node, ctx, type);
  }
}

function emitCommandFact(
  walk: FactWalk,
  node: ShellFactNode,
  ctx: FactContext
): void {
  const drafts = walk.drafts;
  const index = drafts.commands.length;
  const span = spanOf(node);
  const argv = argvOf(walk, node);
  drafts.commands.push(
    ctx.owner === null
      ? { argv, depth: ctx.depth, index, span }
      : { argv, depth: ctx.depth, index, parentId: ctx.owner, span }
  );
  drafts.commandSpans.push(span);
  drafts.commandIndexByStart.set(span.start, index);
  drafts.words.push(...argv);
}

function argvOf(walk: FactWalk, node: ShellFactNode): WordFact[] {
  const argv: WordFact[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child === null) {
      continue;
    }
    const field = node.fieldNameForChild(index);
    if (field === "name" && child.type === "command_name") {
      collectArgvWords(walk, child, argv);
    } else if (field === "argument" && WORD_NODE_TYPES.has(child.type)) {
      argv.push(wordFactOf(child, textOf(walk, child)));
    }
  }
  return argv;
}

function collectArgvWords(
  walk: FactWalk,
  nameNode: ShellFactNode,
  into: WordFact[]
): void {
  for (let index = 0; index < nameNode.childCount; index += 1) {
    const child = nameNode.child(index);
    if (child !== null && WORD_NODE_TYPES.has(child.type)) {
      into.push(wordFactOf(child, textOf(walk, child)));
    }
  }
}

function quoteKindOf(type: string): WordQuoteKind {
  if (type === "raw_string") {
    return "single";
  }
  if (type === "string") {
    return "double";
  }
  return type === "ansi_c_string" ? "ansi-c" : "none";
}

function wordFactOf(node: ShellFactNode, text: string): WordFact {
  const span = spanOf(node);
  const quoteKind = quoteKindOf(node.type);
  const value = foldedValue(node, quoteKind, text);
  return value === undefined
    ? { quoteKind, span, text }
    : { quoteKind, span, text, value };
}

function foldedValue(
  node: ShellFactNode,
  quoteKind: WordQuoteKind,
  text: string
): string | undefined {
  if (hasExpansionInside(node)) {
    return undefined;
  }
  if (quoteKind === "single" || quoteKind === "double") {
    return text.slice(1, -1);
  }
  return quoteKind === "ansi-c" ? ansiCValue(text) : foldBackslashes(text);
}

function ansiCValue(text: string): string | undefined {
  const body = text.slice(2, -1);
  return body.includes("\\") ? undefined : body;
}

function foldBackslashes(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

function hasExpansionInside(root: ShellFactNode): boolean {
  if (EXPANSION_FAMILY_TYPES.has(root.type)) {
    return true;
  }
  const stack: ShellFactNode[] = [];
  pushChildren(stack, root);
  for (;;) {
    const node = stack.pop();
    if (node === undefined) {
      return false;
    }
    if (node.type === "heredoc_body") {
      continue;
    }
    if (EXPANSION_FAMILY_TYPES.has(node.type)) {
      return true;
    }
    pushChildren(stack, node);
  }
}

function emitSubstitutionFact(
  walk: FactWalk,
  node: ShellFactNode,
  owner: number | null
): void {
  const kind = substitutionKindOf(walk.text, node.startIndex);
  if (kind !== null) {
    walk.drafts.substitutions.push({ kind, owner, span: spanOf(node) });
  }
}

function substitutionKindOf(text: string, at: number): SubstitutionKind | null {
  if (text.startsWith("$(", at)) {
    return "dollar-paren";
  }
  if (text.startsWith("`", at)) {
    return "backtick";
  }
  if (text.startsWith("<(", at)) {
    return "procsub-in";
  }
  return text.startsWith(">(", at) ? "procsub-out" : null;
}

function emitExpansionFacts(
  walk: FactWalk,
  node: ShellFactNode,
  owner: number | null
): void {
  const span = spanOf(node);
  const names = expansionNamesOf(walk, node);
  if (names.length === 0) {
    walk.drafts.expansions.push({ name: null, ownerCommandIndex: owner, span });
    return;
  }
  for (const name of names) {
    walk.drafts.expansions.push({ name, ownerCommandIndex: owner, span });
  }
}

function expansionNamesOf(walk: FactWalk, root: ShellFactNode): string[] {
  const names: string[] = [];
  const stack: ShellFactNode[] = [];
  pushChildren(stack, root);
  for (;;) {
    const node = stack.pop();
    if (node === undefined) {
      return names;
    }
    if (NESTED_SITE_TYPES.has(node.type)) {
      continue;
    }
    if (node.type === "variable_name") {
      const name = textOf(walk, node);
      if (IDENTIFIER_NAME.test(name)) {
        names.push(name);
      }
      continue;
    }
    pushChildren(stack, node);
  }
}

interface RedirectOperator {
  readonly fd?: string;
  readonly op: string;
}

function redirectOperator(
  walk: FactWalk,
  node: ShellFactNode
): RedirectOperator | null {
  const op = operatorOf(node);
  if (op === null) {
    return null;
  }
  const descriptor = node.childForFieldName("descriptor");
  return descriptor === null ? { op } : { fd: textOf(walk, descriptor), op };
}

function operatorOf(node: ShellFactNode): string | null {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child !== null && !child.isNamed) {
      return child.type;
    }
  }
  return null;
}

function targetNodeOf(node: ShellFactNode): ShellFactNode | null {
  const destination = node.childForFieldName("destination");
  if (destination !== null) {
    return destination;
  }
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child !== null && child.isNamed) {
      return child;
    }
  }
  return null;
}

function childOfType(node: ShellFactNode, type: string): ShellFactNode | null {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child !== null && child.type === type) {
      return child;
    }
  }
  return null;
}

function baseRedirectFact(
  node: ShellFactNode,
  operator: RedirectOperator,
  owner: number | null,
  target: WordFact
): BaseRedirect {
  return {
    ...(operator.fd === undefined ? {} : { fd: operator.fd }),
    op: operator.op,
    ownerCommandIndex: owner,
    span: spanOf(node),
    target,
  };
}

function emitRedirectFact(
  walk: FactWalk,
  node: ShellFactNode,
  owner: number | null
): void {
  const operator = redirectOperator(walk, node);
  const targetNode = targetNodeOf(node);
  if (operator === null || targetNode === null) {
    return;
  }
  const target = wordFactOf(targetNode, textOf(walk, targetNode));
  const base = baseRedirectFact(node, operator, owner, target);
  walk.drafts.redirects.push(
    node.type === "herestring_redirect"
      ? { ...base, bodySpan: target.span, delimiterQuoted: false }
      : base
  );
}

function emitHeredocFacts(
  walk: FactWalk,
  node: ShellFactNode,
  owner: number | null
): void {
  const operator = redirectOperator(walk, node);
  const delimiter = childOfType(node, "heredoc_start");
  const body = childOfType(node, "heredoc_body");
  if (operator === null || delimiter === null || body === null) {
    return;
  }
  const drafts = walk.drafts;
  const bodySpan = spanOf(body);
  const quoted = isDelimiterQuoted(textOf(walk, delimiter));
  const delimiterWord = wordFactOf(delimiter, textOf(walk, delimiter));
  const base = baseRedirectFact(node, operator, owner, delimiterWord);
  drafts.redirects.push({ ...base, bodySpan, delimiterQuoted: quoted });
  drafts.heredocs.push({
    bodySpan,
    delimiterQuoted: quoted,
    receiverCommandIndex: owner,
  });
  if (quoted) {
    drafts.inert.push(
      // The quoting flag is a fact about the delimiter, not about the
      // receiver: an ownerless entry is still a quoted body, and the
      // receiver rule downstream is what decides whether that makes it data.
      owner === null
        ? { delimiterQuoted: true, span: bodySpan, why: "heredoc-body" }
        : {
            delimiterQuoted: true,
            ownerCommandIndex: owner,
            span: bodySpan,
            why: "heredoc-body",
          }
    );
  }
}

function isDelimiterQuoted(delimiter: string): boolean {
  return /^['"]/.test(delimiter) || delimiter.startsWith("\\");
}

function emitInertFact(
  walk: FactWalk,
  node: ShellFactNode,
  ctx: FactContext,
  type: string
): void {
  const span = spanOf(node);
  const why: InertWhy = type === "comment" ? "comment" : "single-quoted";
  walk.drafts.inert.push(
    ctx.owner === null
      ? { span, why }
      : { ownerCommandIndex: ctx.owner, span, why }
  );
}

function finishFacts(walk: FactWalk): SecurityParseOkFacts {
  const drafts = walk.drafts;
  const substitutions = drafts.substitutions.map((site) => ({
    innerCommandIndex: firstCommandInside(drafts.commandSpans, site.span),
    kind: site.kind,
    ownerCommandIndex: site.owner,
    span: site.span,
  }));
  return {
    commands: drafts.commands,
    expansions: drafts.expansions,
    heredocs: drafts.heredocs,
    inert: drafts.inert,
    redirects: drafts.redirects,
    substitutions,
    words: [...drafts.words].sort(
      (left, right) => left.span.start - right.span.start
    ),
  };
}

function firstCommandInside(
  spans: readonly FactSpan[],
  site: FactSpan
): number | null {
  const from = firstStartAtOrAfter(spans, site.start);
  for (let index = from; index < spans.length; index += 1) {
    const span = spans[index];
    if (span.start >= site.end) {
      return null;
    }
    if (span.start > site.start && span.end <= site.end) {
      return index;
    }
  }
  return null;
}

function firstStartAtOrAfter(
  spans: readonly FactSpan[],
  start: number
): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (spans[middle].start < start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function faultName(fault: unknown): string {
  return fault instanceof Error ? fault.name : typeof fault;
}

function memoRead(command: string): SecurityParseResult | undefined {
  const hit = memo.get(command);
  if (hit !== undefined) {
    memo.delete(command);
    memo.set(command, hit);
  }
  return hit;
}

function memoEvictIfNeeded(): void {
  while (memo.size > MEMO_CAPACITY) {
    const oldest = memo.keys().next();
    if (oldest.done === true) {
      return;
    }
    memo.delete(oldest.value);
  }
}
