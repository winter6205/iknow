/**
 * Bootstrap: SessionHub + HTTP listen + static web.
 * 022 T5: SessionStore required (hub needs it); AgentMode replaces
 * AgentModeCli; caller_role retired from wire.
 */
import * as path from "node:path";
import { SessionHub, type SessionHubOptions } from "./hub.js";
import { listenSessionServer, type ListeningServer } from "./http.js";
import { SessionStore } from "./store/index.js";
import type { AgentMode } from "../config/env.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  mode?: AgentMode;
  embeddings?: boolean;
  json_mode?: boolean;
  /** Base dir for session files; defaults to <cwd>/data. */
  dataDir?: string;
  hubOptions?: SessionHubOptions;
  /** Trace output file path; forwarded to SessionHub for per-session JSONL trace (T5, #64). */
  traceOut?: string;
};

export async function startSessionServe(
  opts?: ServeOptions
): Promise<{ listening: ListeningServer; hub: SessionHub }> {
  const dataDir = opts?.dataDir
    ? path.resolve(opts.dataDir)
    : path.resolve(process.cwd(), "data");
  const store = new SessionStore(dataDir);

  const hub = new SessionHub({
    store,
    defaultMode: opts?.mode ?? "deterministic",
    defaultEmbeddings: opts?.embeddings ?? false,
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
