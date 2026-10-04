/**
 * Per-file reconciliation for session-entry recovery (ADR-0136 §4).
 *
 * READ-ONLY BY CONSTRUCTION. This module opens workspace files, reads
 * `code-snapshots/` blobs, and compares bytes. It never writes, deletes, or
 * renames anything: a verified effect is a fact recovery REPORTS, never one
 * it re-performs. That is what makes repeated recovery idempotent for free
 * (SC27) and keeps crash recovery separate from explicit code rewind
 * (SC14 / specs/code-restore.md).
 *
 * The operation-fact reducer below is read-only for the same reason and on a
 * stricter one: it is a PURE function of the log, so running it twice over one
 * log cannot differ (SC27).
 *
 * Precedence, top to bottom, for one target:
 *   1. capture disabled  → unverified evidence
 *   2. root identity     → the live root is not the recorded root
 *   3. required body     → a referenced pre/post blob is unreadable
 *   4. writer/chronology → the selected chain cannot own or order this write
 *   5. bytes == postimage → VERIFIED effect (whole tool still unknown)
 *   6. bytes == preimage → no replacement verified
 *   7. anything else     → drift, reported and untouched
 *
 * Steps 5 and 6 are byte comparison only. A settled tool result never makes a
 * target verified, and a verified target never makes the whole operation
 * succeed — the two are separate verdicts by contract.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { codeSnapshotSha, readCodeSnapshot } from "./code-snapshot-store.js";
import type {
  FileIntentPosition,
  FileIntentTarget,
  SessionOperationFactRecord,
} from "./jsonl.js";
import { forbiddenPersistedField } from "./native-state-store.js";
import type {
  FileHandlingReason,
  RecoveryHandlingItem,
} from "./recovery-status.js";
import type {
  RuntimeFileOperationRecord,
  RuntimeGraphNodeFact,
  RuntimeOperationFact,
  RuntimeToolResultFact,
  RuntimeWorkerFact,
} from "../../shared/runtime-persistence.js";
import type { NativeStateMessage } from "../../shared/native-state-port.js";
import type {
  OwnedStopEvidence,
  OwnedWorkerSweepResult,
} from "../../harness/subagent/worker-identity-stop.js";

/** Whether a tool operation's result settled. `unknown` is a real state, not a
 *  missing field: the call may still be running, or the host died before the
 *  result was persisted. */
export type ToolOperationSettlement =
  "settled_success" | "settled_error" | "unknown";

/** One target's verdict. `verified_effect` is the only one that asserts the
 *  recorded write landed. */
export type FileTargetVerdict =
  | { readonly relPath: string; readonly state: "verified_effect" }
  | {
      readonly relPath: string;
      readonly state: "not_replaced";
      /** The recorded pre-segment fact: the path was absent before the
       *  operation, so "matches the preimage" is "still absent". */
      readonly absentBefore: boolean;
    }
  | {
      readonly relPath: string;
      readonly state: "needs_handling";
      readonly reason: FileHandlingReason;
    };

/** One tool call's reconciled facts, grouped by `toolUseId` — a multi-file
 *  call and every record of it is ONE operation, not N. */
export interface RecoveredFileOperation {
  readonly toolUseId: string;
  readonly settlement: ToolOperationSettlement;
  readonly targets: ReadonlyArray<FileTargetVerdict>;
  /** True when a human must still decide something: any target needs
   *  handling, or the call never settled while it may have taken effect. */
  readonly needsOperatorAction: boolean;
}

export interface ReconcileResult {
  /** Post-anchor operations in transcript file order. */
  readonly operations: ReadonlyArray<RecoveredFileOperation>;
  /** Flat list of every target needing an operator, in the same order. */
  readonly handling: ReadonlyArray<RecoveryHandlingItem>;
}

export interface ReconcileInput {
  /** Session folder holding this session's `code-snapshots/`. */
  readonly sessionFolder: string;
  /** LIVE write root; every `relPath` resolves against it. */
  readonly taskRoot: string;
  /** Identity of that live root, derived by the host exactly as
   *  `applyCodeRestore` receives it (the hub's `rootIdentityFor`). Deriving it
   *  here would duplicate that one decision, so the host supplies it. */
  readonly liveRootIdentity: string;
  /** Post-anchor intents with their chain positions. */
  readonly intents: ReadonlyArray<FileIntentPosition>;
  /** Per-`toolUseId` settlement, read from the raw head chain. */
  readonly settlements: ReadonlyMap<string, ToolOperationSettlement>;
  /** Assistant `tool_use` ids on the selected head chain. */
  readonly onChainToolUseIds: ReadonlySet<string>;
}

