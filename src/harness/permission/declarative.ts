/**
 * src/harness/permission/declarative.ts
 *
 * Declarative project permission rule compiler (ticket #1004 / ADR-0090).
 *
 * Translates the operator-facing `permissions` section of
 * `<projectIdentityRoot>/.iknow/settings.json` — the flat `allow` / `ask` /
 * `deny` lists of `Tool` / `Tool(specifier)` strings — into the
 * `NormalRuleSpec[]` that plug into the project layer of the permission
 * three-tier policy. Schema validation and fail-loud live in
 * `project-settings.ts`; this module owns rule parsing, group ordering, and
 * the match closures evaluated at permission-check time.
 *
 * Match contracts:
 *  - Bash family: split the command on `;` / `&&` / `||` / `|` / `&` /
 *    newline, strip fixed wrappers per segment, then require every surviving
 *    segment to match the command glob (AND semantics). Trailing `:*` means
 *    "optionally a space then anything".
 *  - Read / Edit families: gitignore-style path glob against the tool's path
 *    field. Read-family deny also covers `edit_file` / `write_file` for the
 *    same path (new-file creation included); ask / allow do not widen.
 *  - WebFetch family: `domain:<host>` with `*` wildcard.
 *  - Everything else is a literal ACI tool name: bare names match the tool
 *    name; `param:value` matches a top-level scalar input field and is
 *    deny/ask only. Specifiers naming a primary content field (Bash
 *    `command`, Read/Edit path, WebFetch `url`) and path-style specifiers on
 *    non-family tools are rejected at compile time with a warning.
 *
 * `Bash(network:true|false|*)` is a `param:value` rule on a non-primary
 * scalar field (the Bash family shares the deny/ask-only contract above):
 * it is the declarative equivalent of the code-layer
 * `code-ask-bash-network` eligibility gate, inherited from the retired
 * `network_equals` predicate. `allow` is rejected for it per the spec.
 *
 * Match closures are pure: they never throw and return `false` on malformed
 * runtime input (schema violations are already fail-loud at load time).
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { NormalRuleSpec, PermissionDecision } from "./types.js";

/* -----------------------------------------------------------------------------
 * Public compilation entry
 * -------------------------------------------------------------------------- */

export interface DeclarativeCompileOpts {
  /**
   * Relative-path anchor — the project work root (the assembly sandbox root
   * in both engines). Also the default for `projectIdentityRoot`.
   */
  readonly workRoot: string;
  /**
   * Anchor for patterns starting with a single `/` (ADR-0037 §4 project
   * identity root). Defaults to `workRoot` when absent.
   */
  readonly projectIdentityRoot?: string;
  /** Home directory for `~/...` expansion; defaults to `os.homedir()`. */
  readonly home?: string;
  /**
   * Known tool names for the unknown-tool deny/ask warning. Absent → the
   * warning is skipped (dynamic MCP tools may register after load).
   */
  readonly knownToolNames?: ReadonlySet<string>;
  /** Diagnostic sink; defaults to `console.warn`. */
  readonly onWarn?: (message: string) => void;
}

/**
 * Compile one `permissions` section into project-layer rules.
 *
 * Order: deny group (file order) → ask group → allow group. The policy
 * engine walks the project layer in array order with first-match-wins, so
 * deny must precede allow (`policy.ts#checkPermission`). `id` / `reason` are
 * generated here — the file never carries them, and `id` embeds no
 * operator-supplied string (injection / length safety).
 */
export function compileDeclarativePermissions(
  section: {
    readonly allow?: readonly string[];
    readonly ask?: readonly string[];
    readonly deny?: readonly string[];
  },
  opts: DeclarativeCompileOpts
): ReadonlyArray<NormalRuleSpec> {
  const ctx: CompileCtx = {
    workRoot: opts.workRoot,
    projectIdentityRoot: opts.projectIdentityRoot ?? opts.workRoot,
    home: opts.home ?? homedir(),
    knownToolNames: opts.knownToolNames,
    onWarn: opts.onWarn ?? ((message: string) => console.warn(message)),
  };
  const rules: NormalRuleSpec[] = [
    ...compileGroup(section.deny, "deny", ctx),
    ...compileGroup(section.ask, "ask", ctx),
    ...compileGroup(section.allow, "allow", ctx),
  ];
  return Object.freeze(rules);
}

