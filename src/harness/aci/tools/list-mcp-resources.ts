/**
 * list_mcp_resources tool — the list side of two explicit tools (read side
 * in read-mcp-resource.ts). The model accesses resources exposed by an MCP
 * server in a list → read two-step flow.
 *
 * Dependency-injection shape (lazy self-reference): what the list tool needs
 * is the assembled McpManager instance. In the build-engine.ts assembly
 * path the manager is provided through the `getMcpManager` lazy closure, so
 * deps take `getManager: () => McpManager`, dereferenced only at call time.
 * Assembly holds no manager reference, avoiding a cycle.
 *
 * Output wire shape:
 *   - one JSON per resource line (explicit field projection)
 *   - blank line (visual separator)
 *   - `--- perServer ---` marker line
 *   - then one perServer state JSON per line (server / state / nextCursor?)
 *   - empty resource set → the neutral `(no resources)` placeholder alone
 *     (a legal empty value)
 *
 * ACI metadata:
 *   category: "read-only"      (an iknow-written meta tool, transparent behavior)
 *   isConcurrencySafe: true    (listing changes no state)
 *   interruptBehavior: cancel  (same shape as web_fetch)
 *   timeoutTier: "default"     (30s — aggregating N servers cannot be fast)
 *
 * description: states only positive trigger conditions, no negative
 * prohibition words. Trigger: before accessing resources exposed by MCP
 * servers, list first to obtain server+uri pairs.
 */

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type {
  ListResourcesResult,
  McpManager,
  McpResource,
  McpPerServerState,
} from "../../mcp/manager.js";

/**
 * Dependency injection: `getManager` lazily dereferences the assembled
 * McpManager. Assembly incomplete → ToolExecutionError (fail-fast, same
 * shape as tool_search).
 */
export interface ListMcpResourcesToolDeps {
  readonly getManager: () => McpManager;
}

interface ListMcpResourcesInput {
  readonly server?: unknown;
  readonly cursor?: unknown;
}

const EMPTY_PLACEHOLDER = "(no resources)";

/**
 * Factory: createListMcpResourcesTool(deps) — the list-MCP-resources tool.
 *
 * The returned AciToolDef satisfies:
 *   - name === "list_mcp_resources"
 *   - inputSchema: { server? string / cursor? string }, additionalProperties:false
 *   - aci metadata: read-only / concurrency-safe / cancel / default tier
 */
export function createListMcpResourcesTool(
  deps: ListMcpResourcesToolDeps
): AciToolDef {
  const getManager = deps.getManager;

  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileListInput(input);
    const manager = resolveManager(getManager);

    let result: ListResourcesResult;
    try {
      result = await manager.listResources({
        ...(parsed.server ? { server: parsed.server } : {}),
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
        signal: ctx?.signal,
      });
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError(
        `[list_mcp_resources] list failed: ${errorMessage(err)}`
      );
    }

    if (result.resources.length === 0) {
      // Even with no resources, show perServer (diagnostic value); if
      // perServer is empty too, return the bare placeholder.
      if (result.perServer.length === 0) return EMPTY_PLACEHOLDER;
      // Only resources empty / perServer has content: still show the perServer header
      return formatWire([], result.perServer);
    }
    return formatWire(result.resources, result.perServer);
  };

  return Object.freeze({
    name: "list_mcp_resources",
    description:
      "list_mcp_resources: list resources exposed by connected MCP servers; use this when you need to know which servers expose resources and which URIs are available before reading content. Returns one JSON object per resource (server, uri, name, description?, mimeType?), followed by a per-server state tail; returns `(no resources)` when no servers expose any resources. Pass `server` to scope the listing to one server; pass `cursor` to continue pagination. Read a resource afterwards with `read_mcp_resource` once you have the `server` and `uri`.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          minLength: 1,
          description:
            "Optional MCP server name to scope the listing; omit to aggregate across all connected servers.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          description:
            "Optional pagination cursor returned by a previous listing on the same server.",
        },
      },
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * Input compilation + strict validation.
 *   - input not an object / null / array → typed error.
 *   - server / cursor are forwarded only when "correct type and non-empty
 *     string"; empty string counts as absent (pragmatic: a model that
 *     occasionally leaves the default empty still gets the full aggregate;
 *     it is not an error signal).
 *   - wrong type (present but not a string) → typed error (distinguishes
 *     "absent" from "type error").
 */
function compileListInput(input: unknown): {
  readonly server?: string;
  readonly cursor?: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError(
      "[list_mcp_resources] input must be an object"
    );
  }
  const raw = input as ListMcpResourcesInput;
  // server: absent → don't forward; non-string → typed error; empty string →
  // treated as absent (not forwarded).
  let server: string | undefined;
  if (raw.server !== undefined) {
    if (typeof raw.server !== "string") {
      throw new ToolExecutionError(
        "[list_mcp_resources] server must be a string when present"
      );
    }
    if (raw.server.length > 0) server = raw.server;
  }
  // cursor: same discipline as server.
  let cursor: string | undefined;
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== "string") {
      throw new ToolExecutionError(
        "[list_mcp_resources] cursor must be a string when present"
      );
    }
    if (raw.cursor.length > 0) cursor = raw.cursor;
  }
  return { ...(server ? { server } : {}), ...(cursor ? { cursor } : {}) };
}

/**
 * Assembly incomplete / absent → typed error (fail-fast; same shape as
 * tool-search.ts). The conditional assembly layer guarantees the handler is
 * only routed to once a manager is present.
 */
function resolveManager(getManager: () => McpManager): McpManager {
  const m = getManager();
  if (!m) {
    throw new ToolExecutionError(
      "[list_mcp_resources] manager not assembled (mcpManager absent)"
    );
  }
  return m;
}

/**
 * Wire assembly: one JSON line per resource + blank line +
 * `--- perServer ---` + perServer lines. Field projection keeps only fields
 * with values so no null leaks (same discipline as tool-search.ts).
 */
function formatWire(
  resources: ReadonlyArray<McpResource>,
  perServer: ReadonlyArray<McpPerServerState>
): string {
  const resourceLines = resources.map((r) =>
    JSON.stringify(projectResource(r))
  );
  const perServerLines = perServer.map((s) =>
    JSON.stringify(projectPerServer(s))
  );
  return [...resourceLines, "", "--- perServer ---", ...perServerLines].join(
    "\n"
  );
}

/** McpResource field projection: absent fields do not appear. */
function projectResource(r: McpResource): Record<string, unknown> {
  const out: Record<string, unknown> = { server: r.server, uri: r.uri };
  if (r.name !== undefined) out.name = r.name;
  if (r.description !== undefined) out.description = r.description;
  if (r.mimeType !== undefined) out.mimeType = r.mimeType;
  return out;
}

/** McpPerServerState field projection: absent nextCursor does not appear. */
function projectPerServer(s: McpPerServerState): Record<string, unknown> {
  const out: Record<string, unknown> = { server: s.server, state: s.state };
  if (s.nextCursor !== undefined) out.nextCursor = s.nextCursor;
  return out;
}
