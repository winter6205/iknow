/**
 * src/harness/hooks/plugin-hooks.ts
 *
 * Plugin `hooks/hooks.json` as a second file source, compiled into Pre/Post
 * command hooks attached to permission Step 1 / Step 5 and delivered to the
 * assembly layer (build-engine / worker) through the existing
 * `HookContribution` seam.
 *
 * Responsibilities: parse -> matcher compile -> subprocess execution. The
 * data plane (discovery / plugin names / root paths) belongs to `plugin/`;
 * this module does not import plugin/ runtime code — file paths and plugin
 * names are passed in by the assembly layer via opts (one-way dependency:
 * hooks -> plugin only through the assembly layer).
 *
 * Contract (clause by clause):
 *  - File format: top-level `{description?, hooks:{PreToolUse?:[], PostToolUse?:[]}}`;
 *    group = `{matcher?, hooks:[handler]}`; handler = `{type:"command", command,
 *    timeout?}`. Only PreToolUse / PostToolUse are consumed; unknown event
 *    names are ignored + one warn per file; non-"command" types are ignored +
 *    warned; timeout is in seconds, default 30, cap 600 (clamped + warned
 *    beyond). Invalid JSON / missing hooks key / unreadable -> skip the file
 *    + plugin-init. Handlers with identical (file, event, matcher, command)
 *    are deduplicated (one hooks.json may be reachable via multiple roots).
 *  - Matcher evaluation: only `[A-Za-z0-9_\- ,|]` -> exact alternative
 *    matching (`|` or `,` separated, case-sensitive, trimmed); any other
 *    character -> unanchored `RegExp.prototype.test`; absent / "" / "*" ->
 *    wildcard; invalid regex -> drop that group + warn (never poisons others).
 *  - Tool-name candidate sets: bash→{bash,Bash}, write_file→{write_file,Write},
 *    edit_file→{edit_file,Edit,MultiEdit}, read_file→{read_file,Read},
 *    grep→{grep,Grep}, glob→{glob,Glob}, skill→{skill,Skill},
 *    spawn_subagent→{spawn_subagent,Task,Agent}; others keep only their own
 *    name. `todo_write` is deliberately **not** mapped to `Write` (a ledger
 *    tool, not a file write; a wrong mapping would make the write gate false-
 *    positive). A matcher group hits when any candidate name hits.
 *  - stdin envelope: `{hook_event_name, tool_name(= first candidate, the
 *    canonical iknow name), tool_input(alias view), tool_response(Post), cwd}`;
 *    `session_id` is unavailable at the Pre/Post seam -> always absent (never fabricated).
 *  - Exit codes: exit 0 = allow / observe; exit 2 = Pre block (reason =
 *    stderr, preferring JSON `systemMessage` / `permissionDecisionReason`,
 *    else the raw text; empty stderr -> try stdout the same way; both empty
 *    -> generic reason), Post only observes (stderr text goes to the
 *    diagnostic channel and **never changes the tool result**); other exit
 *    codes / spawn failure / timeout / killed -> fail-open (allow) +
 *    plugin-exec warning.
 *  - Command execution: async `spawn` (node:child_process; `spawnSync` would
 *    block the event loop under a TUI — never used on this path), `shell:true`,
 *    cwd = taskRoot, stdin gets the envelope then closes, timeout seconds ->
 *    milliseconds, stdout / stderr each truncated by bytes at 1 MiB. The
 *    command string goes to the shell verbatim (rewriting would break plugin semantics).
 *  - Placeholders (brand-neutral, suffix-matched): `${*_PLUGIN_ROOT}` -> the
 *    plugin root; `${*_PLUGIN_DATA}` -> `<userHome>/.iknow/plugin-data/<plugin>`
 *    (created on first reference); `${*_PROJECT_DIR}` -> projectIdentityRoot;
 *    other `${VAR}` resolve from opts.env, undefined -> "". Substituted
 *    variables are exported into the child env under their **verbatim names**
 *    (alongside PATH etc. from the inherited base env).
 *  - First block wins: matcher groups in file order, handlers within a group
 *    in declaration order; the first block short-circuits the return.
 *
 * Dependency direction (bounded context): hooks -> permission (type-only).
 * HookErrorEvent is the permission-executor's typed observation payload (a
 * closed-set member of phase "plugin-init" / "plugin-exec"); HookContribution
 * is hooks' own seam (./index.js). Zero runtime imports of plugin/ / skill/ /
 * subagent/ in this module.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PostToolUseHook, PreToolUseHook } from "../permission/types.js";
import type { HookErrorEvent } from "../permission/permission-executor.js";
import type { HookContribution } from "./index.js";
import type { IknowSettingsHooks } from "../../config/settings.js";

/** hooks.json absolute path + owning plugin name (same shape as plugin/catalog.ts `hooksEntries`). */
export interface PluginHookFile {
  /** Absolute path of `<root>/hooks/hooks.json`. */
  readonly file: string;
  /** Owning plugin name — the base for `${*_PLUGIN_ROOT}` / `${*_PLUGIN_DATA}`. */
  readonly plugin: string;
}

