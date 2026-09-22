/**
 * TUI slash-command vocabulary, parsing, Tab completion and hint lines.
 * Pure TS: no ink / OpenTUI dependencies.
 *
 * Vocabulary: /sessions /new /quit /exit /help /info /thinking /effort /memory
 * /compact /continue /rewind /mcp /graph /config /model /yolo — VOCABULARY
 * below is the single source (don't duplicate the count here, it drifts).
 * /reset is absent from the vocabulary and thus unreachable.
 * - /config: ADR-0092 filesystem-isolation mode switch; value domain and copy
 *   live in harness/sandbox/fs-mode.ts; chat / TUI / serve share semantics.
 * - /graph: non-TTY peer of the graph-mode overlay; value domain and copy
 *   live in harness/graph/mode.ts; same three-entry semantics.
 * - /effort help text is derived from ADJUSTABLE_EFFORT_LEVELS (no second
 *   hardcoded list).
 * - Key binding: Esc = interrupt foreground turn (double-press = rewind),
 *   Ctrl+C = copy selection; the help footer follows this semantics.
 *
 * Parsing: trimmed input starting with "/" goes through the vocabulary;
 * miss → unknown (UI hint); otherwise → a plain message.
 *
 * Tab completion + candidate hints (live filtering):
 *  - slashSuggestions: prefix-filtered candidates in vocabulary order.
 *  - slashComplete: three-state — unique match → `/{cmd} `; no match → null;
 *    ≥2 matches → longest common prefix of candidate forms (returned only on
 *    progress, bash-style partial completion; see the function doc comment).
 *  - slashHintLines: one-line short descriptions for compact rendering below
 *    the input box.
 *
 * Skill entries (shared with the skill-catalog send path):
 *  - discriminated union `SlashCandidate` = static command | skill;
 *  - `slashSuggestions(input, skills?)` interleaves static commands (prefix
 *    filtered, always first) with skill names (case-insensitive prefix
 *    filter, after) — deterministic order;
 *  - `slashComplete(input, skills?)` completes across "static command +
 *    skill" on a unique match;
 *  - `parseSkillLoad(raw, skills)` exact skill-name hit → {name, remainder};
 *    hit on a static command / no match → undefined (static commands win).
 *    Send semantics live in app.tsx. SkillEntryLike is a minimal
 *    {name, description?, aliases?} projection so slash.ts does not depend
 *    on harness catalog types (flat objects can be injected in unit tests).
 *  - Bare-alias matching (spec tui-skill-slash-catalog): a skill matches by
 *    canonical name or unique bare alias (case-insensitive), but listing /
 *    display / completion always use the canonical name. The caller projects
 *    aliases from the catalog (`stripNamespace` + uniqueness check);
 *    slash.ts never splits `:` itself.
 */

import { THINKING_EFFORT_VALUES } from "../session-api/contract.js";
import type { ThinkingEffortWire } from "../session-api/contract.js";
import {
  slashHeadPrefix,
  slashTailRemainder,
} from "../harness/skill/catalog.js";

export type TuiSlashCommand =
  | "sessions"
  | "new"
  | "quit"
  | "exit"
  | "help"
  | "info"
  | "thinking"
  | "effort"
  | "memory"
  | "compact"
  | "continue"
  | "rewind"
  | "mcp"
  | "graph"
  | "config"
  | "model"
  | "yolo";

export type SlashParseResult =
  | { kind: "command"; command: TuiSlashCommand }
  | { kind: "unknown"; raw: string }
  | { kind: "message"; text: string };

/** Minimal skill projection (keeps slash.ts free of harness catalog types;
 *  callers pass a flat object shaped like skillCatalog.available()).
 *
 *  `aliases` (spec tui-skill-slash-catalog): the skill's *unique* bare-name
 *  alias, projected by the caller from the catalog (`stripNamespace` +
 *  `get(bare) === entry` uniqueness check). slash.ts only consumes it and
 *  never splits `:` itself. Absent / empty = no alias (not registered or
 *  dropped due to conflict). */
export interface SkillEntryLike {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
}

/** Slash candidate union: static command | skill.
 *  Order convention: static commands first, skills after (deterministic
 *  slashSuggestions output). The skill arm's `name` is always the canonical
 *  name (invariant 2: display and completion use `plugin:skill`);
 *  `aliases` only take part in matching / exactness checks — never listed. */
export type SlashCandidate =
  | { kind: "command"; command: TuiSlashCommand }
  | {
      kind: "skill";
      name: string;
      description?: string;
      aliases?: ReadonlyArray<string>;
    };