interface CompileCtx {
  readonly workRoot: string;
  readonly projectIdentityRoot: string;
  readonly home: string;
  readonly knownToolNames: ReadonlySet<string> | undefined;
  readonly onWarn: (message: string) => void;
}

/* -----------------------------------------------------------------------------
 * Group compilation
 * -------------------------------------------------------------------------- */

function compileGroup(
  entries: readonly string[] | undefined,
  decision: PermissionDecision,
  ctx: CompileCtx
): NormalRuleSpec[] {
  if (entries === undefined || entries.length === 0) return [];
  const out: NormalRuleSpec[] = [];
  let index = 0;
  for (const entry of entries) {
    index += 1;
    if (typeof entry !== "string") continue;
    const parsed = parseRuleString(entry);
    if (parsed === undefined) {
      ctx.onWarn(
        `[permissions] ignore ${decision} rule ${JSON.stringify(entry)}: malformed syntax`
      );
      continue;
    }
    const match = buildMatcher(parsed, decision, ctx);
    if (match === undefined) continue; // warning already emitted
    out.push(
      Object.freeze({
        id: `project-${decision}-${index}`,
        match,
        decision,
        reason: `project settings: ${decision} ${formatRule(parsed)}`,
      })
    );
  }
  return out;
}

interface ParsedRule {
  /** Tool name as written (trimmed); family resolution is case-insensitive. */
  readonly toolName: string;
  /** `undefined` covers both bare `Tool` and `Tool(*)`. */
  readonly specifier: string | undefined;
}

const RULE_PATTERN = /^([^()]+?)(?:\(([\s\S]*)\))?$/;

function parseRuleString(raw: string): ParsedRule | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parts = RULE_PATTERN.exec(trimmed);
  if (parts === null) return undefined;
  const toolName = (parts[1] ?? "").trim();
  if (toolName.length === 0) return undefined;
  const inside = (parts[2] ?? "").trim();
  return {
    toolName,
    specifier: inside.length === 0 || inside === "*" ? undefined : inside,
  };
}

function formatRule(rule: ParsedRule): string {
  return rule.specifier === undefined
    ? rule.toolName
    : `${rule.toolName}(${rule.specifier})`;
}

/* -----------------------------------------------------------------------------
 * Matcher factory
 * -------------------------------------------------------------------------- */

const FAMILY_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "edit",
  "webfetch",
]);

function isFamilyName(toolName: string): boolean {
  return FAMILY_NAMES.has(toolName.toLowerCase());
}

function buildMatcher(
  rule: ParsedRule,
  decision: PermissionDecision,
  ctx: CompileCtx
): NormalRuleSpec["match"] | undefined {
  const familyName = isFamilyName(rule.toolName)
    ? (rule.toolName.toLowerCase() as "bash" | "read" | "edit" | "webfetch")
    : undefined;

  if (familyName === undefined) {
    return buildLiteralToolMatcher(rule, decision, ctx);
  }
  if (rule.specifier === undefined) {
    return makeToolMatcher(familyName, decision);
  }
  if (familyName === "bash") {
    return buildBashMatcher(rule.specifier, decision, ctx);
  }
  if (familyName === "read" || familyName === "edit") {
    return buildPathMatcher(familyName, rule.specifier, decision, ctx);
  }
  return buildDomainMatcher(rule.specifier, ctx);
}

/** Tool-name matcher for a family (Read deny covers the write side). */
function makeToolMatcher(
  family: "bash" | "read" | "edit" | "webfetch",
  decision: PermissionDecision
): NormalRuleSpec["match"] {
  const members = familyMembers(family, decision, false);
  return ({ tool }) => members.includes(tool);
}

/**
 * Members covered by a family rule.
 *
 * `Read` + deny + path specifier widens to the write tools for the same
 * path (same path matcher), so `Read(.env)` deny also blocks writing
 * `.env`. ask / allow never widen.
 */
