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
 *     JSON.stringify。契约 Y1：handler 永远返纯字符串。
 *   - 三件套缓存（root+id / broken / inflight）由 client.ts 拥有，工具层零知识。
 *   - cancel 走 JSON-RPC `$/cancelRequest`（Q2/A9），本模块不持有任何进程信号。
 *   - 8 件共享 POSITION_SCHEMA（{file, line, character} 1-based line / 0-based
 *     character）；lsp_document_symbol, lsp_workspace_symbol, lsp_diagnostics 不需
 *     position，仅 file 即可（spec 测试策略 S5）。
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

import Ajv from "ajv";
import type { ValidateFunction } from "ajv";

import { getClient } from "../../lsp/client.js";
import type { LspCtx } from "../../lsp/types.js";
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

/** 仅 file 必填的 JSON Schema（document_symbol / workspace_symbol / diagnostics）。 */
const FILE_ONLY_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
  },
  required: ["file"],
  additionalProperties: false,
} as const;

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

/** 把任意 LSP 响应规范成纯字符串（契约 Y1：永不返回结构化 payload）。 */
function stringifyResult(result: unknown): string {
  if (result === undefined) return "";
  if (result === null) return "null";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch (_err) {
    return String(result);
  }
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

/** workspace/symbol params：只接 query（空字符串 = 全部符号）。 */
function workspaceSymbolParams(): unknown {
  return { query: "" };
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
  /** 把 ajv-validated input 映射到 LSP request params。 */
  readonly buildParams: (input: PositionInput | FileOnlyInput) => unknown;
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
    description: `LSP operation ${spec.method}. Read-only symbol lookup; 1-based line, 0-based character.`,
    inputSchema: spec.schema,
    aci: LSP_ACI_META,
    handler: async (input: unknown): Promise<unknown> => {
      const params = validate(input) as PositionInput | FileOnlyInput;
      const client = await getClient(ctx, params.file);
      if (!client) return "(no LSP server available for file)";
      const result = await client.sendRequest(
        spec.method,
        spec.buildParams(params)
      );
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
  method: string
): AciToolDef {
  const validate = compileValidator(POSITION_SCHEMA, name);
  return Object.freeze({
    name,
    description: `LSP operation ${method}. Multi-step: resolves call hierarchy items via textDocument/prepareCallHierarchy first, then forwards ${method} with the first item.`,
    inputSchema: POSITION_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (input: unknown): Promise<unknown> => {
      const params = validate(input) as PositionInput;
      const client = await getClient(ctx, params.file);
      if (!client) return "(no LSP server available for file)";
      const prepared = await client.sendRequest(
        "textDocument/prepareCallHierarchy",
        positionParams(params.file, params.line, params.character)
      );
      const items = extractCallHierarchyItems(prepared);
      const item = items[0];
      if (!item) return stringifyResult([]);
      const result = await client.sendRequest(method, { item });
      return stringifyResult(result);
    },
  });
}

/** tsserver 返回的 prepareCallHierarchy 形态归一化：取 items 数组。 */
function extractCallHierarchyItems(prepared: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(prepared)) return prepared;
  if (prepared && typeof prepared === "object") {
    const candidate = (prepared as { items?: unknown }).items;
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/**
 * lsp_diagnostics 工具：拉取文件级 diagnostics（textDocument/diagnostic LSP 3.16），
 * severity 过滤（忽略 severity=0 hint；保留 1=error / 2=warning / 3=information /
 * 4=deprecated）+ 每文件封顶 20（spec S6 摘要形式）。
 *
 * 输出：纯字符串（契约 Y1）。tsserver 把 diagnostics 包装在 `{kind,items}` 或
 * 直接 `Diagnostic[]`，本 handler 归一化二者。
 */
function makeDiagnosticsTool(ctx: LspCtx): AciToolDef {
  const validate = compileValidator(FILE_ONLY_SCHEMA, "lsp_diagnostics");
  return Object.freeze({
    name: "lsp_diagnostics",
    description:
      "Pull LSP diagnostics for a file (textDocument/diagnostic). Filters severity 0 (Hint); caps at 20 entries per file. Returns a plain-text summary.",
    inputSchema: FILE_ONLY_SCHEMA,
    aci: LSP_ACI_META,
    handler: async (input: unknown): Promise<unknown> => {
      const params = validate(input) as FileOnlyInput;
      const client = await getClient(ctx, params.file);
      if (!client) return "(no LSP server available for file)";
      const raw = await client.sendRequest("textDocument/diagnostic", {
        textDocument: { uri: pathToFileURL(params.file).href },
      });
      return renderDiagnostics(params.file, raw);
    },
  });
}

/** 诊断归一化 + 过滤 + 封顶 + 纯字符串摘要（spec S6）。 */
function renderDiagnostics(file: string, raw: unknown): string {
  const items = extractDiagnostics(raw);
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

function extractDiagnostics(raw: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const items = (raw as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return [];
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
      buildParams: (input) => {
        const p = input as PositionInput;
        return referencesParams(p.file, p.line, p.character);
      },
    },
    {
      name: "lsp_hover",
      method: "textDocument/hover",
      schema: POSITION_SCHEMA,
      buildParams: (input) => {
        const p = input as PositionInput;
        return positionParams(p.file, p.line, p.character);
      },
    },
    {
      name: "lsp_document_symbol",
      method: "textDocument/documentSymbol",
      schema: FILE_ONLY_SCHEMA,
      buildParams: (input) =>
        documentSymbolParams((input as FileOnlyInput).file),
    },
    {
      name: "lsp_workspace_symbol",
      method: "workspace/symbol",
      schema: FILE_ONLY_SCHEMA,
      buildParams: () => workspaceSymbolParams(),
    },
    {
      name: "lsp_go_to_implementation",
      method: "textDocument/implementation",
      schema: POSITION_SCHEMA,
      buildParams: (input) => {
        const p = input as PositionInput;
        return positionParams(p.file, p.line, p.character);
      },
    },
    {
      name: "lsp_prepare_call_hierarchy",
      method: "textDocument/prepareCallHierarchy",
      schema: POSITION_SCHEMA,
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
      "callHierarchy/incomingCalls"
    )
  );
  tools.push(
    makeCallHierarchyCallTool(
      ctx,
      "lsp_outgoing_calls",
      "callHierarchy/outgoingCalls"
    )
  );
  tools.push(makeDiagnosticsTool(ctx));
  return Object.freeze(tools);
}
