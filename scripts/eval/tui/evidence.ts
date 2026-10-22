/**
 * Derived evidence (#1219 §4): every reported number comes from a retained
 * artifact, and the payload index cannot describe itself.
 *
 * WHY: the historical report hardcoded the shape of a good run and counted
 * ATTEMPTS (`stimuli_sent`), so a run where two of four stimuli were rejected
 * was indistinguishable from a clean 4/4. Its hash index also listed ITSELF
 * (`hash_artifacts.py` walked the `artifacts/` directory BEFORE opening the
 * index file), producing a permanently stale self-entry: the recorded digest was
 * 256 B behind the real file. Here the counters are derived from the bytes on
 * disk inside a stated observation window, the index is payload-only, written
 * atomically after the payloads finalize, and verified by reading it back.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  isRealUserMessage,
  isTerminalBoundary,
  validateWholeFile,
  type StoreRecord,
} from "./session-store-reader.js";

/** One payload's digest and size. */
export interface IndexEntry {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly relPath: string;
}

export const DEFAULT_INDEX_NAME = "evidence-index.txt";

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Every file under `root`, depth first, excluding `*.tmp` and held-back names. */
function walkPayloads(root: string, skip: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      const rel = toPosix(relative(root, full));
      // A held-back name is matched on its BASENAME as well as on the
      // root-relative path: the caller holds back by name ("the verdict file")
      // while the payload lives one directory down (`<artifacts>/<label>/…`),
      // and a path-only match excluded nothing at all.
      if (skip.has(rel) || skip.has(entry.name) || rel.endsWith(".tmp"))
        continue;
      found.push(rel);
    }
  };
  visit(root);
  return found;
}

/**
 * Hash the payloads under `root`.
 *
 * The index is never its own payload, nor is a `*.tmp` file (the historical
 * index hashed the very `artifacts/` directory it was written into and recorded
 * itself 256 B stale). `opts.exclude` carries the one further NAME a caller may
 * legitimately hold back — the verdict file, which carries this index's own
 * verification result and therefore cannot sit inside it. Excluded names are
 * matched at any depth, because a verdict lives in `<artifacts>/<label>/` while
 * the walk starts at `<artifacts>/`.
 */
export function buildIndex(
  root: string,
  opts: {
    readonly indexName?: string;
    readonly exclude?: readonly string[];
  } = {}
): { entries: IndexEntry[]; excluded: string[] } {
  const indexName = opts.indexName ?? DEFAULT_INDEX_NAME;
  const excluded: string[] = [];
  const entries: IndexEntry[] = [];
  const skip = new Set([indexName, ...(opts.exclude ?? [])]);
  for (const rel of walkPayloads(root, skip)) {
    let sizeBytes: number;
    let digest: string;
    try {
      const buffer = readFileSync(join(root, rel));
      sizeBytes = buffer.length;
      digest = createHash("sha256").update(buffer).digest("hex");
    } catch {
      excluded.push(rel);
      continue;
    }
    entries.push({ sha256: digest, sizeBytes, relPath: rel });
  }
  return { entries, excluded };
}

function renderIndex(label: string, entries: readonly IndexEntry[]): string {
  const head = [`# ${label}`, "# sha256  size_bytes  path"];
  return (
    [
      ...head,
      ...entries.map((e) => `${e.sha256}  ${e.sizeBytes}  ${e.relPath}`),
    ].join("\n") + "\n"
  );
}

function parseIndex(body: string): IndexEntry[] {
  return body
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const [sha256 = "", size = "", ...rest] = line.trim().split(/\s+/);
      return { sha256, sizeBytes: Number(size), relPath: rest.join(" ") };
    })
    .filter((e) => e.relPath !== "");
}

/** Write the index through a temp file and an atomic rename. */
export function writeIndexAtomic(
  root: string,
  entries: readonly IndexEntry[],
  opts: { readonly indexName?: string; readonly label?: string } = {}
): { path: string; tmpPath: string } {
  const indexName = opts.indexName ?? DEFAULT_INDEX_NAME;
  const path = join(root, indexName);
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    tmpPath,
    renderIndex(opts.label ?? "TUI calibration artifact index", entries),
    "utf8"
  );
  renameSync(tmpPath, path);
  return { path, tmpPath };
}