function familyMembers(
  family: "bash" | "read" | "edit" | "webfetch",
  decision: PermissionDecision,
  hasPathSpecifier: boolean
): ReadonlyArray<string> {
  if (family === "bash") return ["bash"];
  if (family === "webfetch") return ["web_fetch"];
  if (family === "edit") return ["edit_file", "write_file"];
  return decision === "deny" && hasPathSpecifier
    ? ["read_file", "grep", "glob", "edit_file", "write_file"]
    : ["read_file", "grep", "glob"];
}

/* -----------------------------------------------------------------------------
 * Literal tool names (incl. tool-name globs and param:value)
 * -------------------------------------------------------------------------- */

function buildLiteralToolMatcher(
  rule: ParsedRule,
  decision: PermissionDecision,
  ctx: CompileCtx
): NormalRuleSpec["match"] | undefined {
  const name = rule.toolName;
  const glob = compileToolNameGlob(name, decision, ctx);
  if (glob === null) return undefined; // warned
  if (glob !== undefined) {
    if (rule.specifier !== undefined) {
      // A glob in the tool-name slot must not silently become an
      // over-broad rule with a specifier attached — drop it loudly.
      ctx.onWarn(
        `[permissions] ignore ${decision} rule ${JSON.stringify(formatRule(rule))}: tool-name globs do not take a specifier`
      );
      return undefined;
    }
    return ({ tool }) => glob(tool);
  }
  if (rule.specifier === undefined) {
    if (decision !== "allow" && !isKnownToolName(name, ctx)) {
      ctx.onWarn(
        `[permissions] unknown tool name ${JSON.stringify(name)} in ${decision} rule; kept for dynamic MCP registration`
      );
    }
    return ({ tool }) => tool === name;
  }
  return buildParamValueMatcher(name, rule.specifier, decision, ctx);
}

/**
 * Recognise the tool-name slot when it is a glob.
 *
 *  - `*` / `mcp__*` → deny / ask only (a single allow rule must not open
 *    every tool); allow gets a warning and the rule is dropped.
 *  - `mcp__<server>__*` (server segment glob-free) → any decision.
 *  - any other `*`-bearing name → dropped with a warning.
 *
 * Returns `undefined` when the name is a plain literal (caller continues),
 * `null` when the rule was rejected, or a tool predicate.
 */
function compileToolNameGlob(
  name: string,
  decision: PermissionDecision,
  ctx: CompileCtx
): ((tool: string) => boolean) | null | undefined {
  if (name === "*") {
    if (decision === "allow") return rejectAllowGlob(name, ctx);
    return () => true;
  }
  if (name === "mcp__*") {
    if (decision === "allow") return rejectAllowGlob(name, ctx);
    return (tool) => tool.startsWith("mcp__");
  }
  if (!name.includes("*")) return undefined;
  const serverPrefix = mcpServerGlobPrefix(name);
  if (serverPrefix !== undefined)
    return (tool) => tool.startsWith(serverPrefix);
  ctx.onWarn(
    `[permissions] ignore ${decision} rule ${JSON.stringify(name)}: unsupported tool-name glob`
  );
  return null;
}

function rejectAllowGlob(name: string, ctx: CompileCtx): null {
  ctx.onWarn(
    `[permissions] ignore allow rule ${JSON.stringify(name)}: allow tool-name globs must be "mcp__<server>__*"`
  );
  return null;
}

/** `mcp__<server>__*` → `mcp__<server>__` when the server segment is glob-free. */
function mcpServerGlobPrefix(name: string): string | undefined {
  if (!name.startsWith("mcp__") || !name.endsWith("__*")) return undefined;
  const middle = name.slice("mcp__".length, -"__*".length);
  if (middle.length === 0 || middle.includes("*")) return undefined;
  return name.slice(0, -1);
}

function isKnownToolName(name: string, ctx: CompileCtx): boolean {
  return ctx.knownToolNames === undefined || ctx.knownToolNames.has(name);
}

/** Primary content fields — never addressable through `param:value`. */
const PRIMARY_FIELDS: ReadonlySet<string> = new Set([
  "command",
  "url",
  "path",
  "file",
  "filepath",
  "file_path",
]);

