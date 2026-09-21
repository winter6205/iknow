/**
 * LSP probe fixture table — consumed by lsp-probe.ts (spec 251-lsp-tool).
 *
 * One `{ serverId, targetFile, line, char }` entry per language; the probe
 * walks this table × production `SERVERS` running a 9-op smoke test against
 * real language servers.
 *
 * Two kinds of targets:
 *  - **Real repo files** (typescript / json): `targetFile` is an absolute
 *    path used directly as the 9-op target; `line`/`char` point at a real
 *    symbol inside it.
 *  - **Runtime-generated fixtures** (python / yaml / dockerfile): no usable
 *    in-repo target exists (pyright needs a root marker, yaml-language-server
 *    returns empty definition/hover for workflow files, the repo has no
 *    Dockerfile), so `fixture` carries the source, `targetFile` is a filename
 *    inside the fixture project, and the probe writes them into
 *    `.iknow/probe-lsp/<lang>/` (gitignored) before probing. `rootMarkers`
 *    lists the marker files the fixture project root needs (pyright locates
 *    its root via `pyrightconfig.json`).
 *
 * Fixtures live under `.iknow/` (gitignored) so they are never mistaken for
 * real deployment files.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (= worktree root); real-repo target paths resolve from here. */
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface ProbeTarget {
  /** Server id in production `SERVERS`; the probe selects the server by it. */
  readonly serverId: string;
  /** Absolute path to a real repo file, or a filename inside the fixture project (when `fixture` is set). */
  readonly targetFile: string;
  /** 1-based line (converted to 0-based at the handler layer). */
  readonly line: number;
  /** 0-based character. */
  readonly char: number;
  /** Fixture source; when present the probe writes it to `.iknow/probe-lsp/<lang>/` and uses that as target. */
  readonly fixture?: string;
  /** Root-marker files the fixture project needs (e.g. pyrightconfig.json). */
  readonly rootMarkers?: readonly string[];
}

/**
 * Fixture table per language. `--lang` values are exactly the keys here
 * (typescript/python/yaml/json/dockerfile).
 *
 * Verified symbol positions in the real repo files:
 *  - typescript: `client.ts:94` `export async function getClient(`, char 22 is
 *    the start of the `getClient` identifier (0-based).
 *  - json: `tsconfig.json:2` `  "compilerOptions": {`, char 1 is the start of
 *    the key.
 */
export const PROBE_TARGETS: Record<string, ProbeTarget> = {
  typescript: {
    serverId: "typescript",
    targetFile: resolve(REPO_ROOT, "src/harness/lsp/client.ts"),
    line: 94,
    char: 22,
  },
  python: {
    serverId: "pyright",
    targetFile: "probe.py",
    line: 1,
    char: 4,
    rootMarkers: ["pyrightconfig.json"],
    fixture:
      'def compute_offset(base: int, step: int = 1) -> int:\n' +
      '    return base + step\n' +
      '\n' +
      'def main() -> None:\n' +
      '    return compute_offset(1)\n',
  },
  yaml: {
    serverId: "yaml-language-server",
    targetFile: "probe.yml",
    line: 5,
    char: 9,
    // definition/hover came back empty for real .github/workflows/*.yml files
    // (no resolvable anchor), so yaml uses a runtime fixture like python /
    // dockerfile: the anchor reference `*defaults` (line 5, char 9) verifiably
    // resolves to the anchor declaration (`&defaults`) instead.
    rootMarkers: [],
    fixture:
      "defaults: &defaults\n" +
      "  runs-on: ubuntu-latest\n" +
      "jobs:\n" +
      "  build:\n" +
      "    <<: *defaults\n",
  },
  json: {
    serverId: "json-language-server",
    targetFile: resolve(REPO_ROOT, "tsconfig.json"),
    line: 2,
    char: 1,
  },
  dockerfile: {
    serverId: "dockerfile-language-server-nodejs",
    targetFile: "Dockerfile",
    line: 1,
    char: 5,
    // This server returns null for FROM image names and ARG references, but
    // definition on the variable NAME of `ARG BASE_VERSION=20` (line 1, chars
    // 4-16) is non-empty (self range) and hover returns the value
    // (`{"contents":"20"}`). The fixture therefore combines an ARG reference
    // with a variable-name target so definition/hover are truly non-empty;
    // references / implementation / workspaceSymbol / callHierarchy have no
    // provider on this server (see the probe's capability-trimming log).
    rootMarkers: [],
    fixture:
      "ARG BASE_VERSION=20\n" +
      "FROM node:${BASE_VERSION}-alpine\n" +
      'RUN echo "hello" && echo "world"\n',
  },
};
