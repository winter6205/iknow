/**
 * evidence-checker — pure-function rule engine for evidence-first judgment.
 *
 * Pure layer: zero IO, zero LLM, zero loop wiring. Input = read-only snapshot
 * of the main session messages + a claimIndex scalar; output = EvidenceReport.
 * All six checks live inside; callers consume the verdict only, never count
 * conditions.
 *
 * Frozen contract (ADR-0003/0006): no imports from loop-engine / session-api /
 * subagent / fs; consumes only stdout already truncated upstream by
 * sandbox/executor (truncation authority stays upstream). The cross-context
 * imports are AnthropicNativeMessage and the shared claim scan
 * (`../last-nonempty-assistant.js`, the same one verify-loop.ts takes
 * claimIndex from — one backward scan, one definition of "the claim").
 */
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../model-adapter/types.js";
import {
  lastNonEmptyTextBlockIndex,
  type ContentBlockPosition,
} from "../last-nonempty-assistant.js";
import type {
  EvidenceReport,
  EvidenceVerdict,
  TestRunEvidence,
} from "./types.js";

/** Unified is_error failure label prefix (see tool-result.ts). */
const EXECUTION_FAILED_PREFIX = "[execution_failed]";

/**
 * First text of a tool_result content (Anthropic content has two shapes:
 * string | block[]). Malformed content returns null (fail-closed, no crash).
 */
function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  return null;
}

/**
 * Parse the structured JSON of a bash tool_result (bash.ts/executor.ts text
 * contract). Parse failure returns null (fail-closed). On success returns
 * {code, stdout}: code for the exit-code decision; stdout for marker decisions
 * (the real stdout, not the whole JSON blob).
 */
function parseToolResult(text: string | null): {
  readonly code: number | null;
  readonly stdout: string;
} {
  if (text === null) return { code: null, stdout: "" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const code = (parsed as { code?: unknown }).code;
      const stdout = (parsed as { stdout?: unknown }).stdout;
      return {
        code: typeof code === "number" && Number.isInteger(code) ? code : null,
        stdout: typeof stdout === "string" ? stdout : "",
      };
    }
    return { code: null, stdout: "" };
  } catch {
    // Non-JSON: ^Exit code (\d+) regex fallback (defensive; the current model
    // surface always emits the JSON shape).
    const m = /^Exit code (\d+)/m.exec(text);
    return { code: m ? Number(m[1]) : null, stdout: text };
  }
}

/**
 * Two-path exit-code parse: structured JSON {code} first; on parse failure
 * fall back to ^Exit code (\d+); is_error / [execution_failed] prefix → null.
 * JSON parses but shape mismatches → null (fail-closed, never a silent pass).
 */
function parseExitCode(text: string | null, isError: boolean): number | null {
  if (isError || text === null) return null;
  if (text.startsWith(EXECUTION_FAILED_PREFIX)) return null;
  return parseToolResult(text).code;
}