const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildParamValueMatcher(
  toolName: string,
  specifier: string,
  decision: PermissionDecision,
  ctx: CompileCtx
): NormalRuleSpec["match"] | undefined {
  const colon = specifier.indexOf(":");
  const param = colon >= 0 ? specifier.slice(0, colon) : "";
  if (colon < 0 || !PARAM_NAME_PATTERN.test(param)) {
    // No usable param:value shape → a path-style specifier on a tool that
    // has no path semantics. Warn and drop (never silently become a
    // tool-name-only rule).
    ctx.onWarn(
      `[permissions] ignore ${JSON.stringify(`${toolName}(${specifier})`)}: ` +
        `path rules only apply to the Read/Edit/Bash/WebFetch families`
    );
    return undefined;
  }
  const value = specifier.slice(colon + 1);
  if (PRIMARY_FIELDS.has(param)) {
    ctx.onWarn(
      `[permissions] ignore ${JSON.stringify(`${toolName}(${specifier})`)}: ` +
        `"${param}" is a primary content field; use a family rule instead`
    );
    return undefined;
  }
  if (decision === "allow") {
    ctx.onWarn(
      `[permissions] ignore allow rule ${JSON.stringify(`${toolName}(${specifier})`)}: param:value is deny/ask only`
    );
    return undefined;
  }
  return ({ tool, input }) => {
    if (tool !== toolName) return false;
    const obj = asRecord(input);
    if (obj === null) return false;
    return scalarEquals(obj[param], value);
  };
}

/**
 * Scalar comparison for `param:value`:
 *  - `*` → the field exists and is a scalar (string | number | boolean)
 *  - the literals `true` / `false` address a **boolean** field; a string
 *    field holding `"true"` deliberately does not match, mirroring the
 *    strict `=== true` semantics of the bash network gate (a rule meant as
 *    a typed eligibility gate must not fire on a differently-typed value
 *    the code layer treats as absent)
 *  - string field → strict string equality
 *  - number field → `String(n) === value`
 *  - missing / non-scalar field → false
 */
function scalarEquals(actual: unknown, expected: string): boolean {
  if (expected === "*") {
    return (
      typeof actual === "string" ||
      typeof actual === "number" ||
      typeof actual === "boolean"
    );
  }
  if (expected === "true" || expected === "false") {
    return typeof actual === "boolean" && String(actual) === expected;
  }
  if (typeof actual === "string") return actual === expected;
  if (typeof actual === "number") return String(actual) === expected;
  return false;
}

/* -----------------------------------------------------------------------------
 * Bash specifier
 * -------------------------------------------------------------------------- */

function buildBashMatcher(
  specifier: string,
  decision: PermissionDecision,
  ctx: CompileCtx
): NormalRuleSpec["match"] | undefined {
  if (specifier.startsWith("network:")) {
    // Spec Does: "allow 不走 param:value". The Bash family takes the same
    // rule; `network:true|false|*` is the legacy eligibility gate for
    // code-ask-bash-network, expressed here so existing project-side
    // denials migrate without losing the ask fence.
    if (decision === "allow") {
      ctx.onWarn(
        `[permissions] ignore allow rule ${JSON.stringify(`Bash(${specifier})`)}: param:value is deny/ask only`
      );
      return undefined;
    }
    const expected = specifier.slice("network:".length);
    if (expected !== "true" && expected !== "false" && expected !== "*") {
      ctx.onWarn(
        `[permissions] ignore bash rule ${JSON.stringify(specifier)}: network value must be true|false|*`
      );
      return undefined;
    }
    return ({ tool, input }) => {
      if (tool !== "bash") return false;
      const obj = asRecord(input);
      if (obj === null) return false;
      return scalarEquals(obj["network"], expected);
    };
  }
  if (specifier.startsWith("command:")) {
    ctx.onWarn(
      `[permissions] ignore bash rule ${JSON.stringify(specifier)}: "command" is a primary content field; write the command glob directly`
    );
    return undefined;
  }
  const pattern = compileCommandPattern(specifier);
  return ({ tool, input }) => {
    if (tool !== "bash") return false;
    const obj = asRecord(input);
    if (obj === null) return false;
    const command = obj["command"];
    if (typeof command !== "string") return false;
    return pattern(command);
  };
}

