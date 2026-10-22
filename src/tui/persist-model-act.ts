/**
 * src/tui/persist-model-act.ts
 *
 * ADR-0145 §5: the one `/model` act, in order.
 *
 *  1. the conversation's OWN route — `hub.setSessionModel(conversationId,
 *     route)`: the hub resolves the route first (a route that does not
 *     resolve throws the typed `LlmProviderConfigError` and changes
 *     nothing), then writes the route map entry + the session file inside
 *     that conversation's serialize slot. A draft has no conversation yet →
 *     the call is skipped; the draft's first turn inherits the default
 *     written in step 2.
 *  2. the DEFAULT write (`settings.json` → `llm.model`) — the default for
 *     conversations started LATER. A live conversation keeps its own route.
 *
 * A step-1 failure stops the act: the default must not move either (the
 * operator asked for one model, and that model did not resolve).
 *
 * The act lives in its own module (not inline in run.tsx) so the ORDER is
 * testable without a terminal — run.tsx only supplies the two effects.
 *
 * The ordering lives in the TUI layer on purpose: spec §4's act order is a
 * TUI-level sequencing wrapper over the two injected effects (the hub's
 * `setSessionModel` and the default write).
 */
import {
  persistModelRouteFailure,
  type PersistModelDefaultFailure,
  type PersistModelFailureStage,
} from "./persist-model-failure.js";

/** The default-write effect's own outcome: the settings write may fail
 *  ("write") or the runtime reload after it may fail ("reload"). */
export type PersistModelDefaultResult =
  { readonly ok: true } | PersistModelDefaultFailure;

export type PersistModelActResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly stage?: PersistModelFailureStage;
    };

export interface PersistModelActDeps {
  /** The conversation whose route changes; undefined = a draft (no
   *  conversation yet → no route to set). */
  readonly conversationId: string | undefined;
  /** The selected route id (`provider/model`). */
  readonly route: string;
  /** The hub's route setter: resolves the route (typed error when it does
   *  not resolve) and then writes the map entry + the session file. */
  readonly setSessionModel: (
    conversationId: string,
    route: string
  ) => Promise<void>;
  /** The default write (settings.json `llm.model`). */
  readonly writeDefault: () => Promise<PersistModelDefaultResult>;
}

export async function persistModelAct(
  deps: PersistModelActDeps
): Promise<PersistModelActResult> {
  if (deps.conversationId !== undefined) {
    try {
      await deps.setSessionModel(deps.conversationId, deps.route);
    } catch (err) {
      return persistModelRouteFailure(err);
    }
  }
  return deps.writeDefault();
}
