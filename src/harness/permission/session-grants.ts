/**
 * src/harness/permission/session-grants.ts
 *
 * In-memory session grants (v0; no disk persistence per spec).
 * Session layer is the highest priority normal rule layer; the host can add
 * rules mid-session and remove them by id.
 *
 * The returned SessionGrants doubles as a SessionGrantsPolicySource: it
 * exposes `rules()` matching the policy-source interface (see types.ts),
 * alongside `add` / `remove` / `list` / `toRules` helpers.
 */

import type { NormalRuleSpec, SessionGrantsPolicySource } from "./types.js";

export interface SessionGrants extends SessionGrantsPolicySource {
  readonly add: (rule: NormalRuleSpec) => void;
  readonly remove: (id: string) => boolean;
  readonly list: () => ReadonlyArray<NormalRuleSpec>;
  readonly toRules: () => ReadonlyArray<NormalRuleSpec>;
}

interface MutableRule {
  rule: NormalRuleSpec;
  seq: number;
}

/**
 * Build a session grants registry.
 *
 * add() pushes a rule; rules retain insertion order.
 * remove(id) deletes the first matching rule; returns false if not found.
 * list() / toRules() / rules() return a frozen snapshot.
 *
 * Closing-over a Map means call sites need only the returned API; nothing leaks.
 */
export function createSessionGrants(): SessionGrants {
  const store = new Map<string, MutableRule>();
  let seq = 0;

  const add = (rule: NormalRuleSpec): void => {
    seq += 1;
    store.set(rule.id, { rule, seq });
  };

  const remove = (id: string): boolean => {
    const hit = store.get(id);
    if (!hit) return false;
    store.delete(id);
    return true;
  };

  const snapshot = (): NormalRuleSpec[] => {
    return [...store.values()].sort((a, b) => a.seq - b.seq).map((m) => m.rule);
  };

  const list = (): ReadonlyArray<NormalRuleSpec> =>
    Object.freeze(snapshot()) as ReadonlyArray<NormalRuleSpec>;
  const toRules = (): ReadonlyArray<NormalRuleSpec> => list();
  const rules = (): ReadonlyArray<NormalRuleSpec> => list();

  return Object.freeze({
    kind: "session" as const,
    rules,
    add,
    remove,
    list,
    toRules,
  });
}
