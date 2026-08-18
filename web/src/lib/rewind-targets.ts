export type RewindTurnLike = {
  readonly query: string;
};

export type WebRewindTarget = {
  readonly keepTurns: number;
  readonly label: string;
};

/**
 * 从 GET session 的 turns 投影合法回退锚点（对齐 TUI buildRewindTargets）。
 */
export function buildRewindTargetsFromTurns(
  turns: ReadonlyArray<RewindTurnLike>
): ReadonlyArray<WebRewindTarget> {
  const total = turns.length;
  if (total === 0) return [];
  const targets: WebRewindTarget[] = [{ keepTurns: 0, label: turns[0]!.query }];
  for (let i = 1; i < total; i++) {
    targets.push({ keepTurns: i, label: turns[i]!.query });
  }
  return targets;
}
