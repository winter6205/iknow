/**
 * src/tui/transcript-mount-window.ts
 *
 * 消息级尾窗（非行账）：决定 ChatView 挂进 OpenTUI 树的消息子集。
 * Session 全量仍在 TuiSessionState.messages；本模块只裁剪 mount。
 *
 * 对齐主流 Agent（Claude / Cursor / ChatGPT）：近端全文 + 更早消息折叠，
 * 而不是把整段历史做成一棵保留模式树。
 */

export const TRANSCRIPT_TAIL_DEFAULT = 32;
export const TRANSCRIPT_REVEAL_PAGE = 32;

export interface TranscriptMountWindow<T> {
  readonly mounted: ReadonlyArray<T>;
  readonly hiddenCount: number;
  readonly startIndex: number;
}

export function formatEarlierMessagesStub(hiddenCount: number): string | null {
  if (!Number.isFinite(hiddenCount) || hiddenCount <= 0) return null;
  return `↑ ${Math.trunc(hiddenCount)} 条更早的消息`;
}

export function selectTranscriptMountWindow<T>(
  messages: ReadonlyArray<T>,
  revealedCount: number,
  tailDefault: number = TRANSCRIPT_TAIL_DEFAULT
): TranscriptMountWindow<T> {
  if (!Array.isArray(messages)) {
    throw new TypeError(
      "selectTranscriptMountWindow: messages must be an array"
    );
  }
  const n = messages.length;
  if (n === 0) {
    return { mounted: [], hiddenCount: 0, startIndex: 0 };
  }
  const defaultTail =
    Number.isFinite(tailDefault) && tailDefault > 0
      ? Math.trunc(tailDefault)
      : TRANSCRIPT_TAIL_DEFAULT; // EXIT: non-finite|non-positive tailDefault → built-in default
  const requested = Number.isFinite(revealedCount)
    ? Math.trunc(revealedCount)
    : defaultTail; // EXIT: non-finite revealedCount → default tail
  const mount = Math.min(n, requested > 0 ? requested : defaultTail); // EXIT: revealedCount<=0 → default tail, never blank a non-empty session
  const startIndex = n - mount;
  return {
    mounted: messages.slice(startIndex),
    hiddenCount: startIndex,
    startIndex,
  };
}
