/**
 * ntfy notification publisher (spec specs/remote-sync.md §4.6; plan task 6).
 *
 * `remote.notify` works with or without the remote seat: this module reads its
 * settings at TUI start and is a leaf of the TUI lifecycle — publishing is
 * fire-and-forget with a 5 s client-side abort, is never retried, and a
 * delivery failure can neither delay nor change a turn. Payloads carry only the
 * event kind and the tool name; URL, token and payload never reach a log.
 * A resolved token is registered with the output-mask registry so an accidental
 * echo elsewhere is masked.
 *
 * Host-neutral (ADR-0149 §4): nothing here imports the TUI.
 */
import { join } from "node:path";
import { expandPlaceholders, parseEnvFile } from "../config/env.js";
import { setActiveExtraSecrets } from "../harness/sandbox/env-isolation.js";

/** Resolved ntfy settings; `url` and `topic` are required for a publish. */
export interface NtfySettings {
  readonly url: string;
  readonly topic: string;
  /** Literal or `${VAR}`, resolved like `llm.apiKey`. */
  readonly token?: string;
  /** Turn-end gate; absent → 30000, `0` lets every turn through. */
  readonly turnEndMinMs?: number;
}

export interface NtfyPublisher {
  approvalPending(input: { readonly tool: string }): void;
  turnEnded(input: {
    readonly status: "completed" | "cancelled" | "failed";
    readonly durationMs: number;
  }): void;
  close(): void;
}

/** Turn-end gate when `turnEndMinMs` is absent (spec §4.5). */
const DEFAULT_TURN_END_MIN_MS = 30_000;

/** Per-request client-side timeout (spec §4.6). */
const REQUEST_TIMEOUT_MS = 5_000;

/** Output-mask owner slot; one publisher instance owns this slot at a time. */
const SECRET_OWNER = "remote:notify";

const NOTICE_TEXT =
  "iknow: notification delivery failed (no further notices this session)";

interface NtfyMessage {
  readonly title: string;
  readonly body: string;
  readonly priority: string;
  readonly tags: string;
}

/** `.env` / `.env.local` in `cwd` — the same fallback `llm.apiKey` uses. */
function readEnvFileMap(cwd: string): Record<string, string> {
  return {
    ...parseEnvFile(join(cwd, ".env")),
    ...parseEnvFile(join(cwd, ".env.local")),
  };
}

/**
 * Resolve `remote.notify.token`: a literal is returned trimmed, a `${VAR}` /
 * `$VAR` placeholder is resolved by `expandPlaceholders` (process env first,
 * then the `.env` / `.env.local` map); unset / empty / `"yes"` / malformed →
 * undefined (publish without `Authorization`). Never logs or throws.
 */
export function resolveNtfyToken(
  raw: string | undefined,
  cwd: string = process.cwd()
): string | undefined {
  if (raw === undefined) return undefined;
  const fileMap = raw.includes("$") ? readEnvFileMap(cwd) : {};
  return expandPlaceholders(raw, fileMap);
}

/**
 * Create the fire-and-forget ntfy publisher for one TUI process.
 *
 * Defensive on settings: an empty `url` or `topic` disables sending (the
 * config layer already dropped illegal values). The first delivery failure
 * calls `onNotice` once; every later failure is silent. `close()` aborts
 * in-flight requests and turns the publisher into a no-op.
 */
export function createNtfyPublisher(opts: {
  readonly settings: NtfySettings;
  readonly fetchImpl?: typeof fetch;
  readonly onNotice?: (text: string) => void;
  readonly resolveToken?: (raw: string) => string | undefined;
  /** Base for the `.env` fallback of the default resolver. */
  readonly cwd?: string;
}): NtfyPublisher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.settings.url.trim().replace(/\/+$/, "");
  const topic = opts.settings.topic.trim();
  const enabled = baseUrl.length > 0 && topic.length > 0;
  const endpoint = `${baseUrl}/${topic}`;
  const rawToken = opts.settings.token;
  const resolveToken =
    opts.resolveToken ?? ((raw: string) => resolveNtfyToken(raw, opts.cwd));
  const token = rawToken === undefined ? undefined : resolveToken(rawToken);
  if (token !== undefined && token.length > 0) {
    setActiveExtraSecrets(SECRET_OWNER, [token]);
  }
  const turnEndMinMs = opts.settings.turnEndMinMs ?? DEFAULT_TURN_END_MIN_MS;
  const inFlight = new Set<AbortController>();
  let failureNoticed = false;
  let closed = false;

  const notifyFailureOnce = (): void => {
    if (failureNoticed) return;
    failureNoticed = true;
    try {
      opts.onNotice?.(NOTICE_TEXT);
    } catch {
      // EXIT: a notice sink that throws must not break the TUI or the turn.
    }
  };

  const publish = (message: NtfyMessage): void => {
    if (!enabled || closed) return;
    const controller = new AbortController();
    inFlight.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    // A fire-and-forget publish must not pin the process to the event loop.
    timer.unref?.();
    const settle = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      inFlight.delete(controller);
    };
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: message.title,
      Priority: message.priority,
      Tags: message.tags,
    };
    if (token !== undefined && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    // Fire-and-forget: every rejection is handled here, so a failing publish
    // never surfaces as an unhandled rejection in the TUI loop.
    void (async (): Promise<void> => {
      try {
        const response: Response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: message.body,
          signal: controller.signal,
        });
        if (!response.ok && !closed) notifyFailureOnce();
      } catch {
        // EXIT: abort / network / DNS failure → one notice max, never retried.
        if (!closed) notifyFailureOnce();
      } finally {
        settle();
      }
    })();
  };

  return {
    approvalPending: (input) => {
      publish({
        title: "iknow: approval needed",
        body: `${input.tool} is waiting for approval`,
        priority: "high",
        tags: "warning",
      });
    },
    turnEnded: (input) => {
      if (input.durationMs < turnEndMinMs) return;
      publish({
        title: "iknow: turn finished",
        body: input.status,
        priority: "default",
        tags: "white_check_mark",
      });
    },
    close: () => {
      closed = true;
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
    },
  };
}
