/**
 * Symbol-mutation ACI tool set — five model-facing mutation tools.
 *
 * **Why a separate file (rather than reusing `symbol.ts` templates)**:
 *   - Mutations go "read file → text replace → write file", which diverges
 *     from query tools' "single sendRequest → stringify" shape; folding them
 *     into `makeSymbolOperationTool` would grow four extra if-branches in
 *     that factory just to support writing (`buildParams` would need
 *     splitting too).
 *   - Mutations must fire the assembly layer's `onEdit` callback so LSP
 *     views stay in sync; query tools never touch disk and need no notifier
 *     seam. Bolting both responsibilities together would leave ambiguous
 *     fields (fire onEdit only after a successful write / never for queries
 *     — with no type-level difference).
 *   - **The fail-fast and contract levels stay clearer**: query failure =
 *     string sentinel return; mutation failure = typed failure strings
 *     (like `{ deleted: false, references: [...] }`) + `ToolExecutionError`
 *     (rename conflict / no server / refused write). Merging them would mix
 *     two typed-error regimes with a pure-string contract in one place.
 *
 * **Write path**: every mutation tool uses the same
 * "resolve symbol → compute edits via LSP → apply to disk" pipeline. The
 * disk write does not call `edit_file` (no `old_str/new_str` path — the
 * rename's edit ranges come from the language server, not the model). After
 * writing, the assembly layer's `onEdit` triggers
 * `lspNotifier.invalidate(file)`, matching `edit_file` so the LSP didChange
 * sync semantics stay single-sourced.
 *
 * **No overlap with `edit_file`**: these tools mutate by **symbol
 * identity**; `edit_file` remains for text patches that are not one symbol.
 * The two coexist.
 *
 * **aci metadata**: all five use `category: "write"` and reuse the other
 * three `LSP_ACI_META` fields (`isConcurrencySafe: false` /
 * `interruptBehavior: "cancel"` / `timeoutTier: "default"`); the symbol
 * query surface in `symbol.ts` uses the same metadata, and mutations ride
 * the same LSP client / cancellation / timeout chain — diverging metadata
 * means diverging semantics.
 *
 * Boundaries:
 *   - **never** `process.kill`; interruption goes via `$/cancelRequest`.
 *   - **never** expose position fields beyond `{ file, symbol_path }` to
 *     the model (the schema's `additionalProperties: false` guards this).
 *   - **never** silently swallow a failure before invalidation — invalidation
 *     failures leave a stderr trace (fire-and-forget, but best-effort must
 *     stay observable).
 *   - Resolution and writes must both happen inside the request-scoped open
 *     window (`withDocumentOpen`) — tsserver builds no project for a closed
 *     file, so rename/documentSymbol would return empty/wrong; leaving the
 *     window didCloses the document, so files are not kept open on the
 *     server between calls.
 */
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

import type { CancellationToken } from "vscode-jsonrpc/node";

import type { LspClient } from "../../lsp/client.js";
import type { LspCtx } from "../../lsp/types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import type { AciToolDef } from "../types.js";
import {
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  compileValidator,
  createRequestCancellation,
  isMethodNotFoundSentinel,
  renderMethodNotFound,
  renderNoServer,
  requestOrMethodNotFoundSentinel,
  stringifyResult,
  timeoutError,
} from "./lsp.js";
import {
  resolveSymbolPosition,
  type DocumentSymbolNode,
  type LspPosition,
} from "./symbol-resolver.js";
import { getClientDetailed } from "../../lsp/client.js";

// ---------------------------------------------------------------------------
// Schema — the five mutation tools share the `{ file, symbol_path }` base
// plus their own specialized fields
// ---------------------------------------------------------------------------

const SYMBOL_MUTATE_BASE_PROPS = {
  file: { type: "string", minLength: 1 },
  symbol_path: { type: "string", minLength: 1, maxLength: 512 },
} as const;

