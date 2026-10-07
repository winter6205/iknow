/**
 * The frozen run protocol for #1219 TUI calibration.
 *
 * WHY a protocol document at all: the historical driver (`/home/winner/eval-1213/
 * tui_driver.py`) decided what to do from whatever the wall clock said when it
 * woke up — `--warmup 20` was a bare `time.sleep`, the timetable fired
 * unconditionally, and nothing recorded the rules the run was supposed to
 * follow. A verdict was therefore unreproducible. This module is the ONE place
 * where readiness, delivery and stop policy are decided BEFORE any byte is
 * written, and it fails closed: a document that cannot be honored raises
 * `ProtocolError` rather than being repaired at run time.
 *
 * Two rules are structural here rather than advisory:
 *   - the outer watchdog MUST outlast the inner wall plus the exit grace, so a
 *     forced kill can never race the graceful path it is meant to protect;
 *   - `delivery.retryEnter` MUST be false. Resending an input whose acceptance
 *     is unproven is the defect #1219 names, so it is not a knob.
 */

/** One fixed stimulus. `at` is an EARLIEST delivery time relative to the
 *  measured window, never a promise that it is delivered at that instant. */
export interface Stimulus {
  readonly at: number;
  readonly tag: string;
  readonly text: string;
}

/** The startup readiness gate. There is no machine-readable READY event on
 *  this entry, so readiness is proven by a PTY echo probe, not by a sleep. */
export interface ReadinessPolicy {
  /** Token prefix; a unique suffix is appended per probe attempt. */
  readonly tokenPrefix: string;
  readonly probeTimeoutMs: number;
  readonly echoTimeoutMs: number;
  readonly attempts: number;
}

/** How one stimulus reaches the composer. */
export interface DeliveryPolicy {
  readonly chunkBytes: number;
  readonly chunkDelayMs: number;
  /** Wait for the active user round to settle before submitting. */
  readonly settleBeforeSubmit: boolean;
  /** Bounded wait for that settle; past it the stimulus is `refused`, never
   *  silently discarded and never retried. */
  readonly settleWaitMs: number;
  /** Bounded wait for the persisted acceptance evidence. */
  readonly acceptTimeoutMs: number;
  /** Always false; enforced by `parseProtocol`. */
  readonly retryEnter: boolean;
}

/** When the run may stop, and how the stop is classified. */
export interface StopPolicy {
  /** Minimum wall after the last accepted+settled stimulus before `/quit`. */
  readonly minSettleMs: number;
  /** The frozen horizon measured from the last settlement. */
  readonly horizonMs: number;
  readonly exitGraceMs: number;
  /** Inner wall. Exhausting it classifies the stop `wall_timeout`. */
  readonly innerWallMs: number;
}

/** The child process the measurement drives under a real PTY. */
export interface ChildSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** The role this run plays in the report. §4 requires the measured session, the
 *  resume probe and any smoke run to stay distinguishable — and unpooled. */
export type RunKind = "measured" | "resume" | "smoke";

export interface Protocol {
  readonly label: string;
  /** Defaults to `measured`; a resume or smoke run must declare itself so its
   *  samples are never counted into the measured window. */
  readonly runKind: RunKind;
  readonly dataDir: string;
  readonly cwd: string;
  readonly artifactsDir: string;
  readonly conversationId: string;
  readonly child: ChildSpec;
  readonly stimuli: readonly Stimulus[];
  readonly readiness: ReadinessPolicy;
  readonly delivery: DeliveryPolicy;
  readonly stop: StopPolicy;
  readonly outerWatchdogMs: number;
  readonly rssIntervalMs: number;
  readonly snapshotIntervalMs: number;
}

/** A protocol that cannot be honored. Never repaired, never defaulted. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function obj(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProtocolError(
      `${what} must be an object; got: ${JSON.stringify(raw)}`
    );
  }
  return raw as Record<string, unknown>;
}

function str(
  source: Record<string, unknown>,
  key: string,
  what: string
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProtocolError(
      `${what}.${key} must be a non-empty string; got: ${JSON.stringify(value)}`
    );
  }
  return value;
}

function num(
  source: Record<string, unknown>,
  key: string,
  what: string,
  min: number
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new ProtocolError(
      `${what}.${key} must be a finite number >= ${min}; got: ${JSON.stringify(value)}`
    );
  }
  return value;
}

function block(raw: unknown, what: string): Record<string, unknown> {
  if (raw === undefined || raw === null)
    throw new ProtocolError(
      `${what} is required; a missing policy block is not a default`
    );
  return obj(raw, what);
}

/**
 * Stimulus text is SINGLE-LINE composer input.
 *
 * A raw CR or LF inside it is refused rather than sanitized: the composer
 * submits on the first one, so a multi-line stimulus would put its first line
 * in the host and leave the rest behind, and the run would then measure a
 * stimulus the host never received as a whole.
 */
function stimulusText(
  source: Record<string, unknown>,
  what: string,
  tag: string
): string {
  const text = str(source, "text", what);
  if (/[\r\n]/.test(text)) {
    throw new ProtocolError(
      `${what}.text (${tag}) must not contain CR or LF; a stimulus is one composer line. ` +
        `A newline would submit the first line and strand the rest; got: ${JSON.stringify(text)}`
    );
  }
  return text;
}

