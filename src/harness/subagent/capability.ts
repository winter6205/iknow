import {
  AgentCatalogLookupError,
  builtinCatalogResolver,
  type AgentCatalogResolver,
} from "./catalog.js";

export type BashMode = "any" | "readonly";

export interface ResolveSubagentCapabilitiesOptions {
  readonly role?: string;
  readonly parentDisallowedTools?: ReadonlyArray<string>;
  readonly catalog?: AgentCatalogResolver;
}

export interface ResolvedSubagentCapabilities {
  readonly bashMode: BashMode;
  readonly disallowedTools?: ReadonlyArray<string>;
  /** Canonical catalog id, retained for default-role wire compatibility. */
  readonly catalogRole?: string;
  /**
   * A typed lookup failure is retained for callers that need to choose their
   * own error policy. The capability fallback remains fail-closed for bash.
   */
  readonly catalogError?: AgentCatalogLookupError;
}

/**
 * Merge deny lists without changing their first-seen order.
 *
 * The parent list comes first to preserve the existing spawn wire shape;
 * catalog entries add mandatory role restrictions and cannot subtract them.
 * `undefined` remains distinguishable from an explicitly supplied empty list.
 */
export function mergeDisallowedTools(
  parentDisallowedTools: ReadonlyArray<string> | undefined,
  catalogDisallowedTools: ReadonlyArray<string> | undefined
): ReadonlyArray<string> | undefined {
  if (
    parentDisallowedTools === undefined &&
    catalogDisallowedTools === undefined
  ) {
    return undefined;
  }
  return Object.freeze([
    ...new Set<string>([
      ...(parentDisallowedTools ?? []),
      ...(catalogDisallowedTools ?? []),
    ]),
  ]);
}

/**
 * Resolve all role-derived worker capabilities from the catalog.
 *
 * Unknown roles deliberately fall back to `bashMode: "any"` and retain the
 * typed lookup error. Worker assembly may log and continue; dispatch can turn
 * the same diagnostic into a ToolExecutionError. Non-catalog exceptions are
 * not swallowed.
 */
export function resolveSubagentCapabilities(
  opts: ResolveSubagentCapabilitiesOptions
): ResolvedSubagentCapabilities {
  const parentDisallowedTools = opts.parentDisallowedTools;
  if (opts.role === undefined) {
    return {
      bashMode: "any",
      disallowedTools: mergeDisallowedTools(parentDisallowedTools, undefined),
    };
  }

  const catalog = opts.catalog ?? builtinCatalogResolver;
  try {
    const entry = catalog.get(opts.role);
    return {
      bashMode: entry.bashMode ?? "any",
      catalogRole: entry.id,
      disallowedTools: mergeDisallowedTools(
        parentDisallowedTools,
        entry.disallowedTools
      ),
    };
  } catch (err) {
    if (!(err instanceof AgentCatalogLookupError)) {
      throw err;
    }
    return {
      bashMode: "any",
      disallowedTools: mergeDisallowedTools(parentDisallowedTools, undefined),
      catalogError: err,
    };
  }
}

/**
 * Resolve only the catalog-owned bash mode.
 *
 * Parent deny lists are intentionally not accepted: they can remove `bash`,
 * but they cannot turn an `any` catalog mode into `readonly`.
 */
export function resolveBashMode(
  role: string | undefined,
  catalog: AgentCatalogResolver = builtinCatalogResolver
): BashMode {
  return resolveSubagentCapabilities({ role, catalog }).bashMode;
}

export interface AssessSubagentIsolationOptions {
  readonly role?: string;
  readonly availableTools: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly catalog?: AgentCatalogResolver;
}

export type SubagentIsolationReason =
  | "unknown_role_fail_closed"
  | "write_tools_available"
  | "bash_mode_not_readonly"
  | "write_tools_and_bash_denied"
  | "write_tools_denied_bash_readonly";

export interface SubagentIsolationDecision {
  readonly conclusion: "readonly" | "write";
  readonly reason: SubagentIsolationReason;
  readonly effectiveTools: ReadonlyArray<string>;
  readonly catalogError?: AgentCatalogLookupError;
}

/**
 * Decide whether a subagent has a read-only effective capability surface.
 *
 * Both dimensions must pass: `edit_file` and `write_file` must be absent, and
 * `bash` must be absent or backed by the catalog's readonly mode. Unknown
 * roles fail closed even when the supplied tool surface happens to be empty.
 */
export function assessSubagentIsolation(
  opts: AssessSubagentIsolationOptions
): SubagentIsolationDecision {
  const capabilities = resolveSubagentCapabilities({
    role: opts.role,
    parentDisallowedTools: opts.disallowedTools,
    catalog: opts.catalog,
  });
  const denied = new Set(capabilities.disallowedTools ?? []);
  const effectiveTools = Object.freeze(
    opts.availableTools.filter((name) => !denied.has(name))
  );

  if (capabilities.catalogError !== undefined) {
    return {
      conclusion: "write",
      reason: "unknown_role_fail_closed",
      effectiveTools,
      catalogError: capabilities.catalogError,
    };
  }

  if (
    effectiveTools.includes("edit_file") ||
    effectiveTools.includes("write_file")
  ) {
    return {
      conclusion: "write",
      reason: "write_tools_available",
      effectiveTools,
    };
  }

  if (!effectiveTools.includes("bash")) {
    return {
      conclusion: "readonly",
      reason: "write_tools_and_bash_denied",
      effectiveTools,
    };
  }

  if (capabilities.bashMode === "readonly") {
    return {
      conclusion: "readonly",
      reason: "write_tools_denied_bash_readonly",
      effectiveTools,
    };
  }

  return {
    conclusion: "write",
    reason: "bash_mode_not_readonly",
    effectiveTools,
  };
}
