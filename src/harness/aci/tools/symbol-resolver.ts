/**
 * Resolution layer from symbol identity → LSP position.
 *
 * **Why it exists**: line/column must never be a symbol tool's primary
 * input. The model only supplies `{ file, symbol_path }`; this module
 * translates `symbol_path` (a path in the file's symbol tree, e.g.
 * `ClassName/methodName`) into the 0-based `position` that `textDocument/*`
 * requests need. The decoding happens only inside this module — the public
 * API never surfaces line/column.
 *
 * **Layering discipline**: this module only does "symbol tree → position".
 * It issues no business RPCs (the single documentSymbol request shares
 * `lsp.ts`'s gated entry, see `fetchDocumentSymbols`), renders no
 * model-visible strings, and knows no tool names. The tool layer
 * (`symbol.ts`) owns client resolution, cancellation/timeout, and failure
 * string rendering.
 *
 * **Cache**: per-client, per-uri documentSymbol snapshots keyed by the
 * fingerprint of the text synced to the server
 * (`client.getDocumentFingerprint`); the mechanism and rationale are
 * documented authoritatively in exactly one place, the
 * `fetchDocumentSymbols` doc (no fact maintained twice). Concurrent
 * requests for the same uri deduplicate through an inflight map, matching
 * lsp/client.ts's three-piece semantics (only one documentSymbol request in
 * flight at a time). The WeakMap is keyed by client — evicting a client from
 * the connection pool collects its caches too.
 */
import { pathToFileURL } from "node:url";

import { CancellationToken } from "vscode-jsonrpc/node";

import type { LspClient } from "../../lsp/client.js";
import {
  isMethodNotFoundSentinel,
  requestOrMethodNotFoundSentinel,
} from "./lsp.js";

/** The only request this module issues — same method name as in `lsp.ts` /
 * `symbol.ts`. */
const DOCUMENT_SYMBOL_METHOD = "textDocument/documentSymbol";

/** LSP 0-based position (line/character both 0-based, per protocol). */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

interface LspRange {
  readonly start?: LspPosition;
}

/**
 * Node shape after normalizing the two `textDocument/documentSymbol`
 * response forms:
 *   - `DocumentSymbol` (nested): `range` / `selectionRange` / `children`;
 *   - `SymbolInformation` (flat, older servers): `location.range`, no children.
 * Both are read only for name + position + children; remaining fields stay
 * in the raw payload untranslated (that semantics belongs to the language
 * server, same contract as `lsp.ts`).
 */
export interface DocumentSymbolNode {
  readonly name: string;
  readonly kind?: number;
  readonly range?: LspRange;
  readonly selectionRange?: LspRange;
  readonly location?: { readonly range?: LspRange };
  readonly children?: ReadonlyArray<DocumentSymbolNode>;
}

/** Candidate list cap: candidates enter the model context, so they must not
 * grow linearly with the file's symbol count. */
export const MAX_SYMBOL_CANDIDATES = 20;

/**
 * Discriminated union of resolution outcomes. Failure states never throw —
 * "symbol not found" is a legal query result, rendered by the tool layer
 * into a model-readable failure string (`ToolExecutionError` is reserved
 * for protocol-level faults).
 *   - `found`: exactly one symbol matched; `position` goes straight into an
 *     LSP request;
 *   - `not_found`: no path match; `candidates` lists actual symbol paths in
 *     the file (capped);
 *   - `ambiguous`: multiple matches; `candidates` lists all hit paths (capped);
 *   - `no_position`: a node matched but the server gave no
 *     range/selectionRange/location (malformed response) — a different fact
 *     from "no such symbol", kept explicit instead of silently merged;
 *   - `method_not_found`: the server does not support
 *     `textDocument/documentSymbol` (explicit `documentSymbolProvider: false`
 *     or RPC `-32601`) — a capability gap is also a legal query result (the
 *     missing-method sentinel is not counted as a spawn failure); the tool
 *     layer renders it via `renderMethodNotFound`. The sentinel itself lives
 *     in `lsp.ts` (SSOT); this module only passes the `method` fact.
 */
export type SymbolResolution =
  | {
      readonly kind: "found";
      readonly position: LspPosition;
      readonly symbol: DocumentSymbolNode;
      readonly path: string;
    }
  | { readonly kind: "not_found"; readonly candidates: ReadonlyArray<string> }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly kind: "no_position"; readonly path: string }
  | { readonly kind: "method_not_found"; readonly method: string };

/** `undefined` = capability-gap (sentinel) result; it merges into the same
 * shape as the symbol tree, so both share one cache type. */
