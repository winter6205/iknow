/**
 * Bootstrap: SessionHub + HTTP listen + static web.
 */
import { SessionHub, type SessionHubOptions } from "./hub.js";
import {
  listenSessionServer,
  type ListeningServer,
} from "./http.js";
import type { AgentModeCli } from "../interaction/slash.js";
import type { CallerRole } from "../shared/schema.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  role?: CallerRole;
  mode?: AgentModeCli;
  embeddings?: boolean;
  json_mode?: boolean;
  hubOptions?: SessionHubOptions;
};

export async function startSessionServe(
  opts?: ServeOptions,
): Promise<{ listening: ListeningServer; hub: SessionHub }> {
  const hub = new SessionHub({
    defaultRole: opts?.role ?? "employee",
    defaultMode: opts?.mode ?? "deterministic",
    defaultEmbeddings: opts?.embeddings ?? false,
    defaultJsonMode: opts?.json_mode ?? false,
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
