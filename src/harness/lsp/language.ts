/**
 * Extension → LSP languageId mapping.
 *
 * Derived from the same extension source as `server.ts`'s
 * `LspServerInfo.extensions`, but with a separate responsibility: that list
 * drives dispatch (which server to pick); this table tells the server the
 * file's language (languageId) at didOpen time.
 *
 * Extension-less files key on basename (Dockerfile has no extension; handlers
 * pass full paths, so basename is needed to hit `"Dockerfile"` — consistent
 * with `resolveServer`'s basename fallback in `server.ts`); any miss falls
 * back to `"typescript"` — preserving existing TS behavior, since a
 * misdetected extension would fail language recognition and leave symbol
 * queries empty.
 */
import path from "node:path";

/** Extension (with dot) → LSP languageId. */
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
  Dockerfile: "dockerfile",
} as const;

/**
 * LSP languageId for a file: `path.extname(file)`, falling back to basename
 * lookup for extension-less files (Dockerfile, consistent with resolveServer's
 * dispatch contract); any miss returns `"typescript"`.
 */
export function languageIdFor(file: string): string {
  const ext = path.extname(file) || path.basename(file);
  return LANGUAGE_EXTENSIONS[ext] ?? "typescript";
}
