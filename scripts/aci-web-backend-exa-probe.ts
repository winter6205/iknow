/**
 * Real-network Exa probe for the ACI web backend (specs/aci-web-backend.md).
 *
 * Hits api.exa.ai for real; not collected by the default `npm test` run.
 * Missing / blank `EXA_API_KEY` → print Not run and exit 0; never mock the
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

const NOT_RUN = "Not run: npm run probe:aci-web-backend (EXA_API_KEY unset)";
const FETCH_URL = "https://example.com/";
const SEARCH_QUERY = "example.com official site";

function resolveExaApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.EXA_API_KEY;
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

function redactKey(text: string, key: string): string {
  return text.split(key).join("[redacted]");
}

function firstResultUrl(searchOutput: string): string | undefined {
  const match = searchOutput.match(/^\s+URL:\s+(\S+)/m);
  return match?.[1];
}

async function main(): Promise<void> {
  const apiKey = resolveExaApiKey(process.env);
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
