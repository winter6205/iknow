/**
 * LSP server declaration layer.
 *
 * This file does exactly two things:
 *   1. declare `NearestRoot` (walk up from file to the nearest ancestor
 *      containing an include marker as the LSP root);
 *   2. side-by-side declare the multi-language `LspServerInfo`s
 *      (`Typescript`/`Pyright`/`YamlLS`/`JsonLS`/`DockerfileLS`) + the `SERVERS`
 *      array + `resolveServer(file)` single-hit dispatch by extension.
 *
 * Kept flat (splitting into registry/spawn/client files was rejected):
 * client.ts reads the `Typescript` launch handle from here, and the handler
 * layer (aci/tools/lsp.ts) consumes `LspCtx` only indirectly via client.ts's
 * `getClient(file, ctx)`.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

import type { LspCtx, LspServerInfo } from "./types.js";

/**
 * NearestRoot(include, exclude?) — returns a `(file, ctx) => Promise<string|undefined>`
 * lookup: walk up from `path.dirname(file)` to the first ancestor containing any
 * include marker as the root.
 *
 * - `exclude` optional: omitted means no exclusion (any ancestor with an
 *   include marker hits).
 * - Each ancestor is first checked for exclude files: present → skip that
 *   ancestor (treated as excluded).
 * - Upper bound stop = `ctx.directory`: never escape the working directory
 *   (security boundary).
 * - Found → return that ancestor's path; reached stop without a hit → return
 *   `undefined`.
 */
export function NearestRoot(
  includePatterns: readonly string[],
  excludePatterns?: readonly string[]
): (file: string, ctx: LspCtx) => Promise<string | undefined> {
  return async (file: string, ctx: LspCtx): Promise<string | undefined> => {
    const exclude = excludePatterns ?? [];
    // Upper bound stop = ctx.directory: file must lie inside ctx.directory
    // (security boundary). Reject an escaping file at entry instead of only
    // breaking after the walk crosses the bound — that would read ancestors
    // outside ctx.directory and possibly spawn there.
    const stop = path.resolve(ctx.directory);
    const startDir = path.resolve(path.dirname(file));
    if (!isInsideOrEqual(startDir, stop)) return undefined;

    let dir = startDir;
    while (true) {
      const entries = await readdir(dir).catch(() => [] as string[]);
      const hasExclude = exclude.some((name) => entries.includes(name));
      if (!hasExclude) {
        const hasMarker = includePatterns.some((name) =>
          entries.includes(name)
        );
        if (hasMarker) return dir;
      }
      if (dir === stop) break; // reached the upper bound, stop walking up
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem-root guard
      dir = parent;
    }
    return undefined;
  };
}

/**
 * Whether `child` equals or lies below `stop` (prefix relation, handling
 * path.sep and boundaries). Exactly-equal paths count as inside (walking may
 * stop at `stop` itself); only an ancestor directory of `child` counts;
 * anything else is outside.
 */
