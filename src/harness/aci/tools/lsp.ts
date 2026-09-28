/**
 * LSP ACI tool set — handlers kept deliberately thin.
 *
 * Exports 9 operation tools + lsp_diagnostics = 10 tools (the spec count
 * drifted between 9 and 8 across sections; the factory exports the full
 * name list, and the registry's total-count assertion follows, per
 * ADR-0006).
 *
 * Design (stateless-MCP line of thinking):
 *   - Thin handler: input validation (same-source strict ajv compile) →
 *     await getClientDetailed(ctx, file) → when no client, return a layered
 *     sentinel string (renderNoServer) → sendRequest → JSON.stringify (capped
 *     at MAX_RESULT_BYTES with a truncated footer). The handler always
 *     returns a plain string, never structured payloads.
 *   - The three-way caches (root+id / broken / inflight) are owned by
 *     client.ts; the tool layer knows nothing about them.
 *   - Cancel / timeout both go through CancellationTokenSource → JSON-RPC
 *     `$/cancelRequest`: a per-request 20s timeout yields cleanly ahead of
 *     the executor's 30s race. This module never holds process signals.
 *   - 8 tools share POSITION_SCHEMA ({file, line, character} with 1-based
 *     line / 0-based character); lsp_document_symbol and lsp_diagnostics
 *     need only file; lsp_workspace_symbol has optional file / query.
 *
 * Factory signature: `createLspToolSet(ctx: LspCtx): ReadonlyArray<AciToolDef>`.
 *   - registry.ts calls the factory for 10 frozen tool defs and appends them
 *     to the default registry.
 *   - ctx is assembled by build-engine (`LspCtx.directory` = process.cwd()).
 *
 * Boundaries:
 *   - **Never** `process.kill`.
 *   - **Never** return structured payloads (plain strings only).
 *   - **Never** read/translate LSP payload fields (semantics belong to
 *     tsserver / typescript-language-server).
 */
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import path from "node:path";

import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { CancellationTokenSource } from "vscode-jsonrpc/node";
import type { CancellationToken } from "vscode-jsonrpc/node";

import {
  getClientDetailed,
  isMethodNotFoundError,
  serverDeclaresUnsupported,
} from "../../lsp/client.js";
import type { LspClient, LspClientFailure } from "../../lsp/client.js";
import { SERVERS } from "../../lsp/server.js";
import type { LspCtx } from "../../lsp/types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { decideRead } from "../read-policy.js";
import type { AciToolDef } from "../types.js";

/**
 * Strict-mode ajv singleton: compiles handler inputSchema, same-source as
 * the tools/registry.ts assembly-time compile (forced schema homogeneity).
 * `coerceTypes: false` (no implicit conversion) + `strict: true` (no
 * guessing missing values, matching tools/registry.ts).
 */
const lspAjv = new Ajv.default({
  strict: true,
  allErrors: true,
  coerceTypes: false,
});

/** JSON Schema shared by the 8 position operations. */
const POSITION_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    line: { type: "integer", minimum: 1 },
    character: { type: "integer", minimum: 0 },
  },
  required: ["file", "line", "character"],
  additionalProperties: false,
} as const;

/** JSON Schema requiring only file (document_symbol). */
const FILE_ONLY_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
  },
  required: ["file"],
  additionalProperties: false,
} as const;

/**
 * lsp_diagnostics schema (batch form): `file` (single) or `files` (batch,
 * 1-10) — exactly one. The mutual-exclusion check is done manually in the
 * handler (ajv cannot express exactly-one-of and per-case error text), so the
 * schema only constrains types.
 */
const DIAGNOSTICS_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    files: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 10,
    },
  },
  additionalProperties: false,
} as const;

/** Per-call cap for lsp_diagnostics batches: over the cap → ToolExecutionError. */
const DIAGNOSTICS_MAX_FILES = 10;

/**
 * lsp_workspace_symbol schema: `file` is optional (workspace-level queries
 * never needed a file anchor; the old schema required it but buildParams
 * ignored it), plus an optional `query` (the old implementation always sent
 * ""). No required fields.
 */
const WORKSPACE_SYMBOL_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    query: { type: "string" },
  },
  additionalProperties: false,
} as const;

/**
 * Per-request timeout cap: after the executor's 30s race the request would
 * still occupy the server, so a 20s in-connection timer fires first and
 * CancellationTokenSource `cancel()` automatically sends `$/cancelRequest`
 * to the server (no process kill), yielding cleanly.
 */
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 20_000;

/**
 * lsp_diagnostics read-before-wait deadline: right after ensureOpen, pushed
 * diagnostics may not have arrived, so reading diagStore immediately yields
 * empty. Poll every 100ms and continue as soon as the first diagnostics for
 * the uri arrive; on deadline use whatever exists (possibly undefined →
 * empty render).
 */
export const DIAGNOSTICS_WAIT_MS = 2_000;

/**
 * Tool output cap: large responses such as references stringified verbatim
 * can blow the context budget. Over the cap: truncate + footer (N is the
 * full byte count).
 */
export const MAX_RESULT_BYTES = 48 * 1024;