/** Injection seam of createPluginHookContribution. */
export interface CreatePluginHookContributionOpts {
  /** hooks.json entries (from the plugin catalog; `{file, plugin}` pairs). */
  readonly files: readonly PluginHookFile[];
  /** Plugin name -> plugin root (placeholder substitution; derived from the `file` path as fallback when absent). */
  readonly roots: ReadonlyMap<string, string>;
  /** Base for `${*_PLUGIN_DATA}` -> `<userHome>/.iknow/plugin-data/<plugin>`. */
  readonly userHome: string;
  /** Value of `${*_PROJECT_DIR}` -> projectIdentityRoot. */
  readonly projectDir: string;
  /** Child-process cwd (taskRoot). */
  readonly cwd: string;
  /** Source for `${VAR}` values; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Human-readable degradation channel; defaults to console.warn (fallback outlet when onError is absent). */
  readonly warn?: (message: string) => void;
  /** Typed degradation channel (permission-executor HookErrorEvent, phase plugin-*). */
  readonly onError?: (e: HookErrorEvent) => void;
}

/** Output truncation cap: stdout / stderr each 1 MiB. */
export const PLUGIN_HOOK_OUTPUT_CAP_BYTES = 1024 * 1024;

/** Default timeout 30s. */
export const PLUGIN_HOOK_DEFAULT_TIMEOUT_SECONDS = 30;

/** Declared timeout cap 600s (clamped beyond). */
export const PLUGIN_HOOK_MAX_TIMEOUT_SECONDS = 600;

/**
 * Character set for exact-class matchers: only these characters -> exact
 * alternative matching. Any other character (`.` / `*` / `(` / `^` …) -> the
 * regex branch.
 */
const EXACT_MATCHER_RE = /^[A-Za-z0-9_ ,|-]*$/;

/**
 * Tool-name candidate sets. Key = iknow internal tool name (the `tool` the
 * PreToolUseHook ctx provides), value = possible external names; `[0]` is
 * always the canonical iknow name (the envelope's `tool_name`). Tools not in
 * the table -> themselves only (no guessed aliases).
 */
const TOOL_NAME_CANDIDATES: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ["bash", Object.freeze(["bash", "Bash"])],
  ["write_file", Object.freeze(["write_file", "Write"])],
  ["edit_file", Object.freeze(["edit_file", "Edit", "MultiEdit"])],
  ["read_file", Object.freeze(["read_file", "Read"])],
  ["grep", Object.freeze(["grep", "Grep"])],
  ["glob", Object.freeze(["glob", "Glob"])],
  ["skill", Object.freeze(["skill", "Skill"])],
  ["spawn_subagent", Object.freeze(["spawn_subagent", "Task", "Agent"])],
  // todo_write is deliberately absent: never map to Write (a ledger tool; a wrong mapping would make the write gate false-block).
]);

/**
 * Tool-name candidate set (pure function, exported for tests and matcher
 * assertions). Returns a frozen array; `[0]` = the canonical iknow name.
 */
export function pluginHookToolNames(tool: string): readonly string[] {
  return TOOL_NAME_CANDIDATES.get(tool) ?? Object.freeze([tool]);
}

/** Compiled matcher tri-state. */
type CompiledMatcher =
  | { readonly kind: "wildcard" }
  | { readonly kind: "exact"; readonly names: readonly string[] }
  | { readonly kind: "regex"; readonly re: RegExp };

/**
 * Compile a matcher (branching per spec). Returns `undefined` for an invalid
 * regex (the caller drops that group + reports plugin-init).
 */
function compileMatcher(
  matcher: string | undefined
): CompiledMatcher | undefined {
  if (matcher === undefined || matcher === "" || matcher === "*") {
    return { kind: "wildcard" };
  }
  if (EXACT_MATCHER_RE.test(matcher)) {
    const names = matcher
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    // Pure separators / whitespace ("|" or " ") -> no valid alternatives,
    // equivalent to a wildcard (declares no restriction, same shape as
    // absent; not treated as degradation).
    if (names.length === 0) return { kind: "wildcard" };
    return { kind: "exact", names: Object.freeze(names) };
  }
  try {
    return { kind: "regex", re: new RegExp(matcher) };
  } catch {
    return undefined;
  }
}

/**
 * Matcher evaluation (pure function, exported for tests): true when any of
 * `toolNames` hits. Invalid regex -> false (the group was already dropped at
 * construction; this is just a fallback, no warning — pure functions have no channel).
 */
export function evaluatePluginHookMatcher(
  matcher: string | undefined,
  toolNames: readonly string[]
): boolean {
  const compiled = compileMatcher(matcher);
  if (compiled === undefined) return false;
  return matcherMatches(compiled, toolNames);
}

