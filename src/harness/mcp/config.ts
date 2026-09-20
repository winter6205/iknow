/**
 * Two-level MCP config resolver.
 *
 * Load order: user-level `~/.iknow/mcp.json` → project-level
 * `<mcpConfigRoot>/.iknow/mcp.json`. A same-named server at project level replaces
 * the user-level entry wholesale (object substitution, no field-level deep merge).
 * Each server is validated as a discriminated union on `{type:"stdio"|"remote"}`;
 * `disabled:true` or `enabled:false` → status=disabled. Invalid entries are skipped
 * with exactly one warn line whose reason never contains env/command field values.
 *
 * The project-level path derives ONLY from the caller-injected `mcpConfigRoot`
 * (the stable product/main checkout), never from a task worktree or `process.cwd()`.
 *
 * Never read `~/.claude.json` / `.kiro/settings/mcp.json`.
 *
 * Design points:
 *  - Paths are parameterized (`{ home, mcpConfigRoot }`) so tests use tmp fixtures.
 *  - Top-level shape tolerance: accepts an `mcpServers` wrapper or a bare server map.
 *  - Missing file → that level is empty, continue.
 *  - Non-ENOENT IO / broken JSON / non-object top level → throw `McpLifecycleError`
 *    kind `config_load_failed` (the startup boundary may catch it and degrade to no MCP).
 *  - Missing `type` → infer remote from the presence of `url`, else stdio.
 *  - Output array sorted alphabetically by server name for stable upstream diffing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { McpLifecycleError } from "../errors.js";

/**
 * Source level of an MCP server entry (user / project).
 *
 * Override direction is fixed: project wins over user. `source` marks which level
 * the final entry came from, letting the upper layers (manager / assembly) apply
 * policies, e.g. excluding project-only servers when they are invisible from cwd.
 */
export type McpServerSource = "user" | "project";

/**
 * Discriminated union: `kind` determines the `entry` shape.
 *
 * `kind:"stdio"` → `entry.command` required, `entry.url` absent.
 * `kind:"remote"` → `entry.url` required, `entry.command` absent.
 *
 * Optional fields (`env` / `args` ...) are passed through for the adapter / manager
 * to interpret; this module only validates shape, not env/args values.
 */
export type McpServerConfig = McpStdioServer | McpRemoteServer;

export interface McpStdioServer {
  readonly name: string;
  readonly kind: "stdio";
  readonly source: McpServerSource;
  readonly status: "enabled" | "disabled";
  readonly entry: McpStdioEntry;
}

export interface McpRemoteServer {
  readonly name: string;
  readonly kind: "remote";
  readonly source: McpServerSource;
  readonly status: "enabled" | "disabled";
  readonly entry: McpRemoteEntry;
}

