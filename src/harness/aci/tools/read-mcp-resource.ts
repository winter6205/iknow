/**
 * read_mcp_resource tool — the read side of two explicit tools (list side in
 * list-mcp-resources.ts). The model accesses resources exposed by an MCP
 * server in a list → read two-step flow.
 *
 * Dependency-injection shape (lazy self-reference): same as the list tool —
 * deps take `getManager: () => McpManager`, dereferenced only at call time.
 * Assembly incomplete → throw ToolExecutionError (fail-fast; conditional
 * assembly guarantees the handler is only routed to once a manager is
 * present).
 *
 * Input: server and uri are both required non-empty strings (the model knows
 * the pair explicitly after listing).
 *
 * Output wire: a single JSON envelope `{ server, uri, contents: [...] }`.
 * Per-contents field projection (text / blob mutually exclusive):
 *   - always: uri
 *   - optional: mimeType (externally declared content type)
 *   - mutually exclusive: text (utf-8) or blob (base64) — whichever appears,
 *     the other is absent
 * The mutual-exclusion guarantee comes from the SDK protocol (the
 * TextResourceContents | BlobResourceContents union); this tool only projects
 * fields, it does not re-discriminate.
 *
 * Security:
 *   - resource-content injection: no sanitization layer (external content is
 *     treated as untrusted data); the executor's 20000 truncation plus the
 *     self-cap discipline bound output size;
 *   - minimal schema validation of server / uri inputs + typed-error wrapping.
 *
 * ACI metadata:
 *   category: "read-only"        (same shape as list)
 *   isConcurrencySafe: false     (conservative default, same shape as mcp__* tools)
 *   interruptBehavior: cancel    (same shape as list)
 *   timeoutTier: "default"       (30s — server subprocesses cannot be fast)
 *
 * description: states only positive trigger conditions, no negative
 * prohibition words. Trigger: after list_mcp_resources has surfaced a server
 * + uri pair, call this tool to fetch the content.
 */

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError, errorMessage } from "../../errors.js";
import type {
  McpManager,
  McpResourceContent,
  ReadResourceResult,
} from "../../mcp/manager.js";

/**
 * Dependency injection: `getManager` lazily dereferences the assembled
 * McpManager. Assembly incomplete → ToolExecutionError (same shape as
 * list-mcp-resources.ts).
 */
export interface ReadMcpResourceToolDeps {
  readonly getManager: () => McpManager;
}

interface ReadMcpResourceInput {
  readonly server?: unknown;
  readonly uri?: unknown;
}

/**
 * Factory: createReadMcpResourceTool(deps) — the read-MCP-resource tool.
 *
 * The returned AciToolDef satisfies:
 *   - name === "read_mcp_resource"
 *   - inputSchema: { server required + uri required }, additionalProperties:false
 *   - aci metadata: read-only / NOT concurrency-safe / cancel / default tier
 */
export function createReadMcpResourceTool(
  deps: ReadMcpResourceToolDeps
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileReadInput(input);
    const manager = resolveManager(deps.getManager);

    let result: ReadResourceResult;
    try {
      // The manager supports signal; read_mcp_resource must pass through
      // (ADR-0039)
      // ctx.signal to honor its cancel metadata.
      result = await manager.readResource(parsed.server, parsed.uri, {
        signal: ctx?.signal,
      });
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError(
        `[read_mcp_resource] read failed: ${errorMessage(err)}`
      );
    }

    return JSON.stringify(projectReadResult(result));
  };

  return Object.freeze({
    name: "read_mcp_resource",
    description:
      "read_mcp_resource: read the content of a specific resource exposed by an MCP server. Use this after list_mcp_resources has surfaced the `server` and `uri` pair you want. Returns one JSON envelope with the resource content; each `contents` entry has `uri`, optional `mimeType`, and exactly one of `text` (utf-8 string) or `blob` (base64 string). Server processes the request (configured in user trust boundary); large content is truncated by the executor downstream.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          minLength: 1,
          description:
            "MCP server name returned by list_mcp_resources; the server must be currently connected.",
        },
        uri: {
          type: "string",
          minLength: 1,
          description:
            "Resource URI returned by list_mcp_resources; identifies the specific resource to fetch.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * Input compilation + strict validation: server / uri required, non-empty
 * strings. Absent / wrong type / empty string → all typed errors (a read must
 * name server + uri exactly; no default when absent, unlike list's optional
 * semantics).
 */
function compileReadInput(input: unknown): {
  readonly server: string;
  readonly uri: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[read_mcp_resource] input must be an object");
  }
  const raw = input as ReadMcpResourceInput;
  if (typeof raw.server !== "string" || raw.server.length === 0) {
    throw new ToolExecutionError(
      "[read_mcp_resource] server is required and must be a non-empty string"
    );
  }
  if (typeof raw.uri !== "string" || raw.uri.length === 0) {
    throw new ToolExecutionError(
      "[read_mcp_resource] uri is required and must be a non-empty string"
    );
  }
  return { server: raw.server, uri: raw.uri };
}

/**
 * Assembly incomplete / absent → typed error (fail-fast; same shape as
 * list-mcp-resources.ts resolveManager). Conditional assembly guarantees the
 * handler is only routed to once a manager is present.
 */
function resolveManager(getManager: () => McpManager): McpManager {
  const m = getManager();
  if (!m) {
    throw new ToolExecutionError(
      "[read_mcp_resource] manager not assembled (mcpManager absent)"
    );
  }
  return m;
}

/**
 * Field projection: readResult → wire envelope.
 * text / blob are mutually exclusive (guaranteed by the SDK protocol); this
 * projection keeps only the field with a value, so no null leaks through
 * (same discipline as tool-search.ts).
 */
function projectReadResult(r: ReadResourceResult): {
  readonly server: string;
  readonly uri: string;
  readonly contents: ReadonlyArray<Record<string, unknown>>;
} {
  return {
    server: r.server,
    uri: r.uri,
    contents: r.contents.map(projectContent),
  };
}

function projectContent(c: McpResourceContent): Record<string, unknown> {
  const out: Record<string, unknown> = { uri: c.uri };
  if (c.mimeType !== undefined) out.mimeType = c.mimeType;
  // text / blob mutually exclusive: set whichever is present.
  if (c.text !== undefined) {
    out.text = c.text;
  } else if (c.blob !== undefined) {
    out.blob = c.blob;
  }
  return out;
}