/** One grouped operation under construction. `captured` narrows: a single
 *  uncaptured record makes the whole operation's evidence incomplete. */
interface OperationDraft {
  readonly toolUseId: string;
  captured: boolean;
  settlement: ToolOperationSettlement;
  readonly targets: FileTargetVerdict[];
  needsOperatorAction: boolean;
  records: ReadonlyArray<FileIntentPosition>;
}

/**
 * Reconcile every post-anchor intent against the live workspace.
 *
 * `captured` is a property of the RECORD, and records for one `toolUseId` are
 * merged into one operation. A merged operation inherits `captured:false` when
 * ANY of its records is uncaptured: the operation then holds one target with
 * no evidence, and a verified sibling must not make the whole call look
 * verified.
 */
export async function reconcileFileIntents(
  input: ReconcileInput
): Promise<ReconcileResult> {
  const ambiguous = ambiguousPaths(input.intents);
  const drafts = groupByToolUse(input.intents);
  const operations: RecoveredFileOperation[] = [];
  const handling: RecoveryHandlingItem[] = [];
  for (const draft of drafts) {
    draft.settlement = input.settlements.get(draft.toolUseId) ?? "unknown";
    const attributable = input.onChainToolUseIds.has(draft.toolUseId);
    for (const intent of draft.records) {
      for (const target of intent.record.targets) {
        const verdict = await reconcileTarget({
          target,
          captured: draft.captured,
          input,
          ambiguous: ambiguous.has(pathKey(target)),
          attributable,
        });
        draft.targets.push(verdict);
        if (verdict.state === "needs_handling") {
          draft.needsOperatorAction = true;
          handling.push({
            toolUseId: draft.toolUseId,
            relPath: verdict.relPath,
            reason: verdict.reason,
          });
        }
      }
    }
    if (draft.settlement === "unknown" && draft.targets.length > 0) {
      // The call may have taken effect and nothing proves it either way. That
      // is a human decision, not something recovery may retry or assume — and
      // it is reported per target so the operator is handed paths, not just a
      // call id. A target already needing handling keeps its more specific
      // reason; this one would only restate it.
      draft.needsOperatorAction = true;
      for (const verdict of draft.targets) {
        if (verdict.state === "needs_handling") continue;
        handling.push({
          toolUseId: draft.toolUseId,
          relPath: verdict.relPath,
          reason: "tool_outcome_unknown",
        });
      }
    }
    operations.push({
      toolUseId: draft.toolUseId,
      settlement: draft.settlement,
      targets: draft.targets,
      needsOperatorAction: draft.needsOperatorAction,
    });
  }
  return { operations, handling };
}

/** One target, one verdict. Small enough that the precedence list reads as
 *  the contract it is. */
async function reconcileTarget(args: {
  readonly target: FileIntentTarget;
  readonly captured: boolean;
  readonly input: ReconcileInput;
  readonly ambiguous: boolean;
  readonly attributable: boolean;
}): Promise<FileTargetVerdict> {
  const { target, input } = args;
  const path = target.relPath;
  if (!args.captured) return handling(path, "capture_disabled");
  if (target.rootIdentity !== input.liveRootIdentity) {
    return handling(path, "root_identity_mismatch");
  }
  if (!isSafeRelPath(path)) return handling(path, "unresolvable_path");
  if (target.preimageSha === undefined) {
    return handling(path, "body_missing");
  }
  const evidence = await readEvidence(input.sessionFolder, target);
  if (evidence === null) return handling(path, "body_missing");
  if (!args.attributable) return handling(path, "writer_not_on_chain");
  if (args.ambiguous) return handling(path, "ambiguous_ordering");
  const live = await readLiveBytes(resolve(join(input.taskRoot, path)));
  return classifyBytes(path, target, evidence, live);
}

/**
 * Read both recorded bodies and prove the recorded addresses name the bytes
 * actually held. Returns null when either is unreadable or self-inconsistent
 * — a captured intent whose preimage cannot be read has no evidence to
 * compare, and guessing from the surviving side would be fabrication.
 */
async function readEvidence(
  sessionFolder: string,
  target: FileIntentTarget
): Promise<{ pre: string; post: string | null } | null> {
  const pre = await tryReadBlob(sessionFolder, target.preimageSha);
  if (pre === null) return null;
  if (target.postimageSha === undefined) return { pre, post: null };
  const post = await tryReadBlob(sessionFolder, target.postimageSha);
  if (post === null) return null;
  return { pre, post };
}

