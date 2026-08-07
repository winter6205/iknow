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
import { loadIknowEnv } from "../config/env.js";
import { initIknowWorkspaceSafe } from "../harness/identity/index.js";
import type { ServeAskUserHandle } from "../harness/permission/ask-user.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  json_mode?: boolean;
  /** Session pool root; defaults to ~/.iknow (spec #120 SC 1). */
  dataDir?: string;
  hubOptions?: Omit<SessionHubOptions, "store">;
  /** Trace output file path; forwarded to SessionHub for per-session JSONL trace (T5, #64). */
  traceOut?: string;
  /** Optional serve AskUser handle so the SPA can list + resolve pending
   *  permission requests. When omitted, hubOptions.askUser is used verbatim. */
  askHandle?: ServeAskUserHandle;
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
  // #196 IKNOW T5: eager + idempotent 初始化 ~/.iknow/(initIknowWorkspaceSafe
  // 内部 try/catch+warn,失败不阻塞装配 — 幂等备份,build-engine 内还有一次)。
  await initIknowWorkspaceSafe();
  const dataDir = resolveServeDataDir(opts?.dataDir);
  // cwd defaults to process.cwd() → the store picks its project namespace.
  const store = new SessionStore(dataDir);

  const hub = new SessionHub({
    store,
    defaultJsonMode: opts?.json_mode ?? false,
    traceOut: opts?.traceOut,
    // #196 A12: serve 跳过 BOOTSTRAP 段（surface="serve" → bootstrapActive=false）。
    surface: "serve",
    ...opts?.hubOptions,
    // Prefer the full handle when provided so web can resolve asks; fall back
    // to the bare askUser (back-compat for callers that only wire `.ask`).
    ...(opts?.askHandle
      ? { askUser: opts.askHandle.ask, askHandle: opts.askHandle }
      : {}),
  });

  const port =
    opts?.port ??
    (process.env.IKNOW_SERVE_PORT
      ? Number(process.env.IKNOW_SERVE_PORT)
      : 8787);
  const host = opts?.host ?? "127.0.0.1";
  // 上下文窗口：走 env SSOT（loadIknowEnv），供 HealthResponse 下发
  // （context-usage-display 计划：百分比分母）。与 hub.ensureDeps 同源。
  const env = loadIknowEnv();

  const listening = await listenSessionServer({
    hub,
    host,
    port: Number.isFinite(port) ? port : 8787,
    contextWindow: env.compress.contextWindow,
    // Note: serve still ACCEPTS --trace-out (write side via hub). The READ-
    // side reader is now mounted by `iknow trace` (spec #183 R3).
  });

  return { listening, hub };
}