const VOCABULARY: ReadonlySet<string> = new Set<TuiSlashCommand>([
  "sessions",
  "new",
  "quit",
  "exit",
  "help",
  "info",
  "thinking",
  "effort",
  "memory",
  "compact",
  "continue",
  "rewind",
  "mcp",
  "graph",
  "config",
  "model",
  "yolo",
]);

/** Parse input-box content; empty / whitespace-only → message (callers ignore empty input). */
export function parseTuiInput(raw: string): SlashParseResult {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "message", text };
  const head = text.split(/\s+/, 1)[0] ?? text;
  const name = head.slice(1).toLowerCase();
  if (VOCABULARY.has(name)) {
    return { kind: "command", command: name as TuiSlashCommand };
  }
  return { kind: "unknown", raw: text };
}

/** /help vocabulary text (no emoji; user-visible copy is Chinese, matching
 *  the repo's usage style). Skill lines (`/<skill-name>  加载技能`) are
 *  spliced in by the caller and never join the static vocabulary; ordering
 *  here follows the same vocabulary order as slashSuggestions. */
export function helpLines(
  skillNames?: ReadonlyArray<string>
): ReadonlyArray<string> {
  const skillLines =
    skillNames !== undefined && skillNames.length > 0
      ? skillNames.map((name) => `/${name}  加载技能`)
      : [];
  return [
    "/sessions  打开会话列表（↑↓ 选择，Enter 打开，Esc 返回）",
    "/new       新建会话",
    "/mcp       查看 MCP 服务看板（r 重载，Esc 返回）",
    "/info      当前会话元信息",
    "/help      本词表",
    "/thinking  切换思考开关（开/关模型的思考）",
    `/effort    调整思考强度（${ADJUSTABLE_EFFORT_LEVELS.join("/")}；缺省/关闭=自适应）`,
    "/memory    自动记忆与 Dream 开关",
    "/compact   Compact context (keep tail, trim early messages)",
    "/continue  续跑未完成的工具环（不追加新任务）",
    "/rewind    回退到更早的回合（选择锚点后确认）",
    "/graph     图模式开关（on|off|status；下一次 run() 装配生效）",
    "/config    文件系统隔离档（status|fs global|fs workspace；下一次 bash 调用生效）",
    "/yolo      无沙箱模式开关（确认后切换；会话级不落盘）",
    "/model     切换模型（provider/model；下一轮生效）",
    "/quit      退出（别名 /exit）",
    ...skillLines,
    "Esc        打断前台运行中的 turn（双击回退到更早的回合）",
    "Ctrl+C     复制选中文本",
    "Ctrl+O     折叠/展开思考面板",
    "鼠标拖选    选中文本 → 右键复制到剪贴板",
  ];
}

/** One-line short descriptions (compact hint below the input box). */
const HINT_DESCRIPTIONS: Record<TuiSlashCommand, string> = {
  sessions: "打开会话列表",
  new: "新建会话",
  info: "当前会话元信息",
  help: "本词表",
  thinking: "切换思考开关",
  effort: "调整思考强度",
  memory: "自动记忆与 Dream 开关",
  compact: "Compact context",
  continue: "续跑未完成的工具环",
  mcp: "查看 MCP 服务看板",
  rewind: "回退到更早的回合",
  graph: "图模式开关（on|off|status）",
  config: "文件系统隔离档（status|fs global|fs workspace）",
  yolo: "无沙箱模式（确认后切换）",
  model: "切换模型",
  quit: "退出（别名 /exit）",
  exit: "同 /quit",
};

export interface SlashHintLine {
  readonly command: TuiSlashCommand;
  readonly description: string;
}

/** Lowercased first-token prefix (`/xxx...` -> `xxx`; empty / non-"/" -> "").
 *  Algorithm SSOT is the harness's `slashHeadPrefix`; this name is the
 *  established TUI-host export (consumed by app.tsx / tests). */
export function slashPrefix(text: string): string {
  return slashHeadPrefix(text);
}

/**
 * Enumerate all prefix-matched candidates for the current input (static
 * commands first, skills after — deterministic order). Skill matching is a
 * case-insensitive prefix filter. Empty / non-"/" input -> empty array.
 * Static commands keep the original vocabulary order (existing contracts
 * such as slashHintLines unchanged).
 *
 * Anti-overload: on an empty prefix (input is exactly "/") only static
 * commands are returned — a skill needs at least 1 typed character, so a
 * bare `/` never floods the screen with N long skill descriptions.
 *
 * This is the low-level "full candidate enumeration": it serves both
 * slashSuggestions (disambiguation filtering) and slashComplete (Tab needs
 * the LCP over the full set). Each caller owns its own filtering; no
 * branching happens here.
 */
