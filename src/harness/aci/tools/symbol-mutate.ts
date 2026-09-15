/**
 * 符号改写 ACI 工具集 —— spec `symbol-primary-aci`（模型面改工具 5 件）。
 *
 * **为什么独立成文件（不复用 `symbol.ts` 既有模板）**：
 *   - 改工具走「读文件 → 文本替换 → 写文件」三步，与查询工具的「单次
 *     sendRequest → stringify」形态分歧；混进 `makeSymbolOperationTool`
 *     会让那一份工厂为「写」额外长 4 个 if 分支（`buildParams` 也得分流）。
 *   - 改工具要触发装配层的 `onEdit` 回调让 LSP 视图同步；查询工具不写盘，
 *     不必碰 notifier 接缝；两套职责拼到同一处会带歧义字段（写盘后才
 *     触发 onEdit / 查询永远不触发，类型无差异）。
 *   - **fail-fast 与契约层级分得更清楚**：查询失败 = 字符串哨兵返回；
 *     改失败 = typed 失败串（`{ deleted: false, references: [...] }` 之类）
 *     + `ToolExecutionError`（rename 冲突 / 无 server / 写盘拒绝）。拼在一起
 *     两套 typed 错误处理 + 一套纯字符串返回会让契约层次混淆。
 *
 * **写盘路径**：所有改工具走同一份「解析符号 → LSP 计算 edit → 落盘」
 * 链路；写盘不调 `edit_file`（不走 `old_str/new_str` 路径 —— rename 的编辑
 * 范围由语言服务器算，模型不参与）。写盘后用装配层 `onEdit` 触发
 * `lspNotifier.invalidate(file)`，与 `edit_file` 一致（plan T1 决定的
 * LSP didChange 同步语义）。
 *
 * **不重复 `edit_file`**：本批工具以**符号身份**改代码；`edit_file` 留给
 * 不是单一符号的文本补丁（spec §使用规则段）。两者并存。
 *
 * **aci 元数据**：5 件 `category: "write"`，复用 `LSP_ACI_META` 另三字段
 * （`isConcurrencySafe: false` / `interruptBehavior: "cancel"` /
 * `timeoutTier: "default"`）；symbol 查询面在 `symbol.ts` 用同一份元数据，
 * 改工具走 LSP 同一套 client / 取消 / 超时链路 —— 元数据分叉即语义分叉。
 *
 * 边界：
 *   - **永不** `process.kill`；中断走 `$/cancelRequest`。
 *   - **永不** 把 `{ file, symbol_path }` 之外的位置字段暴露给模型
 *     （schema `additionalProperties: false` 守住）。
 *   - **永不** 在无效化前静默吞失败 —— invalidate 失败 stderr 留痕
 *     （fire-and-forget 但 best-effort 必须有可观测面）。
 *   - 解析与写盘都必须在请求级打开窗口（`withDocumentOpen`）内完成 ——
 *     tsserver 对未打开文件不建 project，rename/documentSymbol 全返空 / 错；
 *     窗口退出即 didClose（spec 251 生命周期）。
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
// Schema — 5 件改工具共用 `{ file, symbol_path }` 主身 + 各自特化字段
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

/** safe_delete_symbol: { file, symbol_path } — 与查询共用 schema */
const DELETE_SCHEMA = {
  type: "object",
  properties: { ...SYMBOL_MUTATE_BASE_PROPS },
  required: ["file", "symbol_path"],
  additionalProperties: false,
} as const;

const MAX_NEW_BODY_BYTES = 48 * 1024;
const MAX_INSERT_BYTES = 48 * 1024;

/**
 * 符号改工具的 aci 元数据（symbol-primary-aci T4）：
 *   - `category: "write"` —— 改工具写盘；与查询面 read-only 区分
 *     （ACR permission 装饰按 category 走默认决策：write 默 ask）；
 *   - 其余三字段复用 LSP_ACI_META（同 LSP client / 取消 / 超时链路
 *     —— 元数据分叉即语义分叉）。
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
// LSP payload 归一（不翻译字段，契约 Y2 — 语义归语言服务器）
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
 * tsserver / typescript-language-server 的 `WorkspaceEdit` 形态归一：
 *   - `changes`: 旧 LSP 形态 `{ uri: TextEdit[] }`；
 *   - `documentChanges`: LSP 3.13+ 形态 `(TextDocumentEdit | ResourceOp)[]`。
 * 我们只消费 `TextDocumentEdit[]`（含 `textDocument.uri` 与 `edits` 数组）。
 * `ResourceOp`（Create/Rename/Delete file）本批工具不发起 —— 改只动目标
 * 符号所在的文件，跨文件 rename 也只动 server 算出的 TextEdit 集合。
 */
