/**
 * Content-addressed body pool for published native state (ADR-0136).
 *
 * Layout: `<sessionFolder>/blobs/native/<sha256-hex>` (no extension).
 * Content addressing, exclusive create, and EEXIST-as-dedup mirror
 * code-snapshot-store.ts, so identical states inside one session share one
 * body and a repeated publication rewrites nothing.
 *
 * Why the `native/` level: the trace reader dereferences trace bodies as
 * `<sessionFolder>/blobs/<sha>` (harness/trace/jsonl.ts, traceserver
 * get-record-core.ts) and only ever names a sha there. Nesting one level
 * deeper keeps a raw native body physically unreachable from a trace
 * reference, and keeps raw recovery content and masked trace evidence
 * distinguishable — the two are never interchangeable by a reader. This
 * module does NOT move, rename, or touch the existing `code-snapshots/` pool
 * or the flat `blobs/` layout.
 *
 * Pure filesystem IO over an already-resolved `sessionFolder`; path
 * derivation from a conversationId stays in session-store.ts. The sha is the
 * one segment taken raw from the transcript, hence the alphabet gate.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  NativeStateBoundary,
  NativeStateContentBlock,
  NativeStateRole,
  NativeStateSnapshot,
} from "../../shared/native-state-port.js";
import { BLOBS_DIR_NAME } from "../../shared/session-tree-names.js";
import type { FileIntentTarget } from "./jsonl.js";
import { factPayloadField, isNativeStateBoundary } from "./jsonl.js";

/** Typed body-pool failure. Distinct kinds so the caller can fail closed and
 *  tell the cases apart: an absent body, a name that cannot address one, bytes
 *  that do not parse, and a body whose content violates the published-state
 *  shape are four different recovery states, not one IO fault. */
export type NativeStateBodyError =
  | { kind: "native_state_body_missing"; sha: string }
  | { kind: "native_state_body_invalid_sha"; sha: string }
  | { kind: "native_state_body_corrupt"; reason: string }
  | { kind: "native_state_body_schema_invalid"; field: string };

/** `<sessionFolder>/blobs/native/` — raw native recovery bodies, one level
 *  below the trace-addressable pool. */
export const NATIVE_STATE_BLOBS_DIR_NAME = "native";

/** sha256 hex alphabet — the only shape a body filename may take. */
const SHA_HEX_RE = /^[0-9a-f]{64}$/;

/** Whether `sha` can address a body. Rejects anything that could turn the
 *  body path into a traversal (`../…`, absolute) or a non-hex name. */
export function isNativeStateSha(sha: string): boolean {
  return SHA_HEX_RE.test(sha);
}

/** `<sessionFolder>/blobs/native/` — the body directory SSOT. */
export function nativeStateBlobsDir(sessionFolder: string): string {
  return join(sessionFolder, BLOBS_DIR_NAME, NATIVE_STATE_BLOBS_DIR_NAME);
}

/** Capture input → bytes: a string is utf8, a buffer passes through. One
 *  normalization so sha and body payload can never disagree on encoding. */
const toBodyBytes = (bytes: Buffer | string): Buffer =>
  typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;

/** sha256 hex of the raw bytes — the body's content address / filename. */
export function nativeStateBodySha(bytes: Buffer | string): string {
  return createHash("sha256").update(toBodyBytes(bytes)).digest("hex");
}

/**
 * Write `bytes` as a content-addressed body, returning its sha256 hex.
 * An existing body is left untouched (dedup): `EEXIST` on the exclusive write
 * is the normal repeat-publication path, not a failure.
 */
export async function writeNativeStateBody(
  sessionFolder: string,
  bytes: Buffer | string
): Promise<string> {
  const buf = toBodyBytes(bytes);
  const sha = nativeStateBodySha(buf);
  const dir = nativeStateBlobsDir(sessionFolder);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, sha), buf, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return sha;
    throw err;
  }
  return sha;
}

/**
 * Read a previously written body. A name outside sha256's alphabet is a typed
 * `native_state_body_invalid_sha` BEFORE any filesystem access — a published
 * record is history, not a licence to read outside the session folder. A
 * missing body is a typed `native_state_body_missing`; any other failure
 * propagates so the caller never mistakes an IO fault for an absent state.
 */
export async function readNativeStateBody(
  sessionFolder: string,
  sha: string
): Promise<Buffer> {
  if (!isNativeStateSha(sha)) {
    throw {
      kind: "native_state_body_invalid_sha",
      sha,
    } satisfies NativeStateBodyError;
  }
  try {
    return await readFile(join(nativeStateBlobsDir(sessionFolder), sha));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw {
        kind: "native_state_body_missing",
        sha,
      } satisfies NativeStateBodyError;
    }
    throw err;
  }
}

