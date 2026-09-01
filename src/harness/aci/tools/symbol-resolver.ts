/**
 * 符号身份 → LSP position 的解析层（spec `symbol-primary-aci` T2）。
 *
 * **为什么存在**：spec 规定「禁止把第几行第几列当作符号工具的主入参」。
 * 模型只给 `{ file, symbol_path }`；本模块把 `symbol_path`（文件内符号树
 * 路径，如 `ClassName/methodName`）译成 `textDocument/*` 请求需要的
 * 0-based `position`。译码只在实现内部发生，公共 API 不出现行列。
 *
 * **分层纪律**（complexity-anti-drift）：本模块只做「符号树 → position」，
 * 不发业务 RPC、不渲染模型可见字符串、不认识任何工具名。工具层
 * （`symbol.ts`）负责 client 解析、取消/超时、失败串渲染。
 *
 * **缓存**：per-client、per-uri 的 documentSymbol 快照，用
 * `client.getOpenVersion(uri)` 作版本键 —— `edit_file` 写盘后
 * notifier 走 `didChange` 使 openVersion +1，快照自然失效（不另建
 * invalidate 通道）。并发同 uri 走 inflight 去重，与 `lsp/client.ts` 的
 * 三件套语义同形（同一时刻只发一次 documentSymbol）。
 * WeakMap 以 client 为键 —— client 被逐出连接池即随之回收。
 */
import { pathToFileURL } from "node:url";

import type { CancellationToken } from "vscode-jsonrpc/node";

import type { LspClient } from "../../lsp/client.js";

/** LSP 0-based position（line/character 均 0-based，与协议一致）。 */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

interface LspRange {
  readonly start?: LspPosition;
}

/**
 * `textDocument/documentSymbol` 的两种响应形态归一后的节点：
 *   - `DocumentSymbol`（嵌套）：`range` / `selectionRange` / `children`；
 *   - `SymbolInformation`（扁平，老 server）：`location.range`，无 children。
 * 两者都只读 name + 位置 + children，其余字段留在原始 payload 里不翻译
 * （语义归语言服务器，契约与 `lsp.ts` 一致）。
 */
export interface DocumentSymbolNode {
  readonly name: string;
  readonly kind?: number;
  readonly range?: LspRange;
  readonly selectionRange?: LspRange;
  readonly location?: { readonly range?: LspRange };
  readonly children?: ReadonlyArray<DocumentSymbolNode>;
}

/** 候选名单封顶：候选列表进模型上下文，不能随文件符号数线性膨胀。 */
export const MAX_SYMBOL_CANDIDATES = 20;

/**
 * 解析结果判别联合。失败态不抛异常 —— 「符号找不到」是合法的查询结果，
 * 由工具层渲染成模型可读失败串（`ToolExecutionError` 留给协议级故障）。
 *   - `found`：命中唯一符号，`position` 可直接进 LSP 请求；
 *   - `not_found`：路径无匹配，`candidates` 给文件里的实际符号路径（封顶）；
 *   - `ambiguous`：多处匹配，`candidates` 列全部命中路径（封顶）；
 *   - `no_position`：命中了节点但 server 未给 range/selectionRange/location
 *     （畸形响应）—— 与「没这个符号」是两回事，显式区分而非静默归并。
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
  | { readonly kind: "no_position"; readonly path: string };

interface CacheEntry {
  readonly version: number | undefined;
  readonly nodes: ReadonlyArray<DocumentSymbolNode>;
}

const symbolCache = new WeakMap<LspClient, Map<string, CacheEntry>>();
const symbolInflight = new WeakMap<
  LspClient,
  Map<string, Promise<ReadonlyArray<DocumentSymbolNode>>>
>();

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

/** 把 documentSymbol 响应归一成节点树（非数组 / 畸形项 → 丢弃，不抛）。 */
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
 * 取（或建立）该 uri 的 documentSymbol 快照。
 * 版本键 = `client.getOpenVersion(uri)`：didOpen=1、每次 didChange +1；
 * 版本变了即重取（编辑后不会拿旧树定位到错误 position）。
 * 请求失败原样上抛 —— 工具层的 catch 负责区分超时与业务错误。
 */
async function fetchDocumentSymbols(
  client: LspClient,
  file: string,
  token?: CancellationToken
): Promise<ReadonlyArray<DocumentSymbolNode>> {
  const uri = pathToFileURL(file).href;
  const version = client.getOpenVersion(uri);
  const cache = mapFor(symbolCache, client);
  const hit = cache.get(uri);
  if (hit && hit.version === version) return hit.nodes;

  const inflight = mapFor(symbolInflight, client);
  const pending = inflight.get(uri);
  if (pending) return pending;

  const task = client
    .sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      token
    )
    .then((raw) => {
      const nodes = normalizeSymbols(raw);
      // 用请求返回时的 openVersion 记账：请求期间若发生 didChange，
      // 下次调用版本不匹配会重取（宁可多取一次，不可用陈旧树定位）。
      cache.set(uri, { version: client.getOpenVersion(uri), nodes });
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

/** 从给定层开始，按 segments 逐段沿 name 下钻；返回全部命中。 */
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

/** 在任意子树上尝试 segments（允许模型只给 `methodName` 而非全路径）。 */
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
  // 同一节点可能被 rooted 与 anywhere 两条路径命中同一 path，去重。
  return [...new Map(out.map((m) => [m.path, m])).values()];
}

/** 展平文件符号路径（供 not_found 候选提示），封顶 MAX_SYMBOL_CANDIDATES。 */
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

/** 定义位置：优先 selectionRange（符号名本身），回退 range / location.range。 */
function positionOf(node: DocumentSymbolNode): LspPosition | undefined {
  return (
    node.selectionRange?.start ??
    node.range?.start ??
    node.location?.range?.start
  );
}

/** `a/b//c ` → `["a","b","c"]`（空段与首尾空白容错，不产生空 name 匹配）。 */
export function splitSymbolPath(symbolPath: string): ReadonlyArray<string> {
  return symbolPath
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 把 `{ file, symbol_path }` 解析成 LSP position。
 *
 * 匹配顺序：先按根路径严格下钻（`Class/method`），无命中再在任意子树上试
 * （模型只知道 `method` 时也能命中）。多命中 → `ambiguous`（不猜第一个：
 * 猜错会让后续 rename / references 作用在错误符号上）。
 */
export async function resolveSymbolPosition(
  client: LspClient,
  file: string,
  symbolPath: string,
  token?: CancellationToken
): Promise<SymbolResolution> {
  const segments = splitSymbolPath(symbolPath);
  const nodes = await fetchDocumentSymbols(client, file, token);
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