interface TextDocumentEdit {
  readonly textDocument: { readonly uri: string };
  readonly edits: ReadonlyArray<TextEdit>;
}

function normalizeWorkspaceEdit(raw: unknown): ReadonlyArray<TextDocumentEdit> {
  if (!raw || typeof raw !== "object") return [];
  const edit = raw as {
    changes?: unknown;
    documentChanges?: unknown;
  };
  const out: TextDocumentEdit[] = [];
  // 旧 `changes` 形态：`{ uri: TextEdit[] }`
  if (edit.changes && typeof edit.changes === "object") {
    for (const [uri, edits] of Object.entries(
      edit.changes as Record<string, unknown>
    )) {
      if (!Array.isArray(edits)) continue;
      const textEdits = edits.flatMap((e) => normalizeTextEdit(e));
      if (textEdits.length === 0) continue;
      out.push({ textDocument: { uri }, edits: textEdits });
    }
  }
  // LSP 3.13+ `documentChanges` 形态
  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (!change || typeof change !== "object") continue;
      const doc = change as {
        textDocument?: { uri?: unknown };
        edits?: unknown;
      };
      const uri = doc.textDocument?.uri;
      if (typeof uri !== "string") continue;
      if (!Array.isArray(doc.edits)) continue;
      const textEdits = doc.edits.flatMap((e) => normalizeTextEdit(e));
      if (textEdits.length === 0) continue;
      out.push({ textDocument: { uri }, edits: textEdits });
    }
  }
  return out;
}

function normalizeTextEdit(raw: unknown): TextEdit[] {
  if (!raw || typeof raw !== "object") return [];
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
    return [];
  }
  return [{ range: e.range as LspRange, newText: e.newText }];
}

/** `DocumentSymbolNode.range` 的源类型只承诺 `start`；改工具需要 `end`
 *  构造完整 range。`SymbolInformation.location.range` 与 `DocumentSymbol.range`
 *  协议上都有 `start` + `end`，但 symbol-resolver.ts 用窄类型避免泄露给
 *  查询层（查询只要 selectionRange）。本工厂按协议信任 server payload，
 *  失败时由 normalizeTextEdit 那层兜底（缺 end → 丢弃）。 */
type NodeRange = { start?: LspPosition; end?: LspPosition };

/** 把节点的全范围按协议组装。LSP DocumentSymbol.range 与
 *  SymbolInformation.location.range 都至少含 start + end；缺 end →
 *  退化为单点 range（与 node 起点同），写盘时按空替换处理。 */
function assembleFullRange(
  start: LspPosition,
  end: LspPosition | undefined
): LspRange {
  return { start, end: end ?? start };
}

/** 按 uri 分组（同一文件多 edits 合并）。`fileURLToPath` 解不出 → 丢弃
 *  并记一条 stderr（best-effort；写盘失败再统一抛）。 */
