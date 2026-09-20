/**
 * src/tui/clipboard.ts
 *
 * Native clipboard fallback chain (rebuilt in src/tui/ after the tui-ink
 * archive; logic, platform probing, PATH isolation and timeouts preserved
 * per the original copy-flow contract):
 *  1. macOS pbcopy
 *  2. Linux wl-copy (Wayland)
 *  3. Linux xclip -selection clipboard (X11)
 *  4. Linux xsel --clipboard (X11 degradation)
 *  5. Windows clip.exe
 *  6. last resort: write <dataDir>/last_copy.txt
 *
 * Entry point: `doCopySelection` in app.tsx, used when OSC52 is
 * unavailable/unreachable. The preferred path is
 * `renderer.copyToClipboardOSC52` (built into @opentui/core); this
 * platform-probing chain only runs when the terminal does not support OSC52
 * — both paths are deliberately kept and OSC52 failures never go silent.
 *
 * No external dependency: the implementation is ~100 lines; pulling in
 * pyperclip would reach outside ts-paths and add a lockfile dependency for a
 * single repo, against the minimal-change goal.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CopyResult =
  | { kind: "ok"; method: ClipboardMethod }
  | { kind: "fallback"; path: string; bytes: number }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export type ClipboardMethod =
  "pyperclip" | "pbcopy" | "wl-copy" | "xclip" | "xsel" | "clip.exe";

interface CommandCandidate {
  readonly method: ClipboardMethod;
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Pick command candidates per platform. Linux lists wl-copy / xclip / xsel
 * together; copyToClipboard tries them until one is found on PATH.
 *
 * Why three on Linux: headless servers (CI, plain SSH) usually have none of
 * them; a desktop X11 setup has xclip, Wayland has the other two. Covering
 * all three beats betting on one — Mac/Win never take the Linux path.
 */
function candidatesForPlatform(): ReadonlyArray<CommandCandidate> {
  if (process.platform === "darwin") {
    return [{ method: "pbcopy", cmd: "pbcopy", args: [] }];
  }
  if (process.platform === "win32") {
    return [{ method: "clip.exe", cmd: "clip", args: [] }];
  }
  // linux / freebsd / other UN*X
  return [
    { method: "wl-copy", cmd: "wl-copy", args: [] },
    { method: "xclip", cmd: "xclip", args: ["-selection", "clipboard"] },
    { method: "xsel", cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function tryCommand(
  candidate: CommandCandidate,
  text: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(candidate.cmd, [...candidate.args], {
      stdio: ["pipe", "pipe", "pipe"],
      // detached stays false → the child does not leave the parent's process group
      windowsHide: true,
      env,
    });
    // unref: a wedged clipboard daemon (e.g. wl-copy blocked on the
    // compositor) can ignore SIGTERM; without unref it would hold the event
    // loop and Node never exits after /quit (exit() only unmounts, it does
    // not process.exit). Writing the system clipboard is fire-and-forget and
    // must not block TUI shutdown.
    child.unref();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // already exited on its own
      }
      resolve(false);
    }, 1500);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin?.on("error", () => {
      // EPIPE → the child exited early; spawn still fires close, and the close listener finalizes.
    });
    child.stdin?.end(text, "utf8");
  });
}

/**
 * The binary must be checked on PATH before spawning — a failed spawn leaks
 * stderr noise. This scans the PATH entries directly (no subprocess probe).
 */
function which(binary: string, envPath: string): boolean {
  const sep = process.platform === "win32" ? ";" : ":";
  return envPath.split(sep).some((dir) => {
    if (!dir) return false;
    return existsSync(join(dir, binary));
  });
}

/**
 * Copy text to the system clipboard. Empty text is allowed (treated as
 * success, nothing copied). Three outcomes: clipboard write ok / fallback
 * file write / error (no fallback available).
 *
 * options.env: the env injected into candidate commands (default =
 * process.env). Tests that assert the fallback path pass
 * { PATH: "/nonexistent" } instead of touching the global PATH, avoiding
 * cross-talk between parallel workers.
 *
 * Note: the OSC52 path goes through CliRenderer.copyToClipboardOSC52; this
 * function is only the native fallback when that is unavailable or fails —
 * no redundant probing, one responsibility.
 */
export async function copyToClipboard(
  text: string,
  options: { readonly dataDir?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<CopyResult> {
  if (text.length === 0) {
    return { kind: "empty" };
  }
  const env = options.env ?? process.env;
  const envPath = env.PATH ?? "";
  for (const candidate of candidatesForPlatform()) {
    if (!which(candidate.cmd, envPath)) continue;
    const ok = await tryCommand(candidate, text, env);
    if (ok) {
      return { kind: "ok", method: candidate.method };
    }
  }
  // Last resort: write a file. dataDir defaults to cwd; most shells can cat-paste it.
  const fallbackPath = options.dataDir
    ? join(options.dataDir, "last_copy.txt")
    : join(process.cwd(), "last_copy.txt");
  try {
    await writeFile(fallbackPath, text, "utf8");
    return {
      kind: "fallback",
      path: fallbackPath,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
