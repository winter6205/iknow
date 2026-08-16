/**
 * evidence-checker — 证据优先判定的纯函数规则引擎 (spec 449-evidence-checker)。
 *
 * 纯函数层 (G2-1): 零 IO、零 LLM、零 loop 接线。输入 = 主会话 messages 只读
 * 快照 + claimIndex 标量, 输出 = EvidenceReport。6 条检查全部封装在内部,
 * 调用方只消费 verdict 不数条件。
 *
 * 冻结契约 (ADR-0003/0006): 不 import loop-engine/session-api/subagent/fs;
 * 只消费已被 sandbox/executor 截断过的 stdout (截断是上游权威)。唯一跨
 * context import 是 AnthropicNativeMessage (与 verify-loop.ts:28 同款)。
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

/** is_error 失败标签统一前缀 (tool-result.ts:44)。 */
const EXECUTION_FAILED_PREFIX = "[execution_failed]";

/**
 * tool_result content 首个 text 文本 (Anthropic content 双形状: string | block[])。
 * 畸形 content 返回 null (fail-closed, 不 crash)。
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
 * 解析 bash tool_result 结构化 JSON (bash.ts:79-83 → executor.ts:46 文本契约)。
 * 解析失败返回 null (fail-closed)。解析成功返回 {code, stdout}:
 *  - code 供 exit code 判定; stdout 供 marker 判定 (真实 stdout, 非整段 JSON)。
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
    // 非 JSON: ^Exit code (\d+) 正则回退 (防御性兜底, 当前模型面 bash 恒为 JSON shape)。
    const m = /^Exit code (\d+)/m.exec(text);
    return { code: m ? Number(m[1]) : null, stdout: text };
  }
}

/**
 * exit code 双路解析 (A9, R3 #457): 结构化 JSON {code} 优先; 解析失败回退
 * ^Exit code (\d+); is_error / [execution_failed] 前缀 → null。JSON 成功但
 * 形状不符 → null (fail-closed, 不静默放行)。
 */
function parseExitCode(text: string | null, isError: boolean): number | null {
  if (isError || text === null) return null;
  if (text.startsWith(EXECUTION_FAILED_PREFIX)) return null;
  return parseToolResult(text).code;
}

/** bash tool_use input.command 提取; 畸形 input 返回 "" (不 crash)。 */
function extractCommand(input: unknown): string {
  if (input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return "";
}

/**
 * 五框架 runner 识别 + green 摘要行合取 (G4-1 白名单)。
 * runner 由命令侧锚定 (env 前缀/引用剥离识别), green 只从框架摘要行读数字,
 * 绝不扫描任意输出。两条件都中 → framework 判定; 否则 null (fail-closed)。
 */
const FRAMEWORK_RULES: ReadonlyArray<{
  readonly framework: Exclude<TestRunEvidence["framework"], null>;
  /** 命令侧 runner 锚定 (word boundary, 防 go 子串误中)。 */
  readonly runner: RegExp;
  /** stdout green 摘要行 (只读通过数字)。 */
  readonly green: RegExp;
}> = [
  {
    framework: "pytest",
    runner: /\bpytest\b/,
    // count+duration 双子句摘要行 ("N passed in X.XXs", = 装饰可任意位置)。
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

/** 弱绿四形态 (R2/truth; 窄跑用 -k/-t 过滤或 :: 精确路径定位)。 */
const WEAK_GREEN_PATTERNS: ReadonlyArray<RegExp> = [
  /0 tests run/,
  /collected 0 items/,
  /no tests found/i,
  /no test files found/i, // vitest 输出 "No test files found" (单数 test + files)
];

/** 吞失败四 pattern (G4-3 硬信号; 命令文本命中即该证据作废)。 */
const SWALLOWED_PATTERNS: ReadonlyArray<RegExp> = [
  /\|\|\s*true\b/,
  /\|\|\s*exit\s+0\b/,
  /;\s*exit\s+0\b/,
  /--passWithNoTests/,
];

/** 命令侧窄跑过滤 (-k / -t / :: 精确路径) → 弱绿。 */
function hasNarrowSelection(command: string): boolean {
  return /(^|\s)-[kt]\b/.test(command) || command.includes("::");
}

/** 五框架 marker 判定; 不匹配 → null (fail-closed, 不猜框架)。 */
function detectFramework(
  command: string,
  stdout: string
): TestRunEvidence["framework"] {
  for (const { framework, runner, green } of FRAMEWORK_RULES) {
    if (runner.test(command) && green.test(stdout)) return framework;
  }
  return null;
}

/** 弱绿判定: 摘要文本命中四形态任一, 或命令侧窄跑过滤。 */
function isWeakGreen(command: string, stdout: string): boolean {
  if (WEAK_GREEN_PATTERNS.some((p) => p.test(stdout))) return true;
  return hasNarrowSelection(command);
}

/** 吞失败判定: 命令文本命中四 pattern 任一 → 该证据作废。 */
function isSwallowed(command: string): boolean {
  return SWALLOWED_PATTERNS.some((p) => p.test(command));
}

/**
 * 该 turn 的 bash 是否执行了测试 (命令侧测试意图启发式)。
 * 非测试 bash (ls / mkdir / git add 等) 不作为验证证据。
 */
function isTestCommand(command: string): boolean {
  const t =
    /\b(npm test|npx vitest|npx jest|vitest run|jest|pytest|cargo test|go test)\b/;
  return t.test(command);
}

/** doc-only 豁免: .md / .txt / docs/ 路径编辑不算代码编辑 (A6)。 */
function isDocOnlyPath(filePath: unknown): boolean {
  if (typeof filePath !== "string") return false;
  return /\.(md|txt)$/i.test(filePath) || filePath.includes("docs/");
}

/**
 * 时效判定 (A6, R2 STALE 语义): 绿测试 turn 之后、claimIndex 之前存在
 * edit_file / write_file 且目标路径非 doc-only → stale。时序用 messages index
 * (不用 mtime/diff/git)。bash 内联改文件 (sed -i / echo >) v1 不追 (G4-2 已知局限)。
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

/** 向后扫描找 tool_use_id 配对的 tool_result (preserveToolPairs 保证成对)。 */
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
 * 提取 messages 里所有 bash 测试执行证据 (T3: 填充 marker/三防字段)。
 * 畸形 shape (缺 content / 非对象) 一律跳过, 不 crash (fail-closed)。
 * 非测试 bash (ls / mkdir / git add 等) 不作为验证证据。
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
      if (!isTestCommand(command)) continue; // 只收集测试执行
      const result = findToolResult(messages, b.id);
      const text = result ? toolResultText(result.content) : null;
      const isError = result ? Boolean(result.is_error) : false;
      // marker 判定只读真实 stdout (结构化 JSON 的 stdout 字段);
      // 非 JSON 回退形态 stdout = 全文 (防御性兜底)。
      const { stdout } = parseToolResult(
        isError || text?.startsWith(EXECUTION_FAILED_PREFIX) ? null : text
      );
      runs.push({
        messageIndex: i,
        command,
        exitCode: parseExitCode(text, isError),
        framework: detectFramework(command, stdout),
        greenSummary: detectFramework(command, stdout) !== null,
        weakGreen: isWeakGreen(command, stdout),
        swallowed: isSwallowed(command),
      });
    }
  }
  return runs;
}

