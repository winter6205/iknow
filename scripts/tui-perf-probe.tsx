/** @jsxImportSource @opentui/react */
/**
 * scripts/tui-perf-probe.tsx
 *
 * TUI 渲染性能探针（诊断用，非产品路径；不进 npm test）。
 *
 * 复现「聊几轮之后 TUI 变卡」：用 @opentui/react 测试渲染器挂 ChatView，
 * 灌入 N 轮历史消息，再反复触发一次 UI 更新，测量每次更新的
 *  - `react+layout ms`：act() 内的 CPU（React render + OpenTUI reconcile/layout）；
 *    wall time 被 16ms 帧节拍量化，只有 CPU time 能反映真实工作量；
 *  - `frame-out ms`：帧输出段 CPU；
 *  - `lexer calls` / `chars lexed`：一次更新里 `marked.lexer` 被调用几次、
 *    重新解析多少字符 —— 即「有多少历史消息被重新渲染」。本 fixture 每轮
 *    assistant 有 2 个 text block，故 `lexer calls / 2 / 渲染趟数` = 重渲染的
 *    历史消息条数。
 *
 * 两种更新模式：
 *  - `PROBE_MODE=stream`（缺省）：改 `draftSegments`，模拟流式增量；
 *  - `PROBE_MODE=parent`：只改一个 **与 ChatView props 完全无关** 的父状态，
 *    模拟输入框按键 / 1Hz 计时 tick。
 *
 * 其它开关：`PROBE_TURNS`（历史轮数列表）、`PROBE_DELTAS`（每档更新次数）、
 * `PROBE_SCALE`（单条 assistant 正文体量倍数）、`PROBE_BANNER=0`（关 banner）。
 *
 * 运行：$HOME/.bun/bin/bun run scripts/tui-perf-probe.tsx
 */
import { act, useEffect, useMemo, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { marked } from "marked";
import { ChatView } from "../src/tui/chat-view.js";
import { attachSession, type TuiSessionState } from "../src/tui/session-state.js";
import type { SessionFileV1 } from "../src/session-api/store/schema.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../src/harness/model-adapter/types.js";
import { renderBannerLines } from "../src/tui/banner.js";

const COLS = 120;
const ROWS = 40;

// ── marked.lexer 计数器（唯一 instrumentation：证明历史消息被重解析）──
let lexCalls = 0;
let lexChars = 0;
let lexMs = 0;
const originalLexer = marked.lexer.bind(marked);
(marked as unknown as { lexer: typeof marked.lexer }).lexer = ((
  src: string,
  opts?: unknown
) => {
  lexCalls += 1;
  lexChars += typeof src === "string" ? src.length : 0;
  const t0 = performance.now();
  const out = (originalLexer as (s: string, o?: unknown) => unknown)(src, opts);
  lexMs += performance.now() - t0;
  return out;
}) as typeof marked.lexer;

// ── 会话构造：一轮 = user 提问 + assistant（thinking+工具+markdown）+ tool_result ──

const ASSISTANT_MD = `我已经看过相关实现，下面是这一轮的结论。

## 结论

- 第一点：调用链在 \`chat-view.tsx\` 收口，滚动交给 scrollbox。
- 第二点：**每条消息** 都会重新走一遍 markdown 渲染。
- 第三点：代码块也会重新分词着色。

\`\`\`ts
export function selectViewportMountWindow(messages, opts) {
  const heights = messages.map((_, i) => opts.heights?.[i] ?? 4);
  const contentHeight = heights.reduce((sum, h) => sum + h, 0);
  return contentHeight <= opts.viewportHeight * 8 ? full(messages) : slice();
}
\`\`\`

后续我会继续验证这个假设，并给出最小修复方向。`;

/** 单条 assistant 正文体量倍数（真实会话的回答远长于最小样例）。 */
const SCALE = Number(process.env.PROBE_SCALE ?? 1);
const ASSISTANT_BODY = Array.from({ length: Math.max(1, SCALE) }, () =>
  ASSISTANT_MD
).join("\n\n");

function turnMessages(k: number): AnthropicNativeMessage[] {
  const idA = `toolu_${k}_a`;
  const idB = `toolu_${k}_b`;
  const assistantContent: AnthropicContentBlock[] = [
    {
      type: "thinking",
      thinking: `第 ${k} 轮的内部推理草稿，用来触发 thinking 折叠行渲染。`,
      signature: "sig",
    } as unknown as AnthropicContentBlock,
    { type: "text", text: `先看一下第 ${k} 轮涉及的文件。` },
    {
      type: "tool_use",
      id: idA,
      name: "bash",
      input: { command: `rg -n "selectViewportMountWindow" src/tui | head -${k + 5}` },
    } as unknown as AnthropicContentBlock,
    {
      type: "tool_use",
      id: idB,
      name: "read_file",
      input: { path: `src/tui/chat-view.tsx`, offset: k * 10 },
    } as unknown as AnthropicContentBlock,
    { type: "text", text: ASSISTANT_BODY },
  ];
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `第 ${k} 轮提问：请解释 transcript viewport 的挂载策略，并给出证据。`,
        },
      ],
    },
    { role: "assistant", content: assistantContent },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: idA,
          content: [{ type: "text", text: "src/tui/chat-view.tsx:236" }],
        } as unknown as AnthropicContentBlock,
        {
          type: "tool_result",
          tool_use_id: idB,
          content: [{ type: "text", text: "ok" }],
        } as unknown as AnthropicContentBlock,
      ],
    },
  ];
}

