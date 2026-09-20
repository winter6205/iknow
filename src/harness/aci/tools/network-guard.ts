/**
 * network-guard (SSRF egress layer): the shared outbound-HTTP defense for
 * web_fetch / web_search.
 *
 * Behavioral ground truth: a trimmed version of utils/network_guard.py's
 * DIRECT resolution mode (the PROXY / SYNTHETIC_DNS config pipelines are
 * deliberately not ported — iknow has no use for them).
 *
 * Defenses (applied per hop, redirects included):
 *   1. URL syntax: http/https only, host required, embedded credentials
 *      rejected.
 *   2. IP literals: anything non-public (loopback / private / link-local /
 *      CGNAT / multicast / reserved) is rejected.
 *   3. Hostnames: localhost / local suffixes / single-label names rejected.
 *   4. DNS resolution: any non-public IP in the result → reject; resolution
 *      failure → could not resolve.
 *   5. Redirects: ≤5 hops, each hop re-runs checks 1-4; landing on a
 *      non-public target rejects.
 *   6. Non-2xx → reject (with status code).
 *
 * Known boundary (same shape as upstream DIRECT mode, not a deviation of
 * this implementation): there is no IP pinning between the validation
 * lookup and the production fetch (undici resolves on its own), leaving a
 * theoretical DNS-rebinding TOCTOU window; mitigation needs a custom undici
 * dispatcher that pins the validated IP (future work).
 *
 * Dependency injection (following the grep.ts GrepToolDeps precedent):
 * fetch / lookup are both overridable by test stubs, so all tests run
 * offline. Production default is assembled by createDefaultGuardDeps
 * (fetch = globalThis.fetch redirect:manual; lookup =
 * node:dns/promises.lookup all).
 *
 * All failures throw ToolExecutionError with messages prefixed
 * `${tool} failed:` (matching upstream's "web_fetch failed: ..."
 * convention), fed back to the model verbatim by the executor.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ProxyAgent } from "undici";

import { ToolExecutionError } from "../../errors.js";
import { classifyIp } from "./ip-classify.js";

/**
 * The RequestInit.dispatcher type on global fetch comes from the
 * undici-types@6 bundled with @types/node (an older structural shape), while
 * undici@7's ProxyAgent implements the undici@7 Dispatcher (different type
 * signatures, e.g. FormData). The two type sets are structurally
 * incompatible, but the runtime value is the same proxy semantics. This
 * narrow type bridges them with an assertion — it only declares "whatever
 * shape global fetch needs from dispatcher", without reaching for any.
 */
type FetchDispatcher = NonNullable<Parameters<typeof fetch>[1]>["dispatcher"];

/** Redirect cap (aligned with upstream MAX_REDIRECTS). */
export const MAX_REDIRECTS = 5;

/** Decoded response-body cap (1 MiB); shared by the production streaming read and the stub double-check. */
export const MAX_DECODED_BODY_BYTES = 1_048_576;

/**
 * Content-Length pre-check: true only when the header is a non-negative
 * integer larger than the cap. Absent / empty / non-numeric / negative all
 * return false — an illegal Content-Length is never a rejection basis.
 */
export function contentLengthExceedsCap(
  header: string | null | undefined,
  maxBytes: number
): boolean {
  if (header === null || header === undefined) return false;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) {
    // EXIT: illegal Content-Length is ignored; stream accumulation is authoritative
    return false;
  }
  return Number(trimmed) > maxBytes;
}

/** UTF-8 byte size of the decoded string exceeds the cap → throw a prefix-free ToolExecutionError. */
export function assertDecodedBodyLimit(
  body: string,
  maxBytes: number = MAX_DECODED_BODY_BYTES
): void {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > maxBytes) {
    throw new ToolExecutionError(`body exceeds ${maxBytes} bytes (${bytes})`);
  }
}

/**
 * Accumulate UTF-8 bytes from a ReadableStream, aborting as soon as a chunk
 * crosses the cap. A null stream returns an empty string — never a pretend
 * successful body read.
 */