function groupEditsByPath(
  edits: ReadonlyArray<TextDocumentEdit>
): Map<string, TextEdit[]> {
  const grouped = new Map<string, TextEdit[]>();
  for (const doc of edits) {
    let path: string;
    try {
      path = fileURLToPath(doc.textDocument.uri);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[symbol-mutate] invalid uri in WorkspaceEdit: ${doc.textDocument.uri} (${msg})\n`
      );
      continue;
    }
    const list = grouped.get(path) ?? [];
    list.push(...doc.edits);
    grouped.set(path, list);
  }
  return grouped;
}

/** 单文件内多个 TextEdit 按 range.start 降序排序后依次 splice ——
 *  从尾向头替换保证前面的位置不被后续替换偏移。 */
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
    // 重新切分（newText 可能含多行）。
    lines.length = 0;
    lines.push(...next.split("\n"));
  }
  return text;
}

/** (line, character) → 文本内的字节偏移。line/character 0-based；line
 *  间用单 `\n` 分隔（与 LSP 协议一致）。 */
function offsetFor(lines: string[], pos: LspPosition): number {
  let offset = 0;
  for (let i = 0; i < pos.line; i++) {
    offset += (lines[i] ?? "").length + 1;
  }
  offset += pos.character;
  return offset;
}

// ---------------------------------------------------------------------------
// WorkspaceEdit 落盘 + onEdit 回调
// ---------------------------------------------------------------------------

/** 落盘一组 TextDocumentEdit，调用 onEdit 让 LSP 视图同步。
 *
 * **不平凡路径**：所有写盘走异步 `writeFile`，任一失败立刻抛
 * `ToolExecutionError`（拒绝静默当成功改名）；成功的文件全部记到
 * `writtenFiles` 用于返回与 invalidate 触发。 */
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
    // onEdit 是装配层接 lspNotifier.invalidate 的缝；写盘成功才触发，
    // 失败路径不触发（避免误通知）。
    onEdit?.(filePath);
  }
  return { writtenFiles: written, editCount };
}

// ---------------------------------------------------------------------------
// 解析符号失败 → 模型可读字符串（与 symbol.ts 同一套语义）
// ---------------------------------------------------------------------------

/** 把 documentSymbol 节点 → 全范围（LSP range，**含整个定义体**）。
 *  优先级：node.range > node.location.range（DocumentSymbol vs SymbolInformation）。
 *  selectionRange 只覆盖符号名本身，**不能**用于 replace_body / safe_delete。 */
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
 * 解析符号身份并在**请求级打开窗口**内执行 `run`；任一失败 → 纯字符串
 * 失败串（与查询工具同语义）。
 *
 * 窗口必须罩住解析与随后的改动/查询请求：解析要 didOpen 才建得起来
 * project，`textDocument/rename` / `references` 要同一份 server 侧文本；
 * 退出窗口即 didClose（spec 251「打开文档生命周期」—— 两次调用之间文件
 * 不对 server 保持打开）。落盘（applyWorkspaceEdit）仍在窗口内完成，
 * 随后 notifier 的 didChange 才会命中「已打开」分支。
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
      // 复用 symbol.ts 的渲染语义（一致失败串形态）：not_found / ambiguous /
      // no_position；method_not_found 同样复用 lsp.ts 的哨兵渲染（SSOT）。
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
// 5 件改工具
// ---------------------------------------------------------------------------

/** rename_symbol — 全项目按符号改名。
 *
 * 走 `textDocument/rename` 让 tsserver 计算跨文件 WorkspaceEdit（包含声明点
 * + 所有引用点），应用前必须把 documentSymbol 缓存里旧版的查找目标同步
 * 失效 → 通过 `onEdit` 触发 notifier。
 *
 * **rename 冲突**：tsserver 返 `null` 表示存在冲突（如与同作用域已有
 * 标识符同名）；typed 失败串明确给模型可行动提示。 */
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
            // 缺方法哨兵：server 没有 rename —— 透传（不再当 WorkspaceEdit 解析）。
            if (isMethodNotFoundSentinel(result)) return result;
            // tsserver 返回 null → 改名冲突（与同作用域现有标识符同名 / 跨
            // 文件类型不允许等）。typed 失败串：明确告诉模型 rename 失败，
            // 不留空 catch。
            if (result === null || result === undefined) {
              throw new ToolExecutionError(
                `[${name}] cannot rename ${params.symbol_path} to "${params.new_name}" in ${params.file}: existing declarations would conflict (the language server rejected the rename)`
              );
            }
            const docEdits = normalizeWorkspaceEdit(result);
            if (docEdits.length === 0) {
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

/** replace_symbol_body — 替换该符号定义体（含签名行，范围 = node.range）。
 *
 * 不走 LSP `textDocument/*` 协议（无「替换 body」原语），直接构造
 * 单文件 TextEdit：range = node.range（全范围，含签名与 body），
 * newText = params.new_body。应用后 invalidate 单文件。 */
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

/** insert_before_symbol — 在 range.start 位置插入 code + "\n"（自动换行）。
 *  insert_after_symbol — 在 range.end 位置插入 "\n" + code（自动换行）。
 *
 * 两个共用同一工厂：方向 = "before" → 插在 range.start；
 * 方向 = "after" → 插在 range.end。LSP TextEdit 同 insert 模式 —— server
 * 协议本就支持位置插入（newText 落在 range 上即 splice 入）。 */
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
            // 在 range.start/end 位置上 splice：before → 在 start 之前插入 `code + "\n"`；
            // after → 在 end 之后插入 `"\n" + code`（自动补换行保插入块独立成段）。
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

/** safe_delete_symbol — 无引用才删，否则返回引用列表且不删。
 *
 * 先发 `textDocument/references`（includeDeclaration:true）收集所有引用。
 * 任一引用（含声明点）→ typed 失败串 `{ deleted: false, references: [...] }`，
 * 不删。否则构造 single-file delete edit（range = fullRange），落盘 + invalidate。 */
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
            // 第一步：references（includeDeclaration:true）→ 判空。
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
            // 缺方法哨兵：server 没有 references —— 无法证明「无引用」，
            // fail-closed：透传哨兵、不进入删除路径（与 extractReferences
            // 拒删同源纪律）。
            if (isMethodNotFoundSentinel(refsRaw)) return refsRaw;
            const references = extractReferences(refsRaw);
            if (references.length > 0) {
              // typed 失败路径：返回引用列表 + 明确「不删」。模型见此结果
              // 应决定是否改方案（先迁移引用），绝不静默当删除成功。
              return stringifyResult({
                deleted: false,
                symbol_path: target.path,
                references,
                message:
                  `refusing to delete ${target.path} in ${params.file}: ${references.length} reference(s) exist. ` +
                  `Resolve them first (find_referencing_symbols) before deleting.`,
              });
            }
            // 第二步：无引用 → 删。range = 全范围（删除符号体，连签名带 body）。
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

/** `textDocument/references` 响应归一为 `{ file, line, character }` 列表。
 *  tsserver 返 `Location[]`（`{ uri, range }`）；老 server 也可能返
 *  扁平数组。**malformed response（非数组）→ 抛 `ToolExecutionError`**：
 *  spec §53 与 ACR error-handling-enforcer 禁止空 catch 与 silent fallback；
 *  我们不能"证明无引用"，因此 `safe_delete_symbol` 必须拒绝删除而非进入
 *  "无引用"路径。单条 URI 解析失败 → 静默 `continue`（单条 entry 的局部失败
 *  不等价于"全部无可枚举引用"，政策允许）。 */
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

/** `pathToFileURL` 内联，避免与 lsp.ts 重复 import。 */
function fileURLFromPath(file: string): string {
  // pathToFileURL 是 node:url 内置；不再开一层 import 直接复用即可。
  return new URL(`file://${file}`).href;
}

// ---------------------------------------------------------------------------
// 工厂入口
// ---------------------------------------------------------------------------

/** 5 件符号改工具的名字真值（registry Gate 3 与测试共源）。 */
export const SYMBOL_MUTATE_TOOL_NAMES = Object.freeze([
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
] as const);

/**
 * Worker 可直接写 workspace 文件的能力 SSOT。
 *
 * `category: "write"` 还包含工作树生命周期与进程控制工具；它们不属于
 * worker 的文件写能力面，不能直接拿 category 推导隔离结论。
 */
export const FILE_WRITE_TOOL_NAMES = Object.freeze([
  "edit_file",
  "write_file",
  ...SYMBOL_MUTATE_TOOL_NAMES,
] as const);

/** 装配入口（`registry.ts` 调用点）。
 *
 * 与 `createSymbolQueryToolSet(ctx)` 同形态：ctx 由 build-engine 装配期
 * 透传同一份 `lspCtx`（settings.lsp / disabledServers / idle / requestTimeoutMs）。
 * `onEdit` 由 registry 装配层从 `opts.onEdit` 透传（同一来源 = edit_file 的
 * lspNotifier.invalidate 回调），保证写盘后 LSP 视图同步语义一致。 */
export interface CreateSymbolMutateToolSetOptions {
  readonly ctx: LspCtx;
  readonly onEdit?: (file: string) => void;
}

export function createSymbolMutateToolSet(
  opts: CreateSymbolMutateToolSetOptions
): ReadonlyArray<AciToolDef> {
  const { ctx, onEdit } = opts;
  // 顺序与 SYMBOL_MUTATE_TOOL_NAMES 一致（Gate 3 按名索引，顺序即契约）。
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
  // 构造期 fail-fast：名单与工厂分歧不留到运行期（与 registry Gate 3 同纪律）。
  if (tools.length !== SYMBOL_MUTATE_TOOL_NAMES.length) {
    throw new Error(
      `symbol mutate tool count mismatch: have=${tools.length} want=${SYMBOL_MUTATE_TOOL_NAMES.length}`
    );
  }
  return Object.freeze(tools);
}
