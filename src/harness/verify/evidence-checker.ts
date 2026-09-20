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
 * sandbox/executor (truncation authority stays upstream). The only
 * cross-context import is AnthropicNativeMessage (same as verify-loop.ts).
 */
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../model-adapter/types.js";
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
    green: /\d+\s+passed\s+in\s+[\d.]+\s*s/,
  },
  {
    framework: "jest",
    runner: /\bjest\b/,
    green: /Tests:\s+\d+\s+passed/,
  },
  {
    framework: "vitest",
    runner: /\bvitest\b/,
    green: /Tests\s+\d+\s+passed/,
  },
  {
    framework: "go",
    runner: /\bgo\s+test\b/,
    green: /^ok\s+\S+/m,
  },
  {
    framework: "cargo",
    runner: /\bcargo\s+test\b/,
    green: /test result:\s*ok/,
  },
];

/** Four weak-green shapes (narrow runs use -k/-t filters or :: exact-path selection). */
const WEAK_GREEN_PATTERNS: ReadonlyArray<RegExp> = [
  /0 tests run/,
  /collected 0 items/,
  /no tests found/i,
  /no test files found/i, // vitest prints "No test files found" (singular test + files)
];

/** Four failure-swallowing patterns (hard signal; a command-side hit voids that evidence). */
const SWALLOWED_PATTERNS: ReadonlyArray<RegExp> = [
  /\|\|\s*true\b/,
  /\|\|\s*exit\s+0\b/,
  /;\s*exit\s+0\b/,
  /--passWithNoTests/,
];

/** Command-side narrow selection (-k / -t / :: exact path) → weak green. */
function hasNarrowSelection(command: string): boolean {
  return /(^|\s)-[kt]\b/.test(command) || command.includes("::");
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

/** Failure swallowed: any of the four patterns in the command text → evidence voided. */
function isSwallowed(command: string): boolean {
  return SWALLOWED_PATTERNS.some((p) => p.test(command));
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
 * Staleness check: an edit_file / write_file after the green test turn and
 * before claimIndex, targeting a non-doc-only path → stale. Ordering uses the
 * messages index (never mtime/diff/git). In-bash file mutation (sed -i /
 * echo >) is not tracked in v1 (known limitation).
 */
function hasStaleEdit(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  greenIndex: number,
  claimIndex: number
): boolean {
  for (let i = greenIndex + 1; i < claimIndex; i++) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as AnthropicContentBlock;
      if (b.type !== "tool_use") continue;
      if (b.name === "edit_file" || b.name === "write_file") {
        if (!isDocOnlyPath((b.input as { filePath?: unknown })?.filePath)) {
          return true;
        }
      }
    }
  }
  return false;
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
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as AnthropicContentBlock;
      if (b.type !== "tool_use" || b.name !== "bash") continue;
      const command = extractCommand(b.input);
      if (!isTestCommand(command)) continue; // test executions only
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
        command,
        exitCode: parseExitCode(text, isError),
        framework,
        greenSummary: framework !== null,
        weakGreen: isWeakGreen(command, stdout),
        swallowed: isSwallowed(command),
      });
    }
  }
  return runs;
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
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as AnthropicContentBlock;
      if (b.type !== "tool_use") continue;
      if (b.name === "write_file") {
        const input = b.input as { filePath?: unknown; content?: unknown };
        const fp = typeof input.filePath === "string" ? input.filePath : "";
        const c = input.content;
        const isEmpty =
          (typeof c === "string" && c.trim() === "") ||
          (Array.isArray(c) && c.length === 0);
        if (isTestFilePath(fp) && isEmpty) return true;
      } else if (b.name === "bash") {
        const command = extractCommand(b.input);
        // bash `rm` on a test file: feed each rm target token to
        // isTestFilePath, converging on real test-file path decisions
        // (avoids substring false hits like node_modules / vitest).
        if (/\brm\b/.test(command)) {
          const target = command
            .split(/\s+/)
            .find((t) => t && !t.startsWith("-") && isTestFilePath(t));
          if (target !== undefined) return true;
        }
      }
    }
  }
  return false;
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

/**
 * Collect gamingSignals soft signals (recorded only, never judged).
 * Count-based signals never accuse: fewer assertions / new skip/xfail /
 * --no-verify land only in gamingSignals, never changing the verdict.
 */
function collectGamingSignals(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  const signals: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as AnthropicContentBlock;
      if (b.type !== "tool_use") continue;
      if (b.name === "bash") {
        const command = extractCommand(b.input);
        if (
          /--no-verify|-n\b/.test(command) &&
          /\bgit\s+commit\b/.test(command)
        ) {
          signals.push("git commit --no-verify/-n (skipped pre-commit checks)");
        }
        // bash operations mutating a test file itself → soft signal (aligned
        // with CONTRADICTED: recorded only when the target passes
        // isTestFilePath, avoiding false hits like rm dist/bundle.js).
        if (/\b(rm|sed|mv)\b/.test(command)) {
          const target = command
            .split(/\s+/)
            .find((t) => t && !t.startsWith("-") && isTestFilePath(t));
          if (target !== undefined) {
            signals.push("bash file mutation on test file: " + target);
          }
        }
      } else if (b.name === "edit_file" || b.name === "write_file") {
        // New skip/xfail decorator landing in a test file → soft signal.
        // Scans only the visible input.content text, never reads fs (pure-function discipline).
        const input = b.input as { filePath?: unknown; content?: unknown };
        const fp = typeof input.filePath === "string" ? input.filePath : "";
        if (isTestFilePath(fp) && typeof input.content === "string") {
          if (
            /(\.skip|\.skipIf|\.xfail|@pytest\.mark\.skip|#\[ignore\]|#\[should_panic\])/.test(
              input.content
            )
          ) {
            signals.push("new skip/xfail decorator in test file: " + fp);
          }
        }
      }
    }
  }
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
    // Staleness: code edited after the green test turn but before claimIndex → stale → not SUFFICIENT.
    const stale = runs.some((r) =>
      hasStaleEdit(messages, r.messageIndex, claimIndex)
    );
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