/** Extract bash tool_use input.command; malformed input returns "" (no crash). */
function extractCommand(input: unknown): string {
  if (input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return "";
}

/**
 * Line-bounded prefix for the green summary rules: line start plus a run of
 * non-word characters. Runners decorate their summary line (`=====`, the `✓`
 * glyph) but a summary phrase with word characters before it on the same line
 * is quoted or echoed text inside someone else's line, not the runner's
 * summary. `\r\n` stay excluded so the run cannot spill across a line break.
 */
const GREEN_LINE = "^[^\\w\\r\\n]*";

/**
 * Five-framework runner recognition + green-summary-line conjunction
 * (whitelist). Runner is anchored on the command side (env-prefix / quote
 * stripping); green reads numbers only from framework summary lines, never
 * from arbitrary output. Both conditions must hit → framework; otherwise null
 * (fail-closed).
 */
const FRAMEWORK_RULES: ReadonlyArray<{
  readonly framework: Exclude<TestRunEvidence["framework"], null>;
  /** Command-side runner anchor (word boundary; prevents substring hits like "go"). */
  readonly runner: RegExp;
  /** stdout green summary line (pass counts only). */
  readonly green: RegExp;
}> = [
  {
    framework: "pytest",
    runner: /\bpytest\b/,
    // count+duration summary clause ("N passed in X.XXs"; decorators may appear anywhere).
    green: new RegExp(GREEN_LINE + "\\d+\\s+passed\\s+in\\s+[\\d.]+\\s*s", "m"),
  },
  {
    framework: "jest",
    runner: /\bjest\b/,
    green: new RegExp(GREEN_LINE + "Tests:\\s+\\d+\\s+passed", "m"),
  },
  {
    framework: "vitest",
    runner: /\bvitest\b/,
    green: new RegExp(GREEN_LINE + "Tests\\s+\\d+\\s+passed", "m"),
  },
  {
    framework: "go",
    runner: /\bgo\s+test\b/,
    green: /^ok\s+\S+/m,
  },
  {
    framework: "cargo",
    runner: /\bcargo\s+test\b/,
    green: new RegExp(GREEN_LINE + "test result:\\s*ok", "m"),
  },
];

/** Four weak-green shapes (narrow runs use -k/-t filters or :: exact-path selection). */
const WEAK_GREEN_PATTERNS: ReadonlyArray<RegExp> = [
  /0 tests run/,
  /collected 0 items/,
  /no tests found/i,
  /no test files found/i, // vitest prints "No test files found" (singular test + files)
];

/** Six failure-swallowing patterns (hard signal; a command-side hit voids that evidence). */
const SWALLOWED_PATTERNS: ReadonlyArray<RegExp> = [
  /\|\|\s*true\b/,
  /\|\|\s*exit\s+0\b/,
  /;\s*exit\s+0\b/,
  /--passWithNoTests/,
  // Pipeline tails: bare `bash -c` carries no `set -o pipefail`, so the
  // reported exit code is the tail's, not the runner's — masked evidence is
  // void (the true exit code is not recovered; that stays the pipefail fix).
  /\|\s*tail\b/,
  /\|\s*head\b/,
];

/**
 * Compound clause that writes into stdout (`;` / `&&` / `||` / `&` then
 * echo/printf); the captured group is everything the clause prints. Only the
 * emitted TEXT decides the void — a clause whose payload is not
 * framework-summary-shaped (`&& echo done`) is an honest status line, so the
 * keyword alone is never the trigger.
 */
const SUMMARY_WRITER_CLAUSE =
  /(?:;|&&|\|\||&)\s*\b(?:echo|printf)\b([^\r\n]*)/g;

/**
 * Texts an echo/printf clause emits: its quoted payloads (a leading `-n` /
 * `-e` flag stays outside them), else the bare remainder when unquoted.
 */
function emittedTexts(clauseTail: string): string[] {
  const quoted: string[] = [];
  for (const m of clauseTail.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
    const text = m[1] ?? m[2] ?? m[3];
    if (text !== undefined && text.length > 0) quoted.push(text);
  }
  return quoted.length > 0 ? quoted : [clauseTail];
}

/**
 * Fabricated green: the command itself writes a framework-summary-shaped line
 * into the stdout the checker reads, so that line is not the runner's verdict.
 * Reuses the per-framework `green` shapes (line-anchored) as the authority on
 * what "summary-shaped" means — one definition, never a second looser one.
 */
function fabricatesSummary(command: string): boolean {
  for (const clause of command.matchAll(SUMMARY_WRITER_CLAUSE)) {
    if (
      emittedTexts(clause[1]).some((text) =>
        FRAMEWORK_RULES.some(({ green }) => green.test(text))
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Command-side void (evidence condition 4): failure swallowed by one of the
 * six patterns, or the green line fabricated by the command itself. Both void
 * through the same flag because the observable effect is identical — the
 * reported exit code and the summary line no longer come from one execution.
 */
function isSwallowed(command: string): boolean {
  return (
    SWALLOWED_PATTERNS.some((p) => p.test(command)) ||
    fabricatesSummary(command)
  );
}

/**
 * Command-side narrow selection (-k / -t filters, or a `::` selector glued to
 * an argument token, pytest `f.py::Class::test` shape). A `::` that is not
 * glued on both sides sits in prose or a comment, not in an argument position,
 * so it selects nothing and must not read as a narrow run.
 */
function hasNarrowSelection(command: string): boolean {
  return /(^|\s)-[kt]\b/.test(command) || /\S::\S/.test(command);
}

/** Five-framework marker check; no match → null (fail-closed, never guess a framework). */
function detectFramework(
  command: string,
  stdout: string
): TestRunEvidence["framework"] {
  for (const { framework, runner, green } of FRAMEWORK_RULES) {
    if (runner.test(command) && green.test(stdout)) return framework;
  }
  return null;
}

/** Weak green: any of the four summary shapes in stdout, or command-side narrow selection. */
function isWeakGreen(command: string, stdout: string): boolean {
  if (WEAK_GREEN_PATTERNS.some((p) => p.test(stdout))) return true;
  return hasNarrowSelection(command);
}

/**
 * Whether this turn's bash actually ran tests (command-side intent heuristic).
 * Non-test bash (ls / mkdir / git add etc.) never counts as verification evidence.
 */
function isTestCommand(command: string): boolean {
  const t =
    /\b(npm test|npx vitest|npx jest|vitest run|jest|pytest|cargo test|go test)\b/;
  return t.test(command);
}

/** Doc-only exemption: .md / .txt / docs/ path edits do not count as code edits. */
function isDocOnlyPath(filePath: unknown): boolean {
  if (typeof filePath !== "string") return false;
  return /\.(md|txt)$/i.test(filePath) || filePath.includes("docs/");
}

/**
 * Target path of an edit_file / write_file tool_use input. The production ACI
 * schema key is `path` (enforced by ALLOWED_KEYS in the tools themselves);
 * `filePath` is accepted only for legacy test fixtures. Non-string / absent on
 * both keys returns undefined — the callers keep their fail-closed handling.
 */
export function editBlockPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { path, filePath } = input as { path?: unknown; filePath?: unknown };
  if (typeof path === "string") return path;
  if (typeof filePath === "string") return filePath;
  return undefined;
}

/** The tool_use variant of the content-block union (the walker's payload). */
type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** Non-null object test (the walker's guard primitive): malformed messages /
 *  blocks (null, string, number) fail closed as "no signal", never throw. */
function isRecord(value: unknown): value is object {
  return Boolean(value) && typeof value === "object";
}

/**
 * The single defensive message→content→block→tool_use walk in this module.
 * Every tool_use scanner goes through it — malformed shapes fail closed by
 * being skipped, never by throwing: a non-object message, a non-array
 * content, a non-object block, a non-tool_use block all contribute no
 * signal. The handler receives the narrowed block plus its (message,
 * content-block) coordinates — the message index alone cannot order two
 * blocks of one assistant message — so windowed scans compare pairs;
 * returning true short-circuits the walk. Returns whether any handler call
 * short-circuited.
 */
function forEachToolUseBlock(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  handler: (
    block: ToolUseBlock,
    messageIndex: number,
    contentBlockIndex: number
  ) => boolean | void
): boolean {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      if (!isRecord(block)) continue;
      const b = block as AnthropicContentBlock;
      if (b.type !== "tool_use") continue;
      if (handler(b, i, j)) return true;
    }
  }
  return false;
}

/**
 * Staleness check at block granularity: an edit_file / write_file after the
 * green test tool_use block and up to the claim, targeting a non-doc-only
 * path → stale. The claim message is no longer skipped wholesale — its
 * sibling edit is exactly the code the green run cannot describe (before the
 * claim text it is a post-green edit, after it the code moved past the claim),
 * and the claim's own text block is not a tool_use so it never lands here.
 * Ordering uses the session's own block order (never mtime/diff/git).
 * In-bash file mutation (sed -i / echo >) is not tracked in v1 (known
 * limitation).
 */
function hasStaleEdit(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  green: ContentBlockPosition,
  claim: ContentBlockPosition
): boolean {
  return forEachToolUseBlock(messages, (b, messageIndex, contentBlockIndex) => {
    if (b.name !== "edit_file" && b.name !== "write_file") return;
    // The walk visits the whole array; the window edges are block pairs and
    // everything past the claim message belongs to no window of this turn.
    if (messageIndex > claim.messageIndex) return;
    if (
      messageIndex === claim.messageIndex &&
      contentBlockIndex === claim.contentBlockIndex
    ) {
      return;
    }
    if (
      messageIndex < green.messageIndex ||
      (messageIndex === green.messageIndex &&
        contentBlockIndex <= green.contentBlockIndex)
    ) {
      return;
    }
    return !isDocOnlyPath(editBlockPath(b.input));
  });
}

/** Scan forward for the tool_result paired with a tool_use_id (preserveToolPairs guarantees pairing). */
function findToolResult(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  toolUseId: string
): { readonly content: unknown; readonly is_error?: boolean } | null {
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as AnthropicContentBlock;
      if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
        return { content: b.content, is_error: b.is_error };
      }
    }
  }
  return null;
}

