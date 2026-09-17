/**
 * 符号查询 ACI 工具集 —— spec `symbol-primary-aci`（模型面查询 10 件）。
 *
 * **与 `lsp.ts` 的关系**：`lsp.ts` 的 10 件 `lsp_*` 以「文件 + 行 + 列」提问，
 * 模型必须先 grep 到某一行才能用；本模块以**符号身份**提问
 * （`{ file, symbol_path }`），行列译码封在 `symbol-resolver.ts` 内部。
 * T2 阶段两套并存（旧面 T5 才从模型面移除），故 LSP 客户端解析、取消/超时、
 * 无服务器哨兵、输出封顶全部复用 `lsp.ts` 的既有实现 —— 同一条链路只能有
 * 一份语义（SSOT），复制一份必然漂移。
 *
 * 边界（继承 `lsp.ts`）：
 *   - **永不** `process.kill`；中断走 `$/cancelRequest`。
 *   - **永不** 返回结构化 payload（契约 Y1，handler 恒返字符串）。
 *   - **永不** 翻译 LSP payload 字段（语义归语言服务器）。
 *   - 符号解析失败（找不到 / 歧义 / 畸形节点）是**查询结果**，渲染成可读
 *     字符串；协议/超时故障才抛 `ToolExecutionError`。
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
  extractCallHierarchyItems,
  getClientForWorkspaceDetailed,
  isMethodNotFoundSentinel,
  isNoProjectAnchorError,
  makeDiagnosticsTool,
  renderMethodNotFound,
  renderNoProjectAnchor,
  renderNoServer,
  requestOrMethodNotFoundSentinel,
  stringifyResult,
  timeoutError,
} from "./lsp.js";
import {
  resolveSymbolPosition,
  type LspPosition,
  type SymbolResolution,
} from "./symbol-resolver.js";

/**
 * 符号身份入参（spec §符号身份）：相对/绝对文件路径 + 文件内符号树路径。
 * 无 `line` / `character` —— 这是本工具集与 `lsp_*` 的根本差别，schema 的
 * `additionalProperties: false` 让「顺手补个行列」在校验期就失败。
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

/** 单文件大纲：只要文件路径（大纲本身就是「还不知道符号名」的入口）。 */
const FILE_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", minLength: 1 },
  },
  required: ["file"],
  additionalProperties: false,
} as const;

/**
 * `find_symbol` 入参：`query` **必填且非空**（spec §Model-facing tool set：
 * `workspace/symbol` 的空 query 快照不再是工作区查找的产品语义）。
 * `file` 可选，仅用于把语言服务器选择锚定到该文件所属工程。
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

/** 符号身份 → `textDocument/*` params（position 已是 0-based，无需换算）。 */
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
 * 符号解析失败 → 模型可读字符串（契约 Y1）。
 * 每条都带可行动的下一步：候选路径 / 消歧提示 / 大纲工具名。
 *
 * `method_not_found` 复用 `lsp.ts` 的哨兵渲染（SSOT，不复制文案字面量）——
 * 符号族的缺方法语义与坐标族逐字一致，probe 的 skip 判定才认得出。
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
      // 调用方在 kind === "found" 时不会走到这里；保留穷尽分支让编译期兜底。
      return `(symbol "${res.path}" resolved in ${file})`;
  }
}

/**
 * 符号身份 → 已解析的 position，并在**请求级打开窗口**内执行 `run`。
 *
 * 窗口必须罩住解析与随后的业务请求：解析要 didOpen 才建得起来 project，
 * 业务请求要同一份 server 侧文本；退出窗口即 didClose（spec 251「打开文档
 * 生命周期」—— 两次调用之间文件不对 server 保持打开）。
 *
 * 三段：解析语言服务器 → `withDocumentOpen` + documentSymbol 树定位 → `run`。
 * 失败路径归一成模型可读字符串（契约 Y1），与成功路径的 stringify 同形。
 */
async function withResolvedSymbol<T>(
  ctx: LspCtx,
  file: string,
  symbolPath: string,
  token: CancellationToken,
  run: (client: LspClient, position: LspPosition) => Promise<T>
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
      return renderResolution(file, symbolPath, resolved);
    }
    return run(client, resolved.position);
  });
}

interface SymbolOperationSpec {
  readonly name: string;
  readonly method: string;
  readonly description: string;
  /** 已解析的 position → LSP request params（references 需再挂 context）。 */
  readonly buildParams: (file: string, position: LspPosition) => unknown;
}