/** Read the index back and re-verify every digest and size. */
export function verifyIndex(
  root: string,
  opts: { readonly indexName?: string } = {}
): { ok: boolean; entries: IndexEntry[]; mismatches: string[] } {
  const indexName = opts.indexName ?? DEFAULT_INDEX_NAME;
  const path = join(root, indexName);
  const mismatches: string[] = [];
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      entries: [],
      mismatches: [`index ${indexName} is unreadable: ${String(err)}`],
    };
  }
  const entries = parseIndex(body);
  for (const entry of entries) {
    try {
      const buffer = readFileSync(join(root, entry.relPath));
      const digest = createHash("sha256").update(buffer).digest("hex");
      if (digest !== entry.sha256)
        mismatches.push(
          `${entry.relPath}: digest changed since the index was written`
        );
      if (buffer.length !== entry.sizeBytes) {
        mismatches.push(
          `${entry.relPath}: size ${buffer.length} != indexed ${entry.sizeBytes}`
        );
      }
    } catch (err) {
      mismatches.push(
        `${entry.relPath}: unreadable on readback: ${String(err)}`
      );
    }
  }
  return { ok: mismatches.length === 0, entries, mismatches };
}

/** The retained artifacts one run's counters are derived from. */
export interface ArtifactRefs {
  readonly runDir: string;
  /** `measured`, `resume` or `smoke`. Never pooled across roles. */
  readonly runKind: "measured" | "resume" | "smoke";
  readonly rssCsv: string;
  readonly snapshotsDir: string;
  /** A retained copy of the measured conversation's store file. */
  readonly storeJsonl: string;
  /** The baseline the measured window starts from. */
  readonly baselineJson: string;
  readonly window: { readonly startedIso: string; readonly endedIso: string };
}

export interface RssCounters {
  readonly rows: number;
  readonly uniqueTrel: number;
  readonly duplicateRows: number;
  readonly nonMonotonic: boolean;
  readonly firstTrelS: number | null;
  readonly lastTrelS: number | null;
  readonly peakVmrssKb: number | null;
}

export interface RunCounters {
  readonly runKind: ArtifactRefs["runKind"];
  readonly runDir: string;
  readonly window: ArtifactRefs["window"];
  readonly rss: RssCounters;
  readonly snapshots: number;
  readonly acceptedStimuli: number;
  readonly settledStimuli: number;
  readonly storeRecords: number;
  readonly storeCensus: Readonly<Record<string, number>>;
}

function requireFile(path: string, what: string): void {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `${what} is missing at ${path}; a retained artifact is the only acceptable source for a counter`
    );
  }
}

/** Parse `rss.csv` and report duplicate / non-monotonic rows honestly. */
export function deriveRssCounters(path: string): RssCounters {
  requireFile(path, "the retained RSS sample file");
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const data = lines.slice(1);
  const stamps = data.map((line) => Number(line.split(",")[0]));
  const unique = new Set(stamps);
  let nonMonotonic = false;
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i]! < stamps[i - 1]!) nonMonotonic = true;
  }
  const peak = data.reduce((best, line) => {
    const kb = Number(line.split(",")[3]);
    return Number.isFinite(kb) && kb > best ? kb : best;
  }, 0);
  return {
    rows: data.length,
    uniqueTrel: unique.size,
    duplicateRows: data.length - unique.size,
    nonMonotonic,
    firstTrelS: stamps.length === 0 ? null : stamps[0]!,
    lastTrelS: stamps.length === 0 ? null : stamps[stamps.length - 1]!,
    peakVmrssKb: peak === 0 ? null : peak,
  };
}

function countSnapshots(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => !name.endsWith(".tmp")).length;
  } catch {
    return 0;
  }
}

function parseLines(text: string): StoreRecord[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as StoreRecord);
}

interface BaselineAnchor {
  /** Text of the last COMPLETE line at baseline time — the primary identity. */
  readonly lastLine?: string;
  /** Complete-line ordinal at baseline time; cross-check for `lastLine`. */
  readonly lineCount?: number;
  readonly eventIds?: readonly string[];
}