function sessionWithTurns(turns: number): TuiSessionState {
  const messages: AnthropicNativeMessage[] = [];
  for (let k = 0; k < turns; k++) messages.push(...turnMessages(k));
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "perf-probe",
    messages,
    turnCount: turns,
    updatedAt: "2026-08-27T00:00:00.000Z",
    jsonMode: false,
  };
  return attachSession(file);
}

// ── harness：只有 draftSegments 在变（模拟流式增量）────────────────

interface DraftApi {
  setDraft(text: string): void;
  /** 与 ChatView props 无关的父状态（模拟输入框按键 / 1Hz 计时 tick）。 */
  bumpUnrelated(): void;
}

function Harness(props: {
  readonly session: TuiSessionState;
  readonly banner: boolean;
  readonly register: (api: DraftApi) => void;
}): ReturnType<typeof ChatView> {
  const [draft, setDraft] = useState("");
  const [, setUnrelated] = useState(0);
  // app.tsx 侧 draftSegments 是 state（引用稳定）；harness 必须同样稳定，
  // 否则 useDeferredValue 每次父渲染都多跑一遍，污染 parent 模式计数。
  const segments = useMemo(() => (draft === "" ? [] : [draft]), [draft]);
  useEffect(() => {
    props.register({
      setDraft,
      bumpUnrelated: () => setUnrelated((n) => n + 1),
    });
  }, []);
  return (
    <ChatView
      session={props.session}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[]}
      draftSegments={segments}
      bannerLines={
        props.banner
          ? renderBannerLines(
              { version: "0.1.0", cwd: "/workspace", dataDir: "/tmp" },
              COLS
            )
          : undefined
      }
    />
  );
}

const DELTA = "这是流式回答的一个增量片段。";

interface Row {
  readonly turns: number;
  readonly msgs: number;
  readonly cpuMsPerDelta: number;
  readonly cpuIdleMsPerDelta: number;
  readonly lexPerDelta: number;
  readonly charsPerDelta: number;
  readonly lexMsPerDelta: number;
}

async function measure(
  turns: number,
  deltas: number,
  banner: boolean
): Promise<Row> {
  const session = sessionWithTurns(turns);
  const holder: { api: DraftApi | null } = { api: null };
  const setup = await testRender(
    <Harness
      session={session}
      banner={banner}
      register={(api) => {
        holder.api = api;
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const api = holder.api!;

  // 预热（一次增量，让 itemHeights 量测收敛）。
  api.setDraft(DELTA);
  await setup.waitForVisualIdle();

  lexCalls = 0;
  lexChars = 0;
  lexMs = 0;
  // wall time 被 16ms 帧节拍量化 → 用 CPU time 衡量真实工作量。
  // act() 内 = React render + OpenTUI reconcile/layout；idle 段 = 帧输出。
  let cpuAct = 0;
  let cpuIdle = 0;
  let text = DELTA;
  for (let i = 0; i < deltas; i++) {
    text += DELTA;
    const a0 = process.cpuUsage();
    await act(async () => {
      if (MODE === "parent") api.bumpUnrelated();
      else api.setDraft(text);
    });
    const a = process.cpuUsage(a0);
    cpuAct += (a.user + a.system) / 1000;
    const b0 = process.cpuUsage();
    await setup.waitForVisualIdle();
    const b = process.cpuUsage(b0);
    cpuIdle += (b.user + b.system) / 1000;
  }
  const row: Row = {
    turns,
    msgs: session.messages.length,
    cpuMsPerDelta: cpuAct / deltas,
    cpuIdleMsPerDelta: cpuIdle / deltas,
    lexPerDelta: lexCalls / deltas,
    charsPerDelta: lexChars / deltas,
    lexMsPerDelta: lexMs / deltas,
  };
  await setup.renderer.destroy();
  return row;
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d).padStart(9);
}

const DELTAS = Number(process.env.PROBE_DELTAS ?? 20);
/** `stream` = 每次改 draftSegments；`parent` = 只改与 ChatView 无关的父状态。 */
const MODE = process.env.PROBE_MODE ?? "stream";
const BANNER = process.env.PROBE_BANNER !== "0";
const TURN_SET = (process.env.PROBE_TURNS ?? "1,2,4,8,16")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

console.log(
  `# TUI render probe — mode=${MODE} cols=${COLS} rows=${ROWS} updates/case=${DELTAS} banner=${BANNER} scale=${SCALE}`
);
console.log(
  "turns  msgs  react+layout ms  frame-out ms  lexer calls  chars lexed  lexer ms"
);
for (const turns of TURN_SET) {
  const r = await measure(turns, DELTAS, BANNER);
  console.log(
    `${String(r.turns).padStart(5)} ${String(r.msgs).padStart(5)} ${fmt(r.cpuMsPerDelta, 2)}     ${fmt(r.cpuIdleMsPerDelta, 2)}   ${fmt(r.lexPerDelta, 1)}   ${fmt(r.charsPerDelta, 0)}  ${fmt(r.lexMsPerDelta, 2)}`
  );
}
process.exit(0);
