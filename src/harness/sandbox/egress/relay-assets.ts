/**
 * src/harness/sandbox/egress/relay-assets.ts
 *
 * Egress relay = assets shipped by this repo (`<installRoot>/vendor/egress-relay/`,
 * two pure-node .mjs files); socat is **not a product dependency** (ADR-0107).
 *
 * Single responsibility: resolve the relay dependency trio = node absolute
 * path + two asset absolute paths (plus the asset dir for the fence
 * `--ro-bind`). Path resolution follows the vendor/ripgrep precedent anchored
 * on `resolveInstallRoot()` (walks up from `import.meta.url` to package.json,
 * so dev `src/…` and packaged `dist/…` land at the same package root; never
 * falls back to `process.cwd()`).
 *
 * node resolution: the product may run under bun, so `process.execPath` is
 * not guaranteed to be node — use it only when its basename is `node` and it
 * exists, else `which node`. Executable inside either fence tier (global tier
 * `--bind / /`; workspace tier keeps the exec bit via the home-subtree
 * `--ro-bind`). Unresolvable node / missing assets → `undefined`; the session
 * layer fail-closes (`EgressRelayUnavailableError`).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveInstallRoot } from "../../session-roots.js";

/** Asset dir (relative to install root); the fence `--ro-bind`s it wholesale. */
export const EGRESS_RELAY_DIR_REL = "vendor/egress-relay";
/** In-fence TCP→unix relay (half-bridge). */
export const EGRESS_TCP_RELAY_FILE = "egress-tcp-relay.mjs";
/** HTTP CONNECT tunnel used by ProxyCommand. */
export const EGRESS_HTTP_CONNECT_FILE = "egress-http-connect.mjs";

/** Relay path trio consumed by session / fence assembly (all host-absolute). */
export interface EgressRelayPaths {
  /** Host-resolved node absolute path (shared by command-chain prefix and ProxyCommand). */
  readonly nodePath: string;
  /** Asset dir (`--ro-bind` target, src=dest identical). */
  readonly relayDir: string;
  /** Half-bridge relay script absolute path. */
  readonly bridgeScriptPath: string;
  /** CONNECT tunnel script absolute path (goes into GIT_SSH_COMMAND argv; token never inlined). */
  readonly connectScriptPath: string;
}

/** Compute asset paths from an install root (no existence checks; reusable by tests / assembly). */
export function egressRelayPathsFor(installRoot: string): {
  relayDir: string;
  bridgeScriptPath: string;
  connectScriptPath: string;
} {
  return {
    relayDir: join(installRoot, EGRESS_RELAY_DIR_REL),
    bridgeScriptPath: join(
      installRoot,
      EGRESS_RELAY_DIR_REL,
      EGRESS_TCP_RELAY_FILE
    ),
    connectScriptPath: join(
      installRoot,
      EGRESS_RELAY_DIR_REL,
      EGRESS_HTTP_CONNECT_FILE
    ),
  };
}

/**
 * node executable resolution: execPath is node (exact basename match, fails
 * under bun) and exists → use it directly; else `which node`. Failure →
 * `undefined`.
 */
export function resolveNodeExecutable(): string | undefined {
  const execPath = process.execPath;
  if (
    typeof execPath === "string" &&
    execPath.length > 0 &&
    basename(execPath) === "node" &&
    existsSync(execPath)
  ) {
    return execPath;
  }
  const probe = spawnSync("which", ["node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  const found =
    probe.status === 0 && typeof probe.stdout === "string"
      ? probe.stdout.trim()
      : "";
  return found.length > 0 && existsSync(found) ? found : undefined;
}

/**
 * Production resolution entry. All deps are test/probe injection points
 * (existence, node resolution, install root); omit them to use real host
 * values. Any failed step → `undefined` (caller fail-closes). A throw from
 * `resolveInstallRoot()` (bare environment) likewise collapses to
 * `undefined` — missing-product-dependency semantics.
 */
export function resolveEgressRelay(
  deps: {
    readonly installRoot?: string;
    readonly resolveNode?: () => string | undefined;
    readonly exists?: (path: string) => boolean;
  } = {}
): EgressRelayPaths | undefined {
  const nodePath = (deps.resolveNode ?? resolveNodeExecutable)();
  if (nodePath === undefined) return undefined;
  let installRoot: string;
  try {
    installRoot = deps.installRoot ?? resolveInstallRoot();
  } catch {
    return undefined;
  }
  const paths = egressRelayPathsFor(installRoot);
  const exists = deps.exists ?? existsSync;
  if (!exists(paths.bridgeScriptPath) || !exists(paths.connectScriptPath)) {
    return undefined;
  }
  return { nodePath, ...paths };
}