function enumerateSlashCandidates(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): ReadonlyArray<SlashCandidate> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const prefix = slashPrefix(text);
  const out: SlashCandidate[] = [];
  // Empty prefix (input is exactly "/") -> all commands (startsWith("") is always true).
  for (const cmd of VOCABULARY) {
    if (cmd.startsWith(prefix)) {
      out.push({ kind: "command", command: cmd as TuiSlashCommand });
    }
  }
  // Empty prefix -> no skills; they join only after >=1 typed character.
  if (skills !== undefined && prefix.length > 0) {
    for (const skill of skills) {
      // A prefix hit on the canonical name or any bare alias admits the
      // skill, but emits exactly one canonical candidate — an alias is not a
      // second entry (duplicates would degrade a unique match into the >=2
      // LCP branch).
      if (skillHeadLowers(skill).some((head) => head.startsWith(prefix))) {
        out.push({
          kind: "skill",
          name: skill.name,
          description: skill.description,
          aliases: skill.aliases,
        });
      }
    }
  }
  return out;
}

/** All matchable lowercased first-token forms: canonical name + unique bare
 *  alias (spec invariant 3 — conflicting aliases are already dropped on the
 *  catalog side; this only consumes the projection). */
function skillHeadLowers(skill: SkillEntryLike): ReadonlyArray<string> {
  return [skill.name, ...(skill.aliases ?? [])].map((head) =>
    head.toLowerCase()
  );
}

/** Normalized "lowercased first-token name" set of a SlashCandidate (uniform
 *  check interface). The skill arm includes aliases — a typed bare name
 *  must count as an exact hit (invariant 2/3: exactness accepts bare,
 *  display stays canonical). */
function candidateHeadLowers(c: SlashCandidate): ReadonlyArray<string> {
  return c.kind === "command" ? [c.command] : skillHeadLowers(c);
}

/**
 * Candidates for the disambiguation UI, given the current input (static
 * commands first, skills after — deterministic order). The list serves
 * disambiguation only:
 *  - unique exact hit (typed first token === a candidate name) -> empty list
 *    (even with no longer siblings).
 *  - exact hit + remainder (name followed by space / extra text) -> empty
 *    list (even with longer siblings).
 *  - ambiguous prefix (no exact candidate; e.g. `/way` -> way-foo + way-bar)
 *    -> keep everything, including when remainder is non-empty (`/way now`
 *    still lists way-foo / way-bar — disambiguation isn't done).
 *  - exact hit with longer siblings -> show only the longer siblings, not
 *    the already-complete name.
 *  - case-insensitive (mixed-case `/ECHO` still matches echo).
 *
 * Tab completion (slashComplete) bypasses this filter — it is a separate
 * path that computes LCP over the full candidate set via
 * enumerateSlashCandidates directly.
 *
 * Same empty-prefix contract as enumeration: "/" lists static commands only;
 * slashComplete returns null for "/" (always multi-match).
 */
export function slashSuggestions(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): ReadonlyArray<SlashCandidate> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const remainder = slashRemainder(text);
  const matches = enumerateSlashCandidates(text, skills);
  if (matches.length === 0) return [];
  const prefixLower = slashPrefix(text);
  // Compute each candidate's lowercased head set once (two consumers per candidate: exactness + sibling filtering).
  const headLowers = matches.map((m) => candidateHeadLowers(m));
  // Whether any candidate is an exact hit for the typed prefix (case-insensitive; skill arms include bare aliases).
  const hasExact = headLowers.some((heads) => heads.includes(prefixLower));
  // 1) Exact hit + remainder -> the user has "moved on" (typed a full name
  //    then appended more); candidates no longer disambiguate, hide them all.
  //    Non-exact prefix + remainder is unaffected (prefix ambiguity is still
  //    a disambiguation scenario — only exact hits clear the list).
  if (remainder !== "" && hasExact) return [];
  if (!hasExact) return matches;
  // 3) Exact hit present -> drop that candidate, keep only longer siblings (still disambiguating).
  const out: SlashCandidate[] = [];
  for (const [i, m] of matches.entries()) {
    if (headLowers[i]!.includes(prefixLower)) continue;
    out.push(m);
  }
  return out;
}

