/**
 * Config-layer contract for the egress credential sentinel — parse body for
 * `isolation.credentials`.
 *
 * User-layer credential roster section (user layer only — project files are
 * not adopted: `filterProjectSettingsKeys` drops the whole isolation key with
 * one warning upstream, so this layer never repeats it). The two github
 * entries come from the code-built-in roster
 * (`src/harness/sandbox/egress/credential-assembly.ts` SSOT); this section
 * only carries data for narrowing / appending.
 *
 * Validation discipline matches settings.ts's existing shape (drop-not-throw,
 * drops always tighten):
 *  - non-plain-object section → drop silently, no throw, no warn (same as the
 *    network section);
 *  - invalid entry (missing path/name, missing injectHosts, extract fails to
 *    compile or lacks capture group 1, decode not "jwt") → drop that entry +
 *    `[settings]` warning; other entries kept;
 *  - injectHosts required: missing / empty array / any invalid string → drop
 *    the entry (this repo does not take the "default = all allowedDomains"
 *    trade-off; better to drop the entry);
 *  - extract capture-group check: named groups `(?<n>…)` take no number and
 *    do not count as group 1 (a past lesson from group-1 validation);
 *  - user-layer total entry cap of 16 (overflow tier of the input contract):
 *    files first, envVars next; the excess tail is dropped + warned;
 *  - empty array after drops = keep the empty-array fact (no append =
 *    built-in roster only); the section is not synthesized.
 *
 * Separate file by design — settings.ts file-size discipline (precedent:
 * isolation-network.ts).
 */

/** A single credential file entry (settings-side shape; for the egress-side data shape see credential-assembly.ts). */
export interface IknowSettingsCredentialFileEntry {
  /** Credential file path (literal string carried as-is; `~` expansion belongs to the consumer / minting layer). */
  path: string;
  /** Optional extraction regex source; must compile and contain capture group 1. */
  extract?: string;
  /** Optional decode flag; only the literal "jwt" is valid. */
  decode?: "jwt";
  /** Injection host list; required and non-empty (the data face behind exfil prevention). */
  injectHosts: string[];
}

/** A single credential env-var entry. */
export interface IknowSettingsCredentialEnvVarEntry {
  /** Env var name (literal string, non-empty after trim). */
  name: string;
  /** Injection host list; required and non-empty. */
  injectHosts: string[];
}

/** The `isolation.credentials` section. */
export interface IknowSettingsIsolationCredentials {
  files?: IknowSettingsCredentialFileEntry[];
  envVars?: IknowSettingsCredentialEnvVarEntry[];
}

/** Total user-layer entry cap (files + envVars combined, pinned at 16). */
export const CREDENTIALS_ENTRY_CAP = 16;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * injectHosts value domain: non-empty array with every item a non-empty
 * string after trim.
 * Whole-value decision (any invalid string → reject the entry): partial
 * acceptance on the credential-injection face would silently half-apply
 * ("thought it was narrowed, actually wasn't"); better to drop + trace.
 */
function parseInjectHosts(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (!isNonEmptyString(item)) return undefined;
    out.push(item.trim());
  }
  return out;
}

/**
 * Capture-group-1 existence scan: count `(` that are outside character
 * classes, unescaped, and not followed by `?` (in JS only a bare `(` produces
 * a numbered group; `(?:` `(?=` `(?!` `(?<=` `(?<!` `(?<name>` take no number).
 */
function hasCaptureGroup1(source: string): boolean {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++; // skip the escaped next char (incl. `\(` `\]` etc.)
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && source[i + 1] !== "?") return true;
  }
  return false;
}

/** Compile check + capture-group-1 check; returns a reason string when invalid, undefined when valid. */
function validateExtract(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return "extract is not a string";
  try {
    new RegExp(raw);
  } catch {
    return "extract does not compile";
  }
  if (!hasCaptureGroup1(raw)) return "extract lacks capture group 1";
  return undefined;
}

/** decode value domain: only the literal "jwt" (absence is valid). */
function validateDecode(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "jwt") return 'decode must be the literal "jwt"';
  return undefined;
}

function warn(
  onWarn: ((message: string) => void) | undefined,
  list: "files" | "envVars",
  entry: unknown,
  reason: string
): void {
  onWarn?.(
    `[settings] isolation.credentials.${list} entry ${JSON.stringify(entry)} dropped: ${reason}`
  );
}

