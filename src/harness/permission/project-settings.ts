/**
 * src/harness/permission/project-settings.ts
 *
 * Project settings loader (T6 / #122 Q2b / ticket #169).
 *
 * Reads `.iknow/permissions.toml` from the project working directory and
 * converts the entries into `NormalRuleSpec` so they slot into the project
 * layer of the permission three-tier policy.
 *
 * Design constraints:
 *  - Synchronous load at construction time; no hot-reload (spec §T6).
 *  - Missing file → `undefined` (graceful: built-in defaults stand).
 *  - Schema violation → throws Error with a descriptive message including the
 *    failing JSON path so the operator can locate the issue.
 *  - Only a narrow predicate DSL is supported:
 *      * `match_tool` — string equality on the tool name.
 *      * `match_input` — table of supported predicates against the input
 *        object. Each predicate is mapped to a specific shape check.
 *    Unknown predicates fail the ajv schema at load time (fail-loud).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import Ajv from "ajv";
import { SessionRootError } from "../errors.js";
import {
  MAX_ROOT_DETAIL_CHARS,
  normalizeRootCandidate,
  quoteRoot,
} from "../session-roots.js";
import type { ValidateFunction } from "ajv";
import type {
  NormalRuleSpec,
  PermissionDecision,
  ProjectSettingsPolicySource,
} from "./types.js";

/* -----------------------------------------------------------------------------
 * JSON Schema for `.iknow/permissions.toml`
 *
 * The schema is intentionally narrow: only the predicates documented in
 * `buildRuleMatcher` are accepted. New predicates require a schema update
 * AND a matcher update (one place). `additionalProperties: false` ensures
 * typos don't silently disable.
 * -------------------------------------------------------------------------- */

const SUPPORTED_PREDICATES: ReadonlySet<string> = Object.freeze(
  new Set([
    "command_starts_with",
    "command_ends_with",
    "command_contains",
    "command_equals",
    "path_starts_with",
    "path_ends_with",
    "path_contains",
    "path_equals",
  ])
);

const PROJECT_SETTINGS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "rule"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    rule: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "match_tool", "decision", "reason"],
        properties: {
          id: { type: "string", minLength: 1 },
          match_tool: { type: "string", minLength: 1 },
          match_input: {
            type: "object",
            additionalProperties: false,
            properties: {
              command_starts_with: { type: "string" },
              command_ends_with: { type: "string" },
              command_contains: { type: "string" },
              command_equals: { type: "string" },
              path_starts_with: { type: "string" },
              path_ends_with: { type: "string" },
              path_contains: { type: "string" },
              path_equals: { type: "string" },
            },
          },
          decision: { enum: ["allow", "deny", "ask"] },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
});

function makeAjv(): Ajv.default {
  return new Ajv.default({ strict: true, allErrors: true });
}

/* -----------------------------------------------------------------------------
 * Loader
 * -------------------------------------------------------------------------- */

export interface LoadProjectSettingsOpts {
  /** Explicit absolute or relative path. Overrides the projectIdentityRoot lookup. */
  readonly filePath?: string;
  /**
   * Project identity root — the session's `projectIdentityRoot` (T3,
   * plans/worktree-session-roots.md / ADR-0037 §4): the stable main checkout,
   * NOT the cwd and NOT the task worktree. Used to resolve
   * `.iknow/permissions.toml` when `filePath` is absent. Required in that
   * case: there is deliberately no `process.cwd()` fallback, because a rebound
   * session's cwd is a gitignored tree where the file is simply absent and a
   * silent miss would read as "no project rules".
   */
  readonly projectIdentityRoot?: string;
}

interface RawProjectSettingsFile {
  readonly schema_version: number;
  readonly rule: ReadonlyArray<RawRule>;
}

interface RawRule {
  readonly id: string;
  readonly match_tool: string;
  readonly match_input?: Record<string, unknown>;
  readonly decision: PermissionDecision;
  readonly reason: string;
}

function ajvErrorMessage(
  errors:
    | ReadonlyArray<{ instancePath?: string; message?: string }>
    | null
    | undefined
): string {
  if (!errors || errors.length === 0) return "schema violation (no details)";
  return errors
    .map((e) => `${e.instancePath ?? "<root>"}: ${e.message ?? "invalid"}`)
    .join("; ");
}

/**
 * Predicate matcher factory. Each supported predicate maps to a deterministic
 * equality / substring check against the tool input. Unknown keys in
 * `match_input` are caught by ajv before reaching this function, so this code
 * trusts the schema-validated shape.
 */