/**
 * The records the run is allowed to count, located by IDENTITY.
 *
 * WHY NOT BYTES (#1219). The store is not append-only in byte offset:
 * `SessionStore.save()` writes the whole log to a tmp file and renames it over
 * the authority, and the `session` header on line 1 GROWS during a run
 * (`turnCount`, `title`, `lastUsage`), so every record after it shifts. A byte
 * offset measured at baseline therefore lands mid-line in the FINAL copy: both
 * `parseLines` calls would start or end inside a record and throw `JSON.parse`,
 * which `finalizeEvidence` turns into `counters: null` and the required check
 * `evidence.counters_derived` into a failure — an otherwise clean run reported
 * unusable. `session-store-reader.ts` documents the same fact about its own
 * `byteOffset`; this mirrors its re-anchoring.
 *
 * `lastLine` is the anchor, not the event ids, because a `native_state` boundary
 * record carries NO `id`, so an id-based boundary would stop at the last
 * `message` line and pull the resumed round's terminal boundary into this run's
 * window. A line's TEXT is unique and survives a length change in an earlier
 * line. `eventIds` is the fallback for a baseline written before `lastLine` was
 * persisted. If none of the anchors can be located the store was rewritten below
 * the baseline and the run is unmeasurable — this throws rather than widening the
 * window to "from the start" and reporting numbers it cannot account for.
 */
/**
 * The retained `baseline.json` body.
 *
 * WHY this lives beside `locateBoundary`: the writer and the reader of this
 * shape are one contract, and `run.ts` had grown a second, drifting copy of the
 * field list. `byteOffset` is a report field only — it does not survive a
 * `save()` rewrite, because the `session` header on line 1 grows, which is why
 * `lineCount` and `lastLine` are here.
 */
export function baselineArtifact(baseline: {
  readonly conversationId: string;
  readonly byteOffset: number;
  readonly lineCount: number;
  readonly lastLine: string;
  readonly eventIds: readonly string[];
  readonly path: string;
}): string {
  return JSON.stringify(
    {
      conversationId: baseline.conversationId,
      byteOffset: baseline.byteOffset,
      lineCount: baseline.lineCount,
      lastLine: baseline.lastLine,
      eventIds: baseline.eventIds,
      path: baseline.path,
    },
    null,
    2
  );
}

/**
 * The baseline's own last line, located in the final copy. The ordinal is tried
 * first because it is the common case and it is O(1); the text search is the
 * fallback for a file whose line COUNT changed.
 */
function boundaryByLastLine(
  occupied: readonly string[],
  baseline: BaselineAnchor
): number | null {
  if (baseline.lastLine === undefined || baseline.lastLine === "") return null;
  if (
    baseline.lineCount !== undefined &&
    occupied[baseline.lineCount - 1] === baseline.lastLine
  ) {
    return baseline.lineCount - 1;
  }
  const found = occupied.lastIndexOf(baseline.lastLine);
  return found >= 0 ? found : null;
}

/** The last record whose id was already in the baseline, or -1. */
function boundaryByEventIds(
  occupied: readonly string[],
  ids: ReadonlySet<string>
): number {
  let boundary = -1;
  for (let i = 0; i < occupied.length; i++) {
    let id: unknown;
    try {
      id = (JSON.parse(occupied[i]!) as { id?: unknown }).id;
    } catch {
      throw new Error(
        `the retained store copy has a record that is not valid JSON at line ${i + 1}; ` +
          `the window cannot be established by identity`
      );
    }
    if (typeof id === "string" && ids.has(id)) boundary = i;
  }
  return boundary;
}

function locateBoundary(
  lines: readonly string[],
  baseline: BaselineAnchor
): number {
  const occupied = lines.filter((l) => l.trim() !== "");
  const ids = new Set(baseline.eventIds ?? []);
  const byText = boundaryByLastLine(occupied, baseline);
  if (byText !== null) return byText;
  const byId = ids.size > 0 ? boundaryByEventIds(occupied, ids) : -1;
  if (byId >= 0) return byId;
  // A FRESH conversation: the baseline is genuinely empty, so everything in the
  // store is this run's work. This is not the same as an unlocatable anchor, and
  // conflating the two would fail every first-run.
  if (baseline.lastLine === undefined || baseline.lastLine === "") return -1;
  throw new Error(
    `the baseline boundary is no longer in the retained store copy; it was ` +
      `rewritten below the measured window, so the accepted/settled counters ` +
      `cannot be attributed to this run`
  );
}