function matcherMatches(
  compiled: CompiledMatcher,
  toolNames: readonly string[]
): boolean {
  switch (compiled.kind) {
    case "wildcard":
      return true;
    case "exact":
      return compiled.names.some((name) => toolNames.includes(name));
    case "regex":
      // Unanchored (RegExp.prototype.test semantics) — as specified.
      return toolNames.some((name) => compiled.re.test(name));
  }
}

/**
 * Timeout normalization (pure function, exported for tests): non-finite /
 * ≤0 -> default 30s; beyond 600s -> clamped to 600s; returned unit = ms.
 */
export function pluginHookTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return PLUGIN_HOOK_DEFAULT_TIMEOUT_SECONDS * 1000;
  }
  const seconds = Math.min(raw, PLUGIN_HOOK_MAX_TIMEOUT_SECONDS);
  return Math.round(seconds * 1000);
}

/** Installation facts for the assembly convenience function (a minimal
 *  structural subset of plugin/roots.ts PluginInstallation — no plugin/
 *  import, keeping hooks -> plugin one-way through the assembly layer). */
export interface PluginInstallationRef {
  readonly name: string;
  readonly root: string;
}

/**
 * Assembly convenience function (shared by build-engine and subagent/worker,
 * single source): derives the contribution from the catalog's hooksEntries +
 * the installation list. The two assembly sites were byte-identical; keeping
 * one copy avoids drift.
 *
 * Always returns a HookContribution (**never** undefined): empty `entries`
 * -> an empty contribution (both pre/post absent = "this source declares
 * nothing"), the same shape createPluginHookContribution uses for empty
 * files. The assembly layer can read `.pre` / `.post` directly (undefined
 * values are skipped as absent slots by the combiner), without writing an
 * emptiness guard at every assembly site.
 */
export function createPluginHooksFromCatalog(params: {
  readonly entries: readonly PluginHookFile[];
  readonly installations: ReadonlyArray<PluginInstallationRef>;
  readonly userHome: string;
  readonly projectDir: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  readonly onError?: (e: HookErrorEvent) => void;
}): HookContribution {
  return createPluginHookContribution({
    files: params.entries,
    // roots: plugin name -> root (the base for placeholder substitution).
    roots: new Map(params.installations.map((p) => [p.name, p.root] as const)),
    userHome: params.userHome,
    projectDir: params.projectDir,
    cwd: params.cwd,
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.warn !== undefined ? { warn: params.warn } : {}),
    ...(params.onError !== undefined ? { onError: params.onError } : {}),
  });
}

/**
 * User `settings.hooks` (PreToolUse/PostToolUse map) -> the same command
 * hook compiler. No groups -> empty contribution. Placeholders have no
 * plugin root (the plugin name is fixed to "user").
 */
export function createSettingsHookContribution(params: {
  readonly hooks: IknowSettingsHooks | undefined;
  readonly userHome: string;
  readonly projectDir: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  readonly onError?: (e: HookErrorEvent) => void;
}): HookContribution {
  const hooksRaw = settingsHooksAsMap(params.hooks);
  if (hooksRaw === undefined) return Object.freeze({});
  const opts: CreatePluginHookContributionOpts = {
    files: [],
    roots: new Map(),
    userHome: params.userHome,
    projectDir: params.projectDir,
    cwd: params.cwd,
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.warn !== undefined ? { warn: params.warn } : {}),
    ...(params.onError !== undefined ? { onError: params.onError } : {}),
  };
  const report = makeHookReport(opts);
  const compiled = compileHooksMap(
    {
      file: join(params.userHome, ".iknow", "settings.json"),
      plugin: "user",
    },
    hooksRaw,
    report,
    new Set()
  );
  return contributionFromCompiled(compiled, opts, report);
}

