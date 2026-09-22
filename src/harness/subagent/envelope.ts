/**
 * Subagent JSON envelope — the frozen parent↔child process-boundary schema.
 *
 * Two directions:
 *   - parent→child worker request (parseWorkerEnvelope):
 *       { task, systemPrompt?, disallowedTools?, maxTurns?, timeoutMs?,
 *         sandboxRoot, env?, role?, finalText?, evidenceContext? }
 *   - child→parent result (parseParentEnvelope / truncateEnvelopeResult):
 *       { status: "ok"|"failed", summary, result, fileRefs?, usage?, reason?,
 *         stop_reason?, truncated?, totalLength?, task_id?, tmp_root?,
 *         output_path?, product_roster? }
 *
 * Validation rules:
 *   - missing required field / wrong type / non-object → throw ProtocolError;
 *   - trim the trailing newline before parsing; on multiple newline-separated
 *     lines parse only the first standalone JSON object (a second JSON line is
 *     ignored);
 *   - ajv uses the repo's standard strict configuration (same as
 *     makeAjv in src/harness/tools/registry.ts), no second divergent config.
 *
 * Parent-visible projection: the handoff the parent model sees is a short
 * summary, paths and stop reason — not the full final text. `truncated` is
 * set (report folded, task not failed) when the original is longer than the
 * handoff or exceeds 20000 chars; status/reason stay unchanged.
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { ProtocolError } from "../errors.js";
import type { StopReason } from "../model-adapter/types.js";
import type { WriteSituation } from "../session-roots.js";

/**
 * The parent session's model-visible skill index entries at the moment of
 * spawn (= parent's frozen table ∪ parent's index entry history, filtered by
 * model-index eligibility), carried across the process boundary in the
 * envelope.
 *
 * Shape = wire subset of `SkillSummary` (`identity/assemble.ts`): `name`
 * mandatory, `description` optional (bare-name lines after demotion,
 * ADR-0046). Deliberately **no** `disabled`: the model-visible index never
 * contains disabled entries, and adding the field would open a second
 * meaning on the wire.
 *
 * This is not a second renderer: the worker hands the entries to
 * `skillsSegment` as before (rendering SSOT); this structure is data only.
 */
export interface SkillIndexSnapshotEntry {
  readonly name: string;
  readonly description?: string;
}