/** rename_symbol: { file, symbol_path, new_name } */
const RENAME_SCHEMA = {
  type: "object",
  properties: {
    ...SYMBOL_MUTATE_BASE_PROPS,
    new_name: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["file", "symbol_path", "new_name"],
  additionalProperties: false,
} as const;

/** replace_symbol_body: { file, symbol_path, new_body } */
const REPLACE_BODY_SCHEMA = {
  type: "object",
  properties: {
    ...SYMBOL_MUTATE_BASE_PROPS,
    new_body: { type: "string" },
  },
  required: ["file", "symbol_path", "new_body"],
  additionalProperties: false,
} as const;

/** insert_before_symbol / insert_after_symbol: { file, symbol_path, code } */
const INSERT_SCHEMA = {
  type: "object",
  properties: {
    ...SYMBOL_MUTATE_BASE_PROPS,
    code: { type: "string" },
  },
  required: ["file", "symbol_path", "code"],
  additionalProperties: false,
} as const;

/** safe_delete_symbol: { file, symbol_path } — same schema as the queries */
const DELETE_SCHEMA = {
  type: "object",
  properties: { ...SYMBOL_MUTATE_BASE_PROPS },
  required: ["file", "symbol_path"],
  additionalProperties: false,
} as const;

const MAX_NEW_BODY_BYTES = 48 * 1024;
const MAX_INSERT_BYTES = 48 * 1024;

/**
 * aci metadata for the symbol-mutation tools:
 *   - `category: "write"` — these tools write to disk; distinct from the
 *     read-only query surface (permission decoration derives its default
 *     decision from category: write defaults to ask);
 *   - the other three fields reuse LSP_ACI_META (same LSP client /
 *     cancellation / timeout chain — diverging metadata means diverging
 *     semantics).
 */
const SYMBOL_MUTATE_ACI_META = {
  category: "write" as const,
  isConcurrencySafe: false,
  interruptBehavior: "cancel" as const,
  timeoutTier: "default" as const,
};

interface SymbolMutateInput {
  readonly file: string;
  readonly symbol_path: string;
}
interface RenameInput extends SymbolMutateInput {
  readonly new_name: string;
}
interface ReplaceBodyInput extends SymbolMutateInput {
  readonly new_body: string;
}
interface InsertInput extends SymbolMutateInput {
  readonly code: string;
}

// ---------------------------------------------------------------------------
// LSP payload normalization (no field translation — that semantics belongs
// to the language server)
// ---------------------------------------------------------------------------

interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

interface TextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

/**
 * Normalizing the `WorkspaceEdit` shape returned by tsserver /
 * typescript-language-server:
 *   - `changes`: the legacy LSP shape `{ uri: TextEdit[] }`;
 *   - `documentChanges`: the LSP 3.13+ shape `(TextDocumentEdit | ResourceOp)[]`.
 * We only consume `TextDocumentEdit[]` (with `textDocument.uri` and an
 * `edits` array). `ResourceOp` (create/rename/delete file) is never initiated
 * by this tool set — mutations touch only the files the target symbol lives
 * in; even cross-file renames apply only the TextEdit sets the server
 * computes.
 */
interface TextDocumentEdit {
  readonly textDocument: { readonly uri: string };
  readonly edits: ReadonlyArray<TextEdit>;
}

/**
 * Normalization of unusable WorkspaceEdit fragments: the server returned
 * something this tool set cannot apply → typed refusal, **never partial
 * application**.
 *
 * Why refuse instead of skip: the applier is "read file → text replace →
 * write file", so skipping one file operation would still push the remaining
 * TextEdits to disk — a half-applied rename is worse than a full failure,
 * leaving the workspace "half changed". The old implementation swallowed all
 * three corruptions via `continue` / `flatMap` as "this entry doesn't exist";
 * worst case the server returned only file operations and the tool reported
 * `renamed: true, editCount: 0` — a failure that looked like success.
 *
 * `kind` is a **test / host seam** (same shape as write-file.ts's
 * `LastReadRequiredError.kind`), not on the executor's read surface; the
 * model side only reads `.message`, and the message already contains the
 * kind and which specific op caused it.
 */
export type WorkspaceEditUnsupportedKind =
  "file-operation" | "malformed-entry" | "malformed-edit" | "unresolvable-uri";

export class WorkspaceEditUnsupportedError extends ToolExecutionError {
  override readonly name: string = "WorkspaceEditUnsupportedError";
  readonly kind: WorkspaceEditUnsupportedKind;
  /** Which specific op: `create` / `rename` / `delete`, or a one-line
   * description of the shape problem. */
  readonly detail: string;

  constructor(kind: WorkspaceEditUnsupportedKind, detail: string) {
    super(
      `[symbol-mutate] cannot apply the workspace edit returned by the language server: ` +
        `${kind} (${detail}); no edits were applied.`
    );
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * File operations (LSP 3.16 `ResourceOp`) inside the server's
 * `documentChanges`. Unknown `kind` literals are included too — equally
 * inapplicable, so "not recognized" must not become "skip".
 */
const RESOURCE_OP_KINDS: ReadonlySet<string> = new Set([
  "create",
  "rename",
  "delete",
]);

export function normalizeWorkspaceEdit(
  raw: unknown
): ReadonlyArray<TextDocumentEdit> {
  // `null` / `undefined` is legal "the server rejected this rename" semantics
  // (the handler already translated it into a typed same-scope-conflict
  // failure, see makeRenameSymbolTool), not corruption — so these two states
  // still normalize to empty and the caller handles them per existing
  // semantics.
  if (raw === null || raw === undefined) return [];
  // Any other non-object (string / number / array) yields zero readable
  // entries: it must not pass silently as "no entries" — that is the same
  // "failure looks like success" shape at the envelope layer (the handler
  // would report `renamed: true, editCount: 0` as success).
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspaceEditUnsupportedError(
      "malformed-entry",
      `WorkspaceEdit is not an object (${Array.isArray(raw) ? "array" : typeof raw})`
    );
  }
  const edit = raw as {
    changes?: unknown;
    documentChanges?: unknown;
  };
  return [
    ...normalizeChangesForm(edit.changes),
    ...normalizeDocumentChangesForm(edit.documentChanges),
  ];
}

/** The legacy `changes` form: `{ uri: TextEdit[] }`. A present-but-invalid
 * shape is likewise a typed failure (`changes: []` / `changes: "..."` yield
 * no uri mapping — that is not "no changes"). */
function normalizeChangesForm(changes: unknown): TextDocumentEdit[] {
  if (changes === undefined) return [];
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new WorkspaceEditUnsupportedError(
      "malformed-entry",
      `changes is not a { uri: TextEdit[] } object (${Array.isArray(changes) ? "array" : typeof changes})`
    );
  }
  const out: TextDocumentEdit[] = [];
  for (const [uri, edits] of Object.entries(
    changes as Record<string, unknown>
  )) {
    out.push(...docEditsFor(uri, edits));
  }
  return out;
}

/**
 * The LSP 3.13+ `documentChanges` form. Same rule: when present it must be
 * an array — a lone `TextDocumentEdit` object is also illegal (the protocol
 * requires an array) and must not degrade into "zero entries".
 */
function normalizeDocumentChangesForm(
  documentChanges: unknown
): TextDocumentEdit[] {
  if (documentChanges === undefined) return [];
  if (!Array.isArray(documentChanges)) {
    throw new WorkspaceEditUnsupportedError(
      "malformed-entry",
      `documentChanges is not an array (${typeof documentChanges})`
    );
  }
  const out: TextDocumentEdit[] = [];
  for (const change of documentChanges) {
    out.push(...normalizeDocumentChange(change));
  }
  return out;
}

/**
 * One `documentChanges` entry → `TextDocumentEdit[]` (0 or 1 items).
 *
 * Like the other normalizers in this file: **return what is applicable,
 * throw on what is not** (`WorkspaceEditUnsupportedError`) — there is no
 * third exit of "silently skip".
 */
function normalizeDocumentChange(change: unknown): TextDocumentEdit[] {
  if (!change || typeof change !== "object") {
    throw new WorkspaceEditUnsupportedError(
      "malformed-entry",
      "documentChanges entry is not an object"
    );
  }
  // Check for file operations first: `CreateFile` / `RenameFile` /
  // `DeleteFile` all carry `kind`, while `TextDocumentEdit` protocol-wise
  // does not. An unknown `kind` literal cannot be filtered out either, so it
  // is refused as well (not recognized ≠ skippable).
  const maybeOp = change as { kind?: unknown };
  if (typeof maybeOp.kind === "string") {
    if (!RESOURCE_OP_KINDS.has(maybeOp.kind)) {
      throw new WorkspaceEditUnsupportedError(
        "file-operation",
        `unknown ResourceOp kind "${maybeOp.kind}"`
      );
    }
    throw new WorkspaceEditUnsupportedError(
      "file-operation",
      `ResourceOp ${maybeOp.kind} (this tool set does not create, rename or delete files)`
    );
  }
  const doc = change as {
    textDocument?: { uri?: unknown };
    edits?: unknown;
  };
  const uri = doc.textDocument?.uri;
  if (typeof uri !== "string") {
    throw new WorkspaceEditUnsupportedError(
      "malformed-entry",
      "documentChanges entry has no textDocument.uri"
    );
  }
  return docEditsFor(uri, doc.edits);
}

/**
 * A single uri's edits array → `TextDocumentEdit[]` (0 or 1 items). `edits`
 * not an array, or some `TextEdit` shape illegal → typed failure; **length 0
 * is the exception** — that is the server's legal "nothing to change",
 * returning an empty list (deliberately separate from "N entries all
 * dropped", which throws at the drop point instead).
 */
function docEditsFor(uri: string, edits: unknown): TextDocumentEdit[] {
  if (!Array.isArray(edits)) {
    throw new WorkspaceEditUnsupportedError(
      "malformed-entry",
      `edits for ${uri} is not a TextEdit array`
    );
  }
  const textEdits = normalizeTextEdits(edits, uri);
  return textEdits.length > 0
    ? [{ textDocument: { uri }, edits: textEdits }]
    : [];
}

/**
 * Normalize one file's edits. An empty array is a legal response (the server
 * may say "nothing to change") and yields an empty list; any single entry
 * that cannot be normalized fails the whole batch — thrown **at the swallow
 * point itself**, so a corrupt payload never keeps traveling only to be
 * reported vaguely later.
 */
function normalizeTextEdits(
  raw: ReadonlyArray<unknown>,
  uri: string
): ReadonlyArray<TextEdit> {
  const out: TextEdit[] = [];
  for (const item of raw) {
    const textEdit = normalizeTextEdit(item);
    if (!textEdit) {
      throw new WorkspaceEditUnsupportedError(
        "malformed-edit",
        `TextEdit for ${uri} is not { range: {start,end}, newText: string }`
      );
    }
    out.push(textEdit);
  }
  return out;
}

/** Normalize one TextEdit; illegal shape → `undefined` (caller turns it into
 * a typed failure). */
function normalizeTextEdit(raw: unknown): TextEdit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as {
    range?: { start?: LspPosition; end?: LspPosition };
    newText?: unknown;
  };
  if (
    !e.range ||
    !e.range.start ||
    !e.range.end ||
    typeof e.newText !== "string"
  ) {
    return undefined;
  }
  const { start, end } = e.range;
  // Guard the range coordinate shapes too: values like `{ line: "3" }` make
  // offsetFor silently misplace (NaN indices → empty-string concatenation),
  // so a rename would silently drop characters.
  if (!isLspPosition(start) || !isLspPosition(end)) {
    return undefined;
  }
  return { range: { start, end }, newText: e.newText };
}