/**
 * Decode + validate a body into a snapshot. Unparseable bytes and a body that
 * violates the published-state shape are separate typed failures: recovery
 * must not be able to confuse "the bytes are damaged" with "the state is not
 * the shape this code restores". Pure.
 */
export function parseNativeStateBody(bytes: Buffer): NativeStateSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw {
      kind: "native_state_body_corrupt",
      reason: err instanceof Error ? err.message : String(err),
    } satisfies NativeStateBodyError;
  }
  const field = validateNativeStateSnapshot(parsed);
  if (field !== null) {
    throw {
      kind: "native_state_body_schema_invalid",
      field,
    } satisfies NativeStateBodyError;
  }
  return parsed as NativeStateSnapshot;
}

/** Validate a snapshot before it is written. Returns the failed field name, or
 *  null when valid — the schema.ts validator convention, kept independent of
 *  the session-file schema because a body is a different artifact (a native
 *  recovery state, not a transcript). */
export function validateNativeStateSnapshot(value: unknown): string | null {
  if (!isRecord(value)) return "root";
  return (
    snapshotField(value) ??
    typedRuntimeStateField(value) ??
    forbiddenPersistedField(value)
  );
}

/** The snapshot's own fields: boundary, context, turn identity, opaque bag. */
function snapshotField(value: Record<string, unknown>): string | null {
  if (!isNativeStateBoundary(value["boundary"])) return "boundary";
  const messages = value["messages"];
  if (!Array.isArray(messages)) return "messages";
  for (const message of messages) {
    const field = messageField(message);
    if (field !== null) return field;
  }
  if (value["turnId"] !== undefined && typeof value["turnId"] !== "string") {
    return "turnId";
  }
  if (value["runtimeFacts"] !== undefined && !isRecord(value["runtimeFacts"])) {
    return "runtimeFacts";
  }
  return null;
}

/** The typed runtime fields a published state carries (assembly, loop
 *  position, graph, worker, terminal). A field this version does not name
 *  still round-trips through the opaque bag rather than being rejected — a
 *  future field is unknown, not invalid. */
const RUNTIME_STATE_VALIDATORS: ReadonlyArray<
  readonly [string, (value: unknown) => boolean]
> = [
  ["assembly", isOptionalAssembly],
  ["toolResults", isFactListOf("tool_result")],
  ["graphNodes", isFactListOf("graph_node")],
  ["workers", isFactListOf("worker_progress")],
  ["terminal", isOptionalTerminal],
];

/** The first typed-field failure, or null. One table, so the validator keeps a
 *  single decision instead of five identical branches. */
function typedRuntimeStateField(value: Record<string, unknown>): string | null {
  for (const [key, isValid] of RUNTIME_STATE_VALIDATORS) {
    if (!isValid(value[key])) return key;
  }
  return null;
}

function isOptionalAssembly(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  // Only the fields the contract declares are examined. A payload written by a
  // build that still carried `skillIndexSeen` / `pendingContinuation` /
  // `executionMode` still READS here: those keys are simply not consulted, and
  // nothing restores them, so a stale payload stays readable instead of
  // becoming an unreadable checkpoint. The one field with a real producer is
  // the one validated.
  return isOptionalString(value["systemPrefix"]);
}

function isOptionalTerminal(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value["stopReason"] === "string" &&
    isOptionalString(value["supplierDetail"])
  );
}

/** A list of exactly one fact kind, when present. The record layer owns the
 *  per-fact shape (jsonl.ts); this only checks the collection is a list of that
 *  kind, so a `workers` field full of tool results is not readable as workers. */
function isFactListOf(kind: string): (value: unknown) => boolean {
  return (value) =>
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (fact) =>
          isRecord(fact) &&
          fact["kind"] === kind &&
          factPayloadField(fact) === null
      ));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/* -- persisted-payload exclusion guard ------------------------------------- */

/**
 * The spec excludes four families from saved state (SC18): API credentials and
 * secret values, the in-memory secret-roundtrip registry, live process
 * handles / streams / timers / abort signals, and process-memory permission
 * grants (including `allow-once`). None may be restored, and a payload carrying
 * one is rejected BEFORE any write rather than trusted to be filtered upstream.
 *
 * ONE deep guard, applied on the append path of both the published snapshot and
 * the operation fact, so a new payload kind cannot opt out by being new.
 *
 * It matches KEYS, everywhere this layer owns the shape — including a key
 * smuggled onto a message object, and every level of the runtime state. It does
 * NOT descend into a tool argument or a tool result body: those two subtrees
 * are typed `unknown` on purpose, their keys belong to whatever tool schema
 * produced them (`read_mcp_resource` alone has a `server` key), and a
 * publication must not be rejected over a word in a payload the model wrote.
 * Redaction of model content is the trace masker's job, not this guard's.
 */