/**
 * Longest common prefix of a string set (exact char comparison,
 * case-sensitive; empty array -> ""). Private to slashComplete's
 * multi-match partial completion.
 */
function longestCommonPrefix(forms: ReadonlyArray<string>): string {
  if (forms.length === 0) return "";
  let lcp = forms[0]!;
  for (let i = 1; i < forms.length && lcp !== ""; i++) {
    const form = forms[i]!;
    const end = Math.min(lcp.length, form.length);
    let j = 0;
    while (j < end && lcp[j] === form[j]) j++;
    lcp = lcp.slice(0, j);
  }
  return lcp;
}

/**
 * One Tab-completion result for the current input, shell-like three states:
 *  1) unique match -> `/{cmd} ` / `/{skillName} ` (trailing space; skill
 *     names may contain hyphens/dots, no escaping needed);
 *  2) 0 matches -> null;
 *  3) >=2 matches -> LCP over all candidate completion forms
 *     (`/{command}` / `/{skill.name}`, declared casing preserved), returned
 *     per progress rules (bash-style partial completion, no trailing space;
 *     remaining ambiguity is shown by the candidate UI):
 *       - LCP strictly longer than the typed form `/${slashPrefix(...)}` ->
 *         return LCP;
 *       - equal ignoring case but differing in case (typed form is always
 *         lowercase) -> return LCP (normalizes input to the declared casing,
 *         e.g. '/ECHO' -> '/Echo');
 *       - otherwise (no progress, e.g. '/e' vs exit/effort, bare '/' vs the
 *         whole vocabulary) -> null.
 *     Casing determinism: skill prefix matching is case-insensitive but LCP
 *     compares the declared casings char by char — the LCP of mixed-case
 *     candidates can be shorter than the theoretical case-insensitive common
 *     prefix; acceptable conservative behavior (under-complete rather than
 *     mis-complete).
 *
 * Guard: uses the full candidate enumeration (enumerateSlashCandidates),
 * NOT slashSuggestions' disambiguation filter — even when the typed token is
 * an exact hit (e.g. `/echo`), Tab still completes to `/{name} ` with a
 * trailing space. Remainder already typed -> null.
 */
export function slashComplete(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): string | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
  const remainder = slashRemainder(text);
  if (remainder !== "") return null;
  const matches = enumerateSlashCandidates(text, skills);
  if (matches.length === 0) return null;
  const forms = matches.map((m) =>
    m.kind === "command" ? `/${m.command}` : `/${m.name}`
  );
  if (matches.length === 1) return `${forms[0]!} `;
  // The typed first token is an exact hit of some candidate
  // (case-insensitive, skill arms include bare aliases) and longer siblings
  // exist (matches.length >= 2) -> Tab completes that candidate's canonical
  // name (with trailing space), not the LCP (LCP === typedForm: no progress).
  const typedForm = `/${slashPrefix(text)}`;
  const typedLower = slashPrefix(text);
  const exactIndex = matches.findIndex((m) =>
    candidateHeadLowers(m).includes(typedLower)
  );
  if (exactIndex !== -1) return `${forms[exactIndex]!} `;
  const lcp = longestCommonPrefix(forms);
  if (
    lcp.length > typedForm.length ||
    (lcp.toLowerCase() === typedForm.toLowerCase() && lcp !== typedForm)
  ) {
    // Partial completion: no trailing space (ambiguity remains; wait for next Tab or pick via down-arrow).
    return lcp;
  }
  return null;
}

/**
 * Parse `/skill-name [prompt]`. Trimmed input starting with "/": if the
 * first token `xxx` exactly hits a skill's canonical name or unique bare
 * alias (spec tui-skill-slash-catalog invariant 3) -> return
 * `{ name, remainder }` (`name` is always the canonical name, invariant 2;
 * remainder = what follows the first token, possibly empty). Hit on a static
 * slash command / no match -> undefined (static commands win, invariant 4).
 * Orthogonal to parseTuiInput's command/unknown/message discrimination: a
 * skill name is not in the static vocabulary and parseTuiInput would only
 * call it unknown — callers dispatch through this function *before*
 * parseTuiInput.
 */
