/**
 * Bootstrap: SessionHub + HTTP listen + static web.
 * 022 T5: SessionStore required (hub needs it); caller_role retired from wire.
 */
import { homedir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { SessionHub, type SessionHubOptions } from "./hub.js";
import { listenSessionServer, type ListeningServer } from "./http.js";
import { SessionStore } from "./store/index.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  json_mode?: boolean;
  /** Session pool root; defaults to ~/.iknow (spec #120 SC 1). */
  dataDir?: string;
  hubOptions?: Omit<SessionHubOptions, "store">;
  /** Trace output file path; forwarded to SessionHub for per-session JSONL trace (T5, #64). */
  traceOut?: string;
};

/**
 * Resolve the session pool root: explicit dataDir wins (absolute-pathed);
 * default is the shared pool root ~/.iknow (spec #120 SC 1 / SC 2).
 * Pure (no IO) and exported so tests can assert the default without
 * ever writing to the real $HOME.
 */
export function resolveServeDataDir(dataDir?: string): string {
  return dataDir ? path.resolve(dataDir) : join(homedir(), ".iknow");
}

export async function startSessionServe(
  opts?: ServeOptions
): Promise<{ listening: ListeningServer; hub: SessionHub }> {
  const dataDir = resolveServeDataDir(opts?.dataDir);
  // cwd defaults to process.cwd() → the store picks its project namespace.
  const store = new SessionStore(dataDir);

  const hub = new SessionHub({
    store,
    defaultJsonMode: opts?.json_mode ?? false,
    traceOut: opts?.traceOut,
    ...opts?.hubOptions,
  });

  const port =
    opts?.port ??
    (process.env.IKNOW_SERVE_PORT
      ? Number(process.env.IKNOW_SERVE_PORT)
      : 8787);
  const host = opts?.host ?? "127.0.0.1";

  const listening = await listenSessionServer({
    hub,
    host,
    port: Number.isFinite(port) ? port : 8787,
  });

  return { listening, hub };
}
