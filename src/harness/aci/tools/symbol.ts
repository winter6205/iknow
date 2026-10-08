/**
 * Symbol-query ACI tool set — ten model-facing query tools addressed by
 * symbol identity.
 *
 * **Relation to `lsp.ts`**: the ten `lsp_*` tools there are addressed by
 * "file + line + column", so the model must first grep down to a line; this
 * module asks by **symbol identity** (`{ file, symbol_path }`) and keeps the
 * line/column decoding inside `symbol-resolver.ts`. While both tool families
 * coexist on the model surface, LSP client resolution, cancellation/timeout,
 * the no-server sentinel and output capping are all reused from `lsp.ts` —
 * one pipeline can only carry one semantics (SSOT); a copy would drift.
 *
 * Boundaries (inherited from `lsp.ts`):
 *   - **never** `process.kill`; interruption goes via `$/cancelRequest`.
 *   - **never** return a structured payload — handlers always return strings.
 *   - **never** translate LSP payload fields (that semantics belongs to the
 *     language server).
 *   - A failed symbol resolution (missing / ambiguous / malformed node) is a
 *     **query result**, rendered as a readable string; only protocol or
 *     timeout faults throw `ToolExecutionError`.
 */
import { pathToFileURL } from "node:url";

import type { CancellationToken } from "vscode-jsonrpc/node";
import * as z from "zod/v4";

import { getClientDetailed } from "../../lsp/client.js";
import type { LspClient } from "../../lsp/client.js";
import type { LspCtx } from "../../lsp/types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import type { AciToolDef } from "../types.js";
import {
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  LSP_ACI_META,
  compileValidator,
  createRequestCancellation,
  documentOpenDenial,
  extractCallHierarchyItems,
  getClientForWorkspaceDetailed,
  isMethodNotFoundSentinel,
  isNoProjectAnchorError,
  makeDiagnosticsTool,
  renderMethodNotFound,
  renderNoProjectAnchor,
  renderNoServer,
  requestOrMethodNotFoundSentinel,
  activeRootEntry,
  type ActiveRootEntry,
  stringifyResult,
  timeoutError,
} from "./lsp.js";
import {
  resolveSymbolPosition,
  type LspPosition,
  type SymbolResolution,
} from "./symbol-resolver.js";

/**
 * Symbol-identity input: a relative/absolute file path plus the symbol's path
 * inside that file's symbol tree. No `line` / `character` — that is the
 * fundamental difference from the `lsp_*` family, and the schema's
 * `additionalProperties: false` makes "just add a line/column" fail validation.
 */
const SYMBOL_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", minLength: 1 },
    symbol_path: { type: "string", minLength: 1, maxLength: 512 },
  },
  required: ["file", "symbol_path"],
  additionalProperties: false,
} as const;

/** Single-file outline: only the file path (the outline itself is the entry
 * point for "we don't know the symbol name yet"). */
const FILE_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", minLength: 1 },
  },
  required: ["file"],
  additionalProperties: false,
} as const;

/**
 * `find_symbol` input: `query` is **required and non-empty** — a blank-query
 * `workspace/symbol` snapshot is no longer the product semantics for a
 * workspace lookup. `file` is optional and only anchors language-server
 * selection to that file's project.
 */
const FIND_SYMBOL_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 512 },
    file: { type: "string", minLength: 1 },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

interface SymbolInput {
  readonly file: string;
  readonly symbol_path: string;
}

interface FileInput {
  readonly file: string;
}

interface FindSymbolInput {
  readonly query: string;
  readonly file?: string;
}

/** Symbol identity → `textDocument/*` params (position is already 0-based). */
function symbolPositionParams(
  file: string,
  position: LspPosition
): {
  readonly textDocument: { readonly uri: string };
  readonly position: LspPosition;
} {
  return { textDocument: { uri: pathToFileURL(file).href }, position };
}

