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

function deriveStoreCounters(
  storeJsonl: string,
  baselineOffset: number
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
  const bytes = Buffer.from(raw, "utf8");
  const windowed = parseLines(bytes.subarray(baselineOffset).toString("utf8"));
  const baselineIds = new Set<string>(
    parseLines(bytes.subarray(0, baselineOffset).toString("utf8"))
      .filter((r) => r.type === "message")
      .map((r) => (r as { id: string }).id)
  );
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
  ) as {
    byteOffset?: number;
  };
  const store = deriveStoreCounters(refs.storeJsonl, baseline.byteOffset ?? 0);
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
