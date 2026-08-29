/**
 * LSP ACI 工具集 —— spec 251-lsp-tool（§ aci/tools/lsp.ts：9 件 handler 极薄）。
 *
 * 暴露 9 件 + lsp_diagnostics = 10 件 LSP 工具（spec 计数存在 9-vs-8 不一致，
 * 详见 T6 报告：导出 9 件 operation + lsp_diagnostics；T7 append 10 → 20 件需
 * 调整为 21，见 `ADR-0006` 收口）。
 *
 * 设计（spec #247 Q3 MCP 无状态思路）：
 *   - handler 极薄：参数校验（ajv 严格编译同源）→  await getClient(ctx, file)
 *     → 无 client 返 `"(no LSP server available for file)"` → sendRequest →
 *     JSON.stringify（封顶 MAX_RESULT_BYTES + truncated footer，plan T3）。
 *     契约 Y1：handler 永远返纯字符串。
 *   - 三件套缓存（root+id / broken / inflight）由 client.ts 拥有，工具层零知识。
 *   - cancel / 超时都走 CancellationTokenSource → JSON-RPC `$/cancelRequest`
 *     （Q2/A9 + plan T1：per-request 20s 超时先于 executor 30s race 干净让路），
 *     本模块不持有任何进程信号。
 *   - 8 件共享 POSITION_SCHEMA（{file, line, character} 1-based line / 0-based
 *     character）；lsp_document_symbol, lsp_diagnostics 仅需 file；
 *     lsp_workspace_symbol 的 file / query 均可选（plan T3）。
 *
 * 工厂签名：`createLspToolSet(ctx: LspCtx): ReadonlyArray<AciToolDef>`。
 *   - registry.ts (T7) 调用工厂拿 10 件冻结 tool defs，append 到默认注册表。
 *   - 传入 ctx 由 build-engine 装配（spec `LspCtx.directory` = process.cwd()）。
 *
 * 边界：
 *   - **永不** `process.kill`（Q2/A9）。
 *   - **永不** 返回结构化 payload（契约 Y1）。
 *   - **永不** 读取/翻译 LSP payload 字段（语义归 tsserver / typescript-language-server）。
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { CancellationTokenSource } from "vscode-jsonrpc/node";
import type { CancellationToken } from "vscode-jsonrpc/node";

import { getClient } from "../../lsp/client.js";
import { SERVERS } from "../../lsp/server.js";
import type { LspCtx } from "../../lsp/types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import type { AciToolDef } from "../types.js";

/**
 * 严格模式 ajv 单例：handler 编译 inputSchema 用，与 tools/registry.ts 装配期
 * 编译同源（015 强制同源 schema）。`coerceTypes: false`（不隐式转换） +
 * `strict: true`（不猜测缺失值，对齐 tools/registry.ts）。
 */
const lspAjv = new Ajv.default({
  strict: true,
  allErrors: true,
  coerceTypes: false,
});

/** 8 件 position 操作共享的 JSON Schema（spec §aci/tools/lsp.ts POSITION_SCHEMA）。 */
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

/** 仅 file 必填的 JSON Schema（document_symbol / diagnostics）。 */
const FILE_ONLY_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
  },
  required: ["file"],
  additionalProperties: false,
} as const;

/**
 * lsp_workspace_symbol 专用 schema（lsp-optimization plan T3）：`file` 改可选
 * （工作区级查询本就无需文件锚点，旧 schema 必填 file 但 buildParams 忽略之），
 * 新增可选 `query`（旧实现 query 恒为 ""）。无 required。
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
 * per-request 超时上限（lsp-optimization plan T1）：executor 30s race 超时后
 * 请求仍继续占用 server；连接内 20s 先触发，经 CancellationTokenSource
 * `cancel()` 自动向 server 发 `$/cancelRequest`（Q2/A9，不杀进程），干净让路。
 */
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 20_000;

/**
 * lsp_diagnostics 读前等待 deadline（lsp-optimization plan T3）：ensureOpen 后
 * push diagnostics 尚未到达时立即读 diagStore 会得到空。每 100ms 轮询一次，
 * 首个该 uri 诊断到达即继续；deadline 到用现有内容（可能 undefined → 空渲染）。
 */
export const DIAGNOSTICS_WAIT_MS = 2_000;

/**
 * 工具输出封顶（lsp-optimization plan T3）：references 等大响应原样
 * stringify 进上下文可撑爆预算。超出截断 + footer（N 为完整字节数）。
 */
export const MAX_RESULT_BYTES = 48 * 1024;

