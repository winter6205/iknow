/** Display keep length for the conversation id chip. */
export const SHORT_CONV = 12;

/** Shorten opaque ids for display (conversation / snapshot). */
export function shortId(id: string | null | undefined, keep = 8): string {
  if (!id) return "—";
  const t = id.trim();
  if (t.length <= keep) return t;
  return `${t.slice(0, keep)}…`;
}