/**
 * Shared aci metadata (read-only / not concurrency-safe / cancel / 30s).
 *
 * The symbol query tool set (`symbol.ts`) reuses this exact object — both
 * tool families run through the same LSP client/cancel/timeout chain, so a
 * fork in metadata would be a fork in semantics.
 */
export const LSP_ACI_META = {
  category: "read-only" as const,
  isConcurrencySafe: false,
  interruptBehavior: "cancel" as const,
  timeoutTier: "default" as const,
};

interface PositionInput {
  readonly file: string;
  readonly line: number;
  readonly character: number;
}

interface FileOnlyInput {
  readonly file: string;
}

/** lsp_workspace_symbol input: file / query both optional. */
interface WorkspaceSymbolInput {
  readonly file?: string;
  readonly query?: string;
}

/** lsp_diagnostics input: exactly one of file / files (mutual exclusion checked in the handler). */
interface DiagnosticsInput {
  readonly file?: string;
  readonly files?: readonly string[];
}

/**
 * Sentinel rendering when no usable LSP client exists, layered by
 * failure.reason. Always a plain string:
 *   - no-server: list every supported extension (in SERVERS declaration order);
 *   - no-root: explain that no root marker for the serverId was found above
 *     the file but within ctx.directory;
 *   - spawn-failed: serverId unavailable + installHint (hint sentence omitted
 *     when the server declaration is absent).
 */
export function renderNoServer(
  ctx: LspCtx,
  failure: LspClientFailure,
  file?: string
): string {
  switch (failure.reason) {
    case "no-server": {
      const extensions = SERVERS.flatMap((s) => s.extensions).join(", ");
      return file !== undefined
        ? `(no LSP server configured for ${file}; supported extensions: ${extensions})`
        : `(no LSP server configured; supported extensions: ${extensions})`;
    }
    case "no-root":
      return `(no LSP project root found above ${file} within ${ctx.directory}; missing root marker for ${failure.serverId ?? "unknown-server"})`;
    case "spawn-failed": {
      const hint = SERVERS.find((s) => s.id === failure.serverId)?.installHint;
      const base = `(LSP server ${failure.serverId ?? "unknown-server"} unavailable`;
      return hint !== undefined ? `${base}; hint: ${hint})` : `${base})`;
    }
  }
}

/**
 * Sentinel for "the server does not implement this method". **Not** a
 * failure sentinel: a capability gap is an intrinsic property of the server
 * (yaml/json lack references, callHierarchy, etc.) and the model should just
 * use another tool. Always a plain string.
 *
 * And it is **not** a spawn failure — unlike renderNoServer's spawn-failed
 * layer, the connection and child process are alive and other methods of the
 * same kind still work, so nothing is marked broken and the client is not
 * evicted.
 */
export function renderMethodNotFound(
  method: string,
  serverId?: string
): string {
  const who = serverId !== undefined ? ` ${serverId}` : "";
  return `(LSP server${who} does not implement ${method}; use another tool for this query)`;
}

/**
 * Layered sentinel for queries with no project anchor (wording basis:
 * `docs/guides/lsp-client-analysis.md`).
 *
 * The search set of `workspace/symbol` is determined by the project graph
 * the server last loaded, and that graph is determined by the last file it
 * touched (measured on tsserver: an anchor outside the tsconfig `include`
 * builds only an inferred project containing that file + its import
 * closure). A caller without `file` gets no anchor, so an empty result can
 * mean either "the symbol really doesn't exist" or "the query path has no
 * project context" — the latter measured 40s of all-`[]` in production
 * shape.
 *
 * Deliberately **not** in the `isLspFailureSentinel` family: the three
 * failure prefixes mean "this call did not go through", while this call did
 * (the RPC answered). Recording FAIL would be a misclassification, and the
 * probe never enters this branch. The consumer is the model — it needs
 * "conclusion untrustworthy, take another route", not "LSP is broken".
 */
/**
 * Takes `ctx: LspCtx` by family convention (same form as `renderNoServer`)
 * although it only reads `ctx.directory` — the sentinel text needs just the
 * directory interpolation, and a uniform signature spares callers
 * (`symbol.ts` `find_symbol` handler) from unpacking ctx for one field.
 */
export function renderNoProjectAnchor(ctx: LspCtx): string {
  return `(LSP workspace/symbol has no project anchor under ${ctx.directory}; an empty result from this path is not trustworthy — pass file=<a file inside the project to search> or use get_symbols_overview on a known file)`;
}

/**
 * Protected-path sentinel for the symbol/LSP family (specs/host-read-policy.md
 * SC4): the canonical read policy refused the document open because the path
 * is on the protected roster. Same rendering style as `renderNoServer` — a
 * readable string on the `T | string` channel, never a thrown
 * `ToolExecutionError` — but its own string with its own meaning: distinct
 * from the no-server / no-root / spawn-failed tiers and from the
 * no-project-anchor sentinel, whose meanings stay unchanged.
 */
export function renderProtectedPathDenial(file: string, why: string): string {
  return `(read denied for ${file}: protected-path rule — ${why}; the language server was never asked to open this document)`;
}