function isLspPosition(v: unknown): v is LspPosition {
  if (!v || typeof v !== "object") return false;
  const p = v as { line?: unknown; character?: unknown };
  return typeof p.line === "number" && typeof p.character === "number";
}

/** The source type of `DocumentSymbolNode.range` only promises `start`;
 *  mutation tools need `end` to build a full range. Protocol-wise both
 *  `SymbolInformation.location.range` and `DocumentSymbol.range` carry
 *  `start` + `end`, but symbol-resolver.ts uses a narrow type so it does not
 *  leak to the query layer (queries only need selectionRange). This factory
 *  trusts the server payload per protocol; failures fall back to the
 *  normalizeTextEdit layer (missing end → that entry's shape is illegal,
 *  whole batch typed failure — see WorkspaceEditUnsupportedError). */
type NodeRange = { start?: LspPosition; end?: LspPosition };

/** Assemble the node's full range per protocol. Both LSP
 *  DocumentSymbol.range and SymbolInformation.location.range carry at least
 *  start + end; when end is missing it degrades to a single-point range (at
 *  the node's start), which the write treats as an empty replacement. */
function assembleFullRange(
  start: LspPosition,
  end: LspPosition | undefined
): LspRange {
  return { start, end: end ?? start };
}

/** Group by uri (multiple edits for one file merge). `fileURLToPath` failing
 *  to decode → typed failure: that uri's edits cannot be applied, and
 *  skipping would leave the workspace "half changed" — same no-partial-
 *  application discipline as refusing file operations above. */
