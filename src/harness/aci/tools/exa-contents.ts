/**
 * Exa contents 阅读适配：写死官方端点，不过 network-guard 出站。
 * 协议细节停在本文件，不进 web_fetch handler。
 */

import { ToolExecutionError } from "../../errors.js";
import type { GuardPublicResponse } from "./network-guard.js";

export const EXA_CONTENTS_ENDPOINT = "https://api.exa.ai/contents";

export type ExaContentsFetch = typeof globalThis.fetch;

export async function fetchExaContents(args: {
  readonly url: string;
  readonly apiKey: string;
  readonly as: "text" | "html";
  readonly fetchFn: ExaContentsFetch;
  readonly signal?: AbortSignal;
}): Promise<GuardPublicResponse> {
  if (!args.apiKey.trim()) {
    throw new ToolExecutionError(
      "web_fetch failed: missing_key: Exa contents requires EXA_API_KEY"
    );
  }
  let response: Response;
  try {
    response = await args.fetchFn(EXA_CONTENTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        urls: [args.url],
        text: args.as === "html" ? { includeHtmlTags: true } : true,
      }),
      signal: args.signal,
    });
  } catch (err) {
    const aborted =
      args.signal?.aborted === true ||
      (err instanceof Error && err.name === "AbortError");
    throw new ToolExecutionError(
      `web_fetch failed: timeout: ${
        aborted
          ? "request aborted"
          : `fetch failed: ${err instanceof Error ? err.message : String(err)}`
      } (endpoint: api.exa.ai)`,
      { cause: err }
    );
  }

  if (!response.ok) {
    // EXIT: vendor transport failed — visible typed error, not a capability miss.
    throw new ToolExecutionError(
      `web_fetch failed: http_non_2xx: upstream returned status ${response.status} (endpoint: api.exa.ai)`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch (err) {
    throw new ToolExecutionError(
      `web_fetch failed: parse: malformed JSON response (endpoint: api.exa.ai)`,
      { cause: err }
    );
  }

  return projectExaContents(parsed, args.url, args.as);
}

function projectExaContents(
  raw: unknown,
  requestedUrl: string,
  as: "text" | "html"
): GuardPublicResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new ToolExecutionError(
      "web_fetch failed: parse: expected a JSON object (endpoint: api.exa.ai)"
    );
  }
  const envelope = raw as {
    readonly results?: unknown;
    readonly statuses?: ReadonlyArray<{ readonly status?: unknown }>;
  };
  const failed = envelope.statuses?.find((row) => row.status === "error");
  if (failed) {
    throw new ToolExecutionError(
      "web_fetch failed: http_non_2xx: vendor reported error for URL (endpoint: api.exa.ai)"
    );
  }
  if (!Array.isArray(envelope.results) || envelope.results.length === 0) {
    throw new ToolExecutionError(
      "web_fetch failed: parse: expected results[] in upstream response (endpoint: api.exa.ai)"
    );
  }
  const first = envelope.results[0];
  if (typeof first !== "object" || first === null) {
    throw new ToolExecutionError(
      "web_fetch failed: parse: malformed result row (endpoint: api.exa.ai)"
    );
  }
  const row = first as { readonly url?: unknown; readonly text?: unknown };
  const text = typeof row.text === "string" ? row.text : "";
  const finalUrl =
    typeof row.url === "string" && row.url ? row.url : requestedUrl;
  return {
    status: 200,
    contentType: as === "html" ? "text/html" : "text/plain",
    body: text,
    finalUrl,
  };
}