/** Parent→child worker request envelope. Frozen schema shape: WORKER_SCHEMA. */
export interface WorkerEnvelope {
  readonly task: string;
  readonly systemPrompt?: string;
  readonly disallowedTools?: readonly string[];
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly sandboxRoot: string;
  readonly env?: Readonly<Record<string, unknown>>;
  /**
   * Wire-additive field from SubAgentDefinition.role. The worker assembly
   * queries the catalog for the body and injects the persona section;
   * absent / unknown → baseline behavior (defense-in-depth fallback, see
   * worker.ts).
   */
  readonly role?: string;
  /**
   * Host truncated dialogue (judge). Independent of `task`.
   */
  readonly finalText?: string;
  /**
   * Evidence prompt object (judge). Independent of `task`.
   */
  readonly evidenceContext?: object;
  /**
   * Write-situation tri-state, computed by `manager.buildWorkerPayload` at
   * spawn time via `writeSituation(isolationOn, resolved)` and passed through.
   * The worker prior (`priorMessagesFromEnvelope`) renders the write-root
   * section from it:
   *   - `writable_main` / `writable_tree` → sections ①/② (byte-equal to before);
   *   - `no_writable_root` → state ③ disclosure (does not name the
   *     tree-creation tool, does not embed the sandbox root);
   *   - absent (**legacy envelope** — cross-version resume / old worker
   *     bootstrap) → typed skip: no write-root section, no fallback to old wording.
   *
   * Wire additive + optional — same shape as `role`; legacy envelopes (no
   * field) stay ajv-acceptable, **breaking no existing contract** (under
   * `additionalProperties:false` it must be declared explicitly in
   * WORKER_SCHEMA.properties).
   */
  readonly writeSituation?: WriteSituation;
  /**
   * ADR-0071: this worker's taskId (locked by manager.randomUUID() at parent
   * spawn). Paired with traceFilePath — the worker writes its file-mode trace
   * to that path with conversationId=taskId, replacing the old fake
   * `randomUUID()` L2 scope (retired). Absent → fall back to IKNOW_TRACE_OUT.
   * Wire additive + optional — same shape as `role`; legacy envelopes /
   * cross-version resume stay ajv-acceptable, worker does not degrade
   * (declared explicitly in WORKER_SCHEMA.properties under
   * `additionalProperties:false`).
   */
  readonly taskId?: string;
  /**
   * ADR-0071: file-mode anchor for the worker process's JsonlTraceService,
   * computed by `manager.buildWorkerPayload` at spawn time (the parent has
   * already created `<parent session folder>/subagents/agent-<taskId>.jsonl`
   * for this taskId). The worker creates a file-mode service directly from
   * this path + taskId, no longer the retired `randomUUID()` fake scope
   * (per-agent form preferred). Wire additive + optional — same shape as
   * `role`; legacy envelopes / cross-version resume → absent, worker falls back
   * to the existing IKNOW_TRACE_OUT / defaultTraceDir form (byte-stable).
   */
  readonly traceFilePath?: string;
  /**
   * ADR-0102: worker transcript location — `<parent session folder>/subagents/
   * <taskId>/<taskId>.jsonl` (separate from the `agent-<taskId>.jsonl`
   * per-agent trace — not a second trace, not a replacement for the continue
   * source; trace semantics untouched). The worker loop appends messages as it
   * runs (the SessionFileV1 read path can consume it); the subagent_continue
   * gate keys on its existence. Wire additive + optional — same shape as
   * `traceFilePath`; legacy envelopes (no field) → ajv-accepted → worker writes
   * no transcript (byte-stable).
   */
  readonly transcriptPath?: string;
  /**
   * ADR-0085: parent session ledger anchor — the worker and parent share
   * **one** todos.md, `projectDir` = parent session's project directory (the
   * same value as `TodoWriteToolDeps.todoDir`), `conversationId` = parent
   * session id. The worker assembly passes it to the todo_write factory; the
   * tool reads/updates the parent ledger from it and does a typed rejection
   * on its `add` (adding is parent-session only).
   *
   * Not reverse-derived from the trace file layout (fragile coupling): the
   * manager lands the value directly from host-injected `opts.todoDir` +
   * `def.conversationId`, the same (projectDir, conversationId) pair as
   * todo-write.ts's `resolveConversationTodoPath`.
   *
   * Wire additive + optional — same shape as `role`; legacy envelopes (no
   * field) stay ajv-acceptable, worker assembly falls back to the old
   * no-todoDir form (`additionalProperties:false` requires explicit declaration
   * in WORKER_SCHEMA.properties).
   */
  readonly todoLedger?: {
    readonly projectDir: string;
    readonly conversationId: string;
  };
  /**
   * The parent session's complete model-visible skill index snapshot at spawn
   * time (= parent's frozen table names ∪ parent's index entry history names,
   * see ADR-0098). Present → the worker's `<available_skills>` frozen table
   * takes it as its **sole source** (computed once at worker assembly, then
   * constant in-process via the resolver closure); absent (legacy envelope /
   * cross-version resume / directly constructed manager) → the worker falls
   * back to its own independent rescan (`createSkillScanner`), behavior
   * byte-unchanged.
   *
   * **Empty array ≠ absent**: `[]` = the parent genuinely has no
   * model-visible skills (worker renders the empty-list sentence); key absent
   * = nobody supplied a snapshot (worker self-scans). JSON can tell them
   * apart, so the parent omits the key only when the getter is absent /
   * returns undefined, and still writes `[]` when that's the value.
   *
   * Why full **entries** instead of a name list: the criterion is
   * "complete". Parent and worker can have different skill roots (plugin
   * roots vary with reload / working directory), so re-looking up by name in
   * the worker catalog would **drop entries**; shipping entries also saves
   * the worker one resolution pass. The cost: a name may have no loadable
   * body in the worker (`skill()` reports not found) — index visible, body
   * unavailable is a known degradation, better than silently losing a line.
   *
   * Wire additive + optional — same shape as `role`; legacy envelopes (no
   * field) stay ajv-acceptable, **breaking no existing contract** (under
   * `additionalProperties:false` it must be declared explicitly in
   * WORKER_SCHEMA.properties).
   */
  readonly skillIndexSnapshot?: readonly SkillIndexSnapshotEntry[];
}

