/**
 * Config-layer contract for the network egress allowlist — parse body for
 * `isolation.network`.
 *
 * Carries the `allowedDomains` / `deniedDomains` allow/deny sets; checks shape
 * validity only:
 *  - empty array → keep the empty-array fact (fail-closed signal; the decision
 *    layer rejects everything accordingly), not an error;
 *  - non-string entries / entries empty after trim → drop the entry + onWarn
 *    trace (never throw);
 *  - bare `*` in allowed / denied → drop the entry + onWarn (conservative:
 *    denied follows the same discipline as allowed; bare `*` is never a valid
 *    domain pattern);
 *  - out-of-range `:port` (0 / >65535 / non-numeric / empty / negative) →
 *    reject the entry + onWarn; it **must not pass through as never-match**
 *    (avoid "silent degradation" masquerading as fail-closed);
 *  - an invalid entry never affects valid entries in the same batch
 *    (per-entry decisions);
 *  - drops always tighten: if dropping yields an empty set, keep the
 *    empty-array fact — never synthesize "allow everything".
 *
 * Wildcard semantics for `*.x`, case normalization and port concatenation are
 * left to the semantic layer.
 *
 * Separate file by design: `settings.ts` is already very large (file-size
 * discipline).
 */
export interface IknowSettingsIsolationNetwork {
  /**
   * Allowed domain list (per-entry parsed trim results).
   * Empty array = deny all (a legitimate fail-closed state; the decision layer
   * rejects everything accordingly).
   */
  allowedDomains?: string[];
  /**
   * Denied domain list (per-entry parsed trim results).
   * Same parsing discipline as allowedDomains; deny takes precedence over allow
   * (decided in the semantic layer).
   */
  deniedDomains?: string[];
}

/** Port range valid (1-65535); 0 / 65536 / negative / non-integer / non-numeric are all invalid. */
function isValidPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * Parse the `:port` suffix shape — strict digit string (1-65535); empty,
 * non-numeric or out-of-range are all invalid.
 * Separate function: an invalid port must reject the whole entry (never pass
 * through as never-match); this check and the host-shape check are two
 * independent rules, each kept single-purpose.
 */
function parsePortSuffix(portStr: string): number | undefined {
  // Non-numeric / leading zeros / decimal point / whitespace → reject; Number() is too lenient, require a strict digit string
  if (!/^\d+$/.test(portStr)) return undefined;
  const n = Number(portStr);
  if (!isValidPort(n)) return undefined;
  return n;
}

/**
 * Parse a "domain[:port]" entry — checks shape validity only; wildcard `*.x`
 * semantics are left to the semantic layer. Returns `{ host, port }` or
 * `undefined` (invalid).
 *
 * Shape requirements:
 *  - host non-empty after trim;
 *  - host must not be bare `*` (conservative, same discipline for denied:
 *    "wildcard everything" is not allowed);
 *  - no `:port` suffix → port = undefined;
 *  - with `:port` suffix → port must be a valid integer (1-65535), otherwise
 *    the whole entry is rejected;
 *  - host may contain several dots (e.g. `api.example.com`) but dots are not
 *    required (single-label hosts allowed; the semantic layer decides).
 *
 * The returned `host` is trimmed; `port` is number or undefined.
 */
function parseNetworkEntry(
  raw: unknown
): { host: string; port?: number } | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "*") return undefined;

  // Split on the last ':' only; without a ':' the whole string is the host, no port.
  const colonIdx = trimmed.lastIndexOf(":");
  let host: string;
  let portStr: string | undefined;
  if (colonIdx === -1) {
    host = trimmed;
  } else {
    host = trimmed.slice(0, colonIdx);
    portStr = trimmed.slice(colonIdx + 1);
  }

  if (host.length === 0) return undefined; // e.g. ":443" or "example.com:"
  // Bare `*` as host (incl. the `*:` prefix) is also rejected — same discipline as a whole-string bare `*`
  if (host === "*") return undefined;

  const port = portStr === undefined ? undefined : parsePortSuffix(portStr);
  // Has ":" but invalid port (empty / non-numeric / out-of-range) → reject the whole entry
  if (portStr !== undefined && port === undefined) return undefined;

  return { host, port };
}

/**
 * Parse a domain-list field — shared by allowedDomains / deniedDomains.
 *
 * Behavior:
 *  - non-array → return undefined (whole field dropped, no warning — a
 *    type-layer mismatch, same drop-not-throw discipline as isolation.fsMode;
 *    an invalid whole field already implies a non-plain-object context above);
 *  - empty array → return empty array (legitimate fail-closed state);
 *  - per-entry parseNetworkEntry; invalid entries dropped + onWarn trace;
 *  - valid entries kept in "serialized shape": no port → host string; with
 *    port → `host:port` string (after trim + port numeric validation), so the
 *    semantic layer can split directly.
 *
 * onWarn message format: `[settings] isolation.network.<field> entry "<raw>" dropped: <reason>`,
 * matching the existing `[settings] ...` prefix convention.
 */
export function parseNetworkDomainList(
  raw: unknown,
  field: "allowedDomains" | "deniedDomains",
  onWarn?: (message: string) => void
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const out: string[] = [];
  const warn = onWarn ?? (() => {});
  for (const entry of raw) {
    const parsed = parseNetworkEntry(entry);
    if (parsed === undefined) {
      warn(
        `[settings] isolation.network.${field} entry ${JSON.stringify(entry)} dropped: invalid shape`
      );
      continue;
    }
    out.push(
      parsed.port === undefined ? parsed.host : `${parsed.host}:${parsed.port}`
    );
  }
  return out;
}

/**
 * Parse the whole `isolation.network` section — user layer only.
 *
 * Behavior:
 *  - non-plain-object → undefined (whole section dropped, same discipline as
 *    parseIsolation);
 *  - allowedDomains / deniedDomains parsed independently (per-field
 *    drop-not-throw);
 *  - unknown sibling fields → silently dropped (same discipline as
 *    isolation.fsMode: future fields don't break this parser);
 *  - both allowedDomains and deniedDomains empty → section returns undefined
 *    (no content); only one being an empty array → keep the empty-array fact
 *    (legitimate fail-closed state).
 */
export function parseIsolationNetwork(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsIsolationNetwork | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  const allowed = parseNetworkDomainList(
    obj.allowedDomains,
    "allowedDomains",
    onWarn
  );
  const denied = parseNetworkDomainList(
    obj.deniedDomains,
    "deniedDomains",
    onWarn
  );

  const out: IknowSettingsIsolationNetwork = {};
  if (allowed !== undefined) out.allowedDomains = allowed;
  if (denied !== undefined) out.deniedDomains = denied;
  if (out.allowedDomains === undefined && out.deniedDomains === undefined) {
    return undefined;
  }
  return out;
}

/**
 * Merge user / project `isolation.network` — the project section is dropped
 * upstream (filterProjectSettingsKeys already warns once for the whole
 * isolation key), so this function effectively only looks at user. Kept in
 * merge-function form for symmetry with parseIsolation / mergeIsolation (and
 * a single change point if layer ownership ever shifts).
 */
export function mergeIsolationNetwork(
  user: IknowSettingsIsolationNetwork | undefined,
  _project: IknowSettingsIsolationNetwork | undefined
): IknowSettingsIsolationNetwork | undefined {
  if (!user) return undefined;
  return user;
}
