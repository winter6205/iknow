/**
 * Reverse persistence for settings.json — when the runtime /thinking /effort
 * /memory panels exit via Esc-save, write changes back to settings.json
 * (pure functions + atomic write).
 *
 * Opposite to settings.ts's one-way read (file → runtime), this module is
 * the reverse channel (runtime → file). Design constraints:
 *   - **Merge is based on the original raw JSON, not the parsed
 *     IknowSettings**: IknowSettings is deep-frozen and drops illegal fields,
 *     so write-back must preserve everything in the user's file. thinking
 *     touches only `llm.thinking` / `llm.thinkingEffort`; memory touches only
 *     `memory.autoExtract` / `memory.dream`; model touches only `llm.model`.
 *   - **Field semantics**: `llm.thinking` only `"off" | "adaptive"`;
 *     `llm.thinkingEffort` only the five levels or `null` (null = auto →
 *     delete the key; absence = adaptive, matching env default semantics).
 *     `memory.autoExtract` / `dream` are booleans only; turning autoExtract
 *     off forces dream=false. All other fields are preserved verbatim.
 *   - **Atomic write**: write a tmp file in the **same directory**, then
 *     rename to replace (atomic); the tmp is chmod 0600 before rename
 *     (settings contains apiKey, sensitive); missing parent dir → mkdir -p.
 *     The tmp name is unique per invocation (randomUUID suffix) — concurrent
 *     writers to the same file each write their own tmp, and the atomic
 *     rename guarantees no interleaved partial writes.
 *   - **Self-write sentinel**: returns the full bytes string written (not the
 *     parsed object) so EnvLoader can register it by sha256 content hash;
 *     when the watcher matches it, reload is skipped to prevent write-back
 *     loopback.
 *   - **Starting from broken JSON**: same convention as settings.ts
 *     `readSettingsFile` — file missing / broken JSON → merge from an empty
 *     object, then write back (never clobbers the user's file itself).
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  THINKING_EFFORT_LEVELS,
  isFsIsolationMode,
  type FsIsolationMode,
  type IknowSettingsThinking,
  type IknowSettingsThinkingEffort,
} from "./settings.js";

/**
 * settings.json filename. Joined only with `<home>/.iknow/` (see
 * `resolveThinkingSettingsPath`): write-back always lands in the user layer,
 * never the project layer.
 */
const SETTINGS_FILENAME = "settings.json";

/**
 * Persistable patch value domain for the thinking panel. thinkingEffort
 * `null` means the auto semantics (delete the key, no leftover empty
 * string — empty strings are meaningless in the settings schema).
 */
export interface ThinkingPersistPatch {
  thinking?: IknowSettingsThinking;
  thinkingEffort?: IknowSettingsThinkingEffort | null;
}

/** Persistable patch for the /memory panel. With autoExtract off, the merge layer forces dream=false. */
export interface MemoryPersistPatch {
  autoExtract: boolean;
  dream: boolean;
}

/**
 * Persistable patch for the /model picker: only changes `llm.model` (model
 * route IDs look like `"<provider>/<model>"`). The provider-segment gate
 * (unknown provider → TypeError) lives in `mergeModelPatch`.
 */
export interface ModelPersistPatch {
  model: string;
}

/**
 * Persistable patch for the TUI /config panel "subagent concurrency cap"
 * row. Value domain `3 | 5 | 9 | 15 | "unlimited"` (closed set on panel
 * Enter; env.ts does not accept `"unlimited"`, it is panel-only here).
 * Settings store / read semantics:
 *   - numbers 3 / 5 / 9 / 15 → written as JSON numbers;
 *   - `"unlimited"` → written as the string literal `"unlimited"` (same shape
 *     as `SubagentCapValue` in settings.ts, so the settings parser needs no
 *     new branch);
 *   - invalid values → merge throws TypeError (in sync with fsMode / thinking).
 *
 * The persistence layer (user layer) follows the same pattern as the fsMode
 * patch. "unlimited present" vs "field absent (default 15)" stay
 * distinguishable: write vs don't write.
 */
