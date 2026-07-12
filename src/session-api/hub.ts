/**
 * In-process multi-conversation host over shared KB runtime.
 */
import {
  createConversation,
  formatAnswerHuman,
  recordTurn,
  resetConversation,
  type ConversationState,
} from "../interaction/index.js";
import {
  applySlashCommand,
  type AgentModeCli,
} from "../interaction/slash.js";
import {
  buildAgent,
  prepareRuntime,
  type AnswerAgent,
  type RuntimeBundle,
} from "../cli/runtime.js";
import type { CallerRole } from "../shared/schema.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  PostCommandResponse,
  PostMessageResponse,
  ResetSessionResponse,
  SessionSummary,
  TurnDto,
} from "./contract.js";
import { MAX_MESSAGE_CHARS } from "./contract.js";

export type SessionHubOptions = {
  /** Default role for new sessions. */
  defaultRole?: CallerRole;
  defaultMode?: AgentModeCli;
  defaultEmbeddings?: boolean;
  defaultJsonMode?: boolean;
  /**
   * Injected runtime (tests). When omitted, prepared once on first use.
   */
  bundle?: RuntimeBundle;
};

type LiveSession = {
  state: ConversationState;
  agent: AnswerAgent;
  mode: AgentModeCli;
  embeddings: boolean;
};

export class SessionHub {
  private readonly sessions = new Map<string, LiveSession>();
  private bundle: RuntimeBundle | undefined;
  private readonly defaults: Required<
    Pick<
      SessionHubOptions,
      "defaultRole" | "defaultMode" | "defaultEmbeddings" | "defaultJsonMode"
    >
  >;
  private readonly injectedBundle: RuntimeBundle | undefined;

  constructor(opts?: SessionHubOptions) {
    this.defaults = {
      defaultRole: opts?.defaultRole ?? "employee",
      defaultMode: opts?.defaultMode ?? "deterministic",
      defaultEmbeddings: opts?.defaultEmbeddings ?? false,
      defaultJsonMode: opts?.defaultJsonMode ?? false,
    };
    this.injectedBundle = opts?.bundle;
    this.bundle = opts?.bundle;
  }

  async ensureBundle(embeddings: boolean): Promise<RuntimeBundle> {
    if (this.injectedBundle) {
      return this.injectedBundle;
    }
    if (this.bundle && !embeddings) {
      return this.bundle;
    }
    // First create or embeddings upgrade: prepare (may set embedding mode).
    this.bundle = await prepareRuntime({
      role: this.defaults.defaultRole,
      degrade: false,
      embeddings: embeddings || this.defaults.defaultEmbeddings,
    });
    return this.bundle;
  }

  async createSession(
    req?: CreateSessionRequest,
  ): Promise<CreateSessionResponse> {
    const role = req?.role ?? this.defaults.defaultRole;
    const mode = req?.mode ?? this.defaults.defaultMode;
    const embeddings = req?.embeddings ?? this.defaults.defaultEmbeddings;
    const json_mode = req?.json_mode ?? this.defaults.defaultJsonMode;

    const bundle = await this.ensureBundle(embeddings);
    // Per-session auth context (do not share mutable role across sessions).
    const sessionCtx = {
      caller_role: role,
      simulate_governance_timeout: false,
    };
    const state = createConversation(sessionCtx, { json_mode });
    const { agent } = await buildAgent(
      { ...bundle, session: sessionCtx },
      mode,
    );

    const live: LiveSession = { state, agent, mode, embeddings };
    this.sessions.set(state.conversation_id, live);

    return {
      session: this.summarize(live),
      turns: [],
    };
  }

  getSession(conversationId: string): GetSessionResponse {
    const live = this.require(conversationId);
    return {
      session: this.summarize(live),
      turns: live.state.turns.map((t) => this.toTurnDto(t.query, t.answer, live)),
    };
  }