/**
 * A failed symbol resolution → a model-readable string (handlers never
 * return structured payloads). Every rendering carries an actionable next
 * step: candidate paths / disambiguation hint / outline tool name.
 *
 * `method_not_found` reuses `lsp.ts`'s sentinel rendering (SSOT — no copied
 * message literals): the missing-method semantics of the symbol family is
 * word-for-word identical to the coordinate family, so the probe's skip
 * detection recognizes it.
 */
function renderResolution(
  file: string,
  symbolPath: string,
  res: SymbolResolution
): string {
  const candidates = (list: ReadonlyArray<string>): string =>
    list.length > 0 ? list.join(", ") : "(none)";
  switch (res.kind) {
    case "not_found":
      return `(symbol "${symbolPath}" not found in ${file}; symbols in this file: ${candidates(res.candidates)} — get_symbols_overview lists the full outline)`;
    case "ambiguous":
      return `(symbol "${symbolPath}" matches ${res.candidates.length} symbols in ${file}: ${candidates(res.candidates)} — pass one of these as symbol_path)`;
    case "no_position":
      return `(symbol "${res.path}" was found in ${file} but the language server reported no source range for it)`;
    case "method_not_found":
      return renderMethodNotFound(res.method);
    case "found":
      // Callers never reach here with kind === "found"; the exhaustive branch
      // stays as a compile-time backstop.
      return `(symbol "${res.path}" resolved in ${file})`;
  }
}

/**
 * Symbol identity → resolved position, with `run` executed inside a
 * **request-scoped open window**.
 *
 * The window must span both the resolution and the subsequent business
 * request: resolution needs didOpen for the server to build a project, and
 * the business request needs the same server-side text; leaving the window
 * didCloses the document — between two tool calls the file is not kept open
 * on the server.
 *
 * `entry` arrives already resolved against the handler entry's one active-root
 * snapshot (see `activeRootEntry` in lsp.ts) — this function performs no
 * resolution of its own, so root finding, the policy verdict, the document
 * open, and the request URI all use the same path.
 *
 * Three stages: resolve the language server → `withDocumentOpen` + locating
 * via the documentSymbol tree → `run`. Failure paths normalize to
 * model-readable strings, the same shape as the success path's stringify.
 */
async function withResolvedSymbol<T>(
  ctx: LspCtx,
  entry: ActiveRootEntry,
  symbolPath: string,
  token: CancellationToken,
  run: (client: LspClient, position: LspPosition) => Promise<T>
): Promise<T | string> {
  const { file } = entry;
  const { client, failure } = await getClientDetailed(ctx, file);
  if (!client) {
    return renderNoServer(ctx, failure ?? { reason: "no-server" }, entry.raw);
  }
  // The read policy is consulted before the open window: a protected or
  // undecidable file never enters withDocumentOpen, so no didOpen carries its
  // bytes (specs/host-read-policy.md SC4 — verdict on the T | string channel).
  const denial = await documentOpenDenial(ctx, file);
  if (denial !== null) return denial;
  return client.withDocumentOpen(file, async () => {
    const resolved = await resolveSymbolPosition(
      client,
      file,
      symbolPath,
      token
    );
    if (resolved.kind !== "found") {
      return renderResolution(file, symbolPath, resolved);
    }
    return run(client, resolved.position);
  });
}

interface SymbolOperationSpec {
  readonly name: string;
  readonly method: string;
  readonly description: string;
  /** Resolved position → LSP request params (references attaches context too). */
  readonly buildParams: (file: string, position: LspPosition) => unknown;
}

/**
 * Single-step symbol operation factory: symbol identity → position → one LSP
 * request. Timeout/abort go uniformly through `createRequestCancellation`
 * (the same cancellation chain as `lsp.ts`, covering both the documentSymbol
 * locating stage and the business-request stage).
 */
