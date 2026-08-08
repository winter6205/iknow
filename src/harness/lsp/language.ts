/**
 * 扩展名 → LSP languageId 映射 — spec 302-lsp-multilang（§ language.ts，#304 决策4）。
 *
 * 与 opencode 的 LANGUAGE_EXTENSIONS 同源（#304 Q1），职责独立于
 * `server.ts` 的 `LspServerInfo.extensions`：后者做 dispatch 匹配（选哪个
 * server），本表在 didOpen 时告诉 server 目标文件的语言（languageId）。
 *
 * 无扩展名文件用全文件名当 key（Dockerfile 无扩展名）；未命中一律回退
 * `"typescript"` —— 守现有 TS 行为，避免误判扩展名后语言识别失败导致
 * 符号查询仍空（与旧 client.ts 正则实现等价的回退语义）。
 */
import path from "node:path";

/** 扩展名（含点）→ LSP languageId。 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".pyi": "python",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".dockerfile": "dockerfile",
} as const;

/**
 * 取文件的 LSP languageId：`path.extname(file)`，无扩展名时用全文件名查表
 * （Dockerfile）；未命中回退 `"typescript"`。
 */
export function languageIdFor(file: string): string {
  const ext = path.extname(file) || file;
  return LANGUAGE_EXTENSIONS[ext] ?? "typescript";
}