  async postMessage(
    conversationId: string,
    text: string,
  ): Promise<PostMessageResponse> {
    const live = this.require(conversationId);
    const query = text.trim();
    if (!query) {
      throw new ValidationError("message text must be non-empty", {
        field: "text",
      });
    }
    if (query.length > MAX_MESSAGE_CHARS) {
      throw new ValidationError(
        `message text exceeds max length ${MAX_MESSAGE_CHARS}`,
        { field: "text", max: MAX_MESSAGE_CHARS, length: query.length },
      );
    }

    const answer = await live.agent.answer(query, {
      prior_chunks: live.state.last_priors.length
        ? live.state.last_priors
        : undefined,
      history: live.state.history_finals.length
        ? live.state.history_finals
        : undefined,
    });
    const bundle = await this.ensureBundle(live.embeddings);
    recordTurn(live.state, query, answer, bundle.store);
    return {
      session: this.summarize(live),
      turn: this.toTurnDto(query, answer, live),
    };
  }

  async postCommand(
    conversationId: string,
    command: string,
    args: string[] = [],
  ): Promise<PostCommandResponse> {
    const live = this.require(conversationId);
    const cmd = command.trim().toLowerCase().replace(/^\//, "");
    if (!cmd) {
      throw new ValidationError("command must be non-empty", {
        field: "command",
      });
    }

    if (cmd === "quit" || cmd === "exit") {
      return {
        session: this.summarize(live),
        effect: "quit",
        message: "HTTP session stays open; close the browser tab to leave.",
      };
    }

    const effect = applySlashCommand(cmd, args, {
      state: live.state,
      mode: live.mode,
    });

    switch (effect.type) {
      case "help":
        return {
          session: this.summarize(live),
          effect: "help",
          message: effect.text,
        };
      case "info":
        return {
          session: this.summarize(live),
          effect: "info",
          message: effect.text,
        };
      case "error":
        return {
          session: this.summarize(live),
          effect: "error",
          message: effect.text,
        };
      case "reset":
        return {
          session: this.summarize(live),
          effect: "reset",
          message: effect.message,
        };
      case "mode_change": {
        try {
          const bundle = await this.ensureBundle(live.embeddings);
          const { agent } = await buildAgent(
            { ...bundle, session: live.state.session },
            effect.mode,
          );
          live.agent = agent;
          live.mode = effect.mode;
          return {
            session: this.summarize(live),
            effect: "mode_change",
            message: effect.message,
          };
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : String(err);
          return {
            session: this.summarize(live),
            effect: "error",
            message: `${msg}\n(mode stays ${live.mode})`,
          };
        }
      }
      case "quit":
        return {
          session: this.summarize(live),
          effect: "quit",
          message: "HTTP session stays open.",
        };
    }
  }

  async resetSession(
    conversationId: string,
    opts?: { new_id?: boolean },
  ): Promise<ResetSessionResponse> {
    const live = this.require(conversationId);
    const oldId = live.state.conversation_id;
    resetConversation(live.state, { new_id: opts?.new_id });
    if (opts?.new_id && live.state.conversation_id !== oldId) {
      this.sessions.delete(oldId);
      this.sessions.set(live.state.conversation_id, live);
    }
    return {
      session: this.summarize(live),
      turns: [],
    };
  }

  /** Test / ops: active conversation count. */
  size(): number {
    return this.sessions.size;
  }

  private require(conversationId: string): LiveSession {
    const id = conversationId?.trim();
    if (!id) {
      throw new ValidationError("conversation id required");
    }
    const live = this.sessions.get(id);
    if (!live) {
      throw new NotFoundError(`session not found: ${id}`, {
        conversation_id: id,
      });
    }
    return live;
  }

  private summarize(live: LiveSession): SessionSummary {
    return {
      conversation_id: live.state.conversation_id,
      caller_role: live.state.session.caller_role,
      mode: live.mode,
      json_mode: live.state.json_mode,
      turn_count: live.state.turns.length,
      prior_count: live.state.last_priors.length,
      embeddings: live.embeddings,
    };
  }

  private toTurnDto(
    query: string,
    answer: LiveSession["state"]["turns"][0]["answer"],
    live: LiveSession,
  ): TurnDto {
    const dto: TurnDto = { query, answer };
    if (!live.state.json_mode) {
      dto.human_text = formatAnswerHuman(answer);
    }
    return dto;
  }
}