/**
 * Extract all bash test-execution evidence from messages (fills the
 * marker/anti-forgery fields). Malformed shapes (missing content / non-object)
 * are skipped, never crash (fail-closed). Non-test bash (ls / mkdir / git add)
 * does not count as verification evidence.
 */
function extractTestRuns(
  messages: ReadonlyArray<AnthropicNativeMessage>
): TestRunEvidence[] {
  const runs: TestRunEvidence[] = [];
  forEachToolUseBlock(messages, (b, i, j) => {
    if (b.name !== "bash") return;
    const command = extractCommand(b.input);
    if (!isTestCommand(command)) return; // test executions only
    const result = findToolResult(messages, b.id);
    const text = result ? toolResultText(result.content) : null;
    const isError = result ? Boolean(result.is_error) : false;
    // Marker checks read only the real stdout (stdout field of the
    // structured JSON); the non-JSON fallback shape treats the whole text
    // as stdout (defensive).
    const { stdout } = parseToolResult(
      isError || text?.startsWith(EXECUTION_FAILED_PREFIX) ? null : text
    );
    // Runner + green-summary-line both anchored → framework; greenSummary is equivalent to it.
    const framework = detectFramework(command, stdout);
    runs.push({
      messageIndex: i,
      contentBlockIndex: j,
      command,
      exitCode: parseExitCode(text, isError),
      framework,
      greenSummary: framework !== null,
      weakGreen: isWeakGreen(command, stdout),
      swallowed: isSwallowed(command),
    });
  });
  return runs;
}