/**
 * 单步符号 operation 工厂：符号身份 → position → 一次 LSP request。
 * 超时/abort 统一经 `createRequestCancellation`（与 `lsp.ts` 同一条取消链路，
 * 覆盖 documentSymbol 定位与业务请求两段）。
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
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      try {
        return await withResolvedSymbol(
          ctx,
          params.file,
          params.symbol_path,
          cancel.token,
          async (client, position) => {
            const result = await requestOrMethodNotFoundSentinel(
              client,
              spec.method,
              spec.buildParams(params.file, position),
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
 * 调用图两件（incoming / outgoing）：符号身份 → position →
 * `prepareCallHierarchy` 取首个 item → forward 给 incoming/outgoing。
 * 与 `lsp.ts` 的多步形态同构，只换了入参从行列到符号身份。
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
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      let timedOutMethod = "textDocument/prepareCallHierarchy";
      try {
        return await withResolvedSymbol(
          ctx,
          params.file,
          params.symbol_path,
          cancel.token,
          async (client, position) => {
            const prepared = await requestOrMethodNotFoundSentinel(
              client,
              "textDocument/prepareCallHierarchy",
              symbolPositionParams(params.file, position),
              cancel.token
            );
            if (cancel.timedOut())
              throw timeoutError(name, timedOutMethod, timeoutMs);
            // 缺方法哨兵：server 没有 call hierarchy —— 透传（不再 forward）。
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
 * 无 `file` 分岔的「无 project 锚点」判别（plan T3）：命中 → 分层哨兵字符串。
 *
 * 两种可观测形态收敛到同一条哨兵（根因见 lsp.ts `renderNoProjectAnchor`）：
 *   - tsserver 抛 `No Project.`（锚点文件不属于任何 project）；
 *   - 无 project 上下文下 RPC 正常返回 `[]`。
 *
 * **`[]` 的新契约**：只有「查到了、真没这个符号」才返 `[]`；无锚点的空结果
 * 不再冒充查询结果。返回 `undefined` = 不是无锚点形态（正常数据 / 缺方法哨兵 /
 * 其它错误），由调用方按既有语义处理。
 *
 * 非空结果原样透传（§8.4：正确锚点下覆盖也可能不完整，但那属于 description
 * 的常驻警示面，不是本判别的事）。
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
 * `find_symbol`：按名字/模式在工作区里找符号（`workspace/symbol`）。
 * `file` 缺省时按 `SERVERS` 声明序试探可用语言服务器（继承 `lsp.ts` 的
 * 工作区级 dispatch）；空 query 由 schema `minLength: 1` 在校验期拒绝。
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
            // EXIT: 无 `file` = 无 project 锚点，空结果不可信 → 分层哨兵
            // （`[]` 从今只表示「查到了、真没这个符号」）。带 `file` 的路径
            // 不走这里，行为逐字节不变。
            const sentinel = noAnchorSentinelOrUndefined(ctx, result);
            if (sentinel !== undefined) return sentinel;
          }
          return stringifyResult(result);
        } catch (err) {
          if (cancel.timedOut()) throw timeoutError(name, method, timeoutMs);
          if (params.file === undefined) {
            // EXIT: tsserver 的 `No Project.`（锚点不属于任何 project）同样
            // 是无锚点形态 —— 收敛到同一哨兵，不让它冒充 RPC 故障。判定窄：
            // 只认这一条 message，其余错误照旧上抛。
            if (isNoProjectAnchorError(err)) return renderNoProjectAnchor(ctx);
          }
          throw err;
        } finally {
          cancel.dispose();
        }
      };
      return params.file !== undefined
        ? client.withDocumentOpen(params.file, run)
        : run();
    },
  });
}

/**
 * `get_symbols_overview`：单文件符号大纲 —— 「还不知道符号名」时的入口
 * （spec §符号身份：用大纲或 find_symbol，而不是先 grep 源码）。
 * 输出是 server 原始 documentSymbol 树（契约 Y1 stringify），模型从中读出
 * `name` 与嵌套关系即可拼出别的工具要的 `symbol_path`。
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
      const { client, failure } = await getClientDetailed(ctx, params.file);
      if (!client) {
        return renderNoServer(
          ctx,
          failure ?? { reason: "no-server" },
          params.file
        );
      }
      const timeoutMs = ctx.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
      const cancel = createRequestCancellation(execCtx, timeoutMs);
      return client.withDocumentOpen(params.file, async () => {
        try {
          const result = await requestOrMethodNotFoundSentinel(
            client,
            method,
            {
              textDocument: { uri: pathToFileURL(params.file).href },
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

/** 10 件符号查询工具的名字真值（registry Gate 3 与测试共源）。 */
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
 * MCP transport 用的 Zod schema（SDK 2.0 `registerTool` 的 `inputSchema` 接受
 * Standard Schema；Zod 4 即合规）。与 ACI 进程内的 JSON Schema（`SYMBOL_SCHEMA` /
 * `FILE_SCHEMA` / `FIND_SYMBOL_SCHEMA`）**不重复**：JSON Schema 给 ajv 校验
 * handler 入参，Zod 给 MCP transport —— 同一组字段各写一份是必要的（不同验证器
 * 不同语言），但同一验证器类型内 SSOT 不能再分裂。
 *
 * **`SYMBOL_QUERY_ZOD_SCHEMAS` 即 MCP Zod schema 的 SSOT**：键集合与
 * `SYMBOL_QUERY_TOOL_NAMES` 一一对应，缺一即构造期 fail-fast（与
 * `createSymbolQueryToolSet` 同纪律）。MCP 装配（`src/lsp-mcp/server.ts`）
 * 只 import，不内联。
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
 * 构造符号查询工具集（`registry.ts` 装配入口）。
 *
 * 返回顺序与 `SYMBOL_QUERY_TOOL_NAMES` 一致（Gate 3 按名索引，顺序即契约）。
 * description 全部按**符号身份**行文 —— 不出现「先给行列」，与 spec
 * 「禁止把第几行第几列当作这些工具的主入参」对齐（D9 正面触发措辞）。
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
      // 构造期 fail-fast：名单与工厂分歧不留到运行期（与 registry Gate 3 同纪律）。
      if (!tool) throw new Error(`symbol query tool missing: ${name}`);
      return tool;
    })
  );
}