export function parseSkillLoad(
  raw: string,
  skills: ReadonlyArray<SkillEntryLike>
): { name: string; remainder: string } | undefined {
  const text = raw.trim();
  const prefix = slashPrefix(text);
  if (prefix === "") return undefined;
  if (VOCABULARY.has(prefix)) return undefined;
  for (const skill of skills) {
    // Exact hit on canonical name or bare alias (case-insensitive, same
    // semantics as slashSuggestions' prefix filter). Return the declared
    // skill.name so display keeps the original casing and later catalog.get
    // receives the canonical name, not the user-typed bare one.
    if (skillHeadLowers(skill).includes(prefix)) {
      // invariant 5: slice remainder by the *input token* length
      // (slashRemainder is that single implementation) — using
      // skill.name.length would eat into the remainder on bare-alias input.
      return { name: skill.name, remainder: slashRemainder(text) };
    }
  }
  return undefined;
}

/**
 * /effort: adjustable thinking-effort levels (derived from SSOT — no second
 * hardcoded list). Reuses contract.ts's THINKING_EFFORT_VALUES (which
 * includes ""=adaptive) and filters the adaptive level out: /effort lets
 * users pick only concrete levels (low/medium/high/xhigh/max); default /
 * off falls back to adaptive, ""/auto is never offered.
 */
export const ADJUSTABLE_EFFORT_LEVELS: ReadonlyArray<
  Exclude<ThinkingEffortWire, "">
> = THINKING_EFFORT_VALUES.filter(
  (v): v is Exclude<ThinkingEffortWire, ""> => v !== ""
);

/**
 * /effort: parse the level part of `/effort <level>` (the remainder after
 * the first token). Same remainder pattern as parseSkillLoad: take what
 * follows the first token -> trim -> toLowerCase -> must hit
 * ADJUSTABLE_EFFORT_LEVELS (concrete levels only, no "").
 * Empty / missing / out-of-set -> undefined.
 */
export function parseEffortLevel(raw: string): ThinkingEffortWire | undefined {
  const text = raw.trim();
  const firstTok = text.split(/\s+/, 1)[0] ?? text;
  const rest = text.slice(firstTok.length).trim();
  const level = rest.toLowerCase();
  if (level === "") return undefined;
  return (ADJUSTABLE_EFFORT_LEVELS as readonly string[]).includes(level)
    ? (level as ThinkingEffortWire)
    : undefined;
}

/**
 * The (trimmed) segment after the first token. Shared slicing for
 * `/effort <level>`, `/continue` and `/graph on`. Algorithm SSOT is the
 * harness's `slashTailRemainder`.
 */
export function slashRemainder(raw: string): string {
  return slashTailRemainder(raw);
}

/**
 * Shared by `/effort` and `/continue`: whether anything follows the first
 * token. /effort must tell "no arg" (open panel) from an invalid level;
 * /continue exits with a usage error on any args.
 */
export function slashHasArg(raw: string): boolean {
  return slashRemainder(raw) !== "";
}

export function effortHasArg(raw: string): boolean {
  return slashHasArg(raw);
}

/**
 * Complete by candidate list + selected index (used by PromptInput's
 * internal hintCursor). Out-of-range cursor / empty list -> null. The
 * `/{cmd} ` form matches slashComplete, so callers can overwrite inputValue
 * directly.
 */
export function slashCompleteFromList(
  suggestions: ReadonlyArray<TuiSlashCommand>,
  cursor: number
): string | null {
  if (suggestions.length === 0) return null;
  if (cursor < 0 || cursor >= suggestions.length) return null;
  const cmd = suggestions[cursor]!;
  return `/${cmd} `;
}

/** SlashCandidate version of cursor-based completion (static command |
 *  skill). Same semantics as slashCompleteFromList; skill names kept as
 *  declared (hyphens/dots included). */
export function slashCompleteFromCandidates(
  suggestions: ReadonlyArray<SlashCandidate>,
  cursor: number
): string | null {
  if (suggestions.length === 0) return null;
  if (cursor < 0 || cursor >= suggestions.length) return null;
  const candidate = suggestions[cursor]!;
  return candidate.kind === "command"
    ? `/${candidate.command} `
    : `/${candidate.name} `;
}

/** Build one-line hint rows (command + short description) for candidates; rendering is the caller's job. */
export function slashHintLines(
  suggestions: ReadonlyArray<TuiSlashCommand>
): ReadonlyArray<SlashHintLine> {
  const desc = HINT_DESCRIPTIONS satisfies Record<TuiSlashCommand, string>;
  return suggestions.map((command) => ({
    command,
    description: desc[command],
  }));
}

/**
 * Expose the candidate short descriptions (for PromptInput's internal hint
 * rendering; external callers may still go through slashHintLines).
 */
export const SLASH_HINT_DESCRIPTIONS: Readonly<
  Record<TuiSlashCommand, string>
> = HINT_DESCRIPTIONS;