/**
 * CONTRADICTED fact 1: write_file blanks a test file (content ≈ empty —
 * blank string or empty array). Path via editBlockPath (production `path`
 * first, legacy `filePath`); malformed input / content shapes → not blanked
 * (fail-closed).
 */
function isBlankedTestFileWrite(b: ToolUseBlock): boolean {
  if (b.name !== "write_file") return false;
  const fp = editBlockPath(b.input) ?? "";
  const content = (b.input as { content?: unknown }).content;
  const isEmpty =
    (typeof content === "string" && content.trim() === "") ||
    (Array.isArray(content) && content.length === 0);
  return isTestFilePath(fp) && isEmpty;
}

/**
 * First non-flag command token that is a real test-file path (token split;
 * converges on isTestFilePath to avoid substring false hits like
 * node_modules / vitest). Shared by the rm hard-veto and the bash
 * mutation soft signal so both agree on the target scan.
 */
function findTestFileTarget(command: string): string | undefined {
  return command
    .split(/\s+/)
    .find((t) => t && !t.startsWith("-") && isTestFilePath(t));
}

/**
 * CONTRADICTED fact 2: bash `rm` on a test file — feed each rm target token
 * to isTestFilePath, converging on real test-file path decisions (avoids
 * substring false hits like node_modules / vitest).
 */
function isRmOnTestFile(command: string): boolean {
  if (!/\brm\b/.test(command)) return false;
  return findTestFileTarget(command) !== undefined;
}

/**
 * CONTRADICTED hard-veto check (binary facts; count-based signals never accuse).
 * Only two observable "test file destroyed" facts count:
 *  - write_file blanks a test file (content ≈ empty);
 *  - bash `rm` on a test file.
 * Numeric signals (fewer assertions) never reach CONTRADICTED — they fall to
 * gamingSignals as soft signals.
 */