/**
 * Resolution-failure sentinel for the same seam (SC10 / SC13): the path could
 * not be decided (empty, unusable, dangling, looping), so fail-closed refuses
 * the open. Named and distinct from the protected-path denial and from every
 * no-server tier — never thrown, never an untyped crash out of the handler.
 */
export function renderResolutionFailureDenial(
  file: string,
  why: string
): string {
  return `(read denied for ${file}: resolution failure — ${why}; an undecidable path is never opened by the language server)`;
}

/**
 * Canonical read-policy verdict for the language server's direct file
 * opening: call before `client.withDocumentOpen` (the `didOpen` is where the
 * on-disk bytes enter the server) and return the verdict string verbatim.
 * `null` means allow — the open proceeds exactly as before.
 *
 * Per-call pure evaluation: the policy owns no cross-call state, so N
 * concurrent callers against one shared refcounted client get independent
 * verdicts, and a verdict cannot depend on another call for the same file
 * being in flight. The fs mode is not consulted because both modes are
 * broadly readable host views (ADR-0092) with the same protected-path roster
 * answer; the identity roots come from the live task root (rebind-aware cell
 * first, same vintage discipline as the pool key) and the process home.
 */
export async function documentOpenDenial(
  ctx: LspCtx,
  file: string
): Promise<string | null> {
  const taskRoot = ctx.directoryCell?.read() ?? ctx.directory;
  const verdict = await decideRead(file, { taskRoot, homeRoot: homedir() });
  if (verdict.outcome === "allow") return null;
  return verdict.reason === "protected_path"
    ? renderProtectedPathDenial(file, verdict.message)
    : renderResolutionFailureDenial(file, verdict.message);
}

/**
 * Whether an RPC error is tsserver's `No Project.` (`ThrowNoProject` in
 * typescript.js) — thrown by `workspace/symbol` navto when the anchor file
 * belongs to no project. Measured shape is a vscode-jsonrpc ResponseError
 * whose message is `<syntax> TypeScript Server Error (<version>)\nNo
 * Project.\n<tsserver stack>`.
 *
 * Match on the message substring only: measured `name` is the generic
 * `"Error"` and `code` is `1`, both of which collide with business errors
 * and cannot serve as criteria. The narrowness is deliberate — only this
 * exact shape is rescued into `renderNoProjectAnchor`; all other RPC errors
 * rethrow as before.
 */
export function isNoProjectAnchorError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.includes("No Project.");
}

/** Method-not-found sentinel check (probes treat it as skip, not FAIL). */
export function isMethodNotFoundSentinel(result: unknown): boolean {
  return (
    typeof result === "string" &&
    result.startsWith("(LSP server") &&
    result.includes(" does not implement ")
  );
}

/**
 * Shared by probes and the tool layer: does this layered sentinel mean the
 * LSP call failed? The no-server / no-root / spawn-failed message prefixes
 * all count as FAIL. Successful hover JSON, diagnostics XML, empty strings
 * do not; the method-not-found sentinel deliberately does NOT (see above).
 */
export function isLspFailureSentinel(result: unknown): result is string {
  if (typeof result !== "string" || result.length === 0) return false;
  if (isMethodNotFoundSentinel(result)) return false;
  if (result.startsWith("(no LSP server configured")) return true;
  if (result.startsWith("(no LSP project root found")) return true;
  return result.startsWith("(LSP server ") && result.includes(" unavailable");
}

/**
 * Normalize any LSP response into a plain string (the contract: never hand
 * structured payloads to the model), capped at MAX_RESULT_BYTES by truncating
 * the stringified result; N in the footer is the full byte count.
 */
export function stringifyResult(result: unknown): string {
  let text: string;
  if (result === undefined) text = "";
  else if (result === null) text = "null";
  else if (typeof result === "string") text = result;
  else {
    try {
      text = JSON.stringify(result, null, 2);
    } catch (_err) {
      text = String(result);
    }
  }
  return capResult(text);
}

/** Output cap: rewind char-by-char so the cut never lands inside a multi-byte character, plus a truncated footer. */
function capResult(text: string): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= MAX_RESULT_BYTES) return text;
  // Start guess: UTF-8 byte length >= char length, so cutting at
  // MAX_RESULT_BYTES chars can only overshoot because of multi-byte chars;
  // rewind one char at a time until within budget (only entered above 48KB,
  // so the rewind steps are bounded).
  let cut = MAX_RESULT_BYTES;
  while (
    cut > 0 &&
    Buffer.byteLength(text.slice(0, cut), "utf8") > MAX_RESULT_BYTES
  ) {
    cut--;
  }
  const shown = text.slice(0, cut);
  const shownBytes = Buffer.byteLength(shown, "utf8");
  return `${shown}\n...[truncated, ${shownBytes} of ${total} bytes shown]`;
}

