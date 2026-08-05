/**
 * tests/tui/chat-view.test.tsx
 *
 * 任务 A：聊天区域消息级滚动（PgUp/PgDn/Home/End 由 app.tsx 全局 useInput
 * 监听；ChatView 接收 scroll prop 做消息级切片）。本测试覆盖：
 *  - 无 scroll prop → 全部消息可见（默认 0 = 底部）
 *  - scroll = k → 截掉最新 k 条，可见数量 = total - k
 *  - scroll > 0 → 顶部 dim 指示「↓ N 条新消息」出现
 *  - 切回 scroll = 0 → 指示消失，全部回归
 *  - scroll 越界由 ChatView 兜底 clamp
 *
 * ink 没有原生虚拟滚动；本测试只断言 ChatView 在不同 scroll prop 下的
 * 渲染输出差异（renderToString + 字符串包含 / 不包含）。为简化切片数学，
 * 测试用单角色消息（每对只放一个 user，assistant 留空以避免 pair 干扰）。
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import { ChatView } from "../../src/tui/chat-view.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

function makeSession(
  messages: ReadonlyArray<AnthropicNativeMessage>
): TuiSessionState {
  return { ...createDraftSession(), messages };
}

/** 每条消息独占一行（user-only，无 reply 对），便于算可见数。 */
function buildUserMessages(n: number): ReadonlyArray<AnthropicNativeMessage> {
  const out: AnthropicNativeMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `m-${i}` }] });
  }
  return Object.freeze(out);
}

describe("ChatView 消息级滚动（任务 A）", () => {
  it("无 scroll prop → 全部消息可见，顶部无指示", async () => {
    const session = makeSession(buildUserMessages(10));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    for (let i = 0; i < 10; i++) {
      expect(plain).toContain(`m-${i}`);
    }
    expect(plain).not.toContain("条新消息");
  });

  it("scroll=k → 截掉最新 k 条（m-9..m-(10-k) 不可见）", async () => {
    const session = makeSession(buildUserMessages(10));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scroll={3}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // m-0..m-6 可见
    for (let i = 0; i < 7; i++) {
      expect(plain).toContain(`m-${i}`);
    }
    // m-7 / m-8 / m-9 不可见
    expect(plain).not.toContain("m-7");
    expect(plain).not.toContain("m-8");
    expect(plain).not.toContain("m-9");
    // 顶部指示：3 条新消息
    expect(plain).toContain("3 条新消息");
  });

  it("scroll = total-1 → 只剩最早 1 条，顶部 N-1 指示", async () => {
    const session = makeSession(buildUserMessages(5));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scroll={4}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("m-0");
    expect(plain).not.toContain("m-1");
    expect(plain).not.toContain("m-4");
    expect(plain).toContain("4 条新消息");
  });

  it("scroll 越界（> total-1）由 ChatView 兜底 clamp，不报错", async () => {
    const session = makeSession(buildUserMessages(3));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scroll={9999}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // 兜底到 total-1 = 2：只剩 m-0
    expect(plain).toContain("m-0");
    expect(plain).not.toContain("m-1");
    expect(plain).not.toContain("m-2");
    expect(plain).toContain("2 条新消息");
  });

  it("scroll = 0 切回底部 → 指示消失，全部回归", async () => {
    const session = makeSession(buildUserMessages(5));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scroll={0}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    for (let i = 0; i < 5; i++) {
      expect(plain).toContain(`m-${i}`);
    }
    expect(plain).not.toContain("条新消息");
  });

  it("scroll 负数兜底为 0（不报错，显示全部）", async () => {
    const session = makeSession(buildUserMessages(3));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scroll={-5}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("m-0");
    expect(plain).toContain("m-2");
    expect(plain).not.toContain("条新消息");
  });

  it("指示文案无 emoji（仅用主 emoji 码区检测）", async () => {
    const session = makeSession(buildUserMessages(3));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scroll={2}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // 主 emoji 码区缺席（U+1F300-U+1FAFF）—— 与 render-smoke 同步
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(plain)).toBe(false);
  });
});