/**
 * CONTRADICTED 硬否决判定 (A7 二进制事实, spec: truth count-based 永不指控)。
 * 只认两个可观测的"测试文件被破坏"事实:
 *  - write_file 把测试文件清空 (内容 ≈ 空);
 *  - bash `rm` 测试文件。
 * 数字类信号 (断言减少) 永不 CONTRADICTED (落 gamingSignals 软信号)。
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
        // bash `rm` 测试文件 (rm / rm -f / rm -rf 目标含 test 路径)。
        if (/\brm\b.*(test|spec|__tests__)/.test(command)) return true;
      }
    }
  }
  return false;
}

/** 测试文件路径启发式 (src/foo.test.ts / tests/* / test_*.py 等)。 */
function isTestFilePath(filePath: string): boolean {
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath) ||
    /\b(tests?|__tests__|test_)\./.test(filePath) ||
    filePath.includes("/test/") ||
    filePath.startsWith("test_") ||
    filePath.endsWith("_test.go") ||
    filePath.endsWith("_test.py")
  );
}

/**
 * gamingSignals 软信号收集 (A7: 仅记录, 不参与判定)。
 * count-based 永不指控: 断言数减少 / 新增 skip/xfail / --no-verify 只落
 * gamingSignals, 不改 verdict。
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
        if (/\b(rm|sed|mv)\b/.test(command)) {
          // 变更测试文件自身的 bash 操作视为可疑 (低置信, 只记录)。
          signals.push("bash file mutation on test-ish target");
        }
      }
    }
  }
  return signals;
}

/**
 * fail-closed 的 INSUFFICIENT 报告构造 (A8: 拿不准不 PASS)。
 * stale 由时效路径传入 (stale INSUFFICIENT 时报告需保留 STALE 语义)。
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
 * 证据充分性判定 (A3 五条件合取): exit 0 ∧ green 摘要 ∧ 非弱绿 ∧ 无吞失败
 * ∧ 时效窗口无代码编辑。T2 骨架阶段 greenSummary 恒 false → 永不 SUFFICIENT
 * (fail-closed); T3 填充 marker 判定后放行。时效判定 T3 落 stale 字段。
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
 * checkEvidence — 主入口 (spec Code Style)。
 * 输入 = 主会话 append-only messages 只读快照 (截至最后一次 compact) +
 * claimIndex 标量 (completed 声称位置, 时效窗口右端)。
 */
export function checkEvidence(args: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly claimIndex: number;
}): EvidenceReport {
  const { messages, claimIndex } = args;

  // fail-closed 前置 (A8): claimIndex=0 / 空输入 → INSUFFICIENT。
  if (claimIndex <= 0 || !Array.isArray(messages) || messages.length === 0) {
    return insufficient(
      ["no messages or claimIndex at session start (fail-closed)"],
      []
    );
  }

  const runs = extractTestRuns(messages);
  if (runs.length === 0) {
    return insufficient(["no bash test execution found in transcript"], []);
  }

  // CONTRADICTED (A7): 清空/删除测试文件是唯一硬否决, 优先于其它判定。
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
    // 时效 (A6): 绿测试 turn 之后、claimIndex 之前有代码编辑 → stale → 不 SUFFICIENT。
    const stale = runs.some(
      (r) =>
        r.messageIndex < claimIndex &&
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