export async function readUtf8WithByteLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<string> {
  if (stream === null) {
    // EXIT: no body stream → empty string, not a truncated success
    return "";
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        // EXIT: first chunk that crosses the cap aborts; no partial body returned
        throw new ToolExecutionError(
          `body exceeds ${maxBytes} bytes (${total})`
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Browser-spoofing UA (shared production egress default for web_fetch /
 * web_search).
 *
 * A Chrome 130 desktop UA plus the iknow product suffix, in the
 * `Mozilla/... iknow/<version>` style — spoofing a real browser to pass
 * anti-bot UA filters such as Cloudflare (measured: a pure product UA
 * "iknow-web-fetch/0.1" gets challenged with 202 by Ars Technica's
 * Cloudflare; the browser UA passes). The UA still carries an explicit
 * `iknow/` marker so traffic is not fully disguised as anonymous.
 *
 * The hardcoded version is a known deviation (no auto-update with Chrome),
 * same as upstream. Test coverage: the constant is exported for the tool
 * layer; tests do not check the UA (injected fetch stubs never read
 * headers).
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/130.0.0.0 Safari/537.36 iknow/0.1";

/** Local hostname denylist (aligned with upstream _LOCAL_HOSTNAMES). */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

/** Local hostname suffix denylist (aligned with upstream _LOCAL_HOST_SUFFIXES). */
const LOCAL_HOST_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".cluster.local",
];

/** Per-request options received by the injected fetch (signal already merges caller + timeout). */
export interface GuardFetchOptions {
  readonly signal?: AbortSignal;
}

/** One response from the injected fetch (redirect: manual semantics: 3xx carries location). */
export interface GuardHttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly location?: string;
}

/** Return of fetchPublicResponse: the raw response + final URL (after redirects). */
export interface GuardPublicResponse extends GuardHttpResponse {
  readonly finalUrl: string;
}

/** Test seam / production default: issue one GET (redirects not auto-followed). */
export type GuardFetchFn = (
  url: string,
  options: GuardFetchOptions
) => Promise<GuardHttpResponse>;

/** Test seam / production default: resolve a hostname to a list of IP addresses. */
export type GuardLookupFn = (hostname: string) => Promise<readonly string[]>;

/** Dependency pair (fetch + lookup both required; tool factories fill production defaults or test stubs). */
export interface GuardDeps {
  readonly fetch: GuardFetchFn;
  readonly lookup: GuardLookupFn;
}

/** Call options for fetchPublicResponse. */
export interface FetchPublicOptions {
  /** Tool name (used for the error prefix, e.g. "web_fetch"). */
  readonly tool: string;
  /** Timeout in ms for the whole outbound call (all redirects included). */
  readonly timeoutMs: number;
  /** Caller cancellation signal (passed through by the executor). */
  readonly signal?: AbortSignal;
}

/** Configuration for createDefaultGuardDeps. */
export interface DefaultGuardDepsOptions {
  /** Explicit outbound proxy URL (http/https). Default = direct (no dispatcher). */
  readonly proxyUrl?: string;
  /** Optional UA override; defaults to {@link DEFAULT_USER_AGENT}. */
  readonly userAgent?: string;
}

/**
 * Production default egress deps (SSOT): fetch = globalThis.fetch (redirect:
 * manual, UA defaults to the browser-spoofing string) + lookup =
 * node:dns/promises.lookup(all). web_fetch / web_search factories no longer
 * duplicate the default implementations.
 *
 * Proxy arm (aligned with upstream `fetch_public_http_response`'s `proxy`
 * config and trust_env=False semantics — only explicit configuration takes
 * effect, system HTTP(S)_PROXY is never read):
 *   - When `opts.proxyUrl` is given, fetch attaches an `undici.ProxyAgent`
 *     dispatcher and outbound traffic is relayed by the proxy (remote
 *     resolution + egress, bypassing local DNS pollution / blocking).
 *   - The proxy URL goes through the same httpUrlViolation checks as target
 *     URLs (scheme / host / credentials), matching upstream's
 *     `validate_http_url(resolved_proxy)`.
 *   - The proxy hostname is exempt from the public-IP defense — local
 *     proxies (127.0.0.1 / intranet) must be allowed or local proxy
 *     assembly could never work.
 *   - Going through a proxy does not relax target-URL SSRF validation: the
 *     target still passes syntax + IP + DNS checks hop by hop (the proxy
 *     resolves remotely; local DNS results for target validation carry the
 *     same meaning as in direct mode).
 *
 * @param opts Configuration: proxyUrl / userAgent; both optional.
 */
export function createDefaultGuardDeps(
  opts?: DefaultGuardDepsOptions | string
): GuardDeps {
  // Backward compatibility with the old signature createDefaultGuardDeps(userAgent?: string).
  const userAgent =
    typeof opts === "string" ? opts : (opts?.userAgent ?? DEFAULT_USER_AGENT);
  const proxyUrl = typeof opts === "string" ? undefined : opts?.proxyUrl;
  let dispatcher: ProxyAgent | undefined;
  if (proxyUrl) {
    // The proxy URL reuses the target URL's SSRF syntax defense (scheme / host / credentials).
    const violation = httpUrlViolation(proxyUrl);
    if (violation !== null) {
      throw new ToolExecutionError(violation);
    }
    dispatcher = new ProxyAgent(proxyUrl);
  }
  const fetchFn: GuardFetchFn = async (url, options) => {
    const response = await fetch(url, {
      redirect: "manual",
      signal: options.signal,
      headers: { "User-Agent": userAgent },
      ...(dispatcher
        ? // Type bridge explained on FetchDispatcher (undici@7 vs the
          // undici-types bundled with global fetch differ structurally,
          // but the runtime values are equivalent).
          { dispatcher: dispatcher as unknown as FetchDispatcher }
        : {}),
    });
    const contentLength = response.headers.get("content-length");
    if (contentLengthExceedsCap(contentLength, MAX_DECODED_BODY_BYTES)) {
      // EXIT: Content-Length exceeds cap — cancel the stream, do not buffer
      if (response.body) await response.body.cancel();
      throw new ToolExecutionError(
        `body exceeds ${MAX_DECODED_BODY_BYTES} bytes`
      );
    }
    const body = response.body
      ? await readUtf8WithByteLimit(response.body, MAX_DECODED_BODY_BYTES)
      : await readTextThenLimit(response);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
      location: response.headers.get("location") ?? undefined,
    };
  };
  const lookupFn: GuardLookupFn = async (hostname) => {
    const records = await dnsLookup(hostname, { all: true });
    return records.map((r) => r.address);
  };
  return { fetch: fetchFn, lookup: lookupFn };
}