function settingsHooksAsMap(
  hooks: IknowSettingsHooks | undefined
): Record<string, unknown> | undefined {
  if (hooks === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (hooks.PreToolUse !== undefined) out.PreToolUse = hooks.PreToolUse;
  if (hooks.PostToolUse !== undefined) out.PostToolUse = hooks.PostToolUse;
  if (out.PreToolUse === undefined && out.PostToolUse === undefined) {
    return undefined;
  }
  return out;
}

// ─── Compiled artifacts ────────────────────────────────────────────────────

interface CompiledHandler {
  readonly plugin: string;
  readonly command: string;
  readonly timeoutMs: number;
}

interface CompiledGroup {
  readonly matcher: CompiledMatcher;
  readonly handlers: ReadonlyArray<CompiledHandler>;
}

interface CompiledHooks {
  readonly pre: ReadonlyArray<CompiledGroup>;
  readonly post: ReadonlyArray<CompiledGroup>;
}

type HookEventName = "PreToolUse" | "PostToolUse";

const HOOK_EVENT_NAMES: ReadonlyArray<HookEventName> = Object.freeze([
  "PreToolUse",
  "PostToolUse",
]);

/**
 * Build the plugin hooks contribution (the second HookContribution source).
 *
 * All IO and compilation (read / parse / matcher compile / dedupe) happen at
 * construction; runtime only reads frozen artifacts -> concurrency-safe.
 * No usable handler at all -> returns an empty object (so the assembly layer
 * keeps the plugin-less path byte-identical).
 */
export function createPluginHookContribution(
  opts: CreatePluginHookContributionOpts
): HookContribution {
  // No files -> empty contribution; the assembly layer needs no emptiness
  // check of its own (both `{pre?, post?}` absent = "this source declares
  // nothing", byte-identical to passing empty files; no per-site guard).
  if (opts.files.length === 0) return Object.freeze({});
  const report = makeHookReport(opts);
  const compiled = compileAllFiles(opts.files, report);
  return contributionFromCompiled(compiled, opts, report);
}

function makeHookReport(opts: CreatePluginHookContributionOpts): ReportFn {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  return (
    phase: "plugin-init" | "plugin-exec",
    message: string,
    tool?: string
  ): void => {
    if (opts.onError !== undefined) {
      opts.onError({ phase, message, ...(tool !== undefined ? { tool } : {}) });
      return;
    }
    warn(message);
  };
}

function contributionFromCompiled(
  compiled: CompiledHooks,
  opts: CreatePluginHookContributionOpts,
  report: ReportFn
): HookContribution {
  const runner = createCommandRunner({
    opts,
    report,
    createdDataDirs: new Set<string>(),
  });

  const contribution: HookContribution = {
    ...(compiled.pre.length > 0
      ? {
          pre: Object.freeze(async ({ tool, input }) => {
            const candidates = pluginHookToolNames(tool);
            for (const group of compiled.pre) {
              if (!matcherMatches(group.matcher, candidates)) continue;
              for (const handler of group.handlers) {
                const outcome = await runner.run({
                  event: "PreToolUse",
                  handler,
                  canonicalTool: tool,
                  candidates,
                  toolInput: input,
                });
                // First block wins: the first block short-circuits; later groups / handlers are not evaluated.
                if (outcome.kind === "block") return { reason: outcome.reason };
              }
            }
            return undefined;
          }) satisfies PreToolUseHook,
        }
      : {}),
    ...(compiled.post.length > 0
      ? {
          post: Object.freeze(async (result) => {
            // Post contract: never throws (observation does not change results).
            try {
              const candidates = pluginHookToolNames(result.name);
              const response = projectToolResponse(result);
              for (const group of compiled.post) {
                if (!matcherMatches(group.matcher, candidates)) continue;
                for (const handler of group.handlers) {
                  await runner.run({
                    event: "PostToolUse",
                    handler,
                    canonicalTool: result.name,
                    candidates,
                    toolInput: result.input,
                    toolResponse: response,
                  });
                }
              }
            } catch (err) {
              // EXIT: Post observation exceptions never bubble up to change
              // tool results (same criterion as runAllowed /
              // violation-executor); routed to plugin-exec when the typed
              // channel exists.
              report(
                "plugin-exec",
                `plugin hooks: PostToolUse observation failed: ${errorMessage(err)}`
              );
            }
          }) satisfies PostToolUseHook,
        }
      : {}),
  };
  return Object.freeze(contribution);
}

function projectToolResponse(result: {
  readonly message?: string;
  readonly payload?: unknown;
}): string {
  if (typeof result.message === "string") return result.message;
  try {
    const serialized = JSON.stringify(result.payload ?? {});
    return serialized ?? "{}";
  } catch {
    // EXIT: non-serializable payloads must not throw at the Post observer (never-throw contract).
    return String(result.payload ?? "");
  }
}

// ─── Parsing and compilation ───────────────────────────────────────────────

type ReportFn = (
  phase: "plugin-init" | "plugin-exec",
  message: string,
  tool?: string
) => void;

/**
 * Per-file parsing + compilation. Any degradation in one file only affects
 * that file (skip / ignore the entry), never other files (same discipline as
 * user-hooks.ts: a bad pattern does not poison other rules).
 */
function compileAllFiles(
  files: readonly PluginHookFile[],
  report: ReportFn
): CompiledHooks {
  const pre: CompiledGroup[] = [];
  const post: CompiledGroup[] = [];
  // The dedupe key includes file: one hooks.json can be reachable via multiple roots (only the same file collides).
  const seenHandlers = new Set<string>();

  for (const entry of files) {
    const groups = compileFile(entry, report, seenHandlers);
    pre.push(...groups.pre);
    post.push(...groups.post);
  }
  return Object.freeze({
    pre: Object.freeze(pre),
    post: Object.freeze(post),
  });
}

/** Shared empty artifact for the skip path — a fresh array literal, not a shared mutable array (caller pushes are safe). */
function emptyCompiled(): { pre: CompiledGroup[]; post: CompiledGroup[] } {
  return { pre: [], post: [] };
}

/**
 * Read + JSON parse (all skip paths converge here): any step failing ->
 * report + undefined (the caller skips the file). All three undefined-return
 * paths sit in the degradation table.
 */
function readHooksJson(
  entry: PluginHookFile,
  report: ReportFn
): Record<string, unknown> | undefined {
  const { file, plugin } = entry;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    // EXIT: hooks.json unreadable (existence already checked by catalog;
    // here it is a race / permission issue) -> skip this file; other
    // plugins are unaffected.
    report(
      "plugin-init",
      `plugin '${plugin}' hooks file unreadable: ${file}: ${errorMessage(err)} — skipped`
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // EXIT: corrupted JSON -> skip the whole file (degradation surface).
    report(
      "plugin-init",
      `plugin '${plugin}' hooks JSON corrupt at ${file}: ${errorMessage(err)} — skipped`
    );
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks root is not an object at ${file} — skipped`
    );
    return undefined;
  }
  const hooksRaw = (parsed as { hooks?: unknown }).hooks;
  if (!isPlainObject(hooksRaw)) {
    // EXIT: missing hooks key (or hooks not an object) -> skip the file.
    report(
      "plugin-init",
      `plugin '${plugin}' hooks file missing "hooks" object at ${file} — skipped`
    );
    return undefined;
  }
  return hooksRaw;
}

function compileFile(
  entry: PluginHookFile,
  report: ReportFn,
  seenHandlers: Set<string>
): { pre: CompiledGroup[]; post: CompiledGroup[] } {
  const hooksRaw = readHooksJson(entry, report);
  if (hooksRaw === undefined) return emptyCompiled();
  return compileHooksMap(entry, hooksRaw, report, seenHandlers);
}

/** A parsed event map -> CompiledHooks (shared by settings and hooks.json). */
function compileHooksMap(
  entry: PluginHookFile,
  hooksRaw: Record<string, unknown>,
  report: ReportFn,
  seenHandlers: Set<string>
): { pre: CompiledGroup[]; post: CompiledGroup[] } {
  const { file, plugin } = entry;
  const reportedInFile = new Set<string>();
  const reportOnce = (message: string): void => {
    if (reportedInFile.has(message)) return;
    reportedInFile.add(message);
    report("plugin-init", message);
  };

  const pre: CompiledGroup[] = [];
  const post: CompiledGroup[] = [];

  for (const [eventName, groupsRaw] of Object.entries(hooksRaw)) {
    if (!isHookEventName(eventName)) {
      // EXIT: unknown event names (PreCompact / SessionStart / Stop, etc.)
      // — iknow has no matching moment; ignored + one warn per file
      // (non-goal).
      reportOnce(
        `plugin '${plugin}' unknown hook event "${eventName}" ignored (${file})`
      );
      continue;
    }
    if (!Array.isArray(groupsRaw)) {
      // EXIT: non-array event value -> ignore that event (other events unaffected).
      report(
        "plugin-init",
        `plugin '${plugin}' hooks.${eventName} is not an array at ${file} — ignored`
      );
      continue;
    }
    for (const groupRaw of groupsRaw) {
      const group = compileGroup({
        groupRaw,
        eventName,
        entry,
        report,
        reportOnce,
        seenHandlers,
      });
      if (group === undefined) continue;
      if (eventName === "PreToolUse") pre.push(group);
      else post.push(group);
    }
  }

  return { pre, post };
}

interface CompileContext {
  readonly eventName: HookEventName;
  readonly entry: PluginHookFile;
  readonly report: ReportFn;
  readonly reportOnce: (message: string) => void;
  readonly seenHandlers: Set<string>;
}

/** Matcher evaluation surface: non-object / non-string / invalid regex -> report + undefined (drop the group). */
function compileGroupMatcher(
  groupRaw: Record<string, unknown>,
  ctx: CompileContext
): CompiledMatcher | undefined {
  const { eventName, entry, report } = ctx;
  const { file, plugin } = entry;
  const matcherRaw = groupRaw.matcher;
  if (matcherRaw !== undefined && typeof matcherRaw !== "string") {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks.${eventName} matcher is not a string at ${file} — group dropped`
    );
    return undefined;
  }
  const matcherSource = matcherRaw as string | undefined;
  const matcher = compileMatcher(matcherSource);
  if (matcher === undefined) {
    // EXIT: invalid regex -> drop this group (never poisons others; same discipline as user-hooks).
    report(
      "plugin-init",
      `plugin '${plugin}' invalid matcher regex dropped (${file}): ${JSON.stringify(matcherSource)}`
    );
  }
  return matcher;
}

