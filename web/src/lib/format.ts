/** Shorten opaque ids for display (conversation / snapshot). */
export function shortId(id: string | null | undefined, keep = 8): string {
  if (!id) return "—";
  const t = id.trim();
  if (t.length <= keep) return t;
  return `${t.slice(0, keep)}…`;
}

/** Pretty-print JSON for G2 side panel; falls back to String. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