/** Compile a schema into an ajv validator and build the throwing parse around it. */
export function compileValidator(
  schema: Record<string, unknown>,
  toolName: string
): (input: unknown) => unknown {
  let validate: ValidateFunction;
  try {
    validate = lspAjv.compile(schema);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolExecutionError(
      `[${toolName}] validator compile failed: ${msg}`
    );
  }
  return (input: unknown): unknown => {
    if (!validate(input)) {
      const detail = validate.errors
        ? validate.errors
            .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`)
            .join("; ")
        : "input validation failed";
      throw new ToolExecutionError(`[${toolName}] invalid input: ${detail}`);
    }
    return input;
  };
}

/** Position operations → textDocument/position params (convert 1-based line to 0-based). */
function positionParams(
  file: string,
  line: number,
  character: number
): {
  readonly textDocument: { readonly uri: string };
  readonly position: { readonly line: number; readonly character: number };
} {
  return {
    textDocument: { uri: pathToFileURL(file).href },
    position: { line: line - 1, character },
  };
}

/** document_symbol params: textDocument only, no position. */
function documentSymbolParams(file: string): unknown {
  return { textDocument: { uri: pathToFileURL(file).href } };
}

/** workspace/symbol params: optional query (empty string = full symbol snapshot). */
function workspaceSymbolParams(query?: string): unknown {
  return { query: query ?? "" };
}

/** references params: position plus includeDeclaration context. */
function referencesParams(
  file: string,
  line: number,
  character: number
): unknown {
  return {
    ...positionParams(file, line, character),
    context: { includeDeclaration: true },
  };
}

interface OperationSpec {
  readonly name: string;
  readonly method: string;
  readonly schema: Record<string, unknown>;
  /** Per-operation description — each of the 7 positionOps gets its
   *  own sentence instead of sharing a generic template, so the model prompt
   *  sees positive-trigger phrasing tuned to the operation. */
  readonly description: string;
  /** Map the ajv-validated input onto LSP request params. */
  readonly buildParams: (
    input: PositionInput | FileOnlyInput | WorkspaceSymbolInput
  ) => unknown;
}

/**
 * Send one LSP request, translating "server does not implement this method"
 * (`-32601`) into the method-not-found sentinel: not a spawn failure and no
 * throw — a capability gap is intrinsic to the server, and the model should
 * simply pick another tool. All other errors propagate unchanged (including
 * timeouts, which callers route via `cancel.timedOut()`).
 */
export async function requestOrMethodNotFoundSentinel(
  client: LspClient,
  method: string,
  params: unknown,
  token: CancellationToken,
  serverId?: string
): Promise<unknown> {
  // If initialize explicitly declared `provider: false`, the method is
  // definitely absent — don't send. A missing declaration does NOT count
  // (absent != unsupported; see client.ts serverDeclaresUnsupported).
  if (serverDeclaresUnsupported(client.getServerCapabilities(), method)) {
    return renderMethodNotFound(method, serverId);
  }
  try {
    return await client.sendRequest(method, params, token);
  } catch (err) {
    if (isMethodNotFoundError(err))
      return renderMethodNotFound(method, serverId);
    throw err;
  }
}

/**
 * Per-request cancellation/timeout control:
 *   - **Timeout**: a timer calls `source.cancel()` after `timeoutMs`
 *     (ctx.requestTimeoutMs, default DEFAULT_LSP_REQUEST_TIMEOUT_MS).
 *     When the token is cancelled, vscode-jsonrpc automatically sends
 *     `$/cancelRequest` to the server, and the pending request rejects —
 *     the process is never killed, so the server can abort its computation
 *     and keep serving later requests.
 *   - **Abort bridge**: an AbortSignal passed through from the executor
 *     also calls `source.cancel()`.
 *
 * `timedOut()` lets callers tell "timeout" apart from "abort / business
 * error": a timeout must be translated into a ToolExecutionError (readable
 * by the model), other errors propagate unchanged. dispose clears the timer
 * and removes the abort listener.
 */
export function createRequestCancellation(
  execCtx: ToolExecutionContext | undefined,
  timeoutMs: number
): {
  readonly token: CancellationToken;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const source = new CancellationTokenSource();
  let timedOutFlag = false;
  const timer = setTimeout(() => {
    timedOutFlag = true;
    source.cancel();
  }, timeoutMs);
  const signal = execCtx?.signal;
  const onAbort = (): void => {
    source.cancel();
  };
  if (signal?.aborted) {
    source.cancel();
  } else if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    token: source.token,
    timedOut: () => timedOutFlag,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Uniform timeout error message (model-readable; names the method and the effective seconds). */
export function timeoutError(
  toolName: string,
  method: string,
  timeoutMs: number
): ToolExecutionError {
  return new ToolExecutionError(
    `[${toolName}] LSP request ${method} timed out after ${timeoutMs / 1000}s (cancelled)`
  );
}

/**
 * Client resolution for workspace-level queries (file omitted): with no file
 * anchor to drive resolveServer dispatch, probe servers in SERVERS
 * declaration order — take each server's first extension to build a fake
 * path under `ctx.directory`, run the full NearestRoot/spawn chain via
 * getClientDetailed, and return the first usable client. If all fail,
 * return the last failure reason (the handler renders it as a layered
 * sentinel string).
 */
export async function getClientForWorkspaceDetailed(
  ctx: LspCtx
): Promise<{ client?: LspClient; failure?: LspClientFailure }> {
  let lastFailure: LspClientFailure = { reason: "no-server" };
  for (const server of SERVERS) {
    const ext = server.extensions[0];
    const sample = path.join(ctx.directory, `iknow-workspace${ext}`);
    const res = await getClientDetailed(ctx, sample, { server });
    if (res.client) return { client: res.client };
    if (res.failure) lastFailure = res.failure;
  }
  return { failure: lastFailure };
}

/**
 * Factory for the standard operations: a single LSP request, input →
 * sendRequest → stringify.
 *
 * lsp_incoming_calls / lsp_outgoing_calls use `makeCallHierarchyCallTool`
 * (multi-step: prepareCallHierarchy first, then forward); lsp_diagnostics
 * has its own factory (filter + cap + Markdown render). This factory covers
 * the 7 single-step position ops plus document_symbol and workspace_symbol.
 */
function makeOperationTool(ctx: LspCtx, spec: OperationSpec): AciToolDef {
  const validate = compileValidator(spec.schema, spec.name);
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.schema,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as
        PositionInput | FileOnlyInput | WorkspaceSymbolInput;
      // No file (lsp_workspace_symbol only) → workspace-level query, probing
      // servers in SERVERS order; with a file, original dispatch semantics.
      const { client, failure } =
        params.file !== undefined
          ? await getClientDetailed(ctx, params.file)
          : await getClientForWorkspaceDetailed(ctx);
      if (!client) {
        return renderNoServer(
          ctx,
          failure ?? { reason: "no-server" },
          params.file
        );
      }
      // The read policy is consulted before the request-scoped open: a
      // protected or undecidable file never enters withDocumentOpen, so no
      // didOpen carries its bytes; the denial rides this family's
      // T | string channel as a sentinel.
      if (params.file !== undefined) {
        const denial = await documentOpenDenial(ctx, params.file);
        if (denial !== null) return denial;
      }
      // tsserver builds no project for files it hasn't opened → symbol ops
      // return empty. A request-scoped window wraps didOpen around the whole
      // request (open on entry, close on exit, including throw paths).
      // Workspace-level queries with no file have nothing to open; skip.
      // interruptBehavior="cancel" + per-request timeout: everything goes
      // through the CancellationTokenSource bridge, so abort and timeout both
      // issue `$/cancelRequest` and never kill tsserver. The limit comes from
      // ctx.requestTimeoutMs (default 20s).
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      const run = async (): Promise<unknown> => {
        try {
          // Method not found (-32601) → sentinel string (capability gap, not
          // a failure); timeout → translated below.
          return await requestOrMethodNotFoundSentinel(
            client,
            spec.method,
            spec.buildParams(params),
            cancel.token
          );
        } catch (err) {
          // Timeout path: the token cancel already made sendRequest reject
          // (RequestCancelled); translate into a model-readable
          // ToolExecutionError. Abort / business errors propagate unchanged.
          if (cancel.timedOut())
            throw timeoutError(spec.name, spec.method, timeoutMs);
          throw err;
        } finally {
          cancel.dispose();
        }
      };
      const result =
        params.file !== undefined
          ? await client.withDocumentOpen(params.file, run)
          : await run();
      return stringifyResult(result);
    },
  });
}

/**
 * Multi-step handling for callHierarchy/incomingCalls and outgoingCalls:
 * first prepare the hierarchy item (textDocument/prepareCallHierarchy), take
 * the first item, then forward it to incomingCalls / outgoingCalls.
 *
 * Input still uses POSITION_SCHEMA (1-based line / 0-based character); the
 * handler performs two RPCs internally, and with no client it likewise
 * returns a layered sentinel string (renderNoServer).
 */
function makeCallHierarchyCallTool(
  ctx: LspCtx,
  name: string,
  method: string,
  description: string
): AciToolDef {
  const validate = compileValidator(POSITION_SCHEMA, name);
  return Object.freeze({
    name,
    description,
    inputSchema: POSITION_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as PositionInput;
      const { client, failure } = await getClientDetailed(ctx, params.file);
      if (!client) {
        return renderNoServer(
          ctx,
          failure ?? { reason: "no-server" },
          params.file
        );
      }
      const denial = await documentOpenDenial(ctx, params.file);
      if (denial !== null) return denial;
      // Same as makeOperationTool: the request-scoped window covers both
      // prepare + forward (didOpen spans the whole request, closed on exit).
      // Per-request timeout + abort bridge, same as makeOperationTool.
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      let timedOutMethod = "textDocument/prepareCallHierarchy";
      try {
        return await client.withDocumentOpen(params.file, async () => {
          const prepared = await requestOrMethodNotFoundSentinel(
            client,
            "textDocument/prepareCallHierarchy",
            positionParams(params.file, params.line, params.character),
            cancel.token
          );
          if (cancel.timedOut()) {
            throw timeoutError(name, timedOutMethod, timeoutMs);
          }
          // Method-not-found sentinel: the server has no call hierarchy —
          // pass it through directly (no forward).
          if (isMethodNotFoundSentinel(prepared)) return prepared;
          const items = extractCallHierarchyItems(prepared);
          const item = items[0];
          if (!item) return stringifyResult([]);
          timedOutMethod = method;
          const result = await requestOrMethodNotFoundSentinel(
            client,
            method,
            { item },
            cancel.token
          );
          if (cancel.timedOut())
            throw timeoutError(name, timedOutMethod, timeoutMs);
          // stringifyResult passes strings through unchanged (sentinels and
          // normal string responses take the same path).
          return stringifyResult(result);
        });
      } catch (err) {
        if (cancel.timedOut()) {
          throw timeoutError(name, timedOutMethod, timeoutMs);
        }
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/**
 * Normalize the two LSP response shapes — a plain array, or an object
 * wrapping `{items}` (tsserver's prepareCallHierarchy returns either;
 * diagnostics pushes are arrays). Failure / non-object yields an empty
 * array. Shared normalizer to avoid duplication.
 */
function unwrapItems(raw: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const candidate = (raw as { items?: unknown }).items;
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/** Normalize tsserver's prepareCallHierarchy response shape: extract the items array. */
export function extractCallHierarchyItems(
  prepared: unknown
): ReadonlyArray<unknown> {
  return unwrapItems(prepared);
}

/**
 * lsp_diagnostics tool: reads file-level push diagnostics (tsserver sends
 * `textDocument/publishDiagnostics` notifications; client.ts subscribes and
 * accumulates latest-wins). Severity filter (ignore severity=0 hint; keep
 * 1=error / 2=warning / 3=information / 4=deprecated) plus a 20-per-file cap
 * in summary form.
 *
 * **Batch**: `file` (single) and `files` (1-10) are mutually exclusive,
 * checked manually in the handler (ajv cannot express exactly-one-of); more
 * than DIAGNOSTICS_MAX_FILES entries raise ToolExecutionError. Batch output
 * is one `<diagnostics file=...>` section per file, separated by blank
 * lines; the single-file path behaves exactly as before.
 *
 * **Wait-before-read (convergence upgrade)**: right after ensureOpen the
 * pushed diagnostics may not have arrived yet, and reading diagStore
 * immediately yields undefined → false "clean". Poll the diagnostic entry
 * every 100ms:
 *   - edited file (openVersion >= 2) → wait for entry.pushVersion >=
 *     openVersion (must see the post-edit diagnostics); on deadline use what
 *     is there;
 *   - never edited → wait for the first push (entry present → proceed) or
 *     the deadline;
 *   - execCtx?.signal aborted → stop waiting immediately.
 * The deadline comes from ctx.diagnosticsWaitMs (default DIAGNOSTICS_WAIT_MS
 * = 2s).
 *
 * Output: plain string only (never structured payloads).
 *
 * **name parameter**: the symbol-query surface reuses the same handler
 * semantics exposed as `get_diagnostics_for_file` (diagnostics are already
 * asked per file; there is no symbol identity to speak of). Default
 * `"lsp_diagnostics"` → the old tool behaves byte-identically.
 */
export function makeDiagnosticsTool(
  ctx: LspCtx,
  description: string,
  name = "lsp_diagnostics"
): AciToolDef {
  const validate = compileValidator(DIAGNOSTICS_SCHEMA, name);
  return Object.freeze({
    name,
    description,
    inputSchema: DIAGNOSTICS_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as DiagnosticsInput;
      // Mutual exclusion: exactly one of file / files (xor). Neither or both
      // → error.
      if ((params.file !== undefined) === (params.files !== undefined)) {
        throw new ToolExecutionError(
          `[${name}] provide exactly one of \`file\` or \`files\``
        );
      }
      // Batch cap: more than DIAGNOSTICS_MAX_FILES → error (minItems=1 is
      // handled by the schema).
      if (
        params.files !== undefined &&
        params.files.length > DIAGNOSTICS_MAX_FILES
      ) {
        throw new ToolExecutionError(
          `[${name}] files accepts at most ${DIAGNOSTICS_MAX_FILES} entries; got ${params.files.length}`
        );
      }
      const targets: readonly string[] =
        params.file !== undefined ? [params.file] : (params.files ?? []);
      const segments: string[] = [];
      for (const file of targets) {
        segments.push(await diagnosticsSegment(ctx, file, execCtx));
      }
      // The single-file path is shaped exactly like the old round (one
      // segment, no separator); batch segments join with a blank line.
      return segments.join("\n\n");
    },
  });
}