/** 工具共用的 ajv 元数据（spec aci 元：read-only / 非并发安全 / cancel / 30s）。 */
const LSP_ACI_META = {
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

/** lsp_workspace_symbol 输入：file / query 均可选（plan T3）。 */
interface WorkspaceSymbolInput {
  readonly file?: string;
  readonly query?: string;
}

/**
 * 把任意 LSP 响应规范成纯字符串（契约 Y1：永不返回结构化 payload），
 * 并封顶到 MAX_RESULT_BYTES（截 stringify 后的结果；N = 完整字节数）。
 */
function stringifyResult(result: unknown): string {
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

/** 输出封顶：按字符回退截断（不在多字节字符中间切断）+ truncated footer。 */
function capResult(text: string): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= MAX_RESULT_BYTES) return text;
  // 近似起点：UTF-8 字节数 ≥ 字符数，cap 字符的字节数只可能因多字节字符
  // 超出，逐字符回退到字节边界内（>48KB 才进入，回退步数有限）。
  let cut = MAX_RESULT_BYTES;
  while (cut > 0 && Buffer.byteLength(text.slice(0, cut), "utf8") > MAX_RESULT_BYTES) {
    cut--;
  }
  const shown = text.slice(0, cut);
  const shownBytes = Buffer.byteLength(shown, "utf8");
  return `${shown}\n...[truncated, ${shownBytes} of ${total} bytes shown]`;
}

/** 编译 schema 为 ajv validator + 构造抛错版 parse。 */
function compileValidator(
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

/** Position 操作 → textDocument/position params（1-based line 转 0-based）。 */
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

/** document_symbol params：textDocument only，不带 position。 */
function documentSymbolParams(file: string): unknown {
  return { textDocument: { uri: pathToFileURL(file).href } };
}

/** workspace/symbol params：接可选 query（空字符串 = 全部符号快照）。 */
function workspaceSymbolParams(query?: string): unknown {
  return { query: query ?? "" };
}

/** references params：position + includeDeclaration 上下文。 */
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
  /** #483 D9: per-operation description — each of the 7 positionOps gets its
   *  own sentence instead of sharing a generic template, so the model prompt
   *  sees positive-trigger phrasing tuned to the operation. */
  readonly description: string;
  /** 把 ajv-validated input 映射到 LSP request params。 */
  readonly buildParams: (
    input: PositionInput | FileOnlyInput | WorkspaceSymbolInput
  ) => unknown;
}

/**
 * per-request 取消/超时控制（lsp-optimization plan T1）：
 *   - **超时**：timer 到 DEFAULT_LSP_REQUEST_TIMEOUT_MS 后 `source.cancel()`。
 *     token 被 cancel 时 vscode-jsonrpc 自动向 server 发 `$/cancelRequest`
 *     （Q2/A9 取消语义），pending request 随之 reject —— 不 kill 进程，
 *     server 有机会中断计算继续服务后续请求。
 *   - **abort 桥接**：executor 透传的 AbortSignal abort 时同样 `source.cancel()`。
 *
 * `timedOut()` 供调用方区分「超时」与「abort / 业务错误」：超时需转译成
 * ToolExecutionError（模型可读），其余错误原样上抛。dispose 清 timer + 移除
 * abort listener（照旧语义）。
 */