/**
 * Synchronous URL syntax validation: http/https only, host required,
 * embedded credentials rejected. Violations throw ToolExecutionError
 * (prefix-free — usable standalone and reused inside the guard).
 */
export function validateHttpUrl(url: string): void {
  const violation = httpUrlViolation(url);
  if (violation !== null) throw new ToolExecutionError(violation);
}

/**
 * Outbound fetch: hop-by-hop validation + redirect following (≤
 * MAX_REDIRECTS), returning the final response. Any defense failure throws
 * ToolExecutionError prefixed with `${opts.tool} failed:`.
 */
export async function fetchPublicResponse(
  url: string,
  deps: GuardDeps,
  opts: FetchPublicOptions
): Promise<GuardPublicResponse> {
  const fail = failWithPrefix(opts.tool);
  if (opts.signal?.aborted) fail("request aborted before start");

  const timer = new AbortController();
  const timeoutId = setTimeout(() => timer.abort(), opts.timeoutMs);
  timeoutId.unref();
  const combined = opts.signal
    ? AbortSignal.any([opts.signal, timer.signal])
    : timer.signal;

  try {
    return await followGuardedRedirects(url, deps, combined, fail);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Redirect loop: every hop runs ensurePublicTarget first, then fetch; ≤ MAX_REDIRECTS hops. */
async function followGuardedRedirects(
  url: string,
  deps: GuardDeps,
  signal: AbortSignal,
  fail: (reason: string) => never
): Promise<GuardPublicResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await ensurePublicTarget(current, deps.lookup, fail);
    const response = await runFetch(deps.fetch, current, signal, fail);
    enforceDecodedBodyLimit(response.body, fail);
    if (response.status >= 200 && response.status < 300) {
      return { ...response, finalUrl: current };
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (hop >= MAX_REDIRECTS) fail(`too many redirects (>${MAX_REDIRECTS})`);
      current = new URL(response.location, current).toString();
      continue;
    }
    fail(`unexpected status ${response.status}`);
  }
  return fail(`too many redirects (>${MAX_REDIRECTS})`);
}

