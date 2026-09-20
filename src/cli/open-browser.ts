/**
 * Cross-platform browser open (trace auto-open; zero new runtime deps).
 *
 * Shells out via node:child_process.spawn to the platform default:
 *   - macOS   `open <url>`
 *   - Windows `cmd /c start "" <url>` (start is a cmd builtin)
 *   - Linux/other UN*X `xdg-open <url>`
 *
 * Fail-fast is the caller's job (runTrace throws on a stale ./trace.jsonl
 * before starting). Opening here is fire-and-forget: spawn failures
 * (headless without xdg-open, WSL without a GUI) are silently ignored — the
 * CLI must never crash because a browser could not open. Spawn fails in two
 * flavours: a synchronous throw and an asynchronous 'error' event (e.g.
 * EACCES on the executable); both must be caught or the CLI dies.
 */
import { spawn } from "node:child_process";

export interface OpenBrowserOptions {
  /** Test seam: inject a fake spawn so CI never opens a real browser. Defaults to the node implementation. */
  readonly spawnProcess?: typeof spawn;
  /** Whether to actually open (false = no-op). Default true. */
  readonly enabled?: boolean;
}

/** Resolve the platform's open command (cmd + args, without URL). Tests inject spawn to assert on it. */
export function openCommandForPlatform(
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[] } {
  if (platform === "darwin") {
    return { cmd: "open", args: [] };
  }
  if (platform === "win32") {
    // `start` is a cmd builtin, only reachable via cmd /c; the first "" is the window-title placeholder.
    return { cmd: "cmd", args: ["/c", "start", ""] };
  }
  // linux / freebsd / other UN*X
  return { cmd: "xdg-open", args: [] };
}

/** Open url; spawn failures are silently ignored (no throw, no crashed process). */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void {
  if (opts.enabled === false) return;
  const { cmd, args } = openCommandForPlatform();
  const doSpawn = opts.spawnProcess ?? spawn;
  try {
    const child = doSpawn(cmd, [...args, url], {
      stdio: "ignore",
      detached: true,
    });
    // EACCES / ENOENT etc. surface as an async 'error' event; unhandled, it
    // takes down the whole CLI (the trace is already serving — dying over a
    // browser is wrong). Fail-safe: swallow it, same semantics as the sync
    // catch below.
    child.on("error", () => {});
    // unref: opening the browser is fire-and-forget; don't hold the event
    // loop, so Ctrl+C can exit the trace process without waiting on the child.
    child.unref();
  } catch {
    // spawn threw synchronously -> skip opening, never block CLI startup.
  }
}
