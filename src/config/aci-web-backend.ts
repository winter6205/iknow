/**
 * ACI web backend 能力表：一个闭集 id 声明「有搜 / 有抓」。
 *
 * 缺 = 无实现 / 无 key / 厂商无该 API。本轮仅 `exa`+key 两侧都有；
 * tavily / brave 一律缺（不接 extract / 真 search）。传输失败 ≠ 缺，
 * 不在本函数判定。非法 id 由 env loader fail-loud，不进这里。
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
 * 装配期：「搜走谁 / 抓走谁」。
 * 仅 `exa` + 可用 key → 两侧都走 Exa；其余回落默认检索 + 本机阅读。
 */
export function resolveWebCapability(input: WebCapabilityInput): WebCapability {
  const exaReady = input.backend === "exa" && usableKey(input.exaApiKey);
  if (exaReady) {
    return { searchEngine: "exa", fetchEngine: "exa" };
  }
  // EXIT: stub / no key / vendor has no API this round → built-in defaults.
  return { searchEngine: "default", fetchEngine: "local" };
}