/**
 * Sub-agent failure attribution vocabulary (SSOT). Closed enum: value-set
 * changes must go through an ADR (`modelTransient` was added explicitly as
 * the fifth value by ADR-0111; wire-side mirror =
 * PARENT_SCHEMA.properties.reason.enum). Consumers (manager
 * QueryBufferResult / verify ClassifierEnvelope) reuse it by name; the trace
 * / traceserver layers keep a mirrored literal union per their own
 * "no cross-domain imports" discipline, with cross-referencing comments.
 */
export type SubagentFailureReason =
  | "crashed"
  | "maxTurnsExceeded"
  | "timeout"
  | "protocolError"
  | "modelTransient";

/** Child→parent result envelope. Frozen schema shape: PARENT_SCHEMA. */
export interface SubAgentEnvelope {
  readonly status: "ok" | "failed";
  readonly summary: string;
  readonly result: string;
  readonly fileRefs?: readonly string[];
  /** Usage snapshot of the sub-agent run (TokenUsage shape, JSON-serializable; aligns with schema `usage?: object`). */
  readonly usage?: object;
  readonly reason?: SubagentFailureReason;
  /**
   * Observation floor (additive): the sub-agent run's actual stop reason,
   * sourced from `RunResult.stopReason` (loop-engine's eight-value append-only
   * union).
   *
   * Semantically different from `reason`, **never merged**: `reason` is the
   * parent-side failure-attribution enum (crashed / maxTurnsExceeded /
   * timeout / protocolError, plus modelTransient added as the fifth value by
   * ADR-0111 = transient upstream model-stream/transport failure), while
   * `stop_reason` is the sub-agent loop's own stop cause (including
   * successful stops like completed). The status enum and the closed reason
   * enum keep their frozen judgment shape (locked by
   * tests/subagent/envelope-freeze.test.ts; closedness = values outside the
   * enum are rejected, value-set changes must go through an ADR, see
   * ADR-0111).
   *
   * The TS side reuses `StopReason` directly (single declaration point, zero
   * drift when the union grows); the wire schema side deliberately has **no
   * enum** (see the PARENT_SCHEMA comment). Absent = this envelope was not
   * derived from a run() return value (e.g. the MaxTurnsExceeded throw path)
   * — do not guess.
   */
  readonly stop_reason?: StopReason;
  readonly truncated?: boolean;
  readonly totalLength?: number;
  /**
   * Locator (additive): worker task id. Wire name `task_id` matches
   * wait:false spawn receipts. Absent on legacy envelopes.
   */
  readonly task_id?: string;
  /**
   * Locator (additive): host path of this worker's fence `/tmp` pad
   * (`…/subagents/<taskId>/fence-tmp`). Used to read by id later.
   */
  readonly tmp_root?: string;
  /**
   * Pad-relative path of the file the **host** wrote the worker's terminal
   * assistant text to (`FINAL_TEXT_PAD_NAME`, sibling of the pad's other
   * products). The parent-visible envelope stays a short summary — this field
   * is the full-text channel, read back with `subagent_result(tmp_path)`.
   *
   * Postel: present only when a file was actually written. A failed pad write
   * or an empty/whitespace-only `result` (e.g. the timeout fallback envelope)
   * omits the key rather than pointing at a file that does not exist.
   *
   * Wire additive + optional — legacy envelopes without it still parse; the
   * host's own stamp is in `attachParentVisibleTmp`.
   */
  readonly output_path?: string;
  /**
   * Short roster of pad top-level names. The success path omits it or leaves
   * it empty — nothing populates this field yet.
   */
  readonly product_roster?: readonly string[];
}

/**
 * SSOT name of the host-written final-text file inside a worker's pad.
 * Pad-relative (what `subagent_result(tmp_path)` consumes), never absolute.
 */
export const FINAL_TEXT_PAD_NAME = "final.md";