/**
 * `git status:*` ≡ `git status` optionally followed by a space and anything;
 * `*` anywhere else is a plain wildcard. Returns the full-command predicate.
 *
 * Segmentation is deliberately quote-blind (mirrors
 * `hard-walls.splitShellSegments`' conservative stance): separators inside
 * quotes still split, so such a command simply fails to match — the safe
 * direction for a permission rule.
 */
function compileCommandPattern(
  specifier: string
): (command: string) => boolean {
  const regex = commandGlobToRegex(specifier);
  return (command) => {
    const segments = splitCommandSegments(command);
    if (segments.length === 0) return false;
    for (const segment of segments) {
      const stripped = stripWrappers(segment);
      if (stripped === null) return false;
      if (!regex.test(stripped)) return false;
    }
    return true;
  };
}

function commandGlobToRegex(pattern: string): RegExp {
  let body = pattern;
  let tail = "";
  if (body.endsWith(":*")) {
    body = body.slice(0, -2);
    tail = "( .*)?";
  }
  let source = "";
  for (const ch of body) {
    source += ch === "*" ? ".*" : escapeRegexChar(ch);
  }
  return new RegExp(`^${source}${tail}$`);
}

function escapeRegexChar(ch: string): string {
  return /[\\^$.+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Split a command on `;` / `&&` / `||` / `|` / `&` / `\n` / `\r`.
 *
 * Intentionally distinct from `hard-walls.splitShellSegments`:
 *  - declarative adds `&` (any-depth `&` between commands), `|&` (treated
 *    as a unit boundary by the spec), and `\n` / `\r` as separators;
 *  - `hard-walls.splitShellSegments` only splits on `;` / `&&` / `||` /
 *    `|` because the dangerous-pattern scan is conservative — keeping
 *    newlines and bare `&` inside a single segment lets existing
 *    substring patterns keep matching commands like `echo a & rm -rf /`.
 *
 * Reusing the hard-walls splitter here would weaken the spec Does rule
 * that compound commands (`&`, `|&`, newlines) require every segment to
 * match, so the two implementations stay separate. Backslash escapes are
 * kept literal in both; quoted separators are not exempted (mirrors the
 * hard-walls conservative stance — quoted metachars fail to match rather
 * than silently bypass).
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "\\" && i + 1 < command.length) {
      buf += ch + command[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      if (buf.length > 0) segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) segments.push(buf);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

const DURATION_PATTERN = /^\d+(?:\.\d+)?[smhd]?$/;
const INTEGER_PATTERN = /^\d+$/;
const MAX_WRAPPER_ROUNDS = 8;

/**
 * Strip fixed leading wrappers from one command segment. Returns the
 * remaining payload, or `null` when the segment has no command left.
 *
 * Wrapper handling is table-driven: each stripper owns the rules for one
 * wrapper name; the main loop only does "look up → apply → continue".
 * Behaviour parity with the original if/else chain:
 *   - SIMPLE_WRAPPERS (time, nohup, builtin, noglob, command): drop head.
 *   - nice [-n INT]: drop head + optional `-n` + integer.
 *   - stdbuf [-FLAG]: drop head + optional single-token flag.
 *   - timeout [-FLAG] DURATION: drop head + optional single-token flag +
 *     duration matching DURATION_PATTERN.
 *   - xargs (flag-free only): drop head iff the next token does NOT start
 *     with `-`; `xargs -0 …` is preserved so the rule does not match.
 * `MAX_WRAPPER_ROUNDS` (8) caps chained wrappers; the loop exits with the
 * current payload otherwise (mirrors the original "fall through and
 * return" behaviour).
 */
function stripWrappers(segment: string): string | null {
  let tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  for (let round = 0; round < MAX_WRAPPER_ROUNDS; round += 1) {
    const head = tokens[0]!;
    const stripper = WRAPPER_STRIPPERS.get(head);
    if (stripper === undefined) break;
    const next = stripper(tokens);
    if (next === null) break;
    tokens = next;
  }
  return tokens.length > 0 ? tokens.join(" ") : null;
}

type WrapperStripper = (tokens: string[]) => string[] | null;

/**
 * A `Map` (not a plain object) so an arbitrary first token can never hit
 * `Object.prototype` members (`constructor`, `toString`, …) and be called
 * as a stripper.
 */
const WRAPPER_STRIPPERS: ReadonlyMap<string, WrapperStripper> = new Map<
  string,
  WrapperStripper
>([
  ...["time", "nohup", "builtin", "noglob", "command"].map(
    (name) => [name, dropHead] as const
  ),
  [
    "nice",
    (tokens: string[]) => {
      let t = tokens.slice(1);
      if (t[0]?.startsWith("-") === true) {
        t = t.slice(1);
        if (INTEGER_PATTERN.test(t[0] ?? "")) t = t.slice(1);
      }
      return t;
    },
  ],
  [
    "stdbuf",
    (tokens: string[]) => {
      let t = tokens.slice(1);
      if (t[0]?.startsWith("-") === true) t = t.slice(1);
      return t;
    },
  ],
  [
    "timeout",
    (tokens: string[]) => {
      let t = tokens.slice(1);
      if (t[0]?.startsWith("-") === true) t = t.slice(1);
      if (DURATION_PATTERN.test(t[0] ?? "")) t = t.slice(1);
      return t;
    },
  ],
  [
    "xargs",
    (tokens: string[]) => {
      // Only the flag-free form is a wrapper; `xargs -0 …` changes
      // argument semantics and is left in place (conservative no-match).
      if (tokens[1]?.startsWith("-") === true) return null;
      return tokens.slice(1);
    },
  ],
]);

function dropHead(tokens: string[]): string[] {
  return tokens.slice(1);
}

/* -----------------------------------------------------------------------------
 * Path specifiers (Read / Edit families)
 * -------------------------------------------------------------------------- */

type PathAnchor = "absolute" | "home" | "projectRoot" | "workRoot";

function buildPathMatcher(
  family: "read" | "edit",
  specifier: string,
  decision: PermissionDecision,
  ctx: CompileCtx
): NormalRuleSpec["match"] | undefined {
  const compiled = compilePathPattern(specifier, decision, ctx);
  if (compiled === undefined) {
    ctx.onWarn(
      `[permissions] ignore ${decision} rule ${JSON.stringify(`${family === "read" ? "Read" : "Edit"}(${specifier})`)}: empty path pattern`
    );
    return undefined;
  }
  const members = familyMembers(family, decision, true);
  return ({ tool, input }) => {
    if (!members.includes(tool)) return false;
    const subject = subjectPath(tool, input, ctx);
    if (subject === null) return false;
    return compiled(subject);
  };
}

interface CompiledPathPattern {
  (subjectAbsolute: string): boolean;
}

function compilePathPattern(
  specifier: string,
  decision: PermissionDecision,
  ctx: CompileCtx
): CompiledPathPattern | undefined {
  const normalized = specifier.replace(/\\/g, "/");
  let anchor: PathAnchor = "workRoot";
  let body = normalized;
  if (normalized.startsWith("//")) {
    anchor = "absolute";
    body = normalized.slice(1);
  } else if (normalized.startsWith("~/")) {
    anchor = "home";
    body = normalized.slice(2);
  } else if (normalized.startsWith("/")) {
    anchor = "projectRoot";
    body = normalized.slice(1);
  }
  const segments = body.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  const hasSlash = body.includes("/");
  // deny/ask patterns are any-depth unless written against a filesystem
  // absolute path; allow must opt in with an explicit `**/` prefix.
  const anyDepth = anchor !== "absolute" && (decision !== "allow" || !hasSlash);
  const pattern: PathSegment[] = [
    ...(anyDepth ? [{ kind: "dstar" } as const] : []),
    ...segments.map(compilePathSegment),
  ];
  const anchorRoot = anchorRootFor(anchor, ctx);
  return (subjectAbsolute) => {
    const subjectSegments = subjectSegmentsFor(
      subjectAbsolute,
      anchor,
      anchorRoot
    );
    if (subjectSegments === null) return false;
    return matchPathSegments(subjectSegments, pattern, 0, 0);
  };
}

function anchorRootFor(anchor: PathAnchor, ctx: CompileCtx): string {
  if (anchor === "home") return ctx.home;
  if (anchor === "projectRoot") return ctx.projectIdentityRoot;
  return ctx.workRoot;
}

function subjectSegmentsFor(
  subjectAbsolute: string,
  anchor: PathAnchor,
  anchorRoot: string
): string[] | null {
  if (anchor === "absolute") {
    return subjectAbsolute.split(sep).filter((s) => s.length > 0);
  }
  const rel = relative(anchorRoot, subjectAbsolute);
  if (rel.length === 0) return [];
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).filter((s) => s.length > 0);
}

type PathSegment =
  | { readonly kind: "dstar" }
  | { readonly kind: "glob"; readonly test: (segment: string) => boolean };

function compilePathSegment(segment: string): PathSegment {
  if (segment === "**") return { kind: "dstar" };
  let source = "";
  for (const ch of segment) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += escapeRegexChar(ch);
  }
  const regex = new RegExp(`^${source}$`);
  return { kind: "glob", test: (s) => regex.test(s) };
}