function isInsideOrEqual(child: string, stop: string): boolean {
  if (child === stop) return true;
  const rel = path.relative(stop, child);
  // path.relative not starting with `..` (and non-empty) ⇒ child is below or
  // inside stop.
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Absolute executable paths owned by the active project / worktree, in probe
 * order: the npm bin shim first (what `npm i` creates), then the project
 * virtualenvs (what `pip install` / `uv` create).
 *
 * Why these are probed before the harness's own `node_modules`: the server that
 * understands a project is the one that project pins — its TypeScript version,
 * its Python environment, its plugin set. Resolution that only looks at the
 * harness module cannot see a dependency installed into the user's project at
 * all, which is the gap T1 reproduced.
 */
export function projectExecutableCandidates(
  root: string,
  binName: string
): readonly string[] {
  // EXIT: an empty root yields an empty list (no paths, no throw) so a caller
  // with no resolved root degrades to the harness + PATH layers instead of
  // probing relative paths against an unknown cwd.
  if (root.length === 0 || binName.length === 0) return [];
  return [
    path.join(root, "node_modules", ".bin", binName),
    path.join(root, "node_modules", ".bin", `${binName}.cmd`),
    path.join(root, ".venv", "bin", binName),
    path.join(root, ".venv", "Scripts", `${binName}.exe`),
    path.join(root, "venv", "bin", binName),
    path.join(root, "venv", "Scripts", `${binName}.exe`),
  ];
}

/**
 * First existing project/worktree executable, or undefined. `existsSync`
 * follows the symlink an npm bin shim points at, so a dangling link (an
 * interrupted install) is correctly reported as absent.
 */
function resolveProjectBin(root: string, binName: string): string | undefined {
  for (const candidate of projectExecutableCandidates(root, binName)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `createRequire` anchored at the project root instead of the harness module:
 * node's own resolution then walks the project's `node_modules` chain, which is
 * how any tool in that project resolves its dependency versions.
 */
function requireFromRoot(root: string): NodeRequire {
  return createRequire(path.join(root, "__iknow_lsp_resolve__.js"));
}

/**
 * Layer 3 of `resolveServerExecutable`: this package's own `node_modules` under
 * the harness module — read `pkg/package.json`'s `bin` field and resolve the
 * entry absolutely (the pre-existing `resolveLanguageServerBin` pattern).
 */
function resolvePackageBinEntry(
  pkgName: string,
  binName: string
): string | undefined {
  try {
    const pkgJson = createRequire(import.meta.url).resolve(
      `${pkgName}/package.json`
    );
    const binField = JSON.parse(readFileSync(pkgJson, "utf8")).bin;
    const binRel: string | undefined =
      typeof binField === "string" ? binField : binField?.[binName];
    if (typeof binRel !== "string") return undefined;
    const bin = createRequire(import.meta.url).resolve(
      `${pkgName}/${binRel}`
    );
    return existsSync(bin) ? bin : undefined;
  } catch {
    // EXIT: an unresolvable package.json / bin entry leaves this layer empty;
    // the caller continues to PATH which semantics.
    return undefined;
  }
}

/**
 * Resolve an npm-wrapper language server's executable.
 *
 * Precedence (explicit override first, process `PATH` as the last fallback):
 *   1) `ctx.resolveBin` — the explicit override, highest by contract;
 *   2) the active project / worktree: `node_modules/.bin/<bin>` then the project
 *      virtualenv `bin`/`Scripts` (see `projectExecutableCandidates`);
 *   3) this package's own `node_modules` under the harness module (the existing
 *      `resolveLanguageServerBin` pattern: read `pkg/package.json`'s `bin`
 *      field, resolve it absolutely);
 *   4) PATH `which` semantics (`spawnSync <bin> --version`).
 *
 * An empty root simply skips layer 2. Unavailable → `undefined` (the caller
 * marks the start failed with the `executable-resolution` stage, no throw).
 */
export async function resolveServerExecutable(
  pkgName: string,
  binName: string,
  root: string,
  ctx?: LspCtx
): Promise<string | undefined> {
  if (ctx?.resolveBin) {
    const override = await ctx.resolveBin(pkgName, binName);
    if (override !== undefined) return override;
  }

  // 2) Active project / worktree executable.
  const projectBin = resolveProjectBin(root, binName);
  if (projectBin !== undefined) return projectBin;

  // 3) Same-source resolution of this package's bin entry under node_modules.
  const packageBin = resolvePackageBinEntry(pkgName, binName);
  if (packageBin !== undefined) return packageBin;

  // 4) which semantics: find binName directly on PATH.
  // spawnSync throwing ENOENT (command absent) or a nonzero exit both mean
  // unavailable.
  try {
    const probe = spawnSync(binName, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return binName;
  } catch {
    // EXIT: spawnSync threw ENOENT — the binary is absent from PATH entirely,
    // so no executable resolves and the caller records executable-resolution.
    return undefined;
  }
  return undefined;
}

/**
 * Detect the current Python interpreter path (pyright's `pythonPath`
 * initialization).
 *
 * First existing candidate wins:
 *   1. the virtualenv pointed to by the `VIRTUAL_ENV` env var;
 *   2. `<root>/.venv/bin/python`;
 *   3. `<root>/venv/bin/python`.
 * None found → `undefined` (pyright still spawns without pythonPath; the
 * system python covers it).
 */
async function detectVenvPython(root: string): Promise<string | undefined> {
  const candidates: string[] = [];
  if (process.env.VIRTUAL_ENV) {
    candidates.push(
      path.join(process.env.VIRTUAL_ENV, "bin", "python"),
      path.join(process.env.VIRTUAL_ENV, "Scripts", "python.exe")
    );
  }
  candidates.push(
    path.join(root, ".venv", "bin", "python"),
    path.join(root, ".venv", "Scripts", "python.exe"),
    path.join(root, "venv", "bin", "python"),
    path.join(root, "venv", "Scripts", "python.exe")
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * TS project-root marker files. A directory containing any of them counts as
 * a TS project root. Kept as a nearby local constant (not exported).
 */
const TS_LOCKFILES: readonly string[] = [
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/**
 * TS exclude markers: an ancestor containing these is not treated as a TS
 * project root (a deno.json means the directory is likely a Deno project, not
 * a node TS one). Kept as a nearby local constant (not exported).
 */
const TS_EXCLUDE: readonly string[] = ["deno.json", "deno.jsonc"];

/**
 * Resolve the typescript-language-server executable (not installed /
 * unresolvable → undefined). Same precedence chain as
 * `resolveServerExecutable`; kept as a named helper because the TypeScript
 * server also needs a separate tsserver entry point below.
 */
async function resolveLanguageServerBin(
  root: string,
  ctx?: LspCtx
): Promise<string | undefined> {
  return resolveServerExecutable(
    "typescript-language-server",
    "typescript-language-server",
    root,
    ctx
  );
}

/**
 * tsserver entry point passed to typescript-language-server's
 * `initializationOptions.tsserver.path`.
 *
 * The project's own `typescript` wins over the harness's: the language server
 * and the TypeScript compiler must come from the same project, otherwise
 * diagnostics are computed against a different compiler than the project pins.
 */
function resolveTsserverEntry(root: string): string | undefined {
  try {
    const bin = requireFromRoot(root).resolve("typescript/lib/tsserver.js");
    if (existsSync(bin)) return bin;
  } catch {
    // EXIT: the project does not ship typescript → fall back to the harness's
    // own copy (below), which is the pre-existing behavior.
  }
  try {
    return createRequire(import.meta.url).resolve("typescript/lib/tsserver.js");
  } catch {
    // EXIT: neither the project nor the harness ships typescript → no tsserver
    // entry point to pass, so the server cannot start (spawn returns undefined).
    return undefined;
  }
}

/**
 * TS single-language LSP server declaration (the floor). client.ts knows only
 * this server by default.
 *
 * `spawn` returning `undefined` means this server is unavailable in the
 * current environment (tsserver bin missing / typescript-language-server
 * binary missing); client.ts records it in broken memory without throwing,
 * and the handler layer translates it to the plain string
 * `"(no LSP server available for file)"`.
 */
export const Typescript: LspServerInfo = {
  id: "typescript",
  installHint: "npm i -g typescript typescript-language-server",
  root: NearestRoot(TS_LOCKFILES, TS_EXCLUDE),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  executableCandidates: (root) =>
    projectExecutableCandidates(root, "typescript-language-server"),
  async spawn(root, ctx) {
    let tsserver: string | undefined;
    if (ctx.resolveBin) {
      tsserver = await ctx.resolveBin("typescript", "tsserver");
    }
    if (!tsserver) {
      tsserver = resolveTsserverEntry(root);
      // EXIT: neither the project nor the harness ships typescript → no
      // tsserver to point the server at, so the server cannot start.
      if (!tsserver) return undefined;
    }

    const bin = await resolveLanguageServerBin(root, ctx);
    // EXIT: the language-server executable resolved nowhere (override, project
    // node_modules/.bin, project venv, harness node_modules, PATH).
    if (!bin) return undefined;

    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: { tsserver: { path: tsserver } } };
  },
};

/**
 * Python LSP server (pyright) — one of the first four npm-wrapper languages.
 *
 * root has no "rootless" problem like YAML/JSON: pyright finds the project
 * root via pyproject.toml / setup.py / setup.cfg / requirements.txt / Pipfile
 * / pyrightconfig.json. exclude is omitted (Python has no Deno-style conflict
 * markers).
 *
 * spawn: `resolveServerExecutable("pyright", "pyright-langserver", root, ctx)` probes the bin;
 * `detectVenvPython` probes VIRTUAL_ENV → .venv → venv, passing through
 * `{ pythonPath }` on a hit; otherwise initialization is omitted (legitimate —
 * pyright falls back to system python).
 */
export const Pyright: LspServerInfo = {
  id: "pyright",
  installHint: "npm i -g pyright",
  root: NearestRoot([
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "pyrightconfig.json",
  ]),
  extensions: [".py", ".pyi"],
  executableCandidates: (root) =>
    projectExecutableCandidates(root, "pyright-langserver"),
  async spawn(root, ctx) {
    const bin = await resolveServerExecutable(
      "pyright",
      "pyright-langserver",
      root,
      ctx
    );
    if (!bin) return undefined;
    const pythonPath = await detectVenvPython(root);
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      process: child,
      initialization: pythonPath ? { pythonPath } : undefined,
    };
  },
};

/**
 * YAML LSP server (yaml-language-server) — one of the first four languages.
 *
 * root: no YAML-specific root marker, so it keeps the current
 * `_file => ctx.directory` (same behavior as vscode-json-languageserver).
 * spawn: `resolveServerExecutable("yaml-language-server", ...)`; no
 * init options.
 */
export const YamlLS: LspServerInfo = {
  id: "yaml-language-server",
  installHint: "npm i -g yaml-language-server",
  root: (_file, ctx) => Promise.resolve(ctx.directory),
  extensions: [".yaml", ".yml"],
  executableCandidates: (root) =>
    projectExecutableCandidates(root, "yaml-language-server"),
  async spawn(root, ctx) {
    const bin = await resolveServerExecutable(
      "yaml-language-server",
      "yaml-language-server",
      root,
      ctx
    );
    if (!bin) return undefined;
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: undefined };
  },
};

/**
 * JSON LSP server (vscode-json-languageserver) — one of the first four
 * languages.
 *
 * root: JSON has no project-root concept, `_file => ctx.directory`.
 * spawn: `resolveServerExecutable("vscode-json-languageserver",
 * "vscode-json-languageserver")`; no required init (schemas go through
 * workspace/config).
 */
export const JsonLS: LspServerInfo = {
  id: "json-language-server",
  installHint: "npm i -g vscode-langservers-extracted",
  root: (_file, ctx) => Promise.resolve(ctx.directory),
  extensions: [".json"],
  executableCandidates: (root) =>
    projectExecutableCandidates(root, "vscode-json-languageserver"),
  async spawn(root, ctx) {
    const bin = await resolveServerExecutable(
      "vscode-json-languageserver",
      "vscode-json-languageserver",
      root,
      ctx
    );
    if (!bin) return undefined;
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: undefined };
  },
};

/**
 * Dockerfile LSP server (dockerfile-language-server-nodejs) — one of the
 * first four languages.
 *
 * root: `_file => ctx.directory` (Dockerfiles have no project-root concept).
 * spawn: `resolveServerExecutable("dockerfile-language-server-nodejs",
 * "docker-langserver")`; no init options.
 *
 * extensions includes the extension-less `"Dockerfile"` (full filename):
 * `path.extname("Dockerfile")` is empty, so resolveServer falls back to the
 * full filename and routes a root-level `Dockerfile` to this server.
 */
export const DockerfileLS: LspServerInfo = {
  id: "dockerfile-language-server-nodejs",
  installHint: "npm i -g dockerfile-language-server-nodejs",
  root: (_file, ctx) => Promise.resolve(ctx.directory),
  extensions: [".dockerfile", "Dockerfile"],
  executableCandidates: (root) =>
    projectExecutableCandidates(root, "docker-langserver"),
  async spawn(root, ctx) {
    const bin = await resolveServerExecutable(
      "dockerfile-language-server-nodejs",
      "docker-langserver",
      root,
      ctx
    );
    if (!bin) return undefined;
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: undefined };
  },
};

/**
 * Array of all declared language servers. client.ts consumes it via
 * `resolveServer(file)`; the probe traverses this array × PROBE_TARGETS
 * fixtures for a 9-op smoke test.
 */
export const SERVERS = [
  Typescript,
  Pyright,
  YamlLS,
  JsonLS,
  DockerfileLS,
] as const;

/**
 * resolveServer(file) — pick the LSP server from the file's extension.
 *
 * `const ext = path.extname(file) || path.basename(file);`: extension-less
 * files (e.g. a root-level `Dockerfile`) match on basename — handlers pass
 * `params.file` as a full path, and falling back to the full path would never
 * hit `Dockerfile` from `"/proj/Dockerfile"`. Finds the first server in
 * declaration order whose `extensions.includes(ext)` (single hit, no union);
 * empty array or no match → `undefined` (no throw).
 */
export function resolveServer(file: string): LspServerInfo | undefined {
  const ext = path.extname(file) || path.basename(file);
  return SERVERS.find((s) => s.extensions.includes(ext));
}
