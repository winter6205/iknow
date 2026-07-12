import type { IknowAnswer, PriorChunk, SessionContext } from "../shared/schema.js";

export type ConversationTurn = {
  query: string;
  answer: IknowAnswer;
};

export type ConversationState = {
  conversation_id: string;
  session: SessionContext;
  turns: ConversationTurn[];
  last_priors: PriorChunk[];
  history_finals: Array<{ role: "user" | "assistant"; content: string }>;
  json_mode: boolean;
};