function matchPathSegments(
  subject: ReadonlyArray<string>,
  pattern: ReadonlyArray<PathSegment>,
  si: number,
  pi: number
): boolean {
  if (pi === pattern.length) return si === subject.length;
  const segment = pattern[pi]!;
  if (segment.kind === "dstar") {
    for (let skip = 0; si + skip <= subject.length; skip += 1) {
      if (matchPathSegments(subject, pattern, si + skip, pi + 1)) return true;
    }
    return false;
  }
  if (si === subject.length) return false;
  if (!segment.test(subject[si]!)) return false;
  return matchPathSegments(subject, pattern, si + 1, pi + 1);
}

/**
 * Resolve the absolute subject path for a tool call.
 *
 *  - `read_file` / `edit_file` / `write_file` / `grep` / `glob` read
 *    `input.path`; `grep` / `glob` default to `"."` (the work root) when
 *    the field is absent.
 *  - Non-string / non-object input → `null` (never matches).
 *  - `~/` expands; relative paths resolve against the work root.
 */
function subjectPath(
  tool: string,
  input: unknown,
  ctx: CompileCtx
): string | null {
  const obj = asRecord(input);
  if (obj === null) return null;
  const raw = obj["path"];
  if (typeof raw !== "string") {
    if ((tool === "grep" || tool === "glob") && raw === undefined) {
      return ctx.workRoot;
    }
    return null;
  }
  if (raw.startsWith("~/")) return resolve(ctx.home, raw.slice(2));
  if (isAbsolute(raw)) return raw;
  return resolve(ctx.workRoot, raw);
}

