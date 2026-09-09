/**
 * ACI web backend Exa 真出网探针（specs/aci-web-backend.md SC10）。
 *
 * 与 #826 T8 同档：真打 api.exa.ai，不进默认 `npm test` 收集。
 * 缺 / 空白 `EXA_API_KEY` → 打印 Not run 并以 0 退出，不得 mock 声称 SC10 已过。
 * 有 key → 同一次跑通 createWebSearchTool（Exa search）与
 * createWebFetchTool（Exa contents），backend=exa。非 2xx / 超时走工具 typed 失败。
 * 永不打印 key。
 *
 * 运行：`npm run probe:aci-web-backend`
 */
import { ToolExecutionError } from "../src/harness/errors.js";
import { createWebFetchTool } from "../src/harness/aci/tools/web-fetch.js";
import { createWebSearchTool } from "../src/harness/aci/tools/web-search.js";

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
      await search.handler({ query: SEARCH_QUERY, max_results: 1 })
    );
    if (!searchOut.includes("URL:")) {
      throw new Error("web_search returned no URL line");
    }
    const fetchUrl = firstResultUrl(searchOut) ?? FETCH_URL;
    const fetchOut = String(await fetchTool.handler({ url: fetchUrl }));
    if (!fetchOut.includes("Status:")) {
      throw new Error("web_fetch returned no Status line");
    }
    console.log("PASS web_search (Exa search) hit api.exa.ai");
    console.log("PASS web_fetch (Exa contents) hit api.exa.ai");
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