/**
 * One diagnostics round for one file: server lookup, the ADR-0128 read-policy
 * gate on the document open, then the request-scoped open + wait + read
 * window. Every outcome — no-server rendering, policy denial rendering, or
 * the rendered diagnostics — returns as a segment string; the loop in the
 * handler is pure accumulation.
 */
async function diagnosticsSegment(
  ctx: LspCtx,
  file: string,
  execCtx?: ToolExecutionContext
): Promise<string> {
  const { client, failure } = await getClientDetailed(ctx, file);
  if (!client) {
    return renderNoServer(ctx, failure ?? { reason: "no-server" }, file);
  }
  const denial = await documentOpenDenial(ctx, file);
  if (denial !== null) {
    return denial;
  }
  // Push diagnostics only arrive while the file is open, so the whole
  // "open + wait + read" must live inside one request-scoped window —
  // otherwise didClose drops the diagnostic cache first, and
  // getDiagnosticsEntry forever returns undefined, rendering an empty
  // tag.
  const uri = pathToFileURL(file).href;
  const items = await client.withDocumentOpen(file, () =>
    waitForDiagnostics(
      client,
      uri,
      ctx.diagnosticsWaitMs ?? DIAGNOSTICS_WAIT_MS,
      execCtx?.signal
    )
  );
  return renderDiagnostics(file, items ?? []);
}