function makeSymbolOperationTool(
  ctx: LspCtx,
  spec: SymbolOperationSpec
): AciToolDef {
  const validate = compileValidator(SYMBOL_SCHEMA, spec.name);
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    inputSchema: SYMBOL_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as SymbolInput;
      // ONE active-root read per entry: the resolved path drives resolution,
      // the policy verdict, the open, and the request URI; the raw input is
      // kept only for the no-server sentinel's rendering.
      const entry = activeRootEntry(ctx, params.file);
      const { file } = entry;
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      try {
        return await withResolvedSymbol(
          ctx,
          entry,
          params.symbol_path,
          cancel.token,
          async (client, position) => {
            const result = await requestOrMethodNotFoundSentinel(
              client,
              spec.method,
              spec.buildParams(file, position),
              cancel.token
            );
            if (cancel.timedOut())
              throw timeoutError(spec.name, spec.method, timeoutMs);
            return stringifyResult(result);
          }
        );
      } catch (err) {
        if (cancel.timedOut())
          throw timeoutError(spec.name, spec.method, timeoutMs);
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/**
 * The two call-hierarchy tools (incoming / outgoing): symbol identity →
 * position → `prepareCallHierarchy`, take the first item → forward to
 * incoming/outgoing. Structurally the same as `lsp.ts`'s multi-step form,
 * with the input switched from line/column to symbol identity.
 */
function makeSymbolCallHierarchyTool(
  ctx: LspCtx,
  name: string,
  method: string,
  description: string
): AciToolDef {
  const validate = compileValidator(SYMBOL_SCHEMA, name);
  return Object.freeze({
    name,
    description,
    inputSchema: SYMBOL_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as SymbolInput;
      // ONE active-root read per entry (same discipline as
      // makeSymbolOperationTool).
      const entry = activeRootEntry(ctx, params.file);
      const { file } = entry;
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      let timedOutMethod = "textDocument/prepareCallHierarchy";
      try {
        return await withResolvedSymbol(
          ctx,
          entry,
          params.symbol_path,
          cancel.token,
          async (client, position) => {
            const prepared = await requestOrMethodNotFoundSentinel(
              client,
              "textDocument/prepareCallHierarchy",
              symbolPositionParams(file, position),
              cancel.token
            );
            if (cancel.timedOut())
              throw timeoutError(name, timedOutMethod, timeoutMs);
            // Missing-method sentinel: the server has no call hierarchy —
            // pass it through (no forward).
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
            return stringifyResult(result);
          }
        );
      } catch (err) {
        if (cancel.timedOut())
          throw timeoutError(name, timedOutMethod, timeoutMs);
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/**
 * The "no project anchor" check for the branch without `file`: hit → a
 * layered sentinel string.
 *
 * Two observable shapes converge on the same sentinel (root cause in lsp.ts
 * `renderNoProjectAnchor`):
 *   - tsserver throws `No Project.` (the anchor file belongs to no project);
 *   - an RPC returns `[]` normally, with no project context.
 *
 * **Contract for `[]`**: only "the query ran and the symbol genuinely does
 * not exist" may return `[]`; an empty result without an anchor no longer
 * impersonates a query result. Returning `undefined` = not the no-anchor
 * shape (regular data / missing-method sentinel / other errors), left to the
 * caller's existing handling.
 *
 * Non-empty results pass through unchanged: even with a correct anchor the
 * coverage can be incomplete, but that belongs to the standing warning in
 * the tool description, not to this check.
 */
function noAnchorSentinelOrUndefined(
  ctx: LspCtx,
  result: unknown
): string | undefined {
  return Array.isArray(result) && result.length === 0
    ? renderNoProjectAnchor(ctx)
    : undefined;
}

/**
 * `find_symbol`: search the workspace for symbols by name/pattern
 * (`workspace/symbol`). Without `file`, probe available language servers in
 * `SERVERS` declaration order (inheriting `lsp.ts`'s workspace-level
 * dispatch); an empty query is rejected at validation time by the schema's
 * `minLength: 1`.
 */
function makeFindSymbolTool(ctx: LspCtx, description: string): AciToolDef {
  const name = "find_symbol";
  const validate = compileValidator(FIND_SYMBOL_SCHEMA, name);
  const method = "workspace/symbol";
  return Object.freeze({
    name,
    description,
    inputSchema: FIND_SYMBOL_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as FindSymbolInput;
      // ONE active-root read per entry; `file` (resolved) and `params.file`
      // (raw) stay distinct exactly as in the coordinate family.
      const entry =
        params.file !== undefined
          ? activeRootEntry(ctx, params.file)
          : undefined;
      const file = entry?.file;
      const { client, failure } =
        file !== undefined
          ? await getClientDetailed(ctx, file)
          : await getClientForWorkspaceDetailed(ctx);
      if (!client) {
        return renderNoServer(
          ctx,
          failure ?? { reason: "no-server" },
          params.file
        );
      }
      // A `file` anchor means this call will open the document → the read
      // policy decides first; a workspace-level query without `file` opens
      // nothing and consults nothing.
      if (file !== undefined) {
        const denial = await documentOpenDenial(ctx, file);
        if (denial !== null) return denial;
      }
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      const run = async (): Promise<unknown> => {
        try {
          const result = await requestOrMethodNotFoundSentinel(
            client,
            method,
            { query: params.query },
            cancel.token
          );
          if (cancel.timedOut()) throw timeoutError(name, method, timeoutMs);
          if (params.file === undefined) {
            // EXIT: no `file` = no project anchor, so an empty result is not
            // trustworthy → layered sentinel (`[]` from now on only means
            // "queried, symbol genuinely absent"). Paths that carry `file`
            // skip this and behave byte-for-byte as before.
            const sentinel = noAnchorSentinelOrUndefined(ctx, result);
            if (sentinel !== undefined) return sentinel;
          }
          return stringifyResult(result);
        } catch (err) {
          if (cancel.timedOut()) throw timeoutError(name, method, timeoutMs);
          if (params.file === undefined) {
            // EXIT: tsserver's `No Project.` (anchor belongs to no project)
            // is the same no-anchor shape — converge on the same sentinel
            // instead of letting it masquerade as an RPC fault. The check is
            // deliberately narrow: only this message matches, other errors
            // rethrow as before.
            if (isNoProjectAnchorError(err)) return renderNoProjectAnchor(ctx);
          }
          throw err;
        } finally {
          cancel.dispose();
        }
      };
      return file !== undefined ? client.withDocumentOpen(file, run) : run();
    },
  });
}

/**
 * `get_symbols_overview`: the symbol outline of a single file — the entry
 * point when the symbol name is not yet known (use the outline or
 * find_symbol instead of grepping the source first). The output is the
 * server's raw documentSymbol tree (stringified), from which the model reads
 * `name`s and nesting to compose the `symbol_path` the other tools expect.
 */
function makeSymbolsOverviewTool(ctx: LspCtx, description: string): AciToolDef {
  const name = "get_symbols_overview";
  const validate = compileValidator(FILE_SCHEMA, name);
  const method = "textDocument/documentSymbol";
  return Object.freeze({
    name,
    description,
    inputSchema: FILE_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as FileInput;
      // ONE active-root read per entry: root finding, policy check, document
      // open, and request URI all see the same resolved path.
      const entry = activeRootEntry(ctx, params.file);
      const { file } = entry;
      const { client, failure } = await getClientDetailed(ctx, file);
      if (!client) {
        return renderNoServer(
          ctx,
          failure ?? { reason: "no-server" },
          params.file
        );
      }
      const denial = await documentOpenDenial(ctx, file);
      if (denial !== null) return denial;
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      return client.withDocumentOpen(file, async () => {
        try {
          const result = await requestOrMethodNotFoundSentinel(
            client,
            method,
            {
              textDocument: { uri: pathToFileURL(file).href },
            },
            cancel.token
          );
          if (cancel.timedOut()) throw timeoutError(name, method, timeoutMs);
          return stringifyResult(result);
        } catch (err) {
          if (cancel.timedOut()) throw timeoutError(name, method, timeoutMs);
          throw err;
        } finally {
          cancel.dispose();
        }
      });
    },
  });
}

/** Ground truth for the ten symbol-query tool names (shared by the registry's
 * Gate 3 and the tests). */
export const SYMBOL_QUERY_TOOL_NAMES = Object.freeze([
  "find_symbol",
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_hover",
  "get_diagnostics_for_file",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
] as const);

/**
 * Zod schemas for the MCP transport (SDK 2.0 `registerTool` accepts a
 * Standard Schema for `inputSchema`; Zod 4 qualifies). These do **not**
 * duplicate the in-process ACI JSON Schemas (`SYMBOL_SCHEMA` / `FILE_SCHEMA`
 * / `FIND_SYMBOL_SCHEMA`): JSON Schema feeds ajv for handler inputs, Zod
 * feeds the MCP transport — writing the same fields once per validator is
 * necessary (different validators, different consumers), but SSOT must not
 * split further within one validator type.
 *
 * **`SYMBOL_QUERY_ZOD_SCHEMAS` is the SSOT for the MCP Zod schemas**: the
 * key set corresponds one-to-one with `SYMBOL_QUERY_TOOL_NAMES`, and any
 * missing key fails fast at construction (same discipline as
 * `createSymbolQueryToolSet`). The MCP assembly (`src/lsp-mcp/server.ts`)
 * only imports this — no inlining.
 */
const symbolIdentityZod = z
  .object({
    file: z.string().min(1),
    symbol_path: z.string().min(1).max(512),
  })
  .strict();

const fileOnlyZod = z
  .object({
    file: z.string().min(1),
  })
  .strict();

const findSymbolZod = z
  .object({
    query: z.string().min(1).max(512),
    file: z.string().min(1).optional(),
  })
  .strict();

const diagnosticsZod = z
  .object({
    file: z.string().min(1).optional(),
    files: z.array(z.string().min(1)).min(1).max(10).optional(),
  })
  .strict();

export const SYMBOL_QUERY_ZOD_SCHEMAS: Readonly<Record<string, z.ZodType>> =
  Object.freeze({
    find_symbol: findSymbolZod,
    find_declaration: symbolIdentityZod,
    find_referencing_symbols: symbolIdentityZod,
    find_implementations: symbolIdentityZod,
    get_symbols_overview: fileOnlyZod,
    get_hover: symbolIdentityZod,
    get_diagnostics_for_file: diagnosticsZod,
    prepare_call_hierarchy: symbolIdentityZod,
    list_incoming_calls: symbolIdentityZod,
    list_outgoing_calls: symbolIdentityZod,
  });

/**
 * Build the symbol-query tool set (`registry.ts` assembly entry point).
 *
 * Return order matches `SYMBOL_QUERY_TOOL_NAMES` (Gate 3 indexes by name;
 * order is contract). Descriptions are all written in terms of **symbol
 * identity** — never "give me a line/column first" — aligning with the rule
 * that coordinates must not be presented as these tools' primary input.
 */
export function createSymbolQueryToolSet(
  ctx: LspCtx
): ReadonlyArray<AciToolDef> {
  const ops: ReadonlyArray<SymbolOperationSpec> = [
    {
      name: "find_declaration",
      method: "textDocument/definition",
      description:
        "Resolve a symbol (by file path plus its symbol_path, e.g. `ClassName/methodName`) to where it is declared. Use it as the first hop when reading unfamiliar code; pair with find_referencing_symbols to also see who uses it. Returns the language-server response as a JSON string.",
      buildParams: (file, position) => symbolPositionParams(file, position),
    },
    {
      name: "find_referencing_symbols",
      method: "textDocument/references",
      description:
        "List every reference across the project to a symbol identified by its file path and symbol_path (the declaration is included when the server reports it). Use it to size the blast radius before changing a symbol; pair with find_declaration for the definition site. Returns the language-server response as a JSON string.",
      buildParams: (file, position) => ({
        ...symbolPositionParams(file, position),
        context: { includeDeclaration: true },
      }),
    },
    {
      name: "find_implementations",
      method: "textDocument/implementation",
      description:
        "Resolve an interface or abstract member, identified by its file path and symbol_path, to the concrete implementations. Use it when a call site lands on an abstraction; pair with find_referencing_symbols for the full usage set. Returns the language-server response as a JSON string.",
      buildParams: (file, position) => symbolPositionParams(file, position),
    },
    {
      name: "get_hover",
      method: "textDocument/hover",
      description:
        "Read the type, signature and doc comment of a symbol identified by its file path and symbol_path. Use it to confirm a contract before calling or changing it; pair with find_declaration to jump to the source. Returns the language-server response as a JSON string.",
      buildParams: (file, position) => symbolPositionParams(file, position),
    },
    {
      name: "prepare_call_hierarchy",
      method: "textDocument/prepareCallHierarchy",
      description:
        "Resolve a function or method, identified by its file path and symbol_path, to a call-hierarchy item. Use it to confirm the server agrees on the target; pair with list_incoming_calls / list_outgoing_calls for callers and callees. Returns the language-server response (a list of items) as a JSON string.",
      buildParams: (file, position) => symbolPositionParams(file, position),
    },
  ];

  const byName = new Map<string, AciToolDef>();
  for (const spec of ops)
    byName.set(spec.name, makeSymbolOperationTool(ctx, spec));

  byName.set(
    "find_symbol",
    makeFindSymbolTool(
      ctx,
      "Search the whole workspace for symbols whose name matches a query string (a name or a substring / pattern the server accepts). Use it as the entry point when the defining file is still unknown; pass `file` to anchor the search to that file's project, because searching without `file` only covers the project the server has already loaded — results can be partial even when non-empty, and an empty result may mean the query found no project rather than no such symbol. Pair with get_symbols_overview once a file is identified, and with find_declaration to jump to a specific symbol. Returns the language-server response as a JSON string."
    )
  );
  byName.set(
    "get_symbols_overview",
    makeSymbolsOverviewTool(
      ctx,
      "List the symbol outline of a single file (classes, functions, methods, variables) by file path. Use it to discover the exact symbol_path values the other symbol tools expect; pair with find_symbol when the file itself is still unknown. Returns the language-server response as a JSON string."
    )
  );
  byName.set(
    "get_diagnostics_for_file",
    makeDiagnosticsTool(
      ctx,
      "Read the latest language-server diagnostics for one file (`file`) or up to 10 files at once (`files`, mutually exclusive with `file`). Use it after an edit and before running builds or tests to see in-editor errors; pair with read_file on the rows referenced in the entries. After a recent edit it waits for the server to re-push diagnostics based on the new content (up to the configured deadline, default 2s), then renders whatever is available. Filters severity 0 (Hint); caps at 20 entries per file, appending an `...(N more issue(s) truncated, total M)` footer when over the cap. Returns one plain-text `<diagnostics file=...>` segment per file (one blank row between segments).",
      "get_diagnostics_for_file"
    )
  );
  byName.set(
    "list_incoming_calls",
    makeSymbolCallHierarchyTool(
      ctx,
      "list_incoming_calls",
      "callHierarchy/incomingCalls",
      "List the functions and methods that call a target function, identified by its file path and symbol_path (multi-step: the call-hierarchy item is prepared first, then callers are fetched). Use it to trace who depends on a function; pair with list_outgoing_calls for the reverse direction. Returns the language-server response as a JSON string."
    )
  );
  byName.set(
    "list_outgoing_calls",
    makeSymbolCallHierarchyTool(
      ctx,
      "list_outgoing_calls",
      "callHierarchy/outgoingCalls",
      "List the functions and methods called by a target function, identified by its file path and symbol_path (multi-step: the call-hierarchy item is prepared first, then callees are fetched). Use it to read a function's dependencies without opening every file; pair with list_incoming_calls for the reverse direction. Returns the language-server response as a JSON string."
    )
  );

  return Object.freeze(
    SYMBOL_QUERY_TOOL_NAMES.map((name) => {
      const tool = byName.get(name);
      // Fail fast at construction when the name list and the factories
      // diverge, rather than leaving it to runtime (same discipline as
      // registry Gate 3).
      if (!tool) throw new Error(`symbol query tool missing: ${name}`);
      return tool;
    })
  );
}