type SymbolSnapshot = ReadonlyArray<DocumentSymbolNode> | undefined;

interface CacheEntry {
  readonly fingerprint: string | undefined;
  readonly nodes: SymbolSnapshot;
}

const symbolCache = new WeakMap<LspClient, Map<string, CacheEntry>>();
const symbolInflight = new WeakMap<
  LspClient,
  Map<string, Promise<SymbolSnapshot>>
>();

/**
 * The gated entry requires a token, while this module's public signature
 * makes it optional (callers that omit it have no cancellation intent).
 * `CancellationToken.None` is the standard expression of "not cancellable",
 * matching the old behavior of handing `undefined` straight to
 * `client.sendRequest`.
 */
const NO_CANCELLATION = CancellationToken.None;

function mapFor<V>(
  store: WeakMap<LspClient, Map<string, V>>,
  client: LspClient
): Map<string, V> {
  const existing = store.get(client);
  if (existing) return existing;
  const created = new Map<string, V>();
  store.set(client, created);
  return created;
}

/** Normalize a documentSymbol response into a node tree (non-array /
 * malformed entries → dropped, never thrown). */
function normalizeSymbols(raw: unknown): ReadonlyArray<DocumentSymbolNode> {
  if (!Array.isArray(raw)) return [];
  const out: DocumentSymbolNode[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const node = item as DocumentSymbolNode;
    if (typeof node.name !== "string") continue;
    out.push({
      ...node,
      children: normalizeSymbols(node.children),
    });
  }
  return out;
}

/**
 * Fetch the symbol tree through the capability-gated request path.
 *
 * Why not `client.sendRequest` directly: the method-not-found sentinel and
 * the initialize capability gate both live in
 * `requestOrMethodNotFoundSentinel` (`lsp.ts`). A direct call would still
 * send RPCs when the server **explicitly declares**
 * `documentSymbolProvider: false` and would throw on `-32601` (executor
 * records `execution_failed`), while the initialize-capability + sentinel
 * contract requires both paths to converge on the same sentinel and **not**
 * count as spawn failure. Every symbol-* tool enters here.
 *
 * Returns a discriminated union, not a string: the sentinel itself is a
 * string rendered at the tool-handler layer; this module only passes the
 * "server unsupported" fact upward.
 */
async function requestDocumentSymbols(
  client: LspClient,
  uri: string,
  token: CancellationToken
): Promise<
  | { readonly ok: true; readonly nodes: ReadonlyArray<DocumentSymbolNode> }
  | { readonly ok: false }
> {
  const raw = await requestOrMethodNotFoundSentinel(
    client,
    DOCUMENT_SYMBOL_METHOD,
    { textDocument: { uri } },
    token
  );
  if (isMethodNotFoundSentinel(raw)) return { ok: false };
  return { ok: true, nodes: normalizeSymbols(raw) };
}

/**
 * Get (or establish) the documentSymbol snapshot for a uri.
 * Cache key = `client.getDocumentFingerprint(uri)` (identity of the text
 * content synced to the server). **Not openVersion**: with per-request
 * opens every didOpen restarts at version 1, so two opens share a value —
 * a version cannot distinguish two opens of the same file, and a file
 * changed out-of-band would be positioned by a stale symbol tree. The
 * fingerprint only changes when content changes; re-fetch on mismatch.
 * Capability gap (explicit false / -32601) → `undefined`, which callers
 * turn into `method_not_found`; other request failures propagate as-is —
 * the tool-layer catch separates timeout from business errors.
 */
async function fetchDocumentSymbols(
  client: LspClient,
  file: string,
  token?: CancellationToken
): Promise<SymbolSnapshot> {
  const uri = pathToFileURL(file).href;
  const fingerprint = client.getDocumentFingerprint(uri);
  const cache = mapFor(symbolCache, client);
  const hit = cache.get(uri);
  if (hit && hit.fingerprint === fingerprint) return hit.nodes;

  const inflight = mapFor(symbolInflight, client);
  const pending = inflight.get(uri);
  if (pending) return pending;

  const task = requestDocumentSymbols(client, uri, token ?? NO_CANCELLATION)
    .then((res) => {
      // Capability gaps (sentinel) are cached too: hit-or-refetch keeps
      // both paths semantically identical and stops the tool family from
      // re-hitting a known gap on every call.
      const nodes = res.ok ? res.nodes : undefined;
      // Account with the fingerprint at response time: a didChange during
      // the request makes the next call mismatch and refetch (better one
      // extra fetch than positioning by a stale tree).
      cache.set(uri, {
        fingerprint: client.getDocumentFingerprint(uri),
        nodes,
      });
      return nodes;
    })
    .finally(() => {
      inflight.delete(uri);
    });
  inflight.set(uri, task);
  return task;
}

