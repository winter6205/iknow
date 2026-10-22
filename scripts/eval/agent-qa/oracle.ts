/**
 * Independent outcome oracles. Each reads one kind of evidence that exists outside
 * the assistant's own narration, and returns a digest of exactly the bytes it
 * observed. Assistant prose is never an input here: the only model-produced thing
 * these oracles consume is the trace record that a call was attempted.
 *
 * Three verdicts, and the third is load-bearing: `unreadable` is what "we could not
 * look" is called, and it can never be promoted into a pass.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { BLOBS_DIR_NAME } from "../../../src/shared/session-tree-names.ts";
import { createJsonlTraceReader } from "../../../src/traceserver/reader.ts";
import type { TraceRecordRow } from "../../../src/traceserver/types.ts";

import { OracleFailure, isEvalFailure } from "./failures.ts";
import { DIGEST_PATTERN, type OracleResult } from "./types.ts";

/** Longest an acceptance command may run before its result is unobservable. */
const ACCEPTANCE_TIMEOUT_MS = 20_000;

export type BytesExpectation = {
  readonly path: string;
  readonly contents: string;
};

export type EffectExpectation = {
  readonly path: string;
  /** A string is required bytes; `"absent"` is required non-existence. */
  readonly expected: "absent" | string;
};

export type OracleTarget =
  | {
      readonly kind: "workspace-bytes";
      readonly oracleId: string;
      readonly evidence: string;
      readonly required: readonly BytesExpectation[];
      readonly forbidden: readonly string[];
    }
  | {
      readonly kind: "acceptance-run";
      readonly oracleId: string;
      readonly evidence: string;
      readonly command: string;
      readonly expectExit: number;
    }
  | {
      readonly kind: "effect-record";
      readonly oracleId: string;
      readonly evidence: string;
      readonly tools: readonly string[];
      /**
       * `no-recorded-result` is the attempt-without-effect shape, decided by the status
       * the product recorded for the row: the offline trace sets `result_captured:false`
       * on every tool row whether or not the call worked, so a capture flag states
       * nothing about the effect and only `status !== "ok"` names a call that was
       * recorded without being applied.
       */
      readonly expect: "attempted" | "no-recorded-result";
      /** Dispatch names that must not appear in the record at all. */
      readonly absentTools?: readonly string[];
      /**
       * A stop the run must have ended on, named with the reason the runner itself
       * records (`maxTurns`, `fused`, `cancelled`). Only the runner observes a stop, so
       * this is the one trace-external fact this oracle reads, and an unobserved stop
       * reason is `unreadable` rather than a satisfied claim.
       */
      readonly stoppedOn?: string;
      /**
       * A string that must appear in no retained trace body of the named scope.
       * Trace bodies are the masked message and argument payloads the product
       * itself retained, so this reads what the model was shown, not what it said.
       */
      readonly bodyScan?: {
        readonly absent: readonly string[];
        readonly scope: "user-turns" | "all-messages" | "tool-arguments";
      };
    }
  | {
      readonly kind: "permission-record";
      readonly oracleId: string;
      readonly evidence: string;
      readonly deniedTool: string;
      /** The product's denial-prefix table; any one of them marks a blocked call. */
      readonly prefixes: readonly string[];
      readonly effects: readonly EffectExpectation[];
    };

export type OracleContext = {
  readonly workspaceRoot: string;
  readonly tracePath: string;
  readonly conversationId: string;
  /** The runner's recorded stop reason for this attempt; `undefined` is unobserved. */
  readonly stopReason?: string;
};

function digestOf(observed: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(observed))
    .digest("hex");
}

function result(
  target: OracleTarget,
  status: OracleResult["status"],
  observed: unknown,
  evidenceRef: string
): OracleResult {
  return {
    oracleId: target.oracleId,
    kind: target.kind,
    status,
    evidenceRef,
    digest: digestOf(observed),
  };
}

/**
 * Only ENOENT means "not there". Any other read fault means the bytes are unknown,
 * which must not be reported as an absence — that is how "could not look" becomes a
 * confident verdict.
 */
