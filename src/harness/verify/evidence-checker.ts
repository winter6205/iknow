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
 * exit code 双路解析 (A9, R3 #457): 结构化 JSON {code} 优先 (bash.ts:79-83
 * → executor.ts:46 文本契约); 解析失败回退 ^Exit code (\d+) (防御性兜底,
 * 当前模型面 bash 恒为 JSON shape); is_error / [execution_failed] 前缀 →
 * null。JSON 成功但形状不符 → null (fail-closed, 不静默放行)。
 */
function parseExitCode(text: string | null, isError: boolean): number | null {
  if (isError || text === null) return null;
  if (text.startsWith(EXECUTION_FAILED_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const code = (parsed as { code?: unknown }).code;
      if (typeof code === "number" && Number.isInteger(code)) return code;
    }
    return null;
  } catch {
    const m = /^Exit code (\d+)/m.exec(text);
    return m ? Number(m[1]) : null;
  }
}

/** bash tool_use input.command 提取; 畸形 input 返回 "" (不 crash)。 */
function extractCommand(input: unknown): string {
  if (input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return command;
  }
  return "";
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
 * 提取 messages 里所有 bash 测试执行证据 (T2 骨架; T3 填充 marker/三防字段)。
 * 畸形 shape (缺 content / 非对象) 一律跳过, 不 crash (fail-closed)。
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
      const result = findToolResult(messages, b.id);
      runs.push({
        messageIndex: i,
        command: extractCommand(b.input),
        exitCode: parseExitCode(
          result ? toolResultText(result.content) : null,
          result ? Boolean(result.is_error) : false
        ),
        framework: null, // T3: 五框架 marker 识别
        greenSummary: false, // T3: green 摘要行判定
        weakGreen: false, // T3: 弱绿四形态
        swallowed: false, // T3: 吞失败四 pattern
      });
    }
  }
  return runs;
}

/** fail-closed 的 INSUFFICIENT 报告构造 (A8: 拿不准不 PASS)。 */
function insufficient(
  reasons: ReadonlyArray<string>,
  runs: ReadonlyArray<TestRunEvidence>
): EvidenceReport {
  return {
    verdict: "EVIDENCE_INSUFFICIENT",
    reasons: [...reasons],
    runs: [...runs],
    gamingSignals: [],
    stale: false,
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

  const verdict = computeVerdict(runs);
  if (verdict === "EVIDENCE_INSUFFICIENT") {
    return insufficient(
      ["no run satisfies exit-0 + green-summary evidence threshold"],
      runs
    );
  }
  return {
    verdict,
    reasons: [],
    runs,
    gamingSignals: [],
    stale: false,
  };
}