interface Match {
  readonly node: DocumentSymbolNode;
  readonly path: string;
}

/** Descend from the given level segment-by-segment along `name`; return all hits. */
function matchFrom(
  nodes: ReadonlyArray<DocumentSymbolNode>,
  segments: ReadonlyArray<string>,
  prefix: string
): ReadonlyArray<Match> {
  const [head, ...rest] = segments;
  if (head === undefined) return [];
  const out: Match[] = [];
  for (const node of nodes) {
    if (node.name !== head) continue;
    const path = prefix === "" ? node.name : `${prefix}/${node.name}`;
    if (rest.length === 0) out.push({ node, path });
    else out.push(...matchFrom(node.children ?? [], rest, path));
  }
  return out;
}

/** Try segments on any subtree (the model may give just `methodName`, not a full path). */
function matchAnywhere(
  nodes: ReadonlyArray<DocumentSymbolNode>,
  segments: ReadonlyArray<string>,
  prefix: string
): ReadonlyArray<Match> {
  const out: Match[] = [...matchFrom(nodes, segments, prefix)];
  for (const node of nodes) {
    const path = prefix === "" ? node.name : `${prefix}/${node.name}`;
    out.push(...matchAnywhere(node.children ?? [], segments, path));
  }
  // A node can be hit by both the rooted and anywhere passes at the same path; dedupe.
  return [...new Map(out.map((m) => [m.path, m])).values()];
}

/** Flatten a file's symbol paths (for not_found candidate hints), capped at MAX_SYMBOL_CANDIDATES. */
export function collectSymbolPaths(
  nodes: ReadonlyArray<DocumentSymbolNode>,
  prefix = "",
  out: string[] = []
): ReadonlyArray<string> {
  for (const node of nodes) {
    if (out.length >= MAX_SYMBOL_CANDIDATES) break;
    const path = prefix === "" ? node.name : `${prefix}/${node.name}`;
    out.push(path);
    collectSymbolPaths(node.children ?? [], path, out);
  }
  return out.slice(0, MAX_SYMBOL_CANDIDATES);
}

/** Definition site: prefer selectionRange (the name itself), fall back to range / location.range. */
function positionOf(node: DocumentSymbolNode): LspPosition | undefined {
  return (
    node.selectionRange?.start ??
    node.range?.start ??
    node.location?.range?.start
  );
}

/** `a/b//c ` → `["a","b","c"]` (tolerates empty segments and padding; never matches an empty name). */
export function splitSymbolPath(symbolPath: string): ReadonlyArray<string> {
  return symbolPath
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve `{ file, symbol_path }` to an LSP position.
 *
 * Match order: strict descent from the root first (`Class/method`); if no
 * hit, try any subtree (so a bare `method` still resolves). Multiple hits →
 * `ambiguous` (never guess the first: a wrong pick would aim subsequent
 * rename / references at the wrong symbol).
 *
 * Server without `textDocument/documentSymbol` (explicit false / `-32601`)
 * → `method_not_found` (a capability gap is intrinsic to the server, not a
 * resolution failure); the tool layer renders the same sentinel string and
 * does **not** throw `ToolExecutionError`.
 */
export async function resolveSymbolPosition(
  client: LspClient,
  file: string,
  symbolPath: string,
  token?: CancellationToken
): Promise<SymbolResolution> {
  const segments = splitSymbolPath(symbolPath);
  const nodes = await fetchDocumentSymbols(client, file, token);
  // No symbol tree → symbol identity is moot (we do not even know which symbols the file has).
  if (nodes === undefined) {
    return { kind: "method_not_found", method: DOCUMENT_SYMBOL_METHOD };
  }
  if (segments.length === 0) {
    return { kind: "not_found", candidates: collectSymbolPaths(nodes) };
  }

  const rooted = matchFrom(nodes, segments, "");
  const matches =
    rooted.length > 0 ? rooted : matchAnywhere(nodes, segments, "");
  if (matches.length === 0) {
    return { kind: "not_found", candidates: collectSymbolPaths(nodes) };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      candidates: matches.map((m) => m.path).slice(0, MAX_SYMBOL_CANDIDATES),
    };
  }

  const match = matches[0]!;
  const position = positionOf(match.node);
  if (!position) return { kind: "no_position", path: match.path };
  return {
    kind: "found",
    position,
    symbol: match.node,
    path: match.path,
  };
}