function hasContradiction(
  messages: ReadonlyArray<AnthropicNativeMessage>
): boolean {
  return forEachToolUseBlock(messages, (b) => {
    if (b.name === "write_file") return isBlankedTestFileWrite(b);
    if (b.name === "bash") return isRmOnTestFile(extractCommand(b.input));
    return false;
  });
}

/** Test-file path heuristic (src/foo.test.ts / tests/* / test_*.py etc.). */
function isTestFilePath(filePath: string): boolean {
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath) ||
    /\b(tests?|__tests__|test_)\./.test(filePath) ||
    filePath.includes("/test/") ||
    filePath.includes("/tests/") ||
    /(^|\/)tests?\/?$/.test(filePath) ||
    /(^|\/)test_[^/]+$/.test(filePath) ||
    /(^|\/)(test|tests|spec)\/[^/]+$/.test(filePath) ||
    filePath.endsWith("_test.go") ||
    filePath.endsWith("_test.py")
  );
}

/** New skip/xfail decorator spellings (soft-signal scan over visible input.content). */
const SKIP_DECORATOR_PATTERN =
  /(\.skip|\.skipIf|\.xfail|@pytest\.mark\.skip|#\[ignore\]|#\[should_panic\])/;

/**
 * Bash-side soft signals: git commit --no-verify/-n (skipped pre-commit
 * checks); rm/sed/mv mutating a test file (aligned with CONTRADICTED:
 * recorded only when the target passes isTestFilePath, avoiding false hits
 * like rm dist/bundle.js).
 */
function pushBashGamingSignals(command: string, signals: string[]): void {
  if (/--no-verify|-n\b/.test(command) && /\bgit\s+commit\b/.test(command)) {
    signals.push("git commit --no-verify/-n (skipped pre-commit checks)");
  }
  if (!/\b(rm|sed|mv)\b/.test(command)) return;
  const target = findTestFileTarget(command);
  if (target !== undefined) {
    signals.push("bash file mutation on test file: " + target);
  }
}

/**
 * Edit-side soft signal: a new skip/xfail decorator landing in a test file.
 * Scans only the visible input.content text, never reads fs (pure-function
 * discipline). Path via editBlockPath (production `path` first, legacy
 * `filePath`).
 */
function pushEditGamingSignals(b: ToolUseBlock, signals: string[]): void {
  if (b.name !== "edit_file" && b.name !== "write_file") return;
  const fp = editBlockPath(b.input) ?? "";
  const content = (b.input as { content?: unknown }).content;
  if (!isTestFilePath(fp) || typeof content !== "string") return;
  if (SKIP_DECORATOR_PATTERN.test(content)) {
    signals.push("new skip/xfail decorator in test file: " + fp);
  }
}

/**
 * Collect gamingSignals soft signals (recorded only, never judged).
 * Count-based signals never accuse: fewer assertions / new skip/xfail /
 * --no-verify land only in gamingSignals, never changing the verdict.
 */
function collectGamingSignals(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  const signals: string[] = [];
  forEachToolUseBlock(messages, (b) => {
    if (b.name === "bash") {
      pushBashGamingSignals(extractCommand(b.input), signals);
      return;
    }
    pushEditGamingSignals(b, signals);
  });
  return signals;
}

/**
 * Build the fail-closed INSUFFICIENT report (when unsure, never PASS).
 * stale is passed in by the staleness path (a stale INSUFFICIENT report keeps
 * STALE semantics).
 */
function insufficient(
  reasons: ReadonlyArray<string>,
  runs: ReadonlyArray<TestRunEvidence>,
  stale = false
): EvidenceReport {
  return {
    verdict: "EVIDENCE_INSUFFICIENT",
    reasons: [...reasons],
    runs: [...runs],
    gamingSignals: [],
    stale,
  };
}

/**
 * Evidence-sufficiency verdict (five-condition conjunction): exit 0 ∧ green
 * summary ∧ not weak green ∧ no swallowed failure ∧ no code edit inside the
 * staleness window. Fail-closed throughout: anything unparseable never
 * reaches SUFFICIENT.
 */
function computeVerdict(runs: ReadonlyArray<TestRunEvidence>): EvidenceVerdict {
  for (const run of runs) {
    if (
      run.exitCode === 0 &&
      run.greenSummary &&
      !run.weakGreen &&
      !run.swallowed
    ) {
      return "EVIDENCE_SUFFICIENT";
    }
  }
  return "EVIDENCE_INSUFFICIENT";
}

/**
 * Upstream content gate: does this turn carry a usable content signal?
 * Trigger IFF (a test command was run) ∨ (a non-doc source file was edited);
 * the presence of verify.command alone does NOT open the gate. Pure chit-chat
 * and doc-only edits (isDocOnlyPath SSOT) never enter the verify subsystem.
 *
 * Fail-closed on malformed input via the shared forEachToolUseBlock walk and
 * the module's helpers: a bash block whose command is missing/non-string
 * contributes no test signal (extractCommand → "" → isTestCommand false), an
 * edit block whose path is non-string on both keys (`path` canonical,
 * `filePath` legacy) is no code edit, and malformed messages / content /
 * blocks are skipped — they never throw and never positively trigger.
 */
export function shouldTriggerVerify(args: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
}): boolean {
  // Public entry: a non-array messages argument is malformed input →
  // no usable signal (fail-closed; the walk itself assumes an array).
  if (!Array.isArray(args.messages)) return false;
  return forEachToolUseBlock(args.messages, (b) => {
    if (b.name === "bash") {
      return isTestCommand(extractCommand(b.input));
    }
    if (b.name === "edit_file" || b.name === "write_file") {
      const path = editBlockPath(b.input);
      return path !== undefined && !isDocOnlyPath(path);
    }
    return false;
  });
}