function groupEditsByPath(
  edits: ReadonlyArray<TextDocumentEdit>
): Map<string, TextEdit[]> {
  const grouped = new Map<string, TextEdit[]>();
  for (const doc of edits) {
    let path: string;
    try {
      path = fileURLToPath(doc.textDocument.uri);
    } catch (err) {
      // The uri is shape-valid but simply doesn't resolve to a file path
      // (non-`file:` scheme etc.) — a different attribution from payload
      // corruption, so it gets its own kind: the model learns the server
      // handed back an uri it doesn't accept, rather than a broken response.
      const msg = err instanceof Error ? err.message : String(err);
      throw new WorkspaceEditUnsupportedError(
        "unresolvable-uri",
        `${doc.textDocument.uri} is not a usable file URL: ${msg}`
      );
    }
    const list = grouped.get(path) ?? [];
    list.push(...doc.edits);
    grouped.set(path, list);
  }
  return grouped;
}

/** Sort a file's TextEdits by descending range.start and splice them in that
 * order — replacing from the tail backwards keeps earlier offsets valid
 * through subsequent replacements. */
function applyEditsToText(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });
  const lines = text.split("\n");
  for (const edit of sorted) {
    const start = offsetFor(lines, edit.range.start);
    const end = offsetFor(lines, edit.range.end);
    const next = text.slice(0, start) + edit.newText + text.slice(end);
    text = next;
    // Re-split (newText may contain multiple lines).
    lines.length = 0;
    lines.push(...next.split("\n"));
  }
  return text;
}

/** (line, character) → byte offset within the text. line/character are
 * 0-based; lines are joined by a single `\n` (per LSP protocol). */
function offsetFor(lines: string[], pos: LspPosition): number {
  let offset = 0;
  for (let i = 0; i < pos.line; i++) {
    offset += (lines[i] ?? "").length + 1;
  }
  offset += pos.character;
  return offset;
}

// ---------------------------------------------------------------------------
// WorkspaceEdit application to disk + onEdit callback
// ---------------------------------------------------------------------------

/** Apply a batch of TextDocumentEdit to disk, calling onEdit so LSP views
 * stay in sync.
 *
 * **Non-trivial path**: every write is an async `writeFile`; any failure
 * throws `ToolExecutionError` immediately (refusing to pass a silent failure
 * off as a successful rename); every file that succeeded is recorded in
 * `writtenFiles` for the return value and the invalidate trigger. */
async function applyWorkspaceEdit(
  edits: ReadonlyArray<TextDocumentEdit>,
  onEdit: ((file: string) => void) | undefined
): Promise<{
  readonly writtenFiles: ReadonlyArray<string>;
  readonly editCount: number;
}> {
  const grouped = groupEditsByPath(edits);
  const written: string[] = [];
  let editCount = 0;
  for (const [filePath, fileEdits] of grouped) {
    editCount += fileEdits.length;
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolExecutionError(
        `[symbol-mutate] cannot read ${filePath} before applying edits: ${msg}`
      );
    }
    const next = applyEditsToText(text, fileEdits);
    if (next === text) continue;
    try {
      await writeFile(filePath, next, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolExecutionError(
        `[symbol-mutate] cannot write ${filePath} after applying edits: ${msg}`
      );
    }
    written.push(filePath);
    // onEdit is the assembly-layer seam wiring lspNotifier.invalidate; it
    // fires only after a successful write, never on failure (no bogus
    // notices).
    onEdit?.(filePath);
  }
  return { writtenFiles: written, editCount };
}

// ---------------------------------------------------------------------------
// Failed symbol resolution → model-readable string (same semantics as
// symbol.ts)
// ---------------------------------------------------------------------------