/* -----------------------------------------------------------------------------
 * WebFetch domain specifier
 * -------------------------------------------------------------------------- */

const DOMAIN_PREFIX = "domain:";

function buildDomainMatcher(
  specifier: string,
  ctx: CompileCtx
): NormalRuleSpec["match"] | undefined {
  if (!specifier.toLowerCase().startsWith(DOMAIN_PREFIX)) {
    ctx.onWarn(
      `[permissions] ignore webfetch rule ${JSON.stringify(specifier)}: specifier must be "domain:<host>"`
    );
    return undefined;
  }
  const hostPattern = specifier.slice(DOMAIN_PREFIX.length).trim();
  if (hostPattern.length === 0) {
    ctx.onWarn(
      `[permissions] ignore webfetch rule ${JSON.stringify(specifier)}: empty host pattern`
    );
    return undefined;
  }
  if (hostPattern === "*") {
    return ({ tool, input }) => tool === "web_fetch" && hostOf(input) !== null;
  }
  let source = "";
  for (const ch of hostPattern) {
    source += ch === "*" ? ".*" : escapeRegexChar(ch);
  }
  const regex = new RegExp(`^${source}$`, "i");
  return ({ tool, input }) => {
    if (tool !== "web_fetch") return false;
    const host = hostOf(input);
    if (host === null) return false;
    return regex.test(host);
  };
}

function hostOf(input: unknown): string | null {
  const obj = asRecord(input);
  if (obj === null) return null;
  const url = obj["url"];
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    return parsed.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * Shared helpers
 * -------------------------------------------------------------------------- */

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}