async function tryReadBlob(
  sessionFolder: string,
  sha: string | undefined
): Promise<string | null> {
  if (sha === undefined) return null;
  try {
    const bytes = await readCodeSnapshot(sessionFolder, sha);
    // The address must name the held content; a body that does not hash back
    // to its own name is damaged evidence, not evidence.
    return codeSnapshotSha(bytes) === sha ? sha : null;
  } catch (err) {
    // EXIT: the pool's own "absent" / "cannot be named" verdict means there
    // is no evidence to compare. Anything else is a real read fault and
    // propagates — the same policy `readLiveBytes` applies to the live file
    // below, because an IO fault must never read as missing evidence.
    if (isAbsentBlob(err)) return null;
    throw err;
  }
}

/** The typed `CodeSnapshotError` kinds: the blob is absent, or its name can
 *  never address one. A raw fs `Error` is neither and is not covered. */
function isAbsentBlob(err: unknown): boolean {
  const kind = (err as { readonly kind?: unknown } | null)?.kind;
  return (
    kind === "code_snapshot_missing" || kind === "code_snapshot_invalid_sha"
  );
}

/** The byte-comparison table. `live === null` means the file is absent. */
function classifyBytes(
  path: string,
  target: FileIntentTarget,
  evidence: { pre: string; post: string | null },
  live: string | null
): FileTargetVerdict {
  if (target.absentBefore) {
    // Pre-segment state was absence, so absence IS the preimage case.
    if (live === null) {
      return { relPath: path, state: "not_replaced", absentBefore: true };
    }
    if (evidence.post !== null && live === evidence.post) {
      return { relPath: path, state: "verified_effect" };
    }
    return handling(path, "bytes_match_neither");
  }
  if (live === null) {
    // The file existed before and is gone. Not a byte match with either
    // image, and never a licence to delete anything.
    return handling(path, "target_missing");
  }
  if (evidence.post !== null && live === evidence.post) {
    return { relPath: path, state: "verified_effect" };
  }
  if (live === evidence.pre) {
    return { relPath: path, state: "not_replaced", absentBefore: false };
  }
  return handling(path, "bytes_match_neither");
}

/** sha256 of the live file's bytes, or null when it is absent. A real read
 *  fault propagates — it is not a missing file and must not read as one. */