/** Builds a fail that prefixes `${tool} failed:` (returns never so TS narrows). */
function failWithPrefix(tool: string): (reason: string) => never {
  return (reason: string): never => {
    throw new ToolExecutionError(`${tool} failed: ${reason}`);
  };
}

/** Shared by stubs and production: an over-cap decoded body goes through the prefixed fail; never a half page. */
function enforceDecodedBodyLimit(
  body: string,
  fail: (reason: string) => never
): void {
  try {
    assertDecodedBodyLimit(body);
  } catch (error) {
    if (error instanceof ToolExecutionError) fail(error.message);
    const detail = error instanceof Error ? error.message : String(error);
    fail(detail);
  }
}

/** When there is no ReadableStream, fall back to text(), still enforcing the byte cap. */
async function readTextThenLimit(response: Response): Promise<string> {
  const body = await response.text();
  assertDecodedBodyLimit(body);
  return body;
}

/** Run one injected fetch, normalizing aborts / low-level errors into a prefixed ToolExecutionError. */
async function runFetch(
  fetch: GuardFetchFn,
  url: string,
  signal: AbortSignal,
  fail: (reason: string) => never
): Promise<GuardHttpResponse> {
  try {
    // If the signal was already aborted before fetch started, an injected
    // stub's abort listener may never fire — check once up front.
    if (signal.aborted) fail("request aborted");
    return await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) fail("request aborted");
    const detail = error instanceof Error ? error.message : String(error);
    fail(detail);
  }
}

/**
 * Reuses the private-network / syntax / hostname defenses before a vendor
 * engine is chosen (issues no outbound request).
 */
export async function assertPublicHttpTarget(
  url: string,
  lookup: GuardLookupFn,
  tool: string
): Promise<void> {
  await ensurePublicTarget(url, lookup, failWithPrefix(tool));
}

/** Runs URL syntax + IP/hostname + DNS (four defenses) against one target URL. */
async function ensurePublicTarget(
  url: string,
  lookup: GuardLookupFn,
  fail: (reason: string) => never
): Promise<void> {
  const violation = httpUrlViolation(url);
  if (violation !== null) fail(violation);
  const rawHostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  // WHATWG URLs keep the brackets around IPv6 literals; strip before classification.
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  if (isIP(hostname) !== 0) {
    const label = classifyIp(hostname);
    if (label !== null) {
      fail(`target resolves to non-public address(es): ${hostname} (${label})`);
    }
    return; // public IP literal: hostname / DNS defenses not applicable
  }
  ensureHostnameAllowed(hostname, fail);
  const addresses = await resolveHost(hostname, lookup, fail);
  const blocked = addresses.filter((a) => classifyIp(a) !== null);
  if (blocked.length > 0) {
    const rendered = blocked
      .map((a) => `${a} (${classifyIp(a) ?? "non-public"})`)
      .join(", ");
    fail(`target resolves to non-public address(es): ${rendered}`);
  }
}

/** Hostname denylist + single-label rejection. */
function ensureHostnameAllowed(
  hostname: string,
  fail: (reason: string) => never
): void {
  if (
    LOCAL_HOSTNAMES.has(hostname) ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    fail(`local hostnames are not allowed: ${hostname}`);
  }
  if (!hostname.includes(".")) {
    fail(`single-label hostnames are not allowed: ${hostname}`);
  }
}

/** DNS resolution: failures / empty results both reject. */
async function resolveHost(
  hostname: string,
  lookup: GuardLookupFn,
  fail: (reason: string) => never
): Promise<readonly string[]> {
  let addresses: readonly string[];
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`could not resolve target host ${hostname}: ${detail}`);
    addresses = []; // unreachable — fail always throws; here only for TS definite-assignment
  }
  if (addresses.length === 0) fail(`target host did not resolve: ${hostname}`);
  return addresses;
}

/** URL syntax violation check: returns the violation reason, or null when valid. */
function httpUrlViolation(url: string): string | null {
  if (typeof url !== "string" || url.trim().length === 0) {
    return "URL must be a non-empty string";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL is malformed";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "only http and https URLs are allowed";
  }
  if (!parsed.hostname) return "URL must include a host";
  if (parsed.username || parsed.password) {
    return "URLs with embedded credentials are not allowed";
  }
  return null;
}