function parseFileEntry(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsCredentialFileEntry | undefined {
  if (!isPlainObject(raw)) {
    warn(onWarn, "files", raw, "entry is not an object");
    return undefined;
  }
  if (!isNonEmptyString(raw.path)) {
    warn(onWarn, "files", raw, "path missing or empty");
    return undefined;
  }
  const injectHosts = parseInjectHosts(raw.injectHosts);
  if (injectHosts === undefined) {
    warn(onWarn, "files", raw, "injectHosts missing, empty or invalid");
    return undefined;
  }
  const extractReason = validateExtract(raw.extract);
  if (extractReason !== undefined) {
    warn(onWarn, "files", raw, extractReason);
    return undefined;
  }
  const decodeReason = validateDecode(raw.decode);
  if (decodeReason !== undefined) {
    warn(onWarn, "files", raw, decodeReason);
    return undefined;
  }
  const out: IknowSettingsCredentialFileEntry = {
    path: raw.path.trim(),
    injectHosts,
  };
  if (typeof raw.extract === "string") out.extract = raw.extract;
  if (raw.decode === "jwt") out.decode = "jwt";
  return out;
}

function parseEnvVarEntry(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsCredentialEnvVarEntry | undefined {
  if (!isPlainObject(raw)) {
    warn(onWarn, "envVars", raw, "entry is not an object");
    return undefined;
  }
  if (!isNonEmptyString(raw.name)) {
    warn(onWarn, "envVars", raw, "name missing or empty");
    return undefined;
  }
  const injectHosts = parseInjectHosts(raw.injectHosts);
  if (injectHosts === undefined) {
    warn(onWarn, "envVars", raw, "injectHosts missing, empty or invalid");
    return undefined;
  }
  return { name: raw.name.trim(), injectHosts };
}

/**
 * Cap finalization: stable order files first, envVars next; tail entries
 * beyond CREDENTIALS_ENTRY_CAP are dropped + warned per entry (drops always
 * tighten).
 */
function applyEntryCap(
  files: IknowSettingsCredentialFileEntry[],
  envVars: IknowSettingsCredentialEnvVarEntry[],
  onWarn?: (message: string) => void
): {
  files: IknowSettingsCredentialFileEntry[];
  envVars: IknowSettingsCredentialEnvVarEntry[];
} {
  const total = files.length + envVars.length;
  if (total <= CREDENTIALS_ENTRY_CAP) return { files, envVars };
  let budget = CREDENTIALS_ENTRY_CAP;
  const keptFiles = files.slice(0, budget);
  budget -= keptFiles.length;
  const keptEnvVars = envVars.slice(0, budget);
  for (const dropped of files.slice(keptFiles.length)) {
    warn(
      onWarn,
      "files",
      dropped,
      `entry cap ${CREDENTIALS_ENTRY_CAP} exceeded`
    );
  }
  for (const dropped of envVars.slice(keptEnvVars.length)) {
    warn(
      onWarn,
      "envVars",
      dropped,
      `entry cap ${CREDENTIALS_ENTRY_CAP} exceeded`
    );
  }
  return { files: keptFiles, envVars: keptEnvVars };
}

/** Per-side list parsing: non-array → undefined (field absent); array → collect valid entries in order. */
function parseEntryList<T>(
  rawList: unknown,
  parseEntry: (
    raw: unknown,
    onWarn?: (message: string) => void
  ) => T | undefined,
  onWarn?: (message: string) => void
): T[] | undefined {
  if (!Array.isArray(rawList)) return undefined;
  const out: T[] = [];
  for (const entry of rawList) {
    const parsed = parseEntry(entry, onWarn);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** Section synthesis: absent fields write no key (absent != empty-array fact; see the main function comment). */
function synthesizeSection(
  hasFiles: boolean,
  hasEnvVars: boolean,
  capped: {
    files: IknowSettingsCredentialFileEntry[];
    envVars: IknowSettingsCredentialEnvVarEntry[];
  }
): IknowSettingsIsolationCredentials {
  const out: IknowSettingsIsolationCredentials = {};
  if (hasFiles) out.files = capped.files;
  if (hasEnvVars) out.envVars = capped.envVars;
  return out;
}

/**
 * Parse the `isolation.credentials` section — user layer only (orchestration:
 * guard → two list parses → cap finalization → synthesis; each stage private).
 * Non-plain-object → undefined (drop silently, same as parseIsolationNetwork);
 * both lists parsed per entry (invalid entries dropped + warned); combined
 * overflow drops the tail + warns; both fields absent → undefined (empty
 * section not produced).
 */
export function parseIsolationCredentials(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsIsolationCredentials | undefined {
  if (raw === undefined || raw === null || !isPlainObject(raw)) {
    return undefined;
  }
  const files = parseEntryList(raw.files, parseFileEntry, onWarn);
  const envVars = parseEntryList(raw.envVars, parseEnvVarEntry, onWarn);
  if (files === undefined && envVars === undefined) return undefined;
  const capped = applyEntryCap(files ?? [], envVars ?? [], onWarn);
  return synthesizeSection(files !== undefined, envVars !== undefined, capped);
}

/**
 * Merge user / project `isolation.credentials` — the project section is
 * dropped at the upstream filter-allowlist stage, so this function effectively
 * only looks at user (same symmetric-keepsake shape as mergeIsolationNetwork).
 */
export function mergeIsolationCredentials(
  user: IknowSettingsIsolationCredentials | undefined,
  _project: IknowSettingsIsolationCredentials | undefined
): IknowSettingsIsolationCredentials | undefined {
  if (!user) return undefined;
  return user;
}