/**
 * After ensureOpen, wait for diagnostics for this uri to arrive:
 *   - first check already satisfies the wait condition → return immediately
 *     (never enter the timer);
 *   - poll `client.getDiagnosticsEntry(uri)` every 100ms;
 *   - edited → wait until entry.pushVersion >= openVersion;
 *   - not edited → wait for the first entry;
 *   - waitMs deadline / signal abort → return whatever is there.
 *
 * Returning undefined means no qualifying diagnostic entry arrived before the
 * deadline.
 */
function diagnosticsWereEdited(
  openVersion: number | undefined,
  initialEntry: { readonly pushVersion?: number } | undefined
): boolean {
  if (openVersion === undefined) return false;
  if (openVersion >= 2) return true;
  return (
    initialEntry !== undefined &&
    initialEntry.pushVersion !== undefined &&
    initialEntry.pushVersion >= openVersion
  );
}

function diagnosticsCaughtUp(
  entry: { readonly pushVersion?: number } | undefined,
  openVersion: number
): boolean {
  return (
    entry !== undefined &&
    entry.pushVersion !== undefined &&
    entry.pushVersion >= openVersion
  );
}

async function waitForDiagnostics(
  client: LspClient,
  uri: string,
  waitMs: number,
  signal?: AbortSignal
): Promise<ReadonlyArray<unknown> | undefined> {
  const openVersion = client.getOpenVersion(uri);
  const edited = diagnosticsWereEdited(
    openVersion,
    client.getDiagnosticsEntry(uri)
  );
  const deadline = Date.now() + waitMs;
  for (;;) {
    const entry = client.getDiagnosticsEntry(uri);
    if (
      edited &&
      openVersion !== undefined &&
      diagnosticsCaughtUp(entry, openVersion)
    ) {
      return entry?.items;
    }
    if (!edited && entry !== undefined) {
      return entry.items;
    }
    if (signal?.aborted) return entry?.items;
    if (Date.now() >= deadline) return entry?.items;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Normalize + filter + cap diagnostics into a plain-string summary. */
function renderDiagnostics(file: string, raw: unknown): string {
  const items = unwrapItems(raw);
  const filtered = items.filter((d) => {
    if (!d || typeof d !== "object") return false;
    const severity = (d as { severity?: unknown }).severity;
    // Missing severity is treated as 1=error; severity=0 (Hint) is filtered.
    return typeof severity === "number" ? severity >= 1 : true;
  });
  const cap = 20;
  const truncated = filtered.length > cap;
  const shown = truncated ? filtered.slice(0, cap) : filtered;
  const header = `<diagnostics file="${file}">`;
  const lines = shown.map((d) => formatOne(d));
  const footer = truncated
    ? `\n...(${filtered.length - cap} more issue(s) truncated, total ${filtered.length})`
    : "";
  return `${header}\n${lines.join("\n")}${footer}\n</diagnostics>`;
}

function formatOne(d: unknown): string {
  if (!d || typeof d !== "object") return String(d);
  const diag = d as {
    severity?: number;
    range?: { start?: { line?: number; character?: number } };
    message?: unknown;
    source?: unknown;
    code?: unknown;
  };
  const start = diag.range?.start;
  const line = typeof start?.line === "number" ? start.line + 1 : "?";
  const col = typeof start?.character === "number" ? start.character : "?";
  const sev = severityLabel(diag.severity);
  const msg = typeof diag.message === "string" ? diag.message : "";
  const code = diag.code !== undefined ? ` [${String(diag.code)}]` : "";
  return `${sev} ${line}:${col}${code} ${msg}`.trimEnd();
}

function severityLabel(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "deprecated";
    default:
      return "diag";
  }
}

/**
 * Build the LSP tool set (the entry point registry.ts calls).
 *
 * Return order matches "9 operations + lsp_diagnostics":
 *   1. lsp_definition
 *   2. lsp_references
 *   3. lsp_hover
 *   4. lsp_document_symbol
 *   5. lsp_workspace_symbol
 *   6. lsp_go_to_implementation
 *   7. lsp_prepare_call_hierarchy
 *   8. lsp_incoming_calls
 *   9. lsp_outgoing_calls
 *  10. lsp_diagnostics
 *
 * **Count note**: some spec text says "9 ACI tools appended (11 → 20)" while
 * the enumerated operation names list 9 operations + lsp_diagnostics. This
 * factory exports the full set of 10 (9 operations + lsp_diagnostics), so
 * after appending the total is 21 (11 + 10), not 20; registry.ts assembly
 * expects `ACI_TOOLSET_NAMES.length === 21`.
 */
export function createLspToolSet(ctx: LspCtx): ReadonlyArray<AciToolDef> {
  const positionOps: ReadonlyArray<OperationSpec> = [
    {
      name: "lsp_definition",
      method: "textDocument/definition",
      schema: POSITION_SCHEMA,
      description:
        "Resolve the symbol at a 1-based line, 0-based character position to its declaration; pair with lsp_references to also see usages of the same symbol. Returns the LSP response as a JSON string.",
      buildParams: (input) =>
        positionParams(
          (input as PositionInput).file,
          (input as PositionInput).line,
          (input as PositionInput).character
        ),
    },
    {
      name: "lsp_references",
      method: "textDocument/references",
      schema: POSITION_SCHEMA,
      description:
        "List every reference (across the project) to the symbol at a 1-based line, 0-based character position; the declaration is included when present. Pair with lsp_definition to find where the symbol is declared. Returns the LSP response as a JSON string.",
      buildParams: (input) => {
        const p = input as PositionInput;
        return referencesParams(p.file, p.line, p.character);
      },
    },
    {
      name: "lsp_hover",
      method: "textDocument/hover",
      schema: POSITION_SCHEMA,
      description:
        "Get the type / signature / doc comment at a 1-based line, 0-based character position; pair with lsp_definition to jump to the declaration. Returns the LSP response as a JSON string.",
      buildParams: (input) => {
        const p = input as PositionInput;
        return positionParams(p.file, p.line, p.character);
      },
    },
    {
      name: "lsp_document_symbol",
      method: "textDocument/documentSymbol",
      schema: FILE_ONLY_SCHEMA,
      description:
        "List all symbols in a single file (functions, classes, variables, …) by file path; pair with lsp_workspace_symbol to find symbols across the whole project when the file is unknown. Returns the LSP response as a JSON string.",
      buildParams: (input) =>
        documentSymbolParams((input as FileOnlyInput).file),
    },
    {
      name: "lsp_workspace_symbol",
      method: "workspace/symbol",
      schema: WORKSPACE_SYMBOL_SCHEMA,
      description:
        "Search symbols across the whole workspace by an optional query string (empty or omitted query = the full workspace/symbol snapshot). The file parameter is optional — omit it for a pure workspace-level query, or pass a file to anchor server selection to that file's project. Returns the LSP response as a JSON string.",
      buildParams: (input) =>
        workspaceSymbolParams((input as WorkspaceSymbolInput).query),
    },
    {
      name: "lsp_go_to_implementation",
      method: "textDocument/implementation",
      schema: POSITION_SCHEMA,
      description:
        "Resolve interface / abstract-method call sites at a 1-based line, 0-based character position to concrete implementations; pair with lsp_references for the full usage set. Returns the LSP response as a JSON string.",
      buildParams: (input) => {
        const p = input as PositionInput;
        return positionParams(p.file, p.line, p.character);
      },
    },
    {
      name: "lsp_prepare_call_hierarchy",
      method: "textDocument/prepareCallHierarchy",
      schema: POSITION_SCHEMA,
      description:
        "Resolve a function / method at a 1-based line, 0-based character position to a call-hierarchy item; pair with lsp_incoming_calls / lsp_outgoing_calls for callers / callees of the resolved item. Returns the LSP response (a list of items) as a JSON string.",
      buildParams: (input) => {
        const p = input as PositionInput;
        return positionParams(p.file, p.line, p.character);
      },
    },
  ];

  const tools: AciToolDef[] = positionOps.map((spec) =>
    makeOperationTool(ctx, spec)
  );
  tools.push(
    makeCallHierarchyCallTool(
      ctx,
      "lsp_incoming_calls",
      "callHierarchy/incomingCalls",
      "List functions / methods that call the function at a 1-based line, 0-based character position (multi-step: prepareCallHierarchy first, then incomingCalls on the first item). Pair with lsp_outgoing_calls for the reverse direction. Returns the LSP response as a JSON string."
    )
  );
  tools.push(
    makeCallHierarchyCallTool(
      ctx,
      "lsp_outgoing_calls",
      "callHierarchy/outgoingCalls",
      "List functions / methods called by the function at a 1-based line, 0-based character position (multi-step: prepareCallHierarchy first, then outgoingCalls on the first item). Pair with lsp_incoming_calls for the reverse direction. Returns the LSP response as a JSON string."
    )
  );
  tools.push(
    makeDiagnosticsTool(
      ctx,
      "Read the latest push diagnostics for one file (`file`) or up to 10 files at once (`files`, mutually exclusive with `file`; textDocument/publishDiagnostics, latest-wins) — useful before running builds / tests to see in-editor errors. After a recent edit, waits for the server to re-push diagnostics based on the new content (up to the configured deadline, default 2s), then renders whatever is available. Filters severity 0 (Hint); caps at 20 entries per file, appending an `...(N more issue(s) truncated, total M)` footer when over the cap. Returns one plain-text `<diagnostics file=...>` segment per file (blank line between segments). Pair with read_file offset/limit on the lines referenced in the entries."
    )
  );
  return Object.freeze(tools);
}