/**
 * checkEvidence — main entry.
 * Input = read-only snapshot of the main session's append-only messages (up
 * to the last compact) + claimIndex scalar (position of the completion claim,
 * right edge of the staleness window).
 */
export function checkEvidence(args: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly claimIndex: number;
}): EvidenceReport {
  const { messages, claimIndex } = args;

  // Fail-closed precondition: claimIndex=0 / empty input → INSUFFICIENT.
  if (claimIndex <= 0 || !Array.isArray(messages) || messages.length === 0) {
    return insufficient(
      ["no messages or claimIndex at session start (fail-closed)"],
      []
    );
  }

  // claimIndex windowing: runs produced after the claim are not evidence
  // (right edge of the ordering window = claimIndex; conservative — even a
  // green post-claim run never yields SUFFICIENT).
  const runs = extractTestRuns(messages).filter(
    (r) => r.messageIndex < claimIndex
  );
  if (runs.length === 0) {
    return insufficient(["no bash test execution before claim found"], []);
  }

  // CONTRADICTED: clearing/removing test files is the only hard veto, checked before all else.
  if (hasContradiction(messages)) {
    return {
      verdict: "EVIDENCE_CONTRADICTED",
      reasons: ["test files cleared or removed (binary contradiction)"],
      runs,
      gamingSignals: collectGamingSignals(messages),
      stale: false,
    };
  }

  const gamingSignals = collectGamingSignals(messages);

  const verdict = computeVerdict(runs);
  if (verdict === "EVIDENCE_SUFFICIENT") {
    // Staleness: code edited after the green test block but not past the claim
    // → stale → not SUFFICIENT.
    const claim: ContentBlockPosition = {
      messageIndex: claimIndex,
      // The claim message's own text block, when it has one: the right edge is
      // a block, not a message. Absent (claimIndex pointing at a tool-result
      // turn, or malformed content) fails closed to -1, which no block equals.
      contentBlockIndex: lastNonEmptyTextBlockIndex(
        messages[claimIndex]?.content
      ),
    };
    const stale = runs.some((r) => hasStaleEdit(messages, r, claim));
    if (stale) {
      return insufficient(
        ["code edited after green test run (stale evidence)"],
        runs,
        true
      );
    }
    return {
      verdict,
      reasons: [],
      runs,
      gamingSignals,
      stale: false,
    };
  }
  return {
    ...insufficient(
      ["no run satisfies exit-0 + green-summary evidence threshold"],
      runs
    ),
    gamingSignals,
  };
}
