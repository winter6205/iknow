/**
 * ACI web backend capability table: one closed-set id declares "can search /
 * can fetch".
 *
 * Absent = no implementation / no key / vendor has no such API; this round
 * only `exa`+key has both sides; tavily / brave are always absent (no extract
 * / no real search). A transport failure != absent and is not decided here.
 * Invalid ids fail loud in the env loader and never reach this function.
 */

import type { SearchBackendId } from "./env.js";

export type WebSearchEngine = "default" | "exa";
export type WebFetchEngine = "local" | "exa";

export type WebCapability = {
  readonly searchEngine: WebSearchEngine;
  readonly fetchEngine: WebFetchEngine;
};

export type WebCapabilityInput = {
  readonly backend?: SearchBackendId;
  readonly exaApiKey?: string;
  readonly tavilyApiKey?: string;
  readonly braveApiKey?: string;
};

function usableKey(raw: string | undefined): boolean {
  return Boolean(raw?.trim());
}

/**
 * Assembly time: "who handles search / who handles fetch".
 * Only `exa` + a usable key → both sides go through Exa; everything else falls
 * back to default search + local reading.
 */
export function resolveWebCapability(input: WebCapabilityInput): WebCapability {
  const exaReady = input.backend === "exa" && usableKey(input.exaApiKey);
  if (exaReady) {
    return { searchEngine: "exa", fetchEngine: "exa" };
  }
  // EXIT: stub / no key / vendor has no API this round → built-in defaults.
  return { searchEngine: "default", fetchEngine: "local" };
}