function createRequestCancellation(execCtx?: ToolExecutionContext): {
  readonly token: CancellationToken;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const source = new CancellationTokenSource();
  let timedOutFlag = false;
  const timer = setTimeout(() => {
    timedOutFlag = true;
    source.cancel();
  }, DEFAULT_LSP_REQUEST_TIMEOUT_MS);
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

/** 超时错误的统一文案（模型可读；含触发超时的 method，20s 与常量同源）。 */
function timeoutError(toolName: string, method: string): ToolExecutionError {
  return new ToolExecutionError(
    `[${toolName}] LSP request ${method} timed out after ${DEFAULT_LSP_REQUEST_TIMEOUT_MS / 1000}s (cancelled)`
  );
}

/**
 * workspace 级查询（file 省略）的 client 解析（plan T3）：无文件锚点可走
 * resolveServer dispatch，按 `SERVERS` 声明序逐个试探——取各 server 首个
 * 扩展名拼 `ctx.directory` 下的伪路径，走 getClient 的 NearestRoot/spawn
 * 全链路，首个可用即返回；全部不可用 → undefined（handler 转哨兵字符串）。
 */
async function getClientForWorkspace(ctx: LspCtx) {
  for (const server of SERVERS) {
    const ext = server.extensions[0];
    const sample = path.join(ctx.directory, `iknow-workspace${ext}`);
    const client = await getClient(ctx, sample, { server });
    if (client) return client;
  }
  return undefined;
}

/**
 * 8 件标准 operation 工厂：单次 LSP request，输入 → sendRequest → stringify。
 *
 * lsp_incoming_calls / lsp_outgoing_calls 走 `makeCallHierarchyCallTool`（多步：
 * 先 prepareCallHierarchy 拿 item，再 forward）；lsp_diagnostics 走独立工厂
 * （过滤 + 封顶 + Markdown 渲染）；本工厂处理 7 件标准单步 op + document_symbol
 * + workspace_symbol。
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
        | PositionInput
        | FileOnlyInput
        | WorkspaceSymbolInput;
      // file 缺省（仅 lsp_workspace_symbol）→ 工作区级查询，按 SERVERS 序
      // 试探可用 server；file 在场 → 保持原 dispatch 语义不变。
      const client =
        params.file !== undefined
          ? await getClient(ctx, params.file)
          : await getClientForWorkspace(ctx);
      if (!client) return "(no LSP server available for file)";
      // tsserver 对未打开文件不建 project → 符号类操作返空。先 ensureOpen
      // 把目标文件加进 server 的 project，再发请求（per-connection 幂等）。
      // file 缺省的工作区级查询无文件可打开，跳过。
      if (params.file !== undefined) await client.ensureOpen(params.file);
      // interruptBehavior="cancel" + per-request 超时（plan T1）：统一经
      // CancellationTokenSource 桥接，abort / 超时都走 $/cancelRequest，
      // 不杀 tsserver（Q2/A9）。
      const cancel = createRequestCancellation(execCtx);
      let result: unknown;
      try {
        result = await client.sendRequest(
          spec.method,
          spec.buildParams(params),
          cancel.token
        );
      } catch (err) {
        // 超时路径：token cancel 已让 sendRequest reject（RequestCancelled），
        // 转译成模型可读的 ToolExecutionError；abort / 业务错误原样上抛。
        if (cancel.timedOut()) throw timeoutError(spec.name, spec.method);
        throw err;
      } finally {
        cancel.dispose();
      }
      return stringifyResult(result);
    },
  });
}

/**
 * callHierarchy/incomingCalls 与 outgoingCalls 多步处理：先准备 hierarchy item
 * （sendRequest textDocument/prepareCallHierarchy），取首项 item 后再 forward
 * 给 incomingCalls / outgoingCalls。
 *
 * 输入仍走 POSITION_SCHEMA（1-based line / 0-based character），handler 内部
 * 负责两次 RPC，无 client 同样返 `"(no LSP server available for file)"`。
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
      const client = await getClient(ctx, params.file);
      if (!client) return "(no LSP server available for file)";
      // 同 makeOperationTool：先 ensureOpen 建 project，再 prepare + forward。
      await client.ensureOpen(params.file);
      // per-request 超时 + abort 桥接（plan T1，同 makeOperationTool 注释）。
      const cancel = createRequestCancellation(execCtx);
      try {
        const prepared = await client.sendRequest(
          "textDocument/prepareCallHierarchy",
          positionParams(params.file, params.line, params.character),
          cancel.token
        );
        if (cancel.timedOut()) {
          throw timeoutError(name, "textDocument/prepareCallHierarchy");
        }
        const items = extractCallHierarchyItems(prepared);
        const item = items[0];
        if (!item) return stringifyResult([]);
        const result = await client.sendRequest(
          method,
          { item },
          cancel.token
        );
        if (cancel.timedOut()) throw timeoutError(name, method);
        return stringifyResult(result);
      } catch (err) {
        // 两次 sendRequest 的 cancel-reject（RequestCancelled）都经这里：
        // 超时转译为模型可读错误（取触发超时的那个 method），abort /
        // 业务错误原样上抛。
        if (cancel.timedOut()) {
          throw timeoutError(name, "textDocument/prepareCallHierarchy");
        }
        throw err;
      } finally {
        cancel.dispose();
      }
    },
  });
}

/**
 * LSP 响应的「数组」或「包了 `{items}` 的对象」两种形态归一化(tsserver
 * prepareCallHierarchy 返回前者或后者均存在;diagnostics 推送是数组)。
 * 失败/非对象返回空数组。共享 normalizer 避免重复(DRY)。
 */
function unwrapItems(raw: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const candidate = (raw as { items?: unknown }).items;
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/** tsserver 返回的 prepareCallHierarchy 形态归一化：取 items 数组。 */
function extractCallHierarchyItems(prepared: unknown): ReadonlyArray<unknown> {
  return unwrapItems(prepared);
}

/**
 * lsp_diagnostics 工具：读文件级 push diagnostics（tsserver 走
 * `textDocument/publishDiagnostics` 通知，client.ts 已订阅 latest-wins 累积）。
 * severity 过滤（忽略 severity=0 hint；保留 1=error / 2=warning / 3=information /
 * 4=deprecated）+ 每文件封顶 20（spec S6 摘要形式）。
 *
 * **读前等待（plan T3）**：ensureOpen 后 push 诊断尚未到达时立即读 diagStore
 * 得到 undefined → 误报空。每 100ms 轮询 `client.getDiagnostics(uri)`，首个
 * 该 uri 诊断到达即继续；DIAGNOSTICS_WAIT_MS deadline 到用现有内容（可能
 * undefined → 渲染空）；execCtx?.signal aborted 立即结束等待。
 *
 * 输出：纯字符串（契约 Y1）。
 */
function makeDiagnosticsTool(ctx: LspCtx, description: string): AciToolDef {
  const validate = compileValidator(FILE_ONLY_SCHEMA, "lsp_diagnostics");
  return Object.freeze({
    name: "lsp_diagnostics",
    description,
    inputSchema: FILE_ONLY_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (
      input: unknown,
      execCtx?: ToolExecutionContext
    ): Promise<unknown> => {
      const params = validate(input) as FileOnlyInput;
      const client = await getClient(ctx, params.file);
      if (!client) return "(no LSP server available for file)";
      // push diagnostics 只在文件打开后才到达 → 必须先 ensureOpen,否则
      // getDiagnostics 永远取到 undefined、render 出空 <diagnostics/> 标签。
      await client.ensureOpen(params.file);
      const uri = pathToFileURL(params.file).href;
      const items = await waitForDiagnostics(client, uri, execCtx?.signal);
      return renderDiagnostics(params.file, items ?? []);
    },
  });
}

/**
 * ensureOpen 后等待首个该 uri 的 push 诊断（plan T3）：
 *   - 首查即有（diagnostics 已缓存 / 无诊断文件 push 过空列表）→ 立即返回；
 *   - 每 100ms 轮询，非 undefined 立即返回；
 *   - DIAGNOSTICS_WAIT_MS deadline 到 → 返回现有内容（可能 undefined）；
 *   - signal aborted → 立即结束等待（不拖住 executor 取消）。
 *
 * 返回 undefined 表示 deadline 内未等到任何该 uri 的 diagnostics 推送。
 */
async function waitForDiagnostics(
  client: { getDiagnostics(uri: string): ReadonlyArray<unknown> | undefined },
  uri: string,
  signal?: AbortSignal
): Promise<ReadonlyArray<unknown> | undefined> {
  const deadline = Date.now() + DIAGNOSTICS_WAIT_MS;
  let items = client.getDiagnostics(uri);
  while (items === undefined) {
    if (signal?.aborted) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
    items = client.getDiagnostics(uri);
  }
  return items;
}

/** 诊断归一化 + 过滤 + 封顶 + 纯字符串摘要（spec S6）。 */
function renderDiagnostics(file: string, raw: unknown): string {
  const items = unwrapItems(raw);
  const filtered = items.filter((d) => {
    if (!d || typeof d !== "object") return false;
    const severity = (d as { severity?: unknown }).severity;
    // severity 缺省按 1=error 处理；severity=0 (Hint) 过滤。
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
 * 构造 LSP 工具集（registry.ts T7 调用入口）。
 *
 * 返回值顺序与 spec「9 件 operation + lsp_diagnostics」对应：
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
 * **T6 计数说明**：spec §Objective 写「9 件 ACI 工具 append（11 → 20）」但
 * `specs/251-lsp-tool.md` Objective 第 17-19 行实际列出 9 件 operation 名为
 * 「8 件 operation」；spec §aci/tools/lsp.ts 第 184 行注释也写「9 件 = 8 operation
 * + lsp_diagnostics」。本工厂按 plan T6 列出名称**全量导出 10 件**（9 operation
 * + lsp_diagnostics），T7 append 后总数 21（11 + 10）而非 20，registry.ts
 * 装配时 `ACI_TOOLSET_NAMES.length === 21` 需相应调整。
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
      "Read the latest push diagnostics for a file (textDocument/publishDiagnostics, latest-wins) — useful before running builds / tests to see in-editor errors. Waits up to 2s after opening the file for the first diagnostics push to arrive, then renders whatever is available. Filters severity 0 (Hint); caps at 20 entries per file, appending an `...(N more issue(s) truncated, total M)` footer when over the cap. Returns a plain-text summary wrapped in a `<diagnostics file=...>` tag. Pair with read_file offset/limit on the lines referenced in the entries."
    )
  );
  return Object.freeze(tools);
}