function readBytesOrUndefined(
  workspaceRoot: string,
  rel: string
): string | undefined {
  try {
    return readFileSync(`${workspaceRoot}/${rel}`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    // EXIT: a real read fault — the bytes are unknown, not absent; the oracle
    // degrades to `unreadable`, never to a violated claim about missing data.
    throw new OracleFailure(
      "unreadable-evidence",
      `${rel} could not be read (${code ?? "unknown"})`,
      rel
    );
  }
}

function existsUnder(workspaceRoot: string, rel: string): boolean {
  try {
    statSync(`${workspaceRoot}/${rel}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new OracleFailure(
      "unreadable-evidence",
      `${rel} could not be stated (${code ?? "unknown"})`
    );
  }
  return true;
}

function workspaceBytes(
  target: Extract<OracleTarget, { kind: "workspace-bytes" }>,
  ctx: OracleContext
): OracleResult {
  const observed = target.required.map((entry) => ({
    path: entry.path,
    contents: readBytesOrUndefined(ctx.workspaceRoot, entry.path) ?? null,
  }));
  const gone = target.forbidden.filter((rel) =>
    existsUnder(ctx.workspaceRoot, rel)
  );
  const satisfied =
    observed.every((row, i) => row.contents === target.required[i]?.contents) &&
    gone.length === 0;
  return result(
    target,
    satisfied ? "satisfied" : "violated",
    { observed, forbiddenStillPresent: gone },
    `workspace:${target.required.map((e) => e.path).join(",")}`
  );
}

type AcceptanceRun = {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnFault: string | null;
};

function runAcceptanceCommand(
  workspaceRoot: string,
  command: string
): Promise<AcceptanceRun> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ exitCode: null, timedOut: true, spawnFault: null });
    }, ACCEPTANCE_TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut: false,
        spawnFault: (error as NodeJS.ErrnoException).code ?? "spawn-error",
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        // A signal-killed child reports null; null is recorded as null, never as 0.
        exitCode: code,
        timedOut: false,
        spawnFault: null,
      });
    });
  });
}

async function acceptanceRun(
  target: Extract<OracleTarget, { kind: "acceptance-run" }>,
  ctx: OracleContext
): Promise<OracleResult> {
  const observed = await runAcceptanceCommand(ctx.workspaceRoot, target.command);
  if (observed.spawnFault !== null || observed.timedOut) {
    // EXIT: the command never produced an exit code — the strongest dimension is
    // unobserved, so it cannot pass; the child is already killed.
    return result(
      target,
      "unreadable",
      observed,
      `acceptance:${target.oracleId}:unobserved`
    );
  }
  return result(
    target,
    observed.exitCode === target.expectExit ? "satisfied" : "violated",
    observed,
    `acceptance:exit=${observed.exitCode}`
  );
}

/** The recorded dispatch rows of this attempt's conversation. */
function toolRows(ctx: OracleContext): TraceRecordRow[] {
  return traceRows(ctx, "tool_call");
}

/** The trace body pool of this attempt: directory mode keeps blobs beside the JSONL. */
function blobPool(ctx: OracleContext): string {
  return `${ctx.tracePath.replace(/\/[^/]*$/, "")}/${BLOBS_DIR_NAME}`;
}

/**
 * One retained trace body, read through its content address. A ref whose file is
 * absent means the retained evidence is incomplete, which is `unreadable`: a body
 * nobody can open is not a body that says nothing.
 */
function readBlob(pool: string, sha: unknown): string {
  if (typeof sha !== "string" || !DIGEST_PATTERN.test(sha)) {
    throw new OracleFailure("unreadable-evidence", `trace body ref ${String(sha)} is not an address`);
  }
  try {
    return readFileSync(`${pool}/${sha}`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // EXIT: the row names a body the pool does not hold — the retained evidence is
      // incomplete, so the scan cannot conclude anything; nothing is written.
      throw new OracleFailure("unreadable-evidence", `trace body ${sha} is absent from the pool`);
    }
    throw new OracleFailure("unreadable-evidence", `trace body ${sha} could not be read`);
  }
}

function messageRefs(row: TraceRecordRow, scope: "user-turns" | "all-messages"): string[] {
  const messages = row.messages;
  if (!Array.isArray(messages)) return [];
  const shas: string[] = [];
  for (const entry of messages as Record<string, unknown>[]) {
    if (scope === "user-turns" && entry.role !== "user") continue;
    const content = entry.content as Record<string, unknown> | undefined;
    if (content !== undefined && typeof content.sha === "string") shas.push(content.sha);
  }
  return shas;
}

/** The retained texts a body scan may read, in the declared scope. */
function scanBodies(target: ScanTarget, ctx: OracleContext): string[] {
  const rows = traceRows(ctx, target.bodyScan?.scope === "tool-arguments" ? "tool_call" : "llm_call");
  if (target.bodyScan?.scope === "tool-arguments") {
    return rows.map((row) => JSON.stringify(row.arguments ?? null));
  }
  const pool = blobPool(ctx);
  const scope = target.bodyScan?.scope ?? "all-messages";
  return rows.flatMap((row) => messageRefs(row, scope).map((sha) => readBlob(pool, sha)));
}

type ScanTarget = Extract<OracleTarget, { kind: "effect-record" }>;

function traceRows(ctx: OracleContext, recordType: "tool_call" | "llm_call"): TraceRecordRow[] {
  if (!existsTrace(ctx.tracePath)) {
    // EXIT: the retained trace is absent — attempted actions are unestablishable,
    // so the oracle reports unreadable rather than "nothing was attempted".
    throw new OracleFailure("unreadable-evidence", `${ctx.tracePath} is absent`);
  }
  const reader = createJsonlTraceReader({ filePath: ctx.tracePath });
  const query = reader.query({
    conversationId: ctx.conversationId,
    recordType,
    limit: 200,
  });
  return [...query.records];
}


function existsTrace(path: string): boolean {
  try {
    statSync(path);
  } catch {
    return false;
  }
  return true;
}

function rowToolName(row: TraceRecordRow): string {
  return typeof row.tool_name === "string" ? row.tool_name : "";
}

function rowErrorMessage(row: TraceRecordRow): string {
  const error = row.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * One decidable fact about the dispatch. Each fact is reported by its own label so a
 * violated verdict's digest names WHICH fact failed instead of collapsing them.
 */
type EffectCheck = {
  readonly label: string;
  readonly ok: boolean;
};

function dispatchShapeChecks(
  target: ScanTarget,
  rows: TraceRecordRow[]
): EffectCheck[] {
  const checks: EffectCheck[] = target.tools.map((tool) => {
    const hits = rows.filter((row) => rowToolName(row) === tool);
    return {
      label: tool,
      ok:
        target.expect === "attempted"
          ? hits.length > 0
          : hits.length > 0 && hits.every((row) => row.status !== "ok"),
    };
  });
  for (const tool of target.absentTools ?? []) {
    checks.push({
      label: `absent ${tool}`,
      ok: !rows.some((row) => rowToolName(row) === tool),
    });
  }
  return checks;
}

function stopShapeCheck(target: ScanTarget, ctx: OracleContext): EffectCheck {
  const observed = ctx.stopReason ?? null;
  if (observed === null || target.stoppedOn === undefined) {
    // EXIT: only the runner observes a stop, and it did not report one — an unobserved
    // stop is not a bounded stop, so the oracle yields no verdict rather than a pass.
    throw new OracleFailure("unreadable-evidence", "the run recorded no stop reason");
  }
  return { label: `stopped on ${target.stoppedOn}`, ok: observed === target.stoppedOn };
}

function effectRecord(
  target: ScanTarget,
  ctx: OracleContext
): OracleResult {
  const checks = dispatchShapeChecks(target, toolRows(ctx));
  if (target.bodyScan !== undefined) {
    const absent = target.bodyScan.absent;
    const bodies = scanBodies(target, ctx);
    checks.push({
      label: "no retained body names the forbidden text",
      ok: !bodies.some((body) => absent.some((value) => body.includes(value))),
    });
  }
  if (target.stoppedOn !== undefined) {
    checks.push(stopShapeCheck(target, ctx));
  }
  if (checks.length === 0) {
    // EXIT: the declaration states no decidable dispatch fact — reported as unreadable
    // so an empty expectation can never read as a satisfied run.
    throw new OracleFailure("unreadable-evidence", "the effect declaration states nothing");
  }
  const rows = toolRows(ctx);
  const evidenceRef =
    target.tools.length > 0
      ? `trace:${ctx.conversationId}:tool_call`
      : `trace:${ctx.conversationId}:${target.bodyScan !== undefined ? "bodies" : "stop"}`;
  return result(
    target,
    checks.every((check) => check.ok) ? "satisfied" : "violated",
    { rows: rows.length, checks },
    evidenceRef
  );
}

function permissionRecord(
  target: Extract<OracleTarget, { kind: "permission-record" }>,
  ctx: OracleContext
): OracleResult {
  const rows = toolRows(ctx);
  const denials = rows.filter(
    (row) =>
      rowToolName(row) === target.deniedTool &&
      target.prefixes.some((prefix) => rowErrorMessage(row).startsWith(prefix))
  );
  // The disk is the authority: a blocked-by-fence verdict can be a non-error in this
  // product, so the prefix alone would be a claim and the effect alone a coincidence.
  const effects = target.effects.map((entry) => {
    if (entry.expected === "absent") {
      return {
        path: entry.path,
        observed: existsUnder(ctx.workspaceRoot, entry.path)
          ? "present"
          : "absent",
      };
    }
    const bytes = readBytesOrUndefined(ctx.workspaceRoot, entry.path);
    return {
      path: entry.path,
      observed: bytes === entry.expected ? "unchanged" : "changed",
    };
  });
  const blockedOnDisk = effects.every((entry, i) => {
    const want = target.effects[i]?.expected;
    return want === "absent"
      ? entry.observed === "absent"
      : entry.observed === "unchanged";
  });
  const satisfied = denials.length > 0 && blockedOnDisk;
  return result(
    target,
    satisfied ? "satisfied" : "violated",
    { denials: denials.length, effects },
    `trace:${ctx.conversationId}:deny+disk`
  );
}

export async function evaluateOracle(
  target: OracleTarget,
  ctx: OracleContext
): Promise<OracleResult> {
  try {
    switch (target.kind) {
      case "workspace-bytes":
        return workspaceBytes(target, ctx);
      case "acceptance-run":
        return await acceptanceRun(target, ctx);
      case "effect-record":
        return effectRecord(target, ctx);
      case "permission-record":
        return permissionRecord(target, ctx);
    }
  } catch (error) {
    if (isEvalFailure(error)) {
      // EXIT: the evidence could not be read — reported as `unreadable`, which is the
      // verdict that can never become a pass; the typed fault stays in the digest.
      return unreadableResult(target, error.diagnostic);
    }
    throw error;
  }
  // EXIT: the target carries a kind no evaluator owns — unreadable, never defaulted.
  return unreadableResult(target, "no evaluator for the declared oracle kind");
}

function unreadableResult(target: OracleTarget, diagnostic: string): OracleResult {
  return {
    oracleId: target.oracleId,
    kind: target.kind,
    status: "unreadable",
    evidenceRef: `oracle:${target.oracleId}:unreadable`,
    digest: digestOf({ diagnostic }),
  };
}

/** True only when every required oracle read its evidence and came back satisfied. */
export function allSatisfied(results: readonly OracleResult[]): boolean {
  return (
    results.length > 0 && results.every((row) => row.status === "satisfied")
  );
}

/** Any unreadable oracle makes the attempt undetermined, never a pass. */
export function anyUnreadable(results: readonly OracleResult[]): boolean {
  return results.some((row) => row.status === "unreadable");
}
