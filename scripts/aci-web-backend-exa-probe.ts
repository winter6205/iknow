/**
 * Real-network Exa probe for the ACI web backend (specs/aci-web-backend.md).
 *
 * Hits api.exa.ai for real; not collected by the default `npm test` run.
 * The key is resolved through the real config chain (`loadIknowEnv`), so both
 * supported carriers count: `web.exaApiKey` in `~/.iknow/settings.json` (literal
 * or `${EXA_API_KEY}`) and the `EXA_API_KEY` env var / `.env.local` / `.env`.
 * No usable key anywhere → print Not run and exit 0; never mock the
 * call and claim the acceptance criterion passed.
 * With a key → one run exercises both createWebSearchTool (Exa search) and
 * createWebFetchTool (Exa contents), backend=exa + key (the reading-intent
 * path is api.exa.ai/contents, not the local guard). Handlers carry
 * AbortSignal.timeout (SEARCH_TIMEOUT_MS / FETCH_TIMEOUT_MS); a timeout is
 * a typed failure, not a hang. Non-2xx / timeout go through the tools'
 * typed failure. The key is never printed.
 *
 * Run: `npm run probe:aci-web-backend`
 */
import { ToolExecutionError } from "../src/harness/errors.js";
import {
  createWebFetchTool,
  FETCH_TIMEOUT_MS,
  UNTRUSTED_BANNER,
} from "../src/harness/aci/tools/web-fetch.js";
import {
  createWebSearchTool,
  SEARCH_TIMEOUT_MS,
} from "../src/harness/aci/tools/web-search.js";
import { loadIknowEnv, EXA_API_KEY_ENV_KEY } from "../src/config/env.js";

const NOT_RUN =
  "Not run: npm run probe:aci-web-backend (no Exa key: set web.exaApiKey in ~/.iknow/settings.json, or export EXA_API_KEY)";
const FETCH_URL = "https://example.com/";
const SEARCH_QUERY = "example.com official site";

/**
 * Resolve the Exa key through the real config chain, not `process.env` alone: the
 * settings carrier (`web.exaApiKey`, literal or `${EXA_API_KEY}`) is the primary way a
 * normal install configures this backend, so a probe that only reads the environment
 * would report "Not run" for a correctly configured user — a silent false-pass on the
 * very criterion this probe exists to prove.
 */
function resolveExaApiKey(cwd: string): string | undefined {
  try {
    return loadIknowEnv(cwd).web.exaApiKey;
  } catch {
    // A missing llm.model / unregistered route makes loadIknowEnv throw before the web
    // section is read; that is a settings problem, not a reason to skip the network run.
    const raw = process.env[EXA_API_KEY_ENV_KEY];
    return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
  }
}

function redactKey(text: string, key: string): string {
  return text.split(key).join("[redacted]");
}

function firstResultUrl(searchOutput: string): string | undefined {
  const match = searchOutput.match(/^\s+URL:\s+(\S+)/m);
  return match?.[1];
}

async function main(): Promise<void> {
  const apiKey = resolveExaApiKey(process.cwd());
  if (apiKey === undefined) {
    console.log(NOT_RUN);
    process.exit(0);
  }

  const search = createWebSearchTool({
    backend: "exa",
    exaApiKey: apiKey,
  });
  const fetchTool = createWebFetchTool({
    backend: "exa",
    exaApiKey: apiKey,
  });

  try {
    const searchOut = String(
      await search.handler(
        { query: SEARCH_QUERY, max_results: 1 },
        { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) }
      )
    );
    if (!searchOut.includes("URL:")) {
      throw new Error("web_search returned no URL line");
    }
    const fetchUrl = firstResultUrl(searchOut) ?? FETCH_URL;
    const fetchOut = String(
      await fetchTool.handler(
        { url: fetchUrl },
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
      )
    );
    const bannerAt = fetchOut.indexOf(UNTRUSTED_BANNER);
    const body =
      bannerAt >= 0
        ? fetchOut.slice(bannerAt + UNTRUSTED_BANNER.length).trim()
        : "";
    if (bannerAt < 0 || !(body.trim().length > 0)) {
      throw new Error("web_fetch contents path returned empty text body");
    }
    console.log("PASS web_search (Exa search) hit api.exa.ai");
    console.log(
      "PASS web_fetch (Exa contents) intended path api.exa.ai/contents"
    );
    console.log("SC10 PASS");
  } catch (err) {
    const message =
      err instanceof ToolExecutionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`FAIL: ${redactKey(message, apiKey)}`);
    process.exit(1);
  }
}

void main();