/** Map a documentSymbol node → its full range (LSP range, **covering the
 *  entire definition**). Precedence: node.range > node.location.range
 *  (DocumentSymbol vs SymbolInformation). selectionRange covers only the
 *  symbol name itself and must **not** be used for replace_body /
 *  safe_delete. */
function fullRangeOf(node: DocumentSymbolNode): LspRange | undefined {
  const r = (node.range ?? node.location?.range) as NodeRange | undefined;
  if (!r || !r.start) return undefined;
  return assembleFullRange(r.start, r.end);
}

interface ResolvedSymbol {
  readonly client: LspClient;
  readonly symbol: DocumentSymbolNode;
  readonly path: string;
}

/**
 * Resolve a symbol identity and execute `run` inside a **request-scoped open
 * window**; any failure → a plain-string failure (same semantics as the
 * query tools).
 *
 * The window must span the resolution and the subsequent mutation/query
 * request: resolution needs didOpen for the server to build a project, and
 * `textDocument/rename` / `references` need the same server-side text;
 * leaving the window didCloses the document — files are not kept open on the
 * server between calls. The disk write (applyWorkspaceEdit) still happens
 * inside the window, so the notifier's didChange hits the "already open"
 * branch.
 */
async function withResolvedSymbolForMutate<T>(
  ctx: LspCtx,
  file: string,
  symbolPath: string,
  token: CancellationToken,
  run: (target: ResolvedSymbol) => Promise<T>
): Promise<T | string> {
  const { client, failure } = await getClientDetailed(ctx, file);
  if (!client) {
    return renderNoServer(ctx, failure ?? { reason: "no-server" }, file);
  }
  return client.withDocumentOpen(file, async () => {
    const resolved = await resolveSymbolPosition(
      client,
      file,
      symbolPath,
      token
    );
    if (resolved.kind !== "found") {
      // Reuse symbol.ts's rendering semantics (consistent failure-string
      // shape): not_found / ambiguous / no_position; method_not_found also
      // reuses lsp.ts's sentinel rendering (SSOT).
      const candidates = (list: ReadonlyArray<string>): string =>
        list.length > 0 ? list.join(", ") : "(none)";
      switch (resolved.kind) {
        case "not_found":
          return `(symbol "${symbolPath}" not found in ${file}; symbols in this file: ${candidates(resolved.candidates)} — get_symbols_overview lists the full outline)`;
        case "ambiguous":
          return `(symbol "${symbolPath}" matches ${resolved.candidates.length} symbols in ${file}: ${candidates(resolved.candidates)} — pass one of these as symbol_path)`;
        case "no_position":
          return `(symbol "${resolved.path}" was found in ${file} but the language server reported no source range for it)`;
        case "method_not_found":
          return renderMethodNotFound(resolved.method);
      }
    }
    return run({
      client,
      symbol: resolved.symbol,
      path: resolved.path,
    });
  });
}

// ---------------------------------------------------------------------------
// The five mutation tools
// ---------------------------------------------------------------------------

/** rename_symbol — project-wide rename by symbol identity.
 *
 * Uses `textDocument/rename` so tsserver computes the cross-file
 * WorkspaceEdit (declaration + all reference sites); before applying, stale
 * lookup targets in the documentSymbol cache must be invalidated in sync →
 * done via `onEdit` triggering the notifier.
 *
 * **Rename conflicts**: tsserver returns `null` when a conflict exists (e.g.
 * a same-scope identifier already has the name); the typed failure string
 * gives the model an explicit actionable hint.
 *
 * **Unappliable WorkspaceEdit fragments**: file operations / entries that
 * cannot normalize / illegal `TextEdit` shapes → `WorkspaceEditUnsupportedError`
 * is thrown and **nothing is applied** (the old implementation silently
 * `continue`d and dropped entries via flatMap, which could land a half
 * rename or report an empty-`editCount` "success"). */
