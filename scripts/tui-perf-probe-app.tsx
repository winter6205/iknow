/** @jsxImportSource @opentui/react */
/**
 * scripts/tui-perf-probe-app.tsx
 *
 * Keystroke-latency probe on the product path (full TuiApp). Diagnostic
 * only — not shipped behavior.
 *
 * Reproduces "typing gets laggy after a few chat turns": mount TuiApp with
 * an initialSession carrying N turns of history, then press keys one at a
 * time (touching only the input box's inputValue, fully independent of
 * session history) and count the `marked.lexer` re-parses each keystroke
 * triggers — proving the O(history) re-render also holds on the full
 * product path, not just in ChatView unit-test assemblies.
 *
 * `cpu ms/keystroke` subtracts an idle baseline of the same cadence but
 * still mixes in stdin-parsing / frame-loop noise: order-of-magnitude
 * reference only. For a clean timing curve use `scripts/tui-perf-probe.tsx`.
 *
 * Knobs: `PROBE_TURNS` (history turn counts), `PROBE_KEYS` (keys per case).
 *
 * Run: $HOME/.bun/bin/bun run scripts/tui-perf-probe-app.tsx
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { marked } from "marked";
import { createTuiAskUserBridge } from "../src/tui/ask-user.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../src/tui/hub-bridge.js";
import { createToolEventSink, TuiApp } from "../src/tui/app.js";
import { createPermissionModeContext } from "../src/harness/permission/index.js";
import { createSessionGrants } from "../src/harness/permission/session-grants.js";
import { attachSession } from "../src/tui/session-state.js";
import type { SessionFileV1 } from "../src/session-api/store/schema.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../src/harness/model-adapter/types.js";
import { assistantResult, makeDeps } from "../tests/cli/_fixtures.ts";

const COLS = 120;
const ROWS = 40;

let lexCalls = 0;
let lexChars = 0;
const originalLexer = marked.lexer.bind(marked);
(marked as unknown as { lexer: typeof marked.lexer }).lexer = ((
  src: string,
  opts?: unknown
) => {
  lexCalls += 1;
  lexChars += typeof src === "string" ? src.length : 0;
  return (originalLexer as (s: string, o?: unknown) => unknown)(src, opts);
}) as typeof marked.lexer;

const ASSISTANT_MD = `我已经看过相关实现，下面是这一轮的结论。

## 结论

- 第一点：调用链在 \`chat-view.tsx\` 收口，滚动交给 scrollbox。
- 第二点：**每条消息** 都会重新走一遍 markdown 渲染。
- 第三点：代码块也会重新分词着色。

\`\`\`ts
export function selectViewportMountWindow(messages, opts) {
  const heights = messages.map((_, i) => opts.heights?.[i] ?? 4);
  return heights.reduce((s, h) => s + h, 0);
}
\`\`\`

后续我会继续验证这个假设，并给出最小修复方向。`;

function turnMessages(k: number): AnthropicNativeMessage[] {
  const id = `toolu_${k}`;
  return [
    {
      role: "user",
      content: [{ type: "text", text: `第 ${k} 轮提问：请解释挂载策略。` }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: `先看一下第 ${k} 轮涉及的文件。` },
        {
          type: "tool_use",
          id,
          name: "bash",
          input: { command: `rg -n "viewport" src/tui | head -${k + 5}` },
        } as unknown as AnthropicContentBlock,
        { type: "text", text: ASSISTANT_MD },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text: "src/tui/chat-view.tsx:236" }],
        } as unknown as AnthropicContentBlock,
      ],
    },
  ];
}

function sessionFile(turns: number): SessionFileV1 {
  const messages: AnthropicNativeMessage[] = [];
  for (let k = 0; k < turns; k++) messages.push(...turnMessages(k));
  return {
    schemaVersion: 1,
    conversation_id: "perf-probe-app",
    messages,
    turnCount: turns,
    updatedAt: "2026-08-27T00:00:00.000Z",
    jsonMode: false,
  };
}

async function measure(
  turns: number,
  keys: number
): Promise<{
  turns: number;
  msgs: number;
  cpuMsPerKey: number;
  lexPerKey: number;
  charsPerKey: number;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-perf-"));
  const file = sessionFile(turns);
  const setup = await testRender(
    <TuiApp
      bridge={createTuiBridge({
        dataDir,
        deps: makeDeps([assistantResult({ texts: [] })]),
        inflight: createInflightRegistry(),
      })}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      initialSession={attachSession(file)}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();

  // Warm up: start the mockInput parser.
  setup.mockInput.pressKey("x");
  await new Promise((r) => setTimeout(r, 120));
  await setup.waitForVisualIdle();

  // Idle baseline: same waiting cadence but no keystrokes → subtracts the frame loop's own CPU.
  let cpuIdle = 0;
  for (let i = 0; i < keys; i++) {
    const c0 = process.cpuUsage();
    await new Promise((r) => setTimeout(r, 80));
    await setup.waitForVisualIdle();
    const c = process.cpuUsage(c0);
    cpuIdle += (c.user + c.system) / 1000;
  }

  lexCalls = 0;
  lexChars = 0;
  let cpuMs = 0;
  for (let i = 0; i < keys; i++) {
    const c0 = process.cpuUsage();
    setup.mockInput.pressKey("a");
    await new Promise((r) => setTimeout(r, 80));
    await setup.waitForVisualIdle();
    const c = process.cpuUsage(c0);
    cpuMs += (c.user + c.system) / 1000;
  }
  const out = {
    turns,
    msgs: file.messages.length,
    cpuMsPerKey: (cpuMs - cpuIdle) / keys,
    lexPerKey: lexCalls / keys,
    charsPerKey: lexChars / keys,
  };
  await setup.renderer.destroy();
  return out;
}

const KEYS = Number(process.env.PROBE_KEYS ?? 12);
const TURN_SET = (process.env.PROBE_TURNS ?? "0,2,4,8,16")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);

console.log(
  `# TuiApp keystroke probe — cols=${COLS} rows=${ROWS} keys/case=${KEYS}`
);
console.log("turns  msgs   cpu ms/keystroke  marked.lexer/keystroke  chars/keystroke");
for (const turns of TURN_SET) {
  const r = await measure(turns, KEYS);
  console.log(
    `${String(r.turns).padStart(5)} ${String(r.msgs).padStart(5)} ${r.cpuMsPerKey.toFixed(2).padStart(13)} ${r.lexPerKey.toFixed(1).padStart(20)} ${r.charsPerKey.toFixed(0).padStart(15)}`
  );
}
process.exit(0);