const TRUNCATION_LIMIT = 20000;
/** Parent-visible summary cap (handoff + crashed stderr tail). */
export const SUMMARY_LIMIT = 2000;
const TRUNCATION_MARKER = (total: number) =>
  `[report folded; total ${total} chars]`;

/**
 * Repo-standard ajv config: strict: true + ajv-formats (same makeAjv setup as
 * src/harness/tools/registry.ts). The envelope probe and envelope.ts share this
 * single configuration.
 */
export function makeEnvelopeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/**
 * Parent→child worker request schema (frozen; probe and product consume the same source).
 * ADR-0122: the per-spawn `model` field is deleted; under
 * `additionalProperties: false` a payload that still carries `model` is a
 * ProtocolError (the request is stdin from a same-version parent, not a
 * document read back across versions).
 */
export const WORKER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: { type: "string" },
    systemPrompt: { type: "string" },
    disallowedTools: { type: "array", items: { type: "string" } },
    maxTurns: { type: "integer", minimum: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    sandboxRoot: { type: "string" },
    env: { type: "object" },
    role: { type: "string" },
    finalText: { type: "string" },
    evidenceContext: { type: "object" },
    // Write-situation tri-state — same shape as role (wire additive,
    // optional). Enum values are locked into the wire schema (like status /
    // reason — they are judgment surfaces); legacy envelopes (field absent)
    // → ajv accepts → worker typed skip.
    writeSituation: {
      type: "string",
      enum: ["writable_main", "writable_tree", "no_writable_root"],
    },
    // taskId — same shape as role (wire additive, optional). No format lock
    // (uuid shape is the caller's choice, no SSOT enum). Legacy envelope /
    // cross-version resume → absent → worker falls back to IKNOW_TRACE_OUT.
    taskId: { type: "string" },
    // traceFilePath — same shape as role (wire additive, optional). A string
    // path, no enum lock (path shape is the caller's choice, no SSOT enum).
    // Legacy envelope / cross-version resume → absent → worker falls back to
    // IKNOW_TRACE_OUT.
    traceFilePath: { type: "string" },
    // ADR-0102: transcriptPath — same shape as traceFilePath (wire additive,
    // optional). Path string, no format lock; legacy envelopes omit it →
    // worker writes no transcript.
    transcriptPath: { type: "string" },
    // ADR-0085: parent-session ledger anchor — same shape as role (wire
    // additive, optional). Both sub-fields are required (an incomplete anchor
    // is repudiated: the assembly layer gets a ProtocolError instead of a
    // half-wired ledger); legacy envelopes omit the field → ajv accepts →
    // worker falls back to the old tool surface without todoDir.
    todoLedger: {
      type: "object",
      properties: {
        projectDir: { type: "string", minLength: 1 },
        conversationId: { type: "string", minLength: 1 },
      },
      required: ["projectDir", "conversationId"],
      additionalProperties: false,
    },
    // The parent's full model-visible skill index snapshot at spawn time —
    // same shape as role (wire additive, optional). Entries locked to
    // `{name, description?}`: name mandatory and non-empty (even bare-name
    // demoted lines need a name), description optional (the demoted shape),
    // no extra keys accepted (no second field set on the wire). An empty
    // array is valid and **not synonymous with key absence** (see the
    // interface comment). Legacy envelopes (field absent) → ajv accepts →
    // worker runs its own independent rescan.
    skillIndexSnapshot: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["task", "sandboxRoot"],
  additionalProperties: false,
};