function deriveStoreCounters(
  storeJsonl: string,
  baseline: BaselineAnchor
): {
  accepted: number;
  settled: number;
  records: number;
  census: Record<string, number>;
} {
  requireFile(storeJsonl, "the retained store copy");
  const raw = readFileSync(storeJsonl, "utf8");
  const whole = validateWholeFile(storeJsonl);
  if (whole.error !== null) {
    throw new Error(
      `the retained store copy does not satisfy the production parser: ${whole.error.message}`
    );
  }
  const allLines = raw.split("\n");
  const windowed = parseLines(
    allLines
      .filter((l) => l.trim() !== "")
      .slice(locateBoundary(allLines, baseline) + 1)
      .join("\n")
  );
  const baselineIds = new Set<string>(baseline.eventIds ?? []);
  // The production parser hands back every record AFTER the header, so the
  // header is counted from the file's own first line rather than assumed.
  const census: Record<string, number> = {};
  for (const record of whole.records) {
    const type = String(record.type);
    census[type] = (census[type] ?? 0) + 1;
  }
  const header = parseLines(raw)[0];
  const headerType = String(
    (header as { type?: unknown } | undefined)?.type ?? "unknown"
  );
  census[headerType] = (census[headerType] ?? 0) + 1;
  const accepted = windowed.filter((r) =>
    isRealUserMessage(r, baselineIds)
  ).length;
  const settled = windowed.filter((r) => isTerminalBoundary(r)).length;
  return { accepted, settled, records: whole.records.length, census };
}

/** Derive every counter for one run from its retained artifacts. */
export function deriveCounters(refs: ArtifactRefs): RunCounters {
  const baseline = JSON.parse(
    readFileSync(requireFileOrThrow(refs.baselineJson), "utf8")
  ) as BaselineAnchor;
  // Identity, not `byteOffset` — see `locateBoundary`. A baseline written
  // before this repair still carries `eventIds`, so it remains usable.
  const store = deriveStoreCounters(refs.storeJsonl, baseline);
  return {
    runKind: refs.runKind,
    runDir: refs.runDir,
    window: refs.window,
    rss: deriveRssCounters(refs.rssCsv),
    snapshots: countSnapshots(refs.snapshotsDir),
    acceptedStimuli: store.accepted,
    settledStimuli: store.settled,
    storeRecords: store.records,
    storeCensus: store.census,
  };
}

function requireFileOrThrow(path: string): string {
  requireFile(path, "the retained baseline record");
  return path;
}

/**
 * Split counters by role. Resume and smoke samples are reported separately and
 * are NEVER added into the measured run — pooling them is exactly what hid the
 * decisive fact that a measured run never reached a settled state.
 */
export function separateRuns(counters: readonly RunCounters[]): {
  measured: RunCounters | null;
  others: RunCounters[];
} {
  const measured = counters.filter((c) => c.runKind === "measured");
  return {
    measured: measured.length === 1 ? measured[0]! : null,
    others: counters.filter((c) => c.runKind !== "measured"),
  };
}

/** Append one row to the retained RSS sample file. */
export function appendRssRow(
  path: string,
  row: {
    tRelS: number;
    iso: string;
    pid: number;
    vmrssKb: number;
    alive: number;
  }
): void {
  mkdirSync(dirname(path), { recursive: true });
  const prefix =
    statSync(path, { throwIfNoEntry: false }) === undefined
      ? "t_rel_s,iso,pid,vmrss_kb,alive\n"
      : "";
  appendFileSync(
    path,
    `${prefix}${row.tRelS},${row.iso},${row.pid},${row.vmrssKb},${row.alive}\n`,
    "utf8"
  );
}

/** Write one retained screen snapshot. */
export function writeSnapshot(
  dir: string,
  index: number,
  body: string
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `screen-${String(index).padStart(3, "0")}.txt`);
  writeFileSync(path, body, "utf8");
  return path;
}