export interface SubagentCapPersistPatch {
  maxConcurrentWorkers: number | "unlimited";
}

/**
 * Injection options for resolveThinkingSettingsPath (which layer
 * write-back targets).
 *
 * thinking / memory are **user-layer keys** (`llm` / `memory` sections);
 * project files no longer adopt them (project allowlist = verify / secrets /
 * permissions). Therefore the write-back target is always the user-layer
 * file `<home>/.iknow/settings.json`, decoupled from whether a project file
 * exists — the old "write to project if project exists" rule would put
 * user-layer keys into a file that is never read again (silent no-op +
 * polluting the shared repo), so it is retired.
 */
export interface ResolveSettingsPathOptions {
  /**
   * User home (global config anchor). Write-back target =
   * `<home>/.iknow/settings.json`; default `homedir()` (the same SSOT as
   * `loadIknowSettings`'s user-layer resolution — reader and writer share
   * one source). Tests inject a tmp home to isolate the real user directory.
   */
  home?: string;
}

/** Plain object (raw JSON's top / llm level can only be this; excludes null / arrays). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read one settings file and parse it into a plain object (same convention
 * as settings.ts readSettingsFile): missing file / broken JSON (SyntaxError)
 * → {}; non-plain-object top level → {}. Non-SyntaxError exceptions from
 * JSON.parse (unreachable in today's runtimes) are rethrown defensively to
 * avoid silently swallowing non-syntax parse failures.
 */
async function readSettingsRaw(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
  return isPlainObject(parsed) ? parsed : {};
}

/** thinking value check: only lowercase "off" | "adaptive" (aligned with settings.ts semantics). */
function isValidThinking(v: unknown): v is IknowSettingsThinking {
  return v === "off" || v === "adaptive";
}

/** thinkingEffort value check: only the five lowercase levels (null handled separately by the caller). */
function isValidThinkingEffort(v: unknown): v is IknowSettingsThinkingEffort {
  return (THINKING_EFFORT_LEVELS as readonly string[]).includes(
    typeof v === "string" ? v : ""
  );
}

/**
 * Merge the thinking patch into raw JSON (pure function, no fs).
 *  - missing `llm` → create it;
 *  - `thinkingEffort: null` → delete the key (auto semantics), no leftover
 *    empty string;
 *  - non-plain-object `llm` → overwrite with a fresh object (the original
 *    illegal `llm` value is dropped entirely; only the user's patch fields
 *    remain);
 *  - all other fields preserved verbatim (apiKey / model / fallback / secrets
 *    are never touched);
 *  - illegal patch values (thinking not off/adaptive; thinkingEffort not one
 *    of the five levels and not null) → throw TypeError with a clear message
 *    (caller-boundary error, never silently dropped).
 */
export function mergeThinkingPatch(
  raw: Record<string, unknown>,
  patch: ThinkingPersistPatch
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  const nextLlm: Record<string, unknown> = isPlainObject(next.llm)
    ? { ...next.llm }
    : {};

  if (patch.thinking !== undefined) {
    if (!isValidThinking(patch.thinking)) {
      throw new TypeError(
        `illegal thinking patch value: ${JSON.stringify(patch.thinking)} (expected "off" | "adaptive")`
      );
    }
    nextLlm.thinking = patch.thinking;
  }

  if (patch.thinkingEffort !== undefined) {
    if (patch.thinkingEffort === null) {
      // auto semantics: default = adaptive; the settings schema rejects empty strings, so just delete the key.
      delete nextLlm.thinkingEffort;
    } else if (isValidThinkingEffort(patch.thinkingEffort)) {
      nextLlm.thinkingEffort = patch.thinkingEffort;
    } else {
      throw new TypeError(
        `illegal thinkingEffort patch value: ${JSON.stringify(patch.thinkingEffort)} (expected one of ${THINKING_EFFORT_LEVELS.join(", ")} or null)`
      );
    }
  }

  next.llm = nextLlm;
  return next;
}

