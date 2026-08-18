import type { TokenUsage } from "../api/types";

export type SessionInfoInput = {
  readonly conversationId: string | null;
  readonly turnCount: number;
  readonly jsonMode: boolean;
  readonly phase: string;
  readonly contextWindow: number | null;
  readonly lastUsage: TokenUsage | null;
  readonly thinkingEnabled: boolean;
  readonly effort: string;
};

export function formatSessionInfo(input: SessionInfoInput): string {
  const lu = input.lastUsage;
  const tokenLines =
    lu === null
      ? ["tokens: —"]
      : [
          `tokens in/out: ${lu.inputTokens}/${lu.outputTokens}`,
          `cache read: ${lu.cacheReadInputTokens}`,
          `window: ${input.contextWindow ?? "—"}`,
        ];
  const thinkingLine = input.thinkingEnabled
    ? `thinking: adaptive (${input.effort === "" ? "auto" : input.effort})`
    : "thinking: off";
  return [
    `conversation_id: ${input.conversationId ?? "—"}（${
      input.conversationId ? "已建档" : "draft"
    }）`,
    `turnCount: ${input.turnCount}`,
    `jsonMode: ${input.jsonMode}`,
    `runState: ${input.phase}`,
    ...tokenLines,
    thinkingLine,
  ].join("\n");
}
