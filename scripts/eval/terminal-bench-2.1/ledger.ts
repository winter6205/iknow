/**
 * Append-only lifecycle ledger with write-ahead intent.
 *
 * Why it exists (issue 1219 requirement 2): in #1212 both drivers appended their ledger row
 * only AFTER `subprocess.run(run-attempt.sh)` returned and after tallying
 * (`run-pilot.py:135-140` then `:220-221`; `run-arms.py:160-165` then `:211-212`). A
 * driver killed mid-attempt therefore left real model spend and NO ledger row — the
 * `runs-aborted/run2-missing-logs-mount` case is exactly that, with its spend in no ledger
 * at all.
 *
 * So the order is inverted here: an `intent` row is written and fsynced BEFORE the runner is
 * invoked, and a finalization row (`completed` | `invalid` | `interrupted`) is appended
 * after. Any attempt with an intent and no finalization is, by construction, an attempt
 * that must stay visible in the denominator — it is exactly what a SIGKILL leaves behind.
 *
 * Rows are one JSON object per line. Line-oriented storage is what makes the file
 * recoverable after an abrupt kill: a torn last line is detectable and skipped rather than
 * discarding every earlier row with it.
 */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";

/** Lifecycle phase of one attempt, as recorded in the ledger. */
export type AttemptPhase = "intent" | "completed" | "invalid" | "interrupted";

/** Token usage for one attempt; `null` means unknown and must never be read as zero. */
export interface UsageRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface LedgerRow {
  readonly attemptId: string;
  /** Manifest slot key (`task:arm:maxTurns`); the exclusivity key for one dispatch. */
  readonly slotKey: string;
  readonly task: string;
  readonly arm: string;
  readonly maxTurns: number;
  readonly phase: AttemptPhase;
  readonly recordedAtEpochMs: number;
  /** Set on the intent row, before any dispatch: the attempt exists. */
  readonly attemptStarted: boolean;
  /** Set on the intent row from the observed run, never a literal "pending". */
  readonly modelDispatched: boolean;
  /** True when this row records an explicit preflight exclusion rather than a task outcome. */
  readonly excluded: boolean;
  readonly usage: UsageRecord | null;
  readonly reason: string;
}

/**
 * Why the ledger could not be read. Its existence is the whole point: a ledger that cannot
 * be read is NOT a ledger with no attempts, and only the errno says which one it is.
 */
export interface LedgerUnreadable {
  readonly path: string;
  /** `ENOENT` never appears here: an absent file is the ordinary empty case, not a fault. */
  readonly errno: string;
  readonly reason: string;
}

/**
 * The result of one ledger read, as a TOTAL union: either the file was read (possibly with
 * no rows in it), or it was not. There is no third state in which a failed read is
 * indistinguishable from an empty one.
 *
 * `rows` appears on the unreadable arm as an empty array only so a consumer that has not
 * narrowed keeps compiling; `kind` is the authority: a caller that reads `rows` off an
 * `unreadable` result is reading a placeholder, not a tally. `tornLines` is NOT given the same
 * placeholder — it is `null`, because `0` would assert "the file was parsed and held no torn
 * line" about a file nobody opened. `rows` can degrade to a length; a claim about the file's
 * integrity cannot.
 */
export type LedgerReadResult =
  | {
      readonly kind: "readable";
      readonly rows: ReadonlyArray<LedgerRow>;
      /** Torn or unparseable lines. Non-zero means the file was killed mid-append. */
      readonly tornLines: number;
      readonly unreadable: null;
    }
  | {
      readonly kind: "unreadable";
      readonly rows: ReadonlyArray<LedgerRow>;
      /** Always null: torn-ness is UNKNOWN, and unknown is not zero. */
      readonly tornLines: null;
      readonly unreadable: LedgerUnreadable;
    };

/**
 * Append one row and fsync the file. fsync is the load-bearing part: the intent row must
 * survive a driver kill, and only a flush to disk makes that true.
 */
export function appendRow(ledgerPath: string, row: LedgerRow): void {
  appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, "utf8");
  const fd = openSync(ledgerPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a ledger file. A torn final line is counted and skipped, never silently treated as
 * a complete row — the distinction is what makes "interrupted" classifiable.
 *
 * The read itself is a fault the caller must see. `ENOENT` is the one errno that means
 * "this run has written no row yet", so it returns the ordinary empty result. Every other
 * errno means the run's own lifecycle record is UNKNOWN — `EACCES`, `EISDIR`, `EIO` and
 * the rest now return an `unreadable` result, because reporting an unreadable ledger as an
 * empty one launders "we cannot know what this run spent" into a confident zero.
 */
export function readLedger(ledgerPath: string): LedgerReadResult {
  let text: string;
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") {
      return { kind: "readable", rows: [], tornLines: 0, unreadable: null };
    }
    return {
      kind: "unreadable",
      rows: [],
      tornLines: null,
      unreadable: {
        path: ledgerPath,
        errno: errnoOf(error),
        reason: (error as Error).message,
      },
    };
  }
  const rows: LedgerRow[] = [];
  let tornLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseRow(line);
    if (parsed === null) {
      tornLines += 1;
      continue;
    }
    rows.push(parsed);
  }
  return { kind: "readable", rows, tornLines, unreadable: null };
}

/** The `code` a Node filesystem error carries, or `UNKNOWN` when it carries none. */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function parseRow(line: string): LedgerRow | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.attemptId !== "string" || typeof row.phase !== "string")
    return null;
  return row as unknown as LedgerRow;
}

/** Finalization phases; the complement of an intent row. */
const FINAL_PHASES: ReadonlySet<string> = new Set<AttemptPhase>([
  "completed",
  "invalid",
  "interrupted",
]);

/** An attempt with an intent row and no finalization row: a dispatch that never settled. */
export function unfinishedAttempts(
  rows: ReadonlyArray<LedgerRow>
): ReadonlyArray<LedgerRow> {
  const settled = new Set(
    rows
      .filter((row) => FINAL_PHASES.has(row.phase))
      .map((row) => row.attemptId)
  );
  return rows.filter(
    (row) => row.phase === "intent" && !settled.has(row.attemptId)
  );
}

/** The finalization row for an attempt, or `null` while it is still in flight. */
export function finalizationOf(
  rows: ReadonlyArray<LedgerRow>,
  attemptId: string
): LedgerRow | null {
  const finals = rows.filter(
    (row) => row.attemptId === attemptId && FINAL_PHASES.has(row.phase)
  );
  return finals[finals.length - 1] ?? null;
}

/** Attempt ids already settled, so a restart never re-dispatches them. */
export function settledAttemptIds(
  rows: ReadonlyArray<LedgerRow>
): ReadonlySet<string> {
  return new Set(
    rows
      .filter((row) => FINAL_PHASES.has(row.phase))
      .map((row) => row.attemptId)
  );
}

/** Write an fsynced file with its parent directory fsynced too, for atomic publication. */
export function writeFileFsync(path: string, body: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, body, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