interface ExclusionRule {
  readonly pattern: RegExp;
  /** Carve-out for the one shape a banned word legitimately takes: a worker's
   *  process IDENTITY ({pid,startTime}) — the evidence that proves a worker
   *  stopped, which cannot reach the process. Any other value is a handle. */
  readonly allow?: (value: unknown) => boolean;
}

/** The only keys a `process` value may carry. */
const PROCESS_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "pid",
  "starttime",
]);

const EXCLUSION_RULES: ReadonlyArray<ExclusionRule> = [
  {
    pattern:
      /(api[-_]?key|secret|password|passphrase|credential|token|private[-_]?key|authorization|cookie|sessionkey)/i,
  },
  {
    pattern:
      /(secretregistry|secretsregistry|secret[-_]?roundtrip|roundtripregistry)/i,
  },
  {
    pattern:
      /(childprocess|process[-_]?handle|livehandle|handle|spawn|server|listener|socket|stream|stdin|stdout|stderr|abortcontroller|abortsignal|signal|timer|process)/i,
    allow: isProcessIdentityOnly,
  },
  {
    pattern:
      /(allowonce|permissiongrants?|grants|approvals?|approvedtools|autoapprove|yolo)/i,
  },
];

/** A `process` value that is identity only — no other key survives. */
function isProcessIdentityOnly(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((key) => PROCESS_IDENTITY_KEYS.has(key.toLowerCase()))
  );
}

/** Deepest payload nesting the guard walks. Native messages and facts are
 *  shallow by construction, so this bounds a self-referential payload instead
 *  of recursing without end; a `seen` set catches a cycle at any depth. */
const MAX_SCAN_DEPTH = 24;

/**
 * The first forbidden field in `value` as a dotted path, or null when the
 * payload is clean. Pure, depth-bounded, cycle-safe.
 */
export function forbiddenPersistedField(value: unknown): string | null {
  return scanForbidden(value, "", new WeakSet<object>(), 0);
}

function scanForbidden(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  depth: number
): string | null {
  if (depth > MAX_SCAN_DEPTH) return path;
  if (Array.isArray(value)) return scanList(value, path, seen, depth);
  if (!isRecord(value)) return null;
  return scanRecord(value, path, seen, depth);
}

