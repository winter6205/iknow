import { existsSync } from "node:fs";
import { relative } from "node:path";
import { ToolExecutionError } from "../errors.js";
import type { FsPolicy } from "./fs-policy.js";
import { SENSITIVE_PATHS } from "./fs-policy.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ResourceLimits } from "./resource-limits.js";

export interface SeccompProfile {
  readonly fd: number;
}

export interface BwrapFenceOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly fsPolicy: FsPolicy;
  readonly networkPolicy: NetworkPolicy;
  readonly resourceLimits: ResourceLimits;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly overlaySensitivePaths?: boolean;
  readonly seccompProfile?: never;
}

export interface BwrapFence {
  readonly argv: readonly string[];
  readonly sealed: true;
}

function pathForHome(fsPolicy: FsPolicy): string {
  const paths = fsPolicy.allowedPaths();
  // cwd + home are always present by construction in createFsPolicy. An
  // empty / single-entry list signals a misconfigured caller — fail loud
  // rather than silently falling back to process.cwd() (which would unbind
  // the fence from the actual workspace).
  if (paths.length < 2) {
    throw new ToolExecutionError(
      `bwrap: fsPolicy.allowedPaths() must contain at least cwd+home (got ${paths.length}); refusing to bind unknown paths`
    );
  }
  return paths[1] as string;
}

function isTmpDescendant(cwd: string, tmp: string): boolean {
  const rel = relative(tmp, cwd);
  return rel !== "" && rel !== ".." && !rel.startsWith("../");
}

function bindArgs(
  fsPolicy: FsPolicy,
  cwd: string,
  overlaySensitivePaths: boolean
): string[] {
  const paths = fsPolicy.allowedPaths();
  const home = pathForHome(fsPolicy);
  const tmp = paths[2] ?? "/tmp";
  const overlays = overlaySensitivePaths
    ? SENSITIVE_PATHS.flatMap((path) => {
        const target = path.replace("~", home);
        return existsSync(target) ? ["--tmpfs", target] : [];
      })
    : [];
  return [
    "--bind",
    tmp,
    tmp,
    "--bind",
    cwd,
    cwd,
    "--bind",
    home,
    home,
    ...overlays,
  ];
}

function baseArgs(
  cwd: string,
  fsPolicy: FsPolicy,
  resources: ResourceLimits,
  overlaySensitivePaths: boolean
): string[] {
  const tmp = fsPolicy.allowedPaths()[2] ?? "/tmp";
  const cwdRebind = isTmpDescendant(cwd, tmp) ? ["--bind", cwd, cwd] : [];
  return [
    "--unshare-user-try",
    "--unshare-net",
    "--die-with-parent",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    ...bindArgs(fsPolicy, cwd, overlaySensitivePaths),
    "--size",
    String(resources.tmp),
    "--tmpfs",
    "/tmp",
    ...cwdRebind,
    "--proc",
    "/proc",
    "--dev-bind",
    "/dev",
    "/dev",
  ];
}

export function createBwrapFence(opts: BwrapFenceOptions): BwrapFence {
  const envArgs = Object.entries(opts.env).flatMap(([name, value]) =>
    value === undefined ? [] : ["--setenv", name, value]
  );
  const argv = [
    "bwrap",
    ...baseArgs(
      opts.cwd,
      opts.fsPolicy,
      opts.resourceLimits,
      opts.overlaySensitivePaths ?? true
    ),
    // --clearenv must precede every --setenv so the sandbox inherits only the
    // whitelisted entries, never the host env (bwrap otherwise copies the whole
    // environment of the process that launches it). #225.
    "--clearenv",
    ...envArgs,
    "--chdir",
    opts.cwd,
    "--",
    opts.command,
    ...opts.args,
  ];
  void opts.networkPolicy;
  return Object.freeze({ argv: Object.freeze(argv), sealed: true as const });
}

export type { BwrapFence as BwrapFencePolicy };