/** Child→parent result envelope schema (frozen; probe and product consume the same source). */
export const PARENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string" },
    result: { type: "string" },
    fileRefs: { type: "array", items: { type: "string" } },
    usage: { type: "object" },
    reason: {
      type: "string",
      // ADR-0111: the fifth value modelTransient = a cause-carrying transient
      // model-stream/transport failure (the loop closes it as protocolError +
      // RunResult.apiError presence). The closed-enum judgment surface is
      // unchanged: values outside the enum are still rejected (locked by
      // envelope-freeze).
      enum: [
        "crashed",
        "maxTurnsExceeded",
        "timeout",
        "protocolError",
        "modelTransient",
      ],
    },
    // Observation floor (additive): the sub-agent run's actual stop reason.
    // Under `additionalProperties: false` a new field must be declared
    // explicitly, or ajv judges any envelope carrying stop_reason a
    // ProtocolError.
    //
    // Deliberately **no enum**: `StopReason` is an append-only union; freezing
    // the current eight values into the wire schema would mean syncing two
    // places on every addition, and old parents would reject valid envelopes
    // from new workers. The status / reason enums are frozen because they are
    // the parent's **judgment surfaces** (a frozen V1 contract); stop_reason
    // is observation-only, drives no branch, so Postel keeps it wide.
    stop_reason: { type: "string" },
    truncated: { type: "boolean" },
    totalLength: { type: "integer" },
    // Locator fields (additive, optional): non-empty when a current worker
    // projects a parent-visible envelope. Legacy jsonl without these keys
    // still parses. minLength:1 so empty strings are protocol errors.
    task_id: { type: "string", minLength: 1 },
    tmp_root: { type: "string", minLength: 1 },
    // Final-text path (additive, optional): pad-relative path of the
    // host-written final text. `additionalProperties: false` means an
    // undeclared key here would make every stamped envelope a ProtocolError.
    // minLength:1 — an empty string is a protocol error, not "no file".
    output_path: { type: "string", minLength: 1 },
    product_roster: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "result"],
  additionalProperties: false,
};

function compileEnvelopeAjv(schema: Record<string, unknown>): ValidateFunction {
  return makeEnvelopeAjv().compile(schema);
}

/**
 * Parse + validate a parent→child worker request envelope.
 *
 * Failure modes (all throw ProtocolError):
 *   - input not an object (bare string / array / null) → throw;
 *   - missing required fields (task / sandboxRoot) → throw;
 *   - wrong type (e.g. task: 123) → throw.
 *
 * The trailing newline is trimmed before parsing; with multiple newline-
 * separated lines only the first standalone JSON object is parsed (a second
 * JSON line is ignored).
 */
export function parseWorkerEnvelope(input: string): WorkerEnvelope {
  return parseEnvelope(input, "worker") as WorkerEnvelope;
}

/**
 * Parse + validate a child→parent result envelope. Failure modes same as parseWorkerEnvelope.
 */
export function parseParentEnvelope(input: string): SubAgentEnvelope {
  return parseEnvelope(input, "parent") as SubAgentEnvelope;
}