function buildRuleMatcher(
  toolName: string,
  matchInput: Record<string, unknown> | undefined
): (input: { tool: string; input: unknown }) => boolean {
  const entries: ReadonlyArray<readonly [string, string, unknown]> =
    matchInput === undefined
      ? []
      : Object.entries(matchInput).map(([k, v]) => [k, k, v] as const);

  return (ctx): boolean => {
    if (ctx.tool !== toolName) return false;
    if (entries.length === 0) return true;
    const inputObj =
      ctx.input !== null && typeof ctx.input === "object"
        ? (ctx.input as Record<string, unknown>)
        : {};

    for (const entry of entries) {
      const [, predicate, expected] = entry;
      if (!SUPPORTED_PREDICATES.has(predicate)) {
        // Schema should have caught this; belt-and-suspenders.
        throw new Error(
          `project-settings: unsupported predicate '${predicate}' (schema gap?)`
        );
      }
      if (!matchPredicate(predicate, expected, inputObj)) return false;
    }
    return true;
  };
}

function matchPredicate(
  predicate: string,
  expected: unknown,
  inputObj: Record<string, unknown>
): boolean {
  // Command predicates operate on inputObj.command (string).
  if (
    predicate === "command_starts_with" ||
    predicate === "command_ends_with" ||
    predicate === "command_contains" ||
    predicate === "command_equals"
  ) {
    if (typeof expected !== "string") return false;
    const cmd = inputObj.command;
    if (typeof cmd !== "string") return false;
    if (predicate === "command_starts_with") return cmd.startsWith(expected);
    if (predicate === "command_ends_with") return cmd.endsWith(expected);
    if (predicate === "command_contains") return cmd.includes(expected);
    return cmd === expected;
  }
  // Path predicates operate on inputObj.path (string), with fallbacks.
  if (
    predicate === "path_starts_with" ||
    predicate === "path_ends_with" ||
    predicate === "path_contains" ||
    predicate === "path_equals"
  ) {
    if (typeof expected !== "string") return false;
    const pathVal =
      typeof inputObj.path === "string"
        ? inputObj.path
        : typeof inputObj.file === "string"
          ? inputObj.file
          : typeof inputObj.filepath === "string"
            ? inputObj.filepath
            : "";
    if (predicate === "path_starts_with") return pathVal.startsWith(expected);
    if (predicate === "path_ends_with") return pathVal.endsWith(expected);
    if (predicate === "path_contains") return pathVal.includes(expected);
    return pathVal === expected;
  }
  return false;
}

function ruleFromRaw(raw: RawRule): NormalRuleSpec {
  const matchInput =
    raw.match_input !== undefined ? { ...raw.match_input } : undefined;
  return Object.freeze({
    id: raw.id,
    match: buildRuleMatcher(raw.match_tool, matchInput),
    decision: raw.decision,
    reason: raw.reason,
  });
}

/**
 * Load `.iknow/permissions.toml` and return the parsed project policy source.
 *
 *  - filePath absent → resolves to `<projectIdentityRoot>/.iknow/permissions.toml`;
 *    projectIdentityRoot also absent → throws (no cwd fallback, see opts doc).
 *  - File absent → returns undefined (built-in defaults stand).
 *  - Parse error (smol-toml) → throws with toml error message.
 *  - Schema violation (ajv) → throws with descriptive message including the
 *    JSON path of the first error.
 */
export function loadProjectSettings(
  opts: LoadProjectSettingsOpts = {}
): ProjectSettingsPolicySource | undefined {
  const filePath =
    opts.filePath ?? resolveProjectSettingsPath(opts.projectIdentityRoot);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `project-settings: TOML parse failed at ${filePath}: ${msg}`
    );
  }

  const ajv = makeAjv();
  const validate: ValidateFunction = ajv.compile(PROJECT_SETTINGS_SCHEMA);
  if (!validate(parsed)) {
    throw new Error(
      `project-settings: schema violation at ${filePath}: ${ajvErrorMessage(
        validate.errors
      )}`
    );
  }

  const settings = parsed as RawProjectSettingsFile;
  const rules = settings.rule.map((r) => ruleFromRaw(r));

  return Object.freeze({
    kind: "project",
    filePath,
    rules: Object.freeze(rules) as ReadonlyArray<NormalRuleSpec>,
  });
}

/**
 * `<projectIdentityRoot>/.iknow/permissions.toml`（身份路径，ADR-0037 §4）。
 *
 * 走会话根 SSOT 的规范化：缺根 → `missing_root`，相对 / 空白 / 不可规范化 →
 * `invalid_root`。刻意**不**接受相对根——`resolve()` 相对根等于偷偷回退
 * `process.cwd()`，改绑后那正是 task worktree。
 */
function resolveProjectSettingsPath(
  projectIdentityRoot: string | undefined
): string {
  const normalized = normalizeRootCandidate(projectIdentityRoot);
  if (!normalized.ok) {
    const { rejection } = normalized;
    if (rejection.reason === "missing") {
      throw new SessionRootError(
        "missing_root",
        "projectIdentityRoot is required to resolve .iknow/permissions.toml"
      );
    }
    throw new SessionRootError(
      "invalid_root",
      `projectIdentityRoot must be an absolute path to resolve .iknow/permissions.toml, got ${quoteRoot(rejection.shown, MAX_ROOT_DETAIL_CHARS)}`
    );
  }
  return join(normalized.root, ".iknow", "permissions.toml");
}