async function readLiveBytes(abs: string): Promise<string | null> {
  try {
    return codeSnapshotSha(await readFile(abs));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Paths recorded more than once at the SAME chain position: two writers the
 *  selected chain has no order for. A path recorded at different positions is
 *  ordered by the chain and reconciled target by target. */
function ambiguousPaths(
  intents: ReadonlyArray<FileIntentPosition>
): ReadonlySet<string> {
  const claimsPerPosition = new Map<string, number>();
  const pathOfPosition = new Map<string, string>();
  for (const intent of intents) {
    for (const target of intent.record.targets) {
      const key = `${pathKey(target)}\u0000${intent.anchorIndex}`;
      pathOfPosition.set(key, pathKey(target));
      claimsPerPosition.set(key, (claimsPerPosition.get(key) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [key, claims] of claimsPerPosition) {
    if (claims > 1) out.add(pathOfPosition.get(key)!);
  }
  return out;
}

/** Root + path: the same file under two roots is two claims, and a root
 *  mismatch is reported per target anyway. */
const pathKey = (target: FileIntentTarget): string =>
  `${target.rootIdentity}\u0000${target.relPath}`;

/** One draft per `toolUseId`, in first-seen order, with every record of that
 *  call merged in file order. */
function groupByToolUse(
  intents: ReadonlyArray<FileIntentPosition>
): OperationDraft[] {
  const byId = new Map<string, OperationDraft>();
  for (const intent of intents) {
    const toolUseId = intent.record.toolUseId;
    const existing = byId.get(toolUseId);
    if (existing !== undefined) {
      existing.captured = existing.captured && intent.record.captured;
      existing.records = [...existing.records, intent];
      continue;
    }
    byId.set(toolUseId, {
      toolUseId,
      captured: intent.record.captured,
      settlement: "unknown",
      targets: [],
      needsOperatorAction: false,
      records: [intent],
    });
  }
  return [...byId.values()];
}

const handling = (
  relPath: string,
  reason: FileHandlingReason
): FileTargetVerdict => ({ relPath, state: "needs_handling", reason });

/** A relative path that stays inside the live root. Mirrors the guard
 *  `buildCodeRestorePlan` applies to a transcript-supplied ref: an absolute
 *  path or a `..` segment names a file outside the root and is not read. */
function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0 || isAbsolute(relPath)) return false;
  return !relPath.split(/[\\/]/).some((segment) => segment === "..");
}

/* -- operation-fact reduction (ADR-0136 §2.4, §2.5, §2.6) ------------------ */

/** Which of the three fact payloads a record carries. */
export type OperationFactKind =
  RuntimeOperationFact<NativeStateMessage>["kind"];

/**
 * How one fact stands against the checkpoint recovery restored.
 *
 * The APPEND ORDER of a fact is its association with the state it follows, and
 * `baseBodySha` names that state. So the only decidable question is whether
 * that base survived selection: a fact whose base is a body the restore did
 * not select has no proven position relative to the restored state, and
 * merging it would assert a chronology recovery cannot prove. Such a fact is
 * reported unanchored, never folded.
 */
export type FactAnchoring =
  | { readonly state: "anchored" }
  | {
      readonly state: "unanchored";
      readonly reason: "no_base_state" | "base_state_not_selected";
      readonly baseBodySha: string | null;
    };

/** One settled tool call, as the restored state accounts for it (spec §2.4). */
export interface RecoveredToolResultFact {
  readonly factId: string;
  readonly toolUseId: string;
  readonly batchPosition: number;
  readonly batchSize: number;
  readonly turnId?: string;
  /** The encoded result, exactly as it was committed to history. */
  readonly resultMessage: NativeStateMessage;
  /** Per-file associations; absent when the call touched no tracked file. */
  readonly files?: ReadonlyArray<RuntimeFileOperationRecord>;
}

/**
 * One graph node (spec §2.5) — ONE entry per `nodeId`, not per fact: the
 * reducer is the single owner of the per-node verdict, so a consumer cannot
 * have to re-implement last-wins over a node's transitions. The two arms are
 * deliberately distinct types: `in_flight` is a dispatched node whose outcome
 * is UNKNOWN, and folding it into `settled` would let a reader either re-run it
 * or read it as an error that never happened.
 */
export type RecoveredGraphNode =
  | {
      readonly factId: string;
      readonly nodeId: string;
      readonly state: "settled";
      readonly status: Exclude<RuntimeGraphNodeFact["status"], "running">;
      readonly output?: string;
      readonly error?: string;
      /** Anchored facts folded into this node; 1 = never re-entered. */
      readonly transitions: number;
    }
  | {
      readonly factId: string;
      readonly nodeId: string;
      readonly state: "in_flight";
      readonly outcome: "unknown";
      /** Anchored facts folded into this node; 1 = never re-entered. */
      readonly transitions: number;
    };

/**
 * One owned worker (spec §2.6, SC17). `stopEvidence` is the harness's own
 * `OwnedStopEvidence` — a post-sweep verdict when a sweep ran, else the fact's
 * own recorded stop — and `null` is the honest answer when neither proves
 * disappearance. `needsHandling` is derived from that proof and NEVER from the
 * worker's last recorded state, so "could not confirm" can never be read as
 * stopped.
 */
export interface RecoveredOwnedWorker {
  readonly factId: string;
  readonly taskId: string;
  readonly ownership: RuntimeWorkerFact["ownership"];
  readonly state: RuntimeWorkerFact["state"];
  readonly process?: RuntimeWorkerFact["process"];
  readonly transcriptPath?: string;
  readonly toolUseId?: string;
  readonly stopEvidence: OwnedStopEvidence | null;
  readonly needsHandling: boolean;
}

/** A fact recovery could not place against the restored state. */
export interface UnanchoredFact {
  readonly factId: string;
  readonly kind: OperationFactKind;
  readonly reason: Extract<FactAnchoring, { state: "unanchored" }>["reason"];
  readonly baseBodySha: string | null;
}

/** A fact whose payload must not be surfaced (see `reduceOperationFacts`). */
export interface RejectedFact {
  readonly factId: string;
  readonly kind: OperationFactKind;
  /** Dotted path of the field the exclusion guard refused. */
  readonly field: string;
}

/** What the reducer produced. Every list is in log order, and `graphNodes`
 *  holds one entry per `nodeId` in the order the node was first seen. */
export interface RecoveredOperationFacts {
  readonly toolResults: ReadonlyArray<RecoveredToolResultFact>;
  readonly graphNodes: ReadonlyArray<RecoveredGraphNode>;
  readonly workers: ReadonlyArray<RecoveredOwnedWorker>;
  readonly unanchored: ReadonlyArray<UnanchoredFact>;
  readonly rejected: ReadonlyArray<RejectedFact>;
  /** `factId`s the log carried more than once; the first occurrence counted. */
  readonly duplicateFactIds: ReadonlyArray<string>;
}

export interface ReduceOperationFactsInput {
  /** On-chain `operation_fact` records, in log order. */
  readonly facts: ReadonlyArray<SessionOperationFactRecord>;
  /** `bodySha` of the state recovery restored — the only base a fact may fold into. */
  readonly selectedBodySha: string;
  /** Post-sweep worker verdicts. Absent when the host ran no sweep, which
   *  leaves every worker without stop proof, not without a worker. */
  readonly workerSweep?: OwnedWorkerSweepResult;
}

/** Mutable accumulator behind the readonly result. */
interface FactDraft {
  readonly toolResults: RecoveredToolResultFact[];
  /** Per-node reduction in progress, keyed by `nodeId`; insertion order is the
   *  order the nodes were first seen, so the materialised list is log order. */
  readonly graphNodes: Map<string, { last: RecoveredGraphNode }>;
  readonly workers: RecoveredOwnedWorker[];
  readonly unanchored: UnanchoredFact[];
  readonly rejected: RejectedFact[];
}

const emptyDraft = (): FactDraft => ({
  toolResults: [],
  graphNodes: new Map(),
  workers: [],
  unanchored: [],
  rejected: [],
});

/**
 * Fold the log's operation facts into what the restored state accounts for.
 *
 * Deterministic and idempotent (SC27): a pure function of its input in log
 * order, and a repeated `factId` counts once with the repeats listed, so a
 * second open cannot add anything the first did not.
 *
 * A fact whose payload carries process-memory material (a credential, a
 * secret, a live handle, a secret-registry entry, a permission grant) is
 * REJECTED here rather than surfaced. The log codec validates a fact's shape,
 * not its contents, so this consumer-side check is the only one a read
 * performs: a fact that cannot be trusted is reported, never restored.
 */
export function reduceOperationFacts(
  input: ReduceOperationFactsInput
): RecoveredOperationFacts {
  const draft = emptyDraft();
  const stops = stopEvidenceByTask(input.workerSweep);
  const seen = new Set<string>();
  const duplicateFactIds: string[] = [];
  for (const record of input.facts) {
    if (seen.has(record.factId)) {
      duplicateFactIds.push(record.factId);
      continue;
    }
    seen.add(record.factId);
    classifyFact(draft, record, input.selectedBodySha, stops);
  }
  return { ...draft, graphNodes: graphNodeList(draft), duplicateFactIds };
}

/** One entry per node — the reducer's per-node verdict, materialized. */
const graphNodeList = (draft: FactDraft): ReadonlyArray<RecoveredGraphNode> =>
  [...draft.graphNodes.values()].map((entry) => entry.last);

/** One fact, once, in the precedence its own validity has. */
function classifyFact(
  draft: FactDraft,
  record: SessionOperationFactRecord,
  selectedBodySha: string,
  stops: ReadonlyMap<string, OwnedStopEvidence>
): void {
  const forbidden = forbiddenPersistedField(record.fact);
  if (forbidden !== null) {
    draft.rejected.push({
      factId: record.factId,
      kind: record.fact.kind,
      field: forbidden,
    });
    return;
  }
  const anchoring = anchoringOf(record.baseBodySha, selectedBodySha);
  if (anchoring.state === "unanchored") {
    draft.unanchored.push({
      factId: record.factId,
      kind: record.fact.kind,
      reason: anchoring.reason,
      baseBodySha: anchoring.baseBodySha,
    });
    return;
  }
  foldFact(draft, record, stops);
}

const anchoringOf = (
  baseBodySha: string | null,
  selectedBodySha: string
): FactAnchoring =>
  baseBodySha === selectedBodySha
    ? { state: "anchored" }
    : {
        state: "unanchored",
        reason:
          baseBodySha === null ? "no_base_state" : "base_state_not_selected",
        baseBodySha,
      };

function foldFact(
  draft: FactDraft,
  record: SessionOperationFactRecord,
  stops: ReadonlyMap<string, OwnedStopEvidence>
): void {
  const fact = record.fact;
  switch (fact.kind) {
    case "tool_result":
      draft.toolResults.push(recoveredToolResult(record.factId, fact));
      return;
    case "graph_node":
      foldGraphNode(draft, record.factId, fact);
      return;
    case "worker_progress":
      draft.workers.push(recoveredWorker(record.factId, fact, stops));
      return;
  }
}

function recoveredToolResult(
  factId: string,
  fact: RuntimeToolResultFact<NativeStateMessage>
): RecoveredToolResultFact {
  return {
    factId,
    toolUseId: fact.toolUseId,
    batchPosition: fact.batchPosition,
    batchSize: fact.batchSize,
    ...(fact.turnId !== undefined ? { turnId: fact.turnId } : {}),
    resultMessage: fact.resultMessage,
    ...(fact.files !== undefined ? { files: fact.files } : {}),
  };
}

/**
 * One node's transitions reduce to its LAST one: a node that ran, settled and
 * was entered again has a single verdict — where it last got to. Keeping the
 * fold here is what lets the `done` -> re-entered -> interrupted case stay
 * honest (the last transition is `running`, so the outcome is unknown rather
 * than the earlier `done`), and `transitions` is what tells a reader the node
 * was entered more than once instead of inferring it from a single entry.
 */
function foldGraphNode(
  draft: FactDraft,
  factId: string,
  fact: RuntimeGraphNodeFact
): void {
  const previous = draft.graphNodes.get(fact.nodeId);
  draft.graphNodes.set(fact.nodeId, {
    last: recoveredGraphNode(
      factId,
      fact,
      (previous?.last.transitions ?? 0) + 1
    ),
  });
}

function recoveredGraphNode(
  factId: string,
  fact: RuntimeGraphNodeFact,
  transitions: number
): RecoveredGraphNode {
  if (fact.status === "running") {
    // Dispatched with no terminal transition in the log: the outcome is
    // UNKNOWN, and reporting it as settled would either license a silent
    // re-run or read as a failure that never happened.
    return {
      factId,
      nodeId: fact.nodeId,
      state: "in_flight",
      outcome: "unknown",
      transitions,
    };
  }
  return {
    factId,
    nodeId: fact.nodeId,
    state: "settled",
    status: fact.status,
    ...(fact.output !== undefined ? { output: fact.output } : {}),
    ...(fact.error !== undefined ? { error: fact.error } : {}),
    transitions,
  };
}

function recoveredWorker(
  factId: string,
  fact: RuntimeWorkerFact,
  stops: ReadonlyMap<string, OwnedStopEvidence>
): RecoveredOwnedWorker {
  const stopEvidence = stopEvidenceFor(fact, stops);
  return {
    factId,
    taskId: fact.taskId,
    ownership: fact.ownership,
    state: fact.state,
    ...(fact.process !== undefined ? { process: fact.process } : {}),
    ...(fact.transcriptPath !== undefined
      ? { transcriptPath: fact.transcriptPath }
      : {}),
    ...(fact.toolUseId !== undefined ? { toolUseId: fact.toolUseId } : {}),
    stopEvidence,
    needsHandling: !provesProcessGone(stopEvidence),
  };
}

/** Post-sweep cleanup evidence per task, in the sweep's own vocabulary. */
function stopEvidenceByTask(
  sweep: OwnedWorkerSweepResult | undefined
): ReadonlyMap<string, OwnedStopEvidence> {
  const out = new Map<string, OwnedStopEvidence>();
  for (const worker of sweep?.workers ?? []) {
    out.set(worker.taskId, worker.cleanup);
  }
  return out;
}

/**
 * A sweep verdict when the host swept this session, else the fact's own
 * recorded stop. The producer publishes `stopped` only for a stop it proved, so
 * a recorded stop is itself evidence; anything else leaves `null`, which is
 * the answer that keeps the worker in `needs handling`.
 */
function stopEvidenceFor(
  fact: RuntimeWorkerFact,
  stops: ReadonlyMap<string, OwnedStopEvidence>
): OwnedStopEvidence | null {
  const swept = stops.get(fact.taskId);
  if (swept !== undefined) return swept;
  if (fact.state === "stopped" && fact.process !== undefined) {
    return { state: "confirmed_stopped", pid: fact.process.pid };
  }
  return null;
}

/**
 * The one rule the harness already draws for a stop
 * (`stopStateProvesGone` in harness/subagent/worker-identity-stop.ts), read
 * off the same union so a reader learns no second vocabulary: the process is
 * observably gone. `null` proves nothing.
 */
const provesProcessGone = (evidence: OwnedStopEvidence | null): boolean =>
  evidence !== null &&
  (evidence.state === "confirmed_stopped" || evidence.state === "not_started");
