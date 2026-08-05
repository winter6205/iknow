/**
 * Shared static-asset server for the iknow web UI.
 *
 * Extracted from `src/session-api/http.ts` (022+) so both `iknow serve`
 * (chat SPA) and `iknow trace` (trace inspection SPA) can host their own
 * build output with identical guards:
 *
 *   - `/api` and `/api/*` are NOT treated as static (returns false so the
 *     caller's API handler runs first; see ServeStaticOpts contract).
 *   - Leading `/web/` prefix is stripped (reverse-proxy alias path).
 *   - Path traversal: any resolved path outside webRoot -> 403.
 *   - Missing file -> SPA fallback to `<webRoot>/<fallbackHtml>` (200).
 *   - All responses carry Content-Type by extension + Cache-Control: no-cache.
 *
 * Self-contained (no dependency on session-api contract types) so the
 * traceserver can import it without a circular boundary.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Prefer Vite build output; fall back to web/ source root when dist is absent. */
export function resolveDefaultWebRoot(): string {
  const dist = path.resolve(__dirname, "../../web/dist");
  if (fs.existsSync(dist)) {
    return dist;
  }
  return path.resolve(__dirname, "../../web");
}

export interface ServeStaticOpts {
  readonly res: http.ServerResponse;
  readonly webRoot: string;
  readonly pathname: string;
  /** Filename under webRoot served as the SPA entry (chat="index.html", trace="trace.html"). */
  readonly fallbackHtml: string;
}

/**
 * Try to serve a static asset from `webRoot` matching `pathname`.
 *
 * Returns true when a response was sent (file served / SPA fallback / 403).
 * Returns false ONLY when no file matched AND `fallbackHtml` does not exist
 * under webRoot — caller is then responsible for sending 404.
 */
export function serveStaticRequest(opts: ServeStaticOpts): boolean {
  const { res, webRoot, pathname, fallbackHtml } = opts;
  // Never treat /api as static (caller should only invoke for non-API GETs,
  // but double-guard path traversal + SPA scope).
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return false;
  }

  let rel = pathname === "/" ? `/${fallbackHtml}` : pathname;
  if (rel.startsWith("/web/")) {
    rel = rel.slice("/web".length);
  }
  // Prevent path traversal.
  const rootAbs = path.resolve(webRoot);
  const resolved = path.resolve(webRoot, "." + rel);
  if (!resolved.startsWith(rootAbs + path.sep) && resolved !== rootAbs) {
    res.writeHead(403, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: { kind: "internal", message: "path not allowed" },
      })
    );
    return true;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    pipeFile({ res, filePath: resolved });
    return true;
  }

  // SPA fallback: GET non-/api routes with missing file -> fallbackHtml when present.
  const fallbackPath = path.resolve(webRoot, fallbackHtml);
  if (
    (fallbackPath.startsWith(rootAbs + path.sep) || fallbackPath === rootAbs) &&
    fs.existsSync(fallbackPath) &&
    fs.statSync(fallbackPath).isFile()
  ) {
    pipeFile({ res, filePath: fallbackPath });
    return true;
  }
  return false;
}

interface PipeFileOpts {
  readonly res: http.ServerResponse;
  readonly filePath: string;
}

function pipeFile(opts: PipeFileOpts): void {
  const { res, filePath } = opts;
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).pipe(res);
}