function parseEnvelope(input: string, direction: "worker" | "parent"): unknown {
  const validate = direction === "worker" ? workerValidate : parentValidate;
  // Protocol = one envelope per line (newline-JSON). With multiple newline-
  // separated lines, parse only the first standalone JSON object (a second
  // JSON line is ignored); the trailing newline is absorbed by first-line
  // slicing + trim.
  const firstLine = input.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ProtocolError(
      `subagent envelope parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProtocolError(
      `subagent ${direction} envelope: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`
    );
  }
  if (!validate(parsed)) {
    throw new ProtocolError(
      `subagent ${direction} envelope validation failed: ${JSON.stringify(validate.errors ?? [])}`
    );
  }
  return parsed;
}

function shortSummary(summary: string, result: string): string {
  const source = summary.length > 0 ? summary : result;
  return source.length > SUMMARY_LIMIT
    ? `${source.slice(0, SUMMARY_LIMIT)}…`
    : source;
}

function failedSummary(env: SubAgentEnvelope): string {
  // ADR-0111: modelTransient must be distinguishable from crashed (process-
  // level abnormal death) / protocolError (corrupt protocol) on the parent-
  // visible wording surface — the dedicated hint carries the ADR-0102
  // continue escape hatch (the gate passes by design; the wording guides).
  // Wording for other reasons is unchanged.
  if (env.reason === "modelTransient") {
    return (
      "subagent failed: modelTransient — transient upstream model-stream/" +
      "transport failure, not a task verdict; the worker process is dead, so " +
      "subagent_continue with this task_id resumes the dialogue from its transcript"
    );
  }
  return env.reason === undefined
    ? "subagent failed"
    : `subagent failed: ${env.reason}`;
}

/**
 * Empty handoff, or crash / timeout / truncated terminal.
 * Host may attach a short top-level pad roster (names only).
 */
export function shouldAttachProductRoster(env: SubAgentEnvelope): boolean {
  if (env.truncated === true) return true;
  if (env.reason === "crashed" || env.reason === "timeout") return true;
  if (env.summary.length === 0 && env.result.length === 0) return true;
  return (
    env.status === "failed" &&
    env.result.length === 0 &&
    env.summary === failedSummary(env)
  );
}

function shortHandoff(
  summary: string,
  fileRefs: readonly string[] | undefined,
  stopReason: StopReason | undefined
): string {
  const sections = [summary];
  if (fileRefs !== undefined && fileRefs.length > 0) {
    sections.push(
      `Changed files:\n${fileRefs.map((fileRef) => `- ${fileRef}`).join("\n")}`
    );
  }
  if (stopReason !== undefined) {
    sections.push(`Stop reason: ${stopReason}`);
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}

/**
 * Parent-visible projection: the handoff layer shown to the parent model
 * (short summary + paths + stop reason), not the full final text.
 * `truncated` is true when the original is longer than the handoff or exceeds
 * 20000 chars (report folded, not a task failure).
 */
/**
 * Stamp locator fields onto a parent-visible envelope.
 * `tmp_root` is omitted when the caller has no pad (legacy manager).
 */
export function attachParentVisibleTmp(
  env: SubAgentEnvelope,
  loc: {
    readonly task_id: string;
    readonly tmp_root?: string;
    /**
     * Pad-relative path of the host-written final text. Absent when no file
     * was written (Postel) — never point at a file that does not exist.
     */
    readonly output_path?: string;
  }
): SubAgentEnvelope {
  return {
    ...env,
    task_id: loc.task_id,
    ...(loc.tmp_root !== undefined ? { tmp_root: loc.tmp_root } : {}),
    ...(loc.output_path !== undefined ? { output_path: loc.output_path } : {}),
  };
}

export function projectParentVisibleEnvelope(
  env: SubAgentEnvelope
): SubAgentEnvelope {
  const summary =
    env.status === "failed" &&
    env.summary.length === 0 &&
    env.reason !== "timeout"
      ? failedSummary(env)
      : shortSummary(env.summary, env.result);
  const handoff = shortHandoff(summary, env.fileRefs, env.stop_reason);
  const originalLen = env.result.length;
  const needsFoldMarker = originalLen > TRUNCATION_LIMIT;
  let result = handoff;
  if (needsFoldMarker) {
    const marker = TRUNCATION_MARKER(originalLen);
    const separator = handoff.length > 0 ? "\n\n" : "";
    const available = TRUNCATION_LIMIT - marker.length - separator.length;
    const boundedHandoff =
      handoff.length <= available
        ? handoff
        : `${handoff.slice(0, Math.max(0, available - 1))}…`;
    result = `${boundedHandoff}${separator}${marker}`;
  }
  const truncated = needsFoldMarker || originalLen > result.length;
  if (
    env.summary === summary &&
    env.result === result &&
    env.truncated === undefined &&
    env.totalLength === undefined &&
    !truncated
  ) {
    return env;
  }
  return {
    ...env,
    summary,
    result,
    ...(truncated ? { truncated: true, totalLength: originalLen } : {}),
  };
}

/**
 * IPC condensation: fold when result > 20000 so the full final text never
 * rides the cross-process envelope. Under the limit the fields are kept, so
 * graph nodes can pass upstream products along edges. The parent-model
 * handoff goes through `projectParentVisibleEnvelope`.
 */
export function truncateEnvelopeResult(
  env: SubAgentEnvelope
): SubAgentEnvelope {
  if (env.result.length <= TRUNCATION_LIMIT) {
    if (
      env.status === "failed" &&
      env.summary.length === 0 &&
      env.reason !== "timeout"
    ) {
      return { ...env, summary: failedSummary(env) };
    }
    return env;
  }
  return projectParentVisibleEnvelope(env);
}

const workerValidate = compileEnvelopeAjv(WORKER_SCHEMA);
const parentValidate = compileEnvelopeAjv(PARENT_SCHEMA);
