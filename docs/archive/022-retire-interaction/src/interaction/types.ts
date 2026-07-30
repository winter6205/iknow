import type {
  HistoryTurn,
  IknowAnswer,
  PriorChunk,
  SessionContext,
} from "../shared/schema.js";

export type { HistoryTurn };

export type ConversationTurn = {
  query: string;
  answer: IknowAnswer;
};

export type ConversationState = {
  conversation_id: string;
  session: SessionContext;
  turns: ConversationTurn[];
  last_priors: PriorChunk[];
  history_finals: HistoryTurn[];
  json_mode: boolean;
};