function makeRenameSymbolTool(
  ctx: LspCtx,
  onEdit: ((file: string) => void) | undefined,
  description: string
): AciToolDef {
  const name = "rename_symbol";
  const validate = compileValidator(RENAME_SCHEMA, name);
  return Object.freeze({
    name,
    description,
    inputSchema: RENAME_SCHEMA,
    aci: SYMBOL_MUTATE_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as RenameInput;
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      try {
        return await withResolvedSymbolForMutate(
          ctx,
          params.file,
          params.symbol_path,
          cancel.token,
          async (target) => {
            const uri = fileURLFromPath(params.file);
            const result = await requestOrMethodNotFoundSentinel(
              target.client,
              "textDocument/rename",
              {
                textDocument: { uri },
                position:
                  target.symbol.selectionRange?.start ??
                  target.symbol.range?.start ??
                  target.symbol.location?.range?.start,
                newName: params.new_name,
              },
              cancel.token
            );
            if (cancel.timedOut())
              throw timeoutError(name, "textDocument/rename", timeoutMs);
            // Missing-method sentinel: the server has no rename — pass it
            // through (do not parse it as a WorkspaceEdit).
            if (isMethodNotFoundSentinel(result)) return result;
            // tsserver returns null → rename conflict (same name as an
            // existing same-scope identifier / cross-file type rules etc.).
            // Typed failure string: tell the model plainly that the rename
            // failed — no empty catch.
            if (result === null || result === undefined) {
              throw new ToolExecutionError(
                `[${name}] cannot rename ${params.symbol_path} to "${params.new_name}" in ${params.file}: existing declarations would conflict (the language server rejected the rename)`
              );
            }
            // Normalization throws WorkspaceEditUnsupportedError at the
            // swallow point itself (typed, naming file-operation /
            // malformed-entry / malformed-edit) — no partial application,
            // zero disk writes. It must not be turned into a success receipt
            // before rethrowing: the executor's throwing surface is the only
            // "this call failed" signal, and a string would make a corrupt
            // response read as a successful rename (exactly the
            // "failure-looks-like-success" this layer exists to kill).
            const docEdits = normalizeWorkspaceEdit(result);
            if (docEdits.length === 0) {
              // Empty edits is a legal LSP response (the server says
              // "nothing to change"): a successful no-op, not an error.
              // Corrupt entries never get here — they fail as typed errors in
              // normalization, so they can't merge with "server said zero".
              return stringifyResult({
                renamed: true,
                files: [],
                editCount: 0,
                message: `rename produced no edits (symbol already named "${params.new_name}")`,
              });
            }
            const applied = await applyWorkspaceEdit(docEdits, onEdit);
            return stringifyResult({
              renamed: true,
              symbol_path: target.path,
              new_name: params.new_name,
              files: applied.writtenFiles,
              editCount: applied.editCount,
            });
          }
        );
      } catch (err) {
        if (cancel.timedOut())
          throw timeoutError(name, "textDocument/rename", timeoutMs);
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/** replace_symbol_body — replace the symbol's definition body (signature line
 * included, range = node.range).
 *
 * Does not go through a LSP `textDocument/*` protocol call (there is no
 * "replace body" primitive); it builds a single-file TextEdit directly:
 * range = node.range (full range, signature + body), newText =
 * params.new_body. After applying, invalidate the single file. */
function makeReplaceSymbolBodyTool(
  ctx: LspCtx,
  onEdit: ((file: string) => void) | undefined,
  description: string
): AciToolDef {
  const name = "replace_symbol_body";
  const validate = compileValidator(REPLACE_BODY_SCHEMA, name);
  return Object.freeze({
    name,
    description,
    inputSchema: REPLACE_BODY_SCHEMA,
    aci: SYMBOL_MUTATE_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as ReplaceBodyInput;
      const bodyBytes = Buffer.byteLength(params.new_body, "utf8");
      if (bodyBytes > MAX_NEW_BODY_BYTES) {
        throw new ToolExecutionError(
          `[${name}] new_body is ${bodyBytes} bytes, exceeding ${MAX_NEW_BODY_BYTES}-byte cap (split the replacement across multiple calls or use edit_file)`
        );
      }
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      try {
        return await withResolvedSymbolForMutate(
          ctx,
          params.file,
          params.symbol_path,
          cancel.token,
          async (target) => {
            const range = fullRangeOf(target.symbol);
            if (!range) {
              throw new ToolExecutionError(
                `[${name}] symbol "${target.path}" in ${params.file} has no source range (cannot replace body)`
              );
            }
            const edit: TextDocumentEdit = {
              textDocument: { uri: fileURLFromPath(params.file) },
              edits: [{ range, newText: params.new_body }],
            };
            const applied = await applyWorkspaceEdit([edit], onEdit);
            return stringifyResult({
              replaced: true,
              symbol_path: target.path,
              files: applied.writtenFiles,
              editCount: applied.editCount,
            });
          }
        );
      } catch (err) {
        if (cancel.timedOut())
          throw timeoutError(
            name,
            "documentSymbol + applyWorkspaceEdit",
            timeoutMs
          );
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/** insert_before_symbol — inserts code + "\n" at range.start (auto newline).
 *  insert_after_symbol — inserts "\n" + code at range.end (auto newline).
 *
 *  Both share one factory: direction "before" → insert at range.start;
 *  direction "after" → insert at range.end. Same LSP TextEdit insert pattern
 *  — the protocol already supports positional insertion (newText spliced in
 *  at the range). */
function makeInsertSymbolTool(
  ctx: LspCtx,
  onEdit: ((file: string) => void) | undefined,
  spec: {
    readonly name: string;
    readonly direction: "before" | "after";
    readonly description: string;
  }
): AciToolDef {
  const validate = compileValidator(INSERT_SCHEMA, spec.name);
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    inputSchema: INSERT_SCHEMA,
    aci: SYMBOL_MUTATE_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as InsertInput;
      const codeBytes = Buffer.byteLength(params.code, "utf8");
      if (codeBytes > MAX_INSERT_BYTES) {
        throw new ToolExecutionError(
          `[${spec.name}] code is ${codeBytes} bytes, exceeding ${MAX_INSERT_BYTES}-byte cap (split the insertion across multiple calls or use edit_file)`
        );
      }
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      try {
        return await withResolvedSymbolForMutate(
          ctx,
          params.file,
          params.symbol_path,
          cancel.token,
          async (target) => {
            const range = fullRangeOf(target.symbol);
            if (!range) {
              throw new ToolExecutionError(
                `[${spec.name}] symbol "${target.path}" in ${params.file} has no source range (cannot determine insertion anchor)`
              );
            }
            // Splice at range.start/end: before → insert `code + "\n"` ahead
            // of start; after → insert `"\n" + code` past end (auto newlines
            // keep the inserted block on its own lines).
            const anchor =
              spec.direction === "before" ? range.start : range.end;
            const newText =
              spec.direction === "before"
                ? params.code + "\n"
                : "\n" + params.code;
            const edit: TextDocumentEdit = {
              textDocument: { uri: fileURLFromPath(params.file) },
              edits: [{ range: { start: anchor, end: anchor }, newText }],
            };
            const applied = await applyWorkspaceEdit([edit], onEdit);
            return stringifyResult({
              inserted: true,
              direction: spec.direction,
              symbol_path: target.path,
              files: applied.writtenFiles,
              editCount: applied.editCount,
            });
          }
        );
      } catch (err) {
        if (cancel.timedOut())
          throw timeoutError(
            spec.name,
            "documentSymbol + applyWorkspaceEdit (insert)",
            timeoutMs
          );
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/** safe_delete_symbol — delete only when there are no references; otherwise
 * return the reference list and delete nothing.
 *
 * First sends `textDocument/references` (includeDeclaration:true) to collect
 * every reference. If any reference (including the declaration) exists → a
 * typed failure `{ deleted: false, references: [...] }`, nothing deleted.
 * Otherwise builds a single-file delete edit (range = fullRange), writes it,
 * and invalidates. */
function makeSafeDeleteSymbolTool(
  ctx: LspCtx,
  onEdit: ((file: string) => void) | undefined,
  description: string
): AciToolDef {
  const name = "safe_delete_symbol";
  const validate = compileValidator(DELETE_SCHEMA, name);
  return Object.freeze({
    name,
    description,
    inputSchema: DELETE_SCHEMA,
    aci: SYMBOL_MUTATE_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as SymbolMutateInput;
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      try {
        return await withResolvedSymbolForMutate(
          ctx,
          params.file,
          params.symbol_path,
          cancel.token,
          async (target) => {
            const position =
              target.symbol.selectionRange?.start ??
              target.symbol.range?.start ??
              target.symbol.location?.range?.start;
            if (!position) {
              throw new ToolExecutionError(
                `[${name}] symbol "${target.path}" in ${params.file} has no position (cannot check references)`
              );
            }
            const uri = fileURLFromPath(params.file);
            // Stage 1: references (includeDeclaration:true) → check empty.
            const refsRaw = await requestOrMethodNotFoundSentinel(
              target.client,
              "textDocument/references",
              {
                textDocument: { uri },
                position,
                context: { includeDeclaration: true },
              },
              cancel.token
            );
            if (cancel.timedOut())
              throw timeoutError(name, "textDocument/references", timeoutMs);
            // Missing-method sentinel: the server has no references — we
            // cannot prove "no references", so fail closed: pass the
            // sentinel through and never enter the delete path (same
            // discipline as extractReferences refusing the delete).
            if (isMethodNotFoundSentinel(refsRaw)) return refsRaw;
            const references = extractReferences(refsRaw);
            if (references.length > 0) {
              // Typed failure path: return the reference list + an explicit
              // "not deleted". On seeing this the model should decide whether
              // to re-plan (migrate references first); a delete is never
              // silently reported as successful.
              return stringifyResult({
                deleted: false,
                symbol_path: target.path,
                references,
                message:
                  `refusing to delete ${target.path} in ${params.file}: ${references.length} reference(s) exist. ` +
                  `Resolve them first (find_referencing_symbols) before deleting.`,
              });
            }
            // Stage 2: no references → delete. range = full range (the whole
            // definition: signature and body alike).
            const range = fullRangeOf(target.symbol);
            if (!range) {
              throw new ToolExecutionError(
                `[${name}] symbol "${target.path}" in ${params.file} has no source range (cannot delete)`
              );
            }
            const edit: TextDocumentEdit = {
              textDocument: { uri },
              edits: [{ range, newText: "" }],
            };
            const applied = await applyWorkspaceEdit([edit], onEdit);
            return stringifyResult({
              deleted: true,
              symbol_path: target.path,
              files: applied.writtenFiles,
              editCount: applied.editCount,
            });
          }
        );
      } catch (err) {
        if (cancel.timedOut())
          throw timeoutError(name, "textDocument/references", timeoutMs);
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/** Normalize a `textDocument/references` response into a
 *  `{ file, line, character }` list. tsserver returns `Location[]`
 *  (`{ uri, range }`); older servers may return a flat array. **A malformed
 *  response (not an array) throws `ToolExecutionError`**: empty catches and
 *  silent fallbacks are forbidden here — we cannot "prove no references", so
 *  `safe_delete_symbol` must refuse the delete rather than take the "no
 *  references" path. A single unresolvable URI is skipped with `continue`
 *  (one entry's local failure does not mean "nothing is referenced", which
 *  the policy permits). */
function extractReferences(raw: unknown): ReadonlyArray<{
  readonly file: string;
  readonly line: number;
  readonly character: number;
}> {
  if (!Array.isArray(raw)) {
    throw new ToolExecutionError(
      `[safe_delete_symbol] textDocument/references returned non-array (${typeof raw}); refusing to delete (cannot prove no references).`
    );
  }
  const out: { file: string; line: number; character: number }[] = [];
  for (const ref of raw) {
    if (!ref || typeof ref !== "object") continue;
    const r = ref as {
      uri?: unknown;
      range?: { start?: LspPosition };
    };
    if (typeof r.uri !== "string") continue;
    const start = r.range?.start;
    if (!start) continue;
    let path: string;
    try {
      path = fileURLToPath(r.uri);
    } catch (_err) {
      continue;
    }
    out.push({
      file: path,
      line: start.line,
      character: start.character,
    });
  }
  return out;
}

/** `pathToFileURL` inlined to avoid a duplicate import alongside lsp.ts. */
function fileURLFromPath(file: string): string {
  // pathToFileURL is built into node:url; reuse it directly rather than
  // opening another import layer.
  return new URL(`file://${file}`).href;
}

// ---------------------------------------------------------------------------
// Factory entry point
// ---------------------------------------------------------------------------

/** Ground truth for the five symbol-mutation tool names (shared by the
 * registry's Gate 3 and the tests). */
export const SYMBOL_MUTATE_TOOL_NAMES = Object.freeze([
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
] as const);

/**
 * SSOT for the capability "a worker may directly write workspace files".
 *
 * `category: "write"` also covers worktree lifecycle and process-control
 * tools; those are not part of a worker's file-write capability surface, so
 * isolation conclusions must not be derived from category alone.
 */
export const FILE_WRITE_TOOL_NAMES = Object.freeze([
  "edit_file",
  "write_file",
  ...SYMBOL_MUTATE_TOOL_NAMES,
] as const);

/** Assembly entry (called from `registry.ts`).
 *
 * Same shape as `createSymbolQueryToolSet(ctx)`: build-engine passes the same
 * `lspCtx` at assembly time (settings.lsp / disabledServers / idle /
 * requestTimeoutMs). `onEdit` comes through from the registry's `opts.onEdit`
 * (the same source as edit_file's lspNotifier.invalidate callback), keeping
 * the post-write LSP view-sync semantics identical. */
export interface CreateSymbolMutateToolSetOptions {
  readonly ctx: LspCtx;
  readonly onEdit?: (file: string) => void;
}

export function createSymbolMutateToolSet(
  opts: CreateSymbolMutateToolSetOptions
): ReadonlyArray<AciToolDef> {
  const { ctx, onEdit } = opts;
  // Order matches SYMBOL_MUTATE_TOOL_NAMES (Gate 3 indexes by name; the
  // order is the contract).
  const tools: AciToolDef[] = [
    makeRenameSymbolTool(
      ctx,
      onEdit,
      "Rename a symbol across the project by its file path and symbol_path (e.g. `ClassName/methodName`). " +
        "The language server computes every reference site (declaration + all references across the project), " +
        "the edits are applied to disk and the workspace LSP views are invalidated. " +
        "Returns the list of files touched and the edit count. " +
        "Returns a typed failure string if the rename would conflict with an existing declaration; in that case nothing is written."
    ),
    makeReplaceSymbolBodyTool(
      ctx,
      onEdit,
      "Replace the entire definition body of a symbol — including the declaration header and body — by its file path and symbol_path. " +
        "The replacement range is the symbol's full LSP range (selectionRange alone is too narrow). " +
        "The file is written and the workspace LSP view is invalidated; returns the files touched. " +
        "Use it after find_declaration / get_hover to confirm the symbol, before writing the new body."
    ),
    makeInsertSymbolTool(ctx, onEdit, {
      name: "insert_before_symbol",
      direction: "before",
      description:
        "Insert code immediately before a symbol's definition (anchored to the start of the symbol's range) by its file path and symbol_path. " +
        "Use it to add a decorator, a sibling helper, or a leading comment block; pair with insert_after_symbol to bracket the symbol. " +
        "Returns the files touched and the edit count.",
    }),
    makeInsertSymbolTool(ctx, onEdit, {
      name: "insert_after_symbol",
      direction: "after",
      description:
        "Insert code immediately after a symbol's definition (anchored to the end of the symbol's range) by its file path and symbol_path. " +
        "Use it to add a follow-up function, a trailing comment block, or a sibling symbol; pair with insert_before_symbol to bracket the symbol. " +
        "Returns the files touched and the edit count.",
    }),
    makeSafeDeleteSymbolTool(
      ctx,
      onEdit,
      "Delete a symbol only if it has no references anywhere in the project. The tool first queries `textDocument/references` " +
        "(including the declaration); if any reference exists, it returns `{ deleted: false, references: [...] }` and writes nothing. " +
        "Use it as the safety wrapper around delete; resolve the references first, then retry."
    ),
  ];
  // Fail fast at construction when the name list and the factories diverge,
  // rather than leaving it to runtime (same discipline as registry Gate 3).
  if (tools.length !== SYMBOL_MUTATE_TOOL_NAMES.length) {
    throw new Error(
      `symbol mutate tool count mismatch: have=${tools.length} want=${SYMBOL_MUTATE_TOOL_NAMES.length}`
    );
  }
  return Object.freeze(tools);
}