/** Compile one handler; degradation (non-object / non-command / missing command) returns undefined. */
function compileHandler(
  handlerRaw: unknown,
  ctx: CompileContext,
  matcherSource: string | undefined
): CompiledHandler | undefined {
  const { eventName, entry, report, reportOnce, seenHandlers } = ctx;
  const { file, plugin } = entry;
  if (!isPlainObject(handlerRaw)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hook entry is not an object at ${file} — ignored`
    );
    return undefined;
  }
  const type = (handlerRaw as { type?: unknown }).type;
  if (type !== "command") {
    // EXIT: non-command types (webhook / prompt, etc.) are not executed + warn.
    reportOnce(
      `plugin '${plugin}' non-command hook type ignored (type=${JSON.stringify(type)}, ${file})`
    );
    return undefined;
  }
  const commandRaw = (handlerRaw as { command?: unknown }).command;
  if (typeof commandRaw !== "string" || commandRaw.trim().length === 0) {
    report(
      "plugin-init",
      `plugin '${plugin}' hook entry missing a command string at ${file} — ignored`
    );
    return undefined;
  }
  const timeoutRaw = (handlerRaw as { timeout?: unknown }).timeout;
  const timeoutMs = pluginHookTimeoutMs(timeoutRaw);
  if (
    typeof timeoutRaw === "number" &&
    timeoutRaw > PLUGIN_HOOK_MAX_TIMEOUT_SECONDS
  ) {
    // EXIT: beyond the cap -> clamp to 600s (do not reject the whole entry:
    // the timeout cap is a local protection, not a semantic error in the
    // plugin's declaration).
    reportOnce(
      `plugin '${plugin}' hook timeout ${timeoutRaw}s exceeds max ${PLUGIN_HOOK_MAX_TIMEOUT_SECONDS}s — clamped (${file})`
    );
  }
  // Dedupe: keep only the first of exactly identical
  // (file, event, matcher, command) tuples (one hooks.json may be reachable
  // via multiple roots -> the assembly layer can list the same file twice).
  // JSON.stringify builds the group key: matcher / command are free text, and
  // space-joining would collide (matcher="a b", command="c") with
  // (matcher="a", command="b c").
  const dedupKey = JSON.stringify([
    file,
    eventName,
    matcherSource ?? null,
    commandRaw,
  ]);
  if (seenHandlers.has(dedupKey)) return undefined;
  seenHandlers.add(dedupKey);
  return Object.freeze({ plugin, command: commandRaw, timeoutMs });
}

function compileGroup(
  params: CompileContext & { readonly groupRaw: unknown }
): CompiledGroup | undefined {
  const ctx: CompileContext = params;
  const { groupRaw, eventName, entry, report } = params;
  const { file, plugin } = entry;
  if (!isPlainObject(groupRaw)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks.${eventName} group is not an object at ${file} — ignored`
    );
    return undefined;
  }
  const matcher = compileGroupMatcher(groupRaw, ctx);
  if (matcher === undefined) return undefined;
  const matcherSource = groupRaw.matcher as string | undefined;

  const handlersRaw = groupRaw.hooks;
  if (!Array.isArray(handlersRaw)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks.${eventName} group has no hooks array at ${file} — ignored`
    );
    return undefined;
  }

  const handlers: CompiledHandler[] = [];
  for (const handlerRaw of handlersRaw) {
    const handler = compileHandler(handlerRaw, ctx, matcherSource);
    if (handler !== undefined) handlers.push(handler);
  }

  if (handlers.length === 0) return undefined;
  return Object.freeze({ matcher, handlers: Object.freeze(handlers) });
}

function isHookEventName(name: string): name is HookEventName {
  return name === HOOK_EVENT_NAMES[0] || name === HOOK_EVENT_NAMES[1];
}

// ─── Execution ─────────────────────────────────────────────────────────────

interface RunParams {
  readonly event: HookEventName;
  readonly handler: CompiledHandler;
  /** iknow tool name (input to `pluginHookToolNames`; the envelope takes the first candidate). */
  readonly canonicalTool: string;
  readonly candidates: readonly string[];
  readonly toolInput: unknown;
  readonly toolResponse?: string;
}

type RunOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "block"; readonly reason: string };

interface CommandRunner {
  readonly run: (params: RunParams) => Promise<RunOutcome>;
}

interface CreateCommandRunnerParams {
  readonly opts: CreatePluginHookContributionOpts;
  readonly report: ReportFn;
  /** Idempotence record for create-on-first-reference of `${*_PLUGIN_DATA}` (once per plugin). */
  readonly createdDataDirs: Set<string>;
}

function createCommandRunner(params: CreateCommandRunnerParams): CommandRunner {
  const { opts, report, createdDataDirs } = params;
  const baseEnv = opts.env ?? process.env;

  return Object.freeze({
    run: async (run: RunParams): Promise<RunOutcome> => {
      const { handler, event } = run;
      const substituted = substituteCommand({
        command: handler.command,
        plugin: handler.plugin,
        opts,
        report,
        createdDataDirs,
      });
      const envelope = buildEnvelope(run, opts.cwd);
      const result = await runCommand({
        command: substituted.command,
        env: { ...baseEnv, ...substituted.exported },
        cwd: opts.cwd,
        timeoutMs: handler.timeoutMs,
        stdin: envelope,
      });
      if (result.kind === "error") {
        // EXIT: spawn failure / timeout (fail-open) — better to miss a block
        // than to false-block; report only the plugin name and command head,
        // never the full output text.
        report(
          "plugin-exec",
          `plugin '${handler.plugin}' ${event} hook fail-open (${result.reason}); command: ${commandHead(handler.command)}`,
          run.canonicalTool
        );
        return { kind: "pass" };
      }
      if (result.code === 2) {
        if (event === "PostToolUse") {
          // EXIT: Post exit 2 = observation + diagnostics (**does not change the tool result**).
          report(
            "plugin-exec",
            `plugin '${handler.plugin}' PostToolUse hook exited 2 (observation only, tool result unchanged): ${blockReasonFrom(result, handler.plugin)}`,
            run.canonicalTool
          );
          return { kind: "pass" };
        }
        return {
          kind: "block",
          reason: blockReasonFrom(result, handler.plugin),
        };
      }
      if (result.code !== 0) {
        // EXIT: other exit codes -> fail-open + plugin-exec.
        report(
          "plugin-exec",
          `plugin '${handler.plugin}' ${event} hook fail-open (exit ${String(result.code)}, signal ${String(result.signal)}); command: ${commandHead(handler.command)}`,
          run.canonicalTool
        );
        return { kind: "pass" };
      }
      return { kind: "pass" };
    },
  });
}

/**
 * Exit-2 reason resolution: stderr first; when stderr is JSON, take
 * `systemMessage` / `permissionDecisionReason` (whichever hits first);
 * otherwise the raw text (trimmed). Empty stderr -> the same treatment of
 * stdout; both empty -> a generic reason.
 */
function blockReasonFrom(
  result: { readonly stdout: string; readonly stderr: string },
  plugin: string
): string {
  const fromStderr = textOrJsonReason(result.stderr);
  if (fromStderr !== undefined) return fromStderr;
  const fromStdout = textOrJsonReason(result.stdout);
  if (fromStdout !== undefined) return fromStdout;
  return `${plugin} hook blocked the call (exit 2)`;
}

function textOrJsonReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isPlainObject(parsed)) {
      const systemMessage = (parsed as { systemMessage?: unknown })
        .systemMessage;
      if (typeof systemMessage === "string" && systemMessage.length > 0) {
        return systemMessage;
      }
      const decisionReason = (parsed as { permissionDecisionReason?: unknown })
        .permissionDecisionReason;
      if (typeof decisionReason === "string" && decisionReason.length > 0) {
        return decisionReason;
      }
    }
  } catch {
    // Non-JSON -> raw text (below)
  }
  return trimmed;
}

// ─── envelope ────────────────────────────────────────────────────────────────

/**
 * Envelope JSON. `tool_name` = the first candidate (the canonical iknow
 * name — `edit_file`, not `Edit`).
 *
 * `session_id` is always absent: at the Pre/Post seam `run` carries no
 * `conversationId` — that field is held host-side (permission-executor /
 * loop-engine ctx), and when the hook compiler freezes opts at assembly time
 * the conversationId is not yet bound. Forcing it through would require
 * extending `CreatePluginHookContributionOptions` with a `conversationId?`
 * closure, out of scope here. Current choice: **never** fabricate envelope
 * fields (hooks not seeing session_id is the fact; we do not pretend
 * otherwise), letting hooks handle absence.
 */
function buildEnvelope(run: RunParams, cwd: string): string {
  const envelope: Record<string, unknown> = {
    hook_event_name: run.event,
    tool_name: run.candidates[0] ?? run.canonicalTool,
    tool_input: adaptToolInput(run.toolInput, run.canonicalTool),
    ...(run.toolResponse !== undefined
      ? { tool_response: run.toolResponse }
      : {}),
    cwd,
  };
  const serialized = JSON.stringify(envelope);
  return serialized ?? "{}";
}

/**
 * `tool_input` adapted view: native keys are kept verbatim, generic alias
 * fields are appended (a same-name native key always wins, never overwritten):
 *   file_path ← path；old_string ← old_str；new_string ← new_str；
 *   skill ← the skill tool's name.
 * Non-object input (string / array / null) passes through verbatim (aliases cannot be attached).
 */
function adaptToolInput(input: unknown, tool: string): unknown {
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = { ...input };
  aliasField(out, "file_path", "path");
  aliasField(out, "old_string", "old_str");
  aliasField(out, "new_string", "new_str");
  if (tool === "skill") aliasField(out, "skill", "name");
  return out;
}

function aliasField(
  target: Record<string, unknown>,
  key: string,
  source: string
): void {
  if (target[key] !== undefined) return; // native keys win
  if (target[source] === undefined) return;
  target[key] = target[source];
}

// ─── Placeholder substitution ──────────────────────────────────────────────

interface SubstitutedCommand {
  readonly command: string;
  /** Variables exported into the child env under their verbatim command-string names. */
  readonly exported: Readonly<Record<string, string>>;
}

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function substituteCommand(params: {
  command: string;
  plugin: string;
  opts: CreatePluginHookContributionOpts;
  report: ReportFn;
  createdDataDirs: Set<string>;
}): SubstitutedCommand {
  const { command, plugin, opts, report, createdDataDirs } = params;
  const env = opts.env ?? process.env;
  const exported: Record<string, string> = {};
  const replaced = command.replace(
    PLACEHOLDER_RE,
    (_whole: string, name: string): string => {
      const upper = name.toUpperCase();
      let value: string;
      if (upper.endsWith("_PLUGIN_ROOT")) {
        value = pluginRoot(opts, plugin) ?? "";
      } else if (upper.endsWith("_PLUGIN_DATA")) {
        value = ensurePluginDataDir({
          opts,
          plugin,
          report,
          createdDataDirs,
        });
      } else if (upper.endsWith("_PROJECT_DIR")) {
        value = opts.projectDir;
      } else {
        // Other ${VAR} resolve from env; undefined -> empty string.
        value = env[name] ?? "";
      }
      // Verbatim-name export (`${<NS>_PLUGIN_ROOT}` written in the command ->
      // an env var of the same name) — child scripts read exactly the value
      // used for substitution; no case rewriting, the namespace is whatever
      // the plugin declared.
      exported[name] = value;
      return value;
    }
  );
  return { command: replaced, exported: Object.freeze(exported) };
}

/** Plugin root: the roots map wins; when absent, derived from `file` (`<root>/hooks/hooks.json`) as fallback. */
function pluginRoot(
  opts: CreatePluginHookContributionOpts,
  plugin: string
): string | undefined {
  const fromMap = opts.roots.get(plugin);
  if (fromMap !== undefined) return fromMap;
  // Fallback derivation: the catalog guarantees file = <root>/hooks/hooks.json.
  const entry = opts.files.find((f) => f.plugin === plugin);
  return entry !== undefined ? dirname(dirname(entry.file)) : undefined;
}

/**
 * `${*_PLUGIN_DATA}` -> `<userHome>/.iknow/plugin-data/<plugin>`, created on
 * first reference (once per plugin). mkdir failure -> a plugin-exec warning,
 * then the path is still returned (whether the command subsequently fails is
 * the command's own business — no second-guessing here).
 */
function ensurePluginDataDir(params: {
  opts: CreatePluginHookContributionOpts;
  plugin: string;
  report: ReportFn;
  createdDataDirs: Set<string>;
}): string {
  const { opts, plugin, report, createdDataDirs } = params;
  const dir = join(opts.userHome, ".iknow", "plugin-data", plugin);
  if (createdDataDirs.has(dir)) return dir;
  createdDataDirs.add(dir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // EXIT: a failed mkdir does not block hook execution (fail-open; write-
    // path errors surface through the command's own exit code).
    report(
      "plugin-exec",
      `plugin '${plugin}' plugin-data dir could not be created: ${dir}: ${errorMessage(err)}`
    );
  }
  return dir;
}

// ─── Subprocess execution ──────────────────────────────────────────────────

type CommandResult =
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Async spawn execution. stdin gets the envelope then closes; stdout /
 * stderr are each truncated by bytes at 1 MiB; timeout -> kill the whole
 * process group (detached-spawn group semantics, precedent in
 * sandbox/runner.ts), then return fail-open.
 *
 * Never spawnSync: it would block the event loop under a TUI.
 */
function runCommand(params: {
  command: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  timeoutMs: number;
  stdin: string;
}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutSize = 0;
    let stderrSize = 0;
    let timer: NodeJS.Timeout | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const cap = PLUGIN_HOOK_OUTPUT_CAP_BYTES;

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(params.command, {
        shell: true,
        cwd: params.cwd,
        env: params.env,
        // detached: the child forms its own process group, so a timeout can kill the whole tree (including shell grandchildren).
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // EXIT: a synchronous spawn throw (invalid cwd, etc.) -> fail-open (the caller warns).
      finish({ kind: "error", reason: `spawn threw: ${errorMessage(err)}` });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, params.timeoutMs);
    // The timeout timer must not hold the host event loop open (cleared once the hook finishes).
    timer.unref();

    child.on("error", (err) => {
      // EXIT: async spawn failure (ENOENT / EACCES / invalid cwd) -> fail-open.
      finish({ kind: "error", reason: `spawn failed: ${errorMessage(err)}` });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        // EXIT: timeout -> fail-open; the process group was killed.
        finish({
          kind: "error",
          reason: `timeout after ${params.timeoutMs}ms`,
        });
        return;
      }
      finish({
        kind: "exit",
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutSize >= cap) return;
      const room = cap - stdoutSize;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      stdoutChunks.push(slice);
      stdoutSize += slice.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrSize >= cap) return;
      const room = cap - stderrSize;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      stderrChunks.push(slice);
      stderrSize += slice.length;
    });
    // The child exited early (e.g. exit 2 without reading stdin) -> EPIPE, ignored (fail-open surface).
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(params.stdin);
  });
}

/** Kill the whole process group (SIGKILL; the timeout is a hard bound, no grace); ESRCH swallowed. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort: the process may have just exited.
    }
  }
}

/** Command head (≤80 chars) — warnings show only the head, never the full command text. */
function commandHead(command: string): string {
  const head = command.length <= 80 ? command : `${command.slice(0, 80)}…`;
  return JSON.stringify(head);
}

// ─── Small utilities ───────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