function parseStimuli(raw: unknown): Stimulus[] {
  const list = raw;
  if (!Array.isArray(list))
    throw new ProtocolError(
      `stimuli must be an array; got: ${JSON.stringify(raw)}`
    );
  if (list.length === 0)
    throw new ProtocolError(
      "stimuli must not be empty; a run with no stimulus measures nothing"
    );
  const seen = new Set<string>();
  const stimuli: Stimulus[] = list.map((entry, i) => {
    const s = obj(entry, `stimuli[${i}]`);
    const tag = str(s, "tag", `stimuli[${i}]`);
    if (seen.has(tag))
      throw new ProtocolError(
        `stimuli[${i}].tag duplicates ${tag}; every stimulus needs its own record`
      );
    seen.add(tag);
    return {
      at: num(s, "at", `stimuli[${i}]`, 0),
      tag,
      text: stimulusText(s, `stimuli[${i}]`, tag),
    };
  });
  return [...stimuli].sort((a, b) => a.at - b.at);
}

function parseReadiness(raw: unknown): ReadinessPolicy {
  const r = block(raw, "readiness");
  return {
    tokenPrefix: str(r, "tokenPrefix", "readiness"),
    probeTimeoutMs: num(r, "probeTimeoutMs", "readiness", 1),
    echoTimeoutMs: num(r, "echoTimeoutMs", "readiness", 1),
    attempts: num(r, "attempts", "readiness", 1),
  };
}

function parseDelivery(raw: unknown): DeliveryPolicy {
  const d = block(raw, "delivery");
  if (d["retryEnter"] !== false) {
    throw new ProtocolError(
      `delivery.retryEnter must be false; resending an unproven input is the #1219 defect; got: ${JSON.stringify(d["retryEnter"])}`
    );
  }
  return {
    chunkBytes: num(d, "chunkBytes", "delivery", 1),
    chunkDelayMs: num(d, "chunkDelayMs", "delivery", 0),
    settleBeforeSubmit: d["settleBeforeSubmit"] === true,
    settleWaitMs: num(d, "settleWaitMs", "delivery", 0),
    acceptTimeoutMs: num(d, "acceptTimeoutMs", "delivery", 1),
    retryEnter: false,
  };
}

function parseStop(raw: unknown): StopPolicy {
  const s = block(raw, "stop");
  return {
    minSettleMs: num(s, "minSettleMs", "stop", 0),
    horizonMs: num(s, "horizonMs", "stop", 0),
    exitGraceMs: num(s, "exitGraceMs", "stop", 1),
    innerWallMs: num(s, "innerWallMs", "stop", 1),
  };
}

const RUN_KINDS: readonly RunKind[] = ["measured", "resume", "smoke"];

function parseRunKind(raw: unknown): RunKind {
  if (raw === undefined) return "measured";
  if (typeof raw !== "string" || !RUN_KINDS.includes(raw as RunKind)) {
    throw new ProtocolError(
      `runKind must be one of ${RUN_KINDS.join(" | ")}; got: ${JSON.stringify(raw)}. ` +
        "An unlabelled sample cannot be told apart from the measured window."
    );
  }
  return raw as RunKind;
}

function parseChild(raw: unknown): ChildSpec {
  const c = obj(raw, "child");
  const args = c["args"];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new ProtocolError(
      `child.args must be an array of strings; got: ${JSON.stringify(args)}`
    );
  }
  return {
    command: str(c, "command", "child"),
    args: args as readonly string[],
  };
}

/** Validate a raw document into a runnable protocol, or raise. */
export function parseProtocol(raw: unknown): Protocol {
  const p = obj(raw, "protocol");
  const stop = parseStop(p["stop"]);
  const outerWatchdogMs = num(p, "outerWatchdogMs", "protocol", 1);
  const innerCeiling = stop.innerWallMs + stop.exitGraceMs;
  if (outerWatchdogMs <= innerCeiling) {
    throw new ProtocolError(
      `outerWatchdogMs (${outerWatchdogMs}) must exceed stop.innerWallMs + stop.exitGraceMs (${innerCeiling}); ` +
        "the outer watchdog exists to outlive the inner wall"
    );
  }
  return {
    label: str(p, "label", "protocol"),
    runKind: parseRunKind(p["runKind"]),
    dataDir: str(p, "dataDir", "protocol"),
    cwd: str(p, "cwd", "protocol"),
    artifactsDir: str(p, "artifactsDir", "protocol"),
    conversationId: str(p, "conversationId", "protocol"),
    child: parseChild(p["child"]),
    stimuli: parseStimuli(p["stimuli"]),
    readiness: parseReadiness(p["readiness"]),
    delivery: parseDelivery(p["delivery"]),
    stop,
    outerWatchdogMs,
    rssIntervalMs: num(p, "rssIntervalMs", "protocol", 1),
    snapshotIntervalMs: num(p, "snapshotIntervalMs", "protocol", 1),
  };
}