function scanList(
  list: ReadonlyArray<unknown>,
  path: string,
  seen: WeakSet<object>,
  depth: number
): string | null {
  if (seen.has(list)) return `${path}[]`;
  seen.add(list);
  for (let i = 0; i < list.length; i++) {
    const found = scanForbidden(list[i], `${path}[${i}]`, seen, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function scanRecord(
  record: Record<string, unknown>,
  path: string,
  seen: WeakSet<object>,
  depth: number
): string | null {
  if (seen.has(record)) return path;
  seen.add(record);
  for (const key of Object.keys(record)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (isExcludedKey(key, record[key])) return childPath;
    if (isOpaqueModelPayload(record, key)) continue;
    const found = scanForbidden(record[key], childPath, seen, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** The subtrees whose keys belong to a tool's own schema rather than to this
 *  layer. The KEY itself is still checked above; only the descent is skipped. */
function isOpaqueModelPayload(
  record: Record<string, unknown>,
  key: string
): boolean {
  if (record["type"] === "tool_use") return key === "input";
  return record["type"] === "tool_result" && key === "content";
}

function isExcludedKey(key: string, child: unknown): boolean {
  return EXCLUSION_RULES.some(
    (rule) => rule.pattern.test(key) && rule.allow?.(child) !== true
  );
}

/** Failed-field check for an operation-fact request, before any IO. The fact
 *  payload is validated with the record layer's own validator, so a fact that
 *  can be written is a fact that can be read back. */
export function operationFactInputField(
  factId: string,
  fact: unknown
): string | null {
  if (typeof factId !== "string" || factId.length === 0) return "factId";
  const field = factPayloadField(fact);
  if (field !== null) return field;
  return forbiddenPersistedField(fact);
}

/** Failed-field check for a publication request, before any IO — a rejected
 *  publication must not leave a body behind. Returns null when publishable. */
export function nativeStateInputField(
  anchorEventId: string,
  boundary: NativeStateBoundary,
  snapshot: NativeStateSnapshot
): string | null {
  if (typeof anchorEventId !== "string" || anchorEventId.length === 0) {
    return "anchorEventId";
  }
  // The record is read without dereferencing its body, so the two boundary
  // values must not be able to disagree.
  if (!isNativeStateBoundary(boundary) || boundary !== snapshot?.boundary) {
    return "boundary";
  }
  return validateNativeStateSnapshot(snapshot);
}

/** Failed-field check for a file-intent request, before any IO. An intent must
 *  name at least one target: a zero-target record asserts no effect at all,
 *  and an empty association list is indistinguishable from "no evidence was
 *  kept" — which is what `captured:false` is for. */
export function fileIntentInputField(
  toolUseId: string,
  targets: ReadonlyArray<FileIntentTarget>,
  captured: boolean
): string | null {
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    return "toolUseId";
  }
  if (!Array.isArray(targets) || targets.length === 0) return "targets";
  for (const target of targets) {
    if (!isFileIntentTargetRecord(target, captured)) return "targets";
  }
  return null;
}

/** Whether one target is a well-formed association. `relPath` /
 *  `rootIdentity` must resolve a live file, so an empty one is a shape error,
 *  not a cosmetic value. */
function isFileIntentTargetRecord(
  target: FileIntentTarget,
  captured: boolean
): boolean {
  return (
    typeof target?.relPath === "string" &&
    target.relPath.length > 0 &&
    typeof target.rootIdentity === "string" &&
    target.rootIdentity.length > 0 &&
    typeof target.absentBefore === "boolean" &&
    hasValidShas(target, captured)
  );
}

/** The two sha keys reuse the body pool's sha256 alphabet gate — the same
 *  64-lowercase hex a `code-snapshots/` blob name takes, and both arrive from
 *  the transcript, so both are gated before a read resolves them to a path.
 *  The preimage IS the recovery evidence: a captured intent without one, or a
 *  suppressed intent carrying one, each misstate what was recorded. */
function hasValidShas(target: FileIntentTarget, captured: boolean): boolean {
  if (
    target.preimageSha !== undefined &&
    !isNativeStateSha(target.preimageSha)
  ) {
    return false;
  }
  if (
    target.postimageSha !== undefined &&
    !isNativeStateSha(target.postimageSha)
  ) {
    return false;
  }
  // Both shas are well-formed now, so "carries a preimage" is simply
  // presence. Capture and evidence must agree: a captured intent MUST carry
  // its preimage, a suppressed one MUST NOT.
  if (captured) return target.preimageSha !== undefined;
  return target.preimageSha === undefined;
}

/** One message's failed field, or null. Split out so the message loop above
 *  keeps a single decision of its own. */
function messageField(message: unknown): string | null {
  if (!isRecord(message)) return "messages";
  if (!isRole(message["role"])) return "messages";
  const content = message["content"];
  if (!Array.isArray(content)) return "messages";
  for (const block of content) {
    if (!isContentBlock(block)) return "messages";
  }
  if (
    message["hostInjected"] !== undefined &&
    message["hostInjected"] !== true
  ) {
    return "messages";
  }
  return null;
}

/** Keyed off the neutral unions so a new role / block member fails compilation
 *  here until it is listed here. */
const ROLE_MEMBERS: Record<NativeStateRole, true> = {
  user: true,
  assistant: true,
  system: true,
};

/** Per-block-type shape checks, keyed by the neutral content-block union (the
 *  `Record<Union, true>` discipline, holding a validator instead of a marker so
 *  one function carries the whole block table). */
const BLOCK_VALIDATORS = new Map<
  NativeStateContentBlock["type"],
  (block: Record<string, unknown>) => boolean
>([
  ["text", (b) => typeof b["text"] === "string"],
  [
    "tool_use",
    (b) =>
      typeof b["id"] === "string" &&
      typeof b["name"] === "string" &&
      "input" in b,
  ],
  [
    "tool_result",
    (b) => typeof b["tool_use_id"] === "string" && "content" in b,
  ],
  [
    "thinking",
    (b) =>
      typeof b["thinking"] === "string" && typeof b["signature"] === "string",
  ],
  ["redacted_thinking", (b) => typeof b["data"] === "string"],
]);

function isRole(value: unknown): value is NativeStateRole {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ROLE_MEMBERS, value)
  );
}

function isContentBlock(value: unknown): value is NativeStateContentBlock {
  if (!isRecord(value)) return false;
  const type = value["type"];
  if (typeof type !== "string") return false;
  const validate = BLOCK_VALIDATORS.get(
    type as NativeStateContentBlock["type"]
  );
  return validate !== undefined && validate(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
