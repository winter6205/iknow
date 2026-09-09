/**
 * Golden set for ACI network two-role lock (discover vs read).
 *
 * Invariant (specs/960-web-discover-vs-read.md SC1–SC3, SC5 first half):
 * fixed operator input + decidable first-tool / next-step trajectory.
 * Prompt-development: fixtures exist before description edits.
 *
 * These objects are the set. Behavioral first-tool verdicts run under
 * `npm run test:real-llm` (HAS_KEY). Missing key → skip + Not run.
 */

export type DiscoverVsReadFixtureId =
  | "sc1-search-no-url"
  | "sc2-read-given-url"
  | "sc3-empty-search-not-guess-fetch";

export interface DiscoverVsReadFixture {
  readonly id: DiscoverVsReadFixtureId;
  /** Vitest `-t` substring; each fixture is individually runnable. */
  readonly title: string;
  readonly userPrompt: string;
  readonly spec: "SC1" | "SC2" | "SC3";
}

const HTTP_URL = /https?:\/\/[^\s]+/i;

export function httpUrlsIn(text: string): ReadonlyArray<string> {
  return text.match(new RegExp(HTTP_URL, "gi")) ?? [];
}

export const DISCOVER_VS_READ_FIXTURES: readonly DiscoverVsReadFixture[] =
  Object.freeze([
    {
      id: "sc1-search-no-url",
      spec: "SC1",
      title: "SC1: no URL, search/news request → first tool web_search",
      userPrompt:
        "Use network search to find recent news about the IETF QUIC working group this week. " +
        "I do not have a page URL. Start by discovering sources.",
    },
    {
      id: "sc2-read-given-url",
      spec: "SC2",
      title:
        "SC2: user already gave http(s) URL and asked to read page → first tool MAY be web_fetch",
      userPrompt:
        "Read this page and summarize the opening paragraph: " +
        "https://example.com/iknow-960-user-given-page",
    },
    {
      id: "sc3-empty-search-not-guess-fetch",
      spec: "SC3",
      title:
        "SC3: after search returns zero results, next step is NOT a guessed-URL web_fetch",
      userPrompt:
        "Search the web for the exact phrase XK9-NO-RESULTS-iknow-discover-vs-read. " +
        "I do not have a URL. Report what the search returns.",
    },
  ]);

export function fixtureById(
  id: DiscoverVsReadFixtureId
): DiscoverVsReadFixture {
  const found = DISCOVER_VS_READ_FIXTURES.find((f) => f.id === id);
  if (found === undefined) {
    throw new Error(`discover-vs-read fixture missing: ${id}`);
  }
  return found;
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && HTTP_URL.test(value);
}

export function fetchUrlFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  if (!("url" in input)) return undefined;
  return typeof input.url === "string" ? input.url : undefined;
}