export function mergeMemoryPatch(
  raw: Record<string, unknown>,
  patch: MemoryPersistPatch
): Record<string, unknown> {
  if (typeof patch.autoExtract !== "boolean") {
    throw new TypeError(
      `illegal autoExtract patch value: ${JSON.stringify(patch.autoExtract)} (expected boolean)`
    );
  }
  if (typeof patch.dream !== "boolean") {
    throw new TypeError(
      `illegal dream patch value: ${JSON.stringify(patch.dream)} (expected boolean)`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextMem: Record<string, unknown> = isPlainObject(next.memory)
    ? { ...next.memory }
    : {};
  nextMem.autoExtract = patch.autoExtract;
  nextMem.dream = patch.autoExtract ? patch.dream : false;
  next.memory = nextMem;
  return next;
}

/**
 * Reverse-persistence patch for fsMode. Value domain `"global" | "workspace"`,
 * sharing the `isFsIsolationMode` closed set with the
 * `settings.isolation.fsMode` parser.
 */
export interface FsModePersistPatch {
  fsMode: FsIsolationMode;
}

/**
 * Reverse-persistence patch for the worktree gate. Closed value set
 * `true | false` (the TUI display layer renders `ON | OFF`, same source as
 * the `resolveWorktreeOnMutate` parser).
 *
 * User-layer key: writes `isolation.worktreeOnMutate` in
 * `<home>/.iknow/settings.json` (same section as fsMode; the switch belongs
 * to the user layer).
 */
export interface WorktreeOnMutatePersistPatch {
  worktreeOnMutate: boolean;
}

/**
 * Merge the fsMode patch into raw JSON (pure function, no fs).
 *  - missing `isolation` → create it;
 *  - non-plain-object `isolation` → overwrite with a fresh object (the
 *    original illegal `isolation` value is dropped entirely; only the patch
 *    field and known user-isolation subkeys are kept; but this function
 *    writes **only** `fsMode` and never replicates other isolation subkeys —
 *    a simplification in the drop-not-throw shape: replacing the isolation
 *    section wholesale would lose concurrent keys like worktreeOnMutate, so
 *    this implementation does a shallow `{ ...raw.isolation }` copy and then
 *    overwrites fsMode);
 *  - illegal patch value (fsMode outside the `"global" | "workspace"` closed
 *    set) → throw `TypeError` (caller-boundary error, never silently
 *    dropped; same discipline as `mergeThinkingPatch`);
 *  - all other top-level keys (llm / memory / secrets, etc.) preserved verbatim.
 *
 * Known inefficiency (left unfixed, recorded in review): the whole file is
 * rewritten even when the value is unchanged. The choke point is the caller
 * (the TUI persist closure compares against the current holder value before
 * deciding to write), not this pure function — the returned `bytes` feeds
 * the self-write sentinel's hash, and short-circuiting to unmerged raw would
 * make the sentinel read content that differs from what actually landed.
 */
export function mergeFsModePatch(
  raw: Record<string, unknown>,
  patch: FsModePersistPatch
): Record<string, unknown> {
  if (!isFsIsolationMode(patch.fsMode)) {
    throw new TypeError(
      `illegal fsMode patch value: ${JSON.stringify(patch.fsMode)} (expected "global" | "workspace")`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextIso: Record<string, unknown> = isPlainObject(next.isolation)
    ? { ...next.isolation }
    : {};
  nextIso.fsMode = patch.fsMode;
  next.isolation = nextIso;
  return next;
}

/**
 * Merge the worktree-gate patch into raw JSON (pure function, no fs).
 *
 * Shaped entry-by-entry like `mergeFsModePatch` (same section, same discipline):
 *  - missing `isolation` → create it;
 *  - non-plain-object `isolation` → overwrite with a fresh object (the
 *    original illegal value is dropped entirely);
 *  - an existing `isolation` section is always **shallow-copied** and only
 *    `worktreeOnMutate` is overwritten — neighbor keys like `fsMode` /
 *    `worktreeExclusive` are preserved verbatim (pinned by round-trip assertions);
 *  - illegal patch value (non-boolean, e.g. `"ON"` / `1` / `undefined`) →
 *    throw `TypeError` (never silently dropped; in sync with fsMode /
 *    thinking / cap);
 *  - all other top-level keys (llm / memory / secrets / subagent, etc.)
 *    preserved verbatim.
 */
export function mergeWorktreeOnMutatePatch(
  raw: Record<string, unknown>,
  patch: WorktreeOnMutatePersistPatch
): Record<string, unknown> {
  if (typeof patch.worktreeOnMutate !== "boolean") {
    throw new TypeError(
      `illegal worktreeOnMutate patch value: ${JSON.stringify(patch.worktreeOnMutate)} (expected boolean)`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextIso: Record<string, unknown> = isPlainObject(next.isolation)
    ? { ...next.isolation }
    : {};
  nextIso.worktreeOnMutate = patch.worktreeOnMutate;
  next.isolation = nextIso;
  return next;
}

/**
 * Merge the subagent cap patch into raw JSON (pure function, no fs).
 *
 * Mirrors `mergeFsModePatch`'s shape: missing subagent → create;
 * non-plain-object subagent → overwrite with a fresh object (a shallow copy
 * of the original subagent section would preserve future concurrent keys
 * like taskTimeoutMs, but today the subagent section has only the single
 * maxConcurrentWorkers key; when fields grow, apply the same drop-not-throw
 * simplification — consistent with fsMode, avoiding wholesale replacement
 * that would lose user fields).
 *
 * Value gate (1:1 with the panel's closed Enter set 3 | 5 | 9 | 15 | "unlimited"):
 *   - any other number / string literal / null / undefined → throw TypeError
 *     (never silently persisted; in sync with fsMode / thinking);
 *   - numeric literals must be finite positive integers (NaN / Infinity /
 *     floats all rejected).
 *
 * Does not check whether the project file exists — `subagent` is a
 * user-layer key (like thinking / fsMode); `persistSubagentCapChanges`
 * writes it back to the user layer.
 */
export function mergeSubagentCapPatch(
  raw: Record<string, unknown>,
  patch: SubagentCapPersistPatch
): Record<string, unknown> {
  const value = patch.maxConcurrentWorkers;
  const allowed: ReadonlyArray<number | "unlimited"> = [
    3,
    5,
    9,
    15,
    "unlimited",
  ];
  const ok =
    value === "unlimited" ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      (allowed as ReadonlyArray<unknown>).includes(value));
  if (!ok) {
    throw new TypeError(
      `illegal subagent cap patch value: ${JSON.stringify(value)} (expected one of 3, 5, 9, 15, or "unlimited")`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextSub: Record<string, unknown> = isPlainObject(next.subagent)
    ? { ...next.subagent }
    : {};
  nextSub.maxConcurrentWorkers = value;
  next.subagent = nextSub;
  return next;
}

/**
 * Collect the provider id set registered in raw `llm.providers` (data source
 * for the gate). Same discipline as settings.ts `parseLlmProvider`: only
 * items that are plain objects with a non-empty-after-trim `.id` count;
 * missing / non-array `providers` / invalid items → not counted (that
 * provider is treated as unknown and the caller throws; never silently passed).
 */
function collectProviderIds(rawLlm: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isPlainObject(rawLlm)) return ids;
  const providers = rawLlm.providers;
  if (!Array.isArray(providers)) return ids;
  for (const p of providers) {
    if (
      isPlainObject(p) &&
      typeof p.id === "string" &&
      p.id.trim().length > 0
    ) {
      ids.add(p.id.trim());
    }
  }
  return ids;
}

/**
 * Merge the model patch into raw JSON (pure function, no fs); only changes
 * `llm.model`.
 *
 * Value gate (any failure → TypeError carrying the concrete illegal value
 * and the expected shape; the caller-boundary catch turns it into a notice;
 * nothing is silently dropped or written):
 *   - `patch.model` not a string / empty after trim;
 *   - missing "/" (model route IDs look like `"<provider>/<model>"`);
 *   - either segment empty after trimming the split on the **first** "/"
 *     (e.g. `"/foo"`, `"foo/"`);
 *   - the provider segment not present in the **raw** `llm.providers`
 *     (array, per-item `.id`) — unknown providers are never persisted:
 *     writing one would fall through to the env-layer fallback path,
 *     contradicting the user's choice.
 *
 * On pass: non-plain-object `llm` → overwrite with a fresh object (same as
 * mergeThinkingPatch); all other `llm` fields and other top-level sections
 * (apiKey / thinking / memory / isolation / permissions / providers …) are
 * preserved verbatim. The written value = trimmed patch.model (consistent
 * with settings.ts `parseLlm`'s trim discipline for model).
 */
export function mergeModelPatch(
  raw: Record<string, unknown>,
  patch: ModelPersistPatch
): Record<string, unknown> {
  const rawValue = patch.model;
  const expected = 'expected "<provider>/<model>"';
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new TypeError(
      `illegal model patch value: ${JSON.stringify(rawValue)} (${expected})`
    );
  }
  const model = rawValue.trim();
  const slash = model.indexOf("/");
  const providerId = slash < 0 ? "" : model.slice(0, slash).trim();
  const modelId = slash < 0 ? "" : model.slice(slash + 1).trim();
  if (slash < 0 || providerId.length === 0 || modelId.length === 0) {
    throw new TypeError(
      `illegal model patch value: ${JSON.stringify(rawValue)} (${expected}, with non-empty provider and model segments)`
    );
  }
  if (!collectProviderIds(raw.llm).has(providerId)) {
    throw new TypeError(
      `unknown provider in model patch value: ${JSON.stringify(rawValue)} (provider ${JSON.stringify(providerId)} not in llm.providers)`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextLlm: Record<string, unknown> = isPlainObject(next.llm)
    ? { ...next.llm }
    : {};
  nextLlm.model = model;
  next.llm = nextLlm;
  return next;
}

/**
 * Choose the target settings file path for write-back (which layer it lands in):
 *  - thinking / memory are **user-layer keys** (`llm` / `memory` sections) →
 *    the target is always `<home>/.iknow/settings.json`; `home` defaults to
 *    `homedir()` (same resolution as `loadIknowSettings`).
 *  - **Never checks** whether a project file exists — project files no longer
 *    adopt `llm` / `memory` (the allowlist), so writing there is a silent
 *    no-op that pollutes the shared repo. The old two-tier "project exists
 *    → project path / else workspaceRoot path" rule (including the
 *    `existsSync` probe) is fully retired.
 *  - A missing target directory is handled by `persistThinkingChanges`'s
 *    internal `mkdir -p`.
 */
export function resolveThinkingSettingsPath(
  opts?: ResolveSettingsPathOptions
): string {
  const home = opts?.home ?? homedir();
  return join(home, ".iknow", SETTINGS_FILENAME);
}

async function persistMergedSettings(
  filePath: string,
  merged: Record<string, unknown>
): Promise<{ path: string; bytes: string }> {
  const bytes = `${JSON.stringify(merged, null, 2)}\n`;
  const tmpPath = join(
    dirname(filePath),
    `.${SETTINGS_FILENAME}.${randomUUID()}.tmp`
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, bytes, { encoding: "utf8", flag: "w" });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, filePath);
  return { path: filePath, bytes };
}

/**
 * Persist the thinking patch to the given settings file (atomic write).
 * Read raw JSON (missing file / broken JSON → start from an empty object) →
 * merge the patch → write a tmp file (same directory, chmod 0600 before
 * rename) → atomic rename replace. The tmp name is unique per invocation
 * (`.settings.json.<uuid>.tmp`): concurrent writers each write their own tmp
 * and the atomic rename guarantees the final state = one complete write
 * snapshot (no half-written / no torn content). Returns the full bytes
 * string for self-write sentinel registration (compared by content hash; no
 * object parsing).
 */
export async function persistThinkingChanges(
  filePath: string,
  patch: ThinkingPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeThinkingPatch(raw, patch));
}

export async function persistMemoryChanges(
  filePath: string,
  patch: MemoryPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeMemoryPatch(raw, patch));
}

/**
 * Persist the fsMode patch to settings.json (atomic write).
 * Mirrors `persistMemoryChanges`: read raw JSON (broken JSON / missing file
 * → start from an empty object) → merge the patch → write a tmp file (same
 * directory, chmod 0600 before rename) → atomic rename replace. Returns the
 * full bytes string for self-write sentinel registration (EnvLoader compares
 * content hashes and skips reload on a watcher hit to prevent loopback).
 *
 * Illegal fsMode values throw `TypeError` from `mergeFsModePatch`; no write
 * happens and the original file is left untouched (no silent swallowing, no double write).
 */
export async function persistFsModeChanges(
  filePath: string,
  patch: FsModePersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeFsModePatch(raw, patch));
}

/**
 * Persist the subagent cap patch to settings.json (atomic write).
 *
 * Mirrors `persistFsModeChanges`: read raw JSON (broken JSON / missing file
 * → start from an empty object) → merge patch → write a tmp file (same
 * directory, chmod 0600 before rename) → atomic rename replace. Returns the
 * full bytes string for self-write sentinel registration (EnvLoader compares
 * content hashes and skips reload on a watcher hit to prevent loopback, same
 * shape as the fsMode patch).
 *
 * Illegal cap values throw TypeError from `mergeSubagentCapPatch`; no write
 * happens and the original file is left untouched (no silent swallowing, no double write).
 */
export async function persistSubagentCapChanges(
  filePath: string,
  patch: SubagentCapPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeSubagentCapPatch(raw, patch));
}

/**
 * Persist the worktree-gate patch to settings.json (atomic write).
 *
 * Mirrors `persistFsModeChanges` / `persistSubagentCapChanges`: read raw
 * JSON (broken JSON / missing file → start from an empty object) → merge
 * patch → write a tmp file in the same directory (chmod 0600 before rename)
 * → atomic rename replace. Returns the full bytes for self-write sentinel
 * registration (EnvLoader compares content hashes and skips reload on a
 * watcher hit to prevent loopback).
 *
 * Illegal values throw TypeError from `mergeWorktreeOnMutatePatch`; no write
 * happens and the original file is left untouched (no silent swallowing, no double write).
 */
export async function persistWorktreeOnMutateChanges(
  filePath: string,
  patch: WorktreeOnMutatePersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(
    filePath,
    mergeWorktreeOnMutatePatch(raw, patch)
  );
}

/**
 * Persist the model patch to the given settings file (atomic write, reuses
 * persistMergedSettings). Read raw JSON (missing file / broken JSON → start
 * from an empty object) → mergeModelPatch → tmp in the same directory +
 * chmod 0600 + rename. Illegal model / unknown provider → merge throws
 * TypeError and the file is not touched. Returns the full bytes string for
 * self-write sentinel registration (same content-hash contract as thinking /
 * memory).
 */
export async function persistModelChanges(
  filePath: string,
  patch: ModelPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeModelPatch(raw, patch));
}

/** sha256 hex — content hash for the self-write sentinel (compared by markSelfWrite). */
export function hashSettingsContent(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