export interface McpStdioEntry {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpRemoteEntry {
  readonly url: string;
}

/** Top-level result of loadMcpConfig. */
export interface McpConfigResult {
  /** All servers after merging and dropping invalid entries, sorted alphabetically by name. */
  readonly servers: readonly McpServerConfig[];
}

/**
 * Loader inputs.
 *
 * - `home` ≡ `~` (user level reads `<home>/.iknow/mcp.json`)
 * - `mcpConfigRoot` ≡ stable product/main checkout (project level reads
 *   `<mcpConfigRoot>/.iknow/mcp.json`); NOT a task worktree or process.cwd()
 *
 * Both are mandatory to prevent implicit process.env / process.cwd() reads that
 * would break cross-machine reproducibility. Callers inject the `mcpConfigRoot`
 * returned by the roots resolver.
 */
export interface LoadMcpConfigOpts {
  readonly home: string;
  readonly mcpConfigRoot: string;
}

/**
 * Main entry: read both mcp.json levels, then merge + validate + isolate
 * invalid entries + one warn line each.
 *
 * Failure modes:
 *  - Either file missing → that level is empty, continue.
 *  - Non-ENOENT IO / broken JSON / non-object top level or server map →
 *    throw `McpLifecycleError` (`config_load_failed`).
 *    // EXIT: config load failed → no MCP manager, preserve harness startup
 *  - A single invalid server entry → one warn line, skip it, others continue.
 */
export async function loadMcpConfig(
  opts: LoadMcpConfigOpts
): Promise<McpConfigResult> {
  const userPath = path.join(opts.home, ".iknow", "mcp.json");
  const projectPath = path.join(opts.mcpConfigRoot, ".iknow", "mcp.json");

  const userEntries = await readLevelConfig(userPath, "user");
  const projectEntries = await readLevelConfig(projectPath, "project");

  // Entry-level wholesale override: a project entry with the same name replaces
  // the user one entirely (object substitution, no field-level deep merge).
  // `source` is rewritten along with it, reflecting the final winning level
  // rather than the first occurrence.
  const merged = new Map<
    string,
    { entry: RawServerEntry; source: McpServerSource }
  >();
  for (const [name, entry] of userEntries) {
    merged.set(name, { entry, source: "user" });
  }
  for (const [name, entry] of projectEntries) {
    merged.set(name, { entry, source: "project" }); // wholesale replace, never merge
  }

  const servers: McpServerConfig[] = [];
  // Alphabetical output keeps ordering stable across processes (upstream diff / logs / assembly).
  const names = [...merged.keys()].sort();
  for (const name of names) {
    const slot = merged.get(name);
    if (!slot) continue;
    const parsed = parseServerEntry(name, slot.entry, slot.source);
    if (parsed) servers.push(parsed);
  }

  return { servers };
}

// ---------------------------------------------------------------------------
// Internal — single-level read + shape validation
// ---------------------------------------------------------------------------

interface RawServerEntry {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly url?: unknown;
  readonly disabled?: unknown;
  readonly enabled?: unknown;
}

async function readLevelConfig(
  filePath: string,
  level: McpServerSource
): Promise<ReadonlyMap<string, RawServerEntry>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return new Map(); // missing file → empty level, degrade
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level io error reading config file: ${e.code ?? "unknown"}`,
      { cause: err }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = err as Error;
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level invalid JSON in config file: ${e.message.slice(0, 80)}`,
      { cause: err }
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level top-level is not an object in config file`
    );
  }

  // Prefer the `mcpServers` wrapper; otherwise accept a bare top-level server map.
  const obj = parsed as Record<string, unknown>;
  const inner = obj["mcpServers"];
  const mapSource = inner !== undefined ? inner : obj; // shape compatibility
  if (
    typeof mapSource !== "object" ||
    mapSource === null ||
    Array.isArray(mapSource)
  ) {
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level server map is not an object in config file`
    );
  }

  const out = new Map<string, RawServerEntry>();
  for (const [name, value] of Object.entries(
    mapSource as Record<string, unknown>
  )) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      warnEntry(name, "entry is not an object");
      continue;
    }
    out.set(name, value as RawServerEntry);
  }
  return out;
}

function parseServerEntry(
  name: string,
  raw: RawServerEntry,
  source: McpServerSource
): McpServerConfig | null {
  // status: driven by the `disabled` / `enabled` fields.
  // `enabled` wins when both are present (convention; unit tests pin this contract).
  let status: "enabled" | "disabled" = "enabled";
  if (raw.disabled === true) status = "disabled";
  if (raw.enabled === false) status = "disabled";
  if (raw.enabled === true) status = "enabled";

  // Shape inference: when `type` is absent, decide from whether `url` is present.
  const typeRaw = raw.type;
  const hasUrl = typeof raw.url === "string" && raw.url.length > 0;
  const hasCommand = typeof raw.command === "string" && raw.command.length > 0;

  let kind: "stdio" | "remote";
  if (typeRaw === "stdio") {
    if (!hasCommand) {
      warnEntry(name, "stdio entry missing command");
      return null;
    }
    kind = "stdio";
  } else if (typeRaw === "remote") {
    if (!hasUrl) {
      warnEntry(name, "remote entry missing url");
      return null;
    }
    kind = "remote";
  } else if (typeRaw === undefined) {
    if (hasUrl) kind = "remote";
    else kind = "stdio"; // no type + no url → treat as stdio, command validation still applies
  } else {
    warnEntry(name, `unknown type "${String(typeRaw)}"`);
    return null;
  }

  if (kind === "stdio") {
    if (!hasCommand) {
      // inferred as stdio but still missing command → invalid entry
      warnEntry(name, "stdio entry missing command");
      return null;
    }
    return {
      name,
      kind: "stdio",
      source,
      status,
      entry: {
        command: raw.command as string,
        args: normalizeStringArray(raw.args, name),
        env: normalizeStringRecord(raw.env, name),
      },
    };
  }

  // kind === "remote"
  return {
    name,
    kind: "remote",
    source,
    status,
    entry: {
      url: raw.url as string,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal — normalization
// ---------------------------------------------------------------------------

function normalizeStringArray(
  v: unknown,
  _name: string
): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") out.push(x);
  }
  return out;
}

function normalizeStringRecord(
  v: unknown,
  _name: string
): Readonly<Record<string, string>> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal — warn (reason must not leak env / command field values)
// ---------------------------------------------------------------------------

/**
 * Warn once for an invalid entry. The reason template carries only field
 * names / type descriptions — never values like env[k]=v or command="...".
 */
function warnEntry(name: string, reason: string): void {
  console.warn(`[mcp/config] server '${name}' skipped: ${reason}`);
}
