/**
 * src/harness/permission/project-settings.ts
 *
 * Project settings loader (T6 / #122 Q2b / ticket #169 / ticket #1004;
 * ADR-0084 move, ADR-0090 declarative rewrite).
 *
 * Reads the `permissions` section of `<cwd>/.iknow/settings.json` and
 * compiles the declarative `Tool` / `Tool(specifier)` rules into the
 * `NormalRuleSpec[]` shape that slots into the project layer of the
 * permission three-tier policy.
 *
 * Schema (ajv, `additionalProperties: false`):
 *   { defaultMode?: "default"|"plan",
 *     allow?:  string[], ask?: string[], deny?: string[] }
 *
 *  - File absent / no `permissions` section / malformed JSON → undefined.
 *  - Both `.iknow/permissions.toml` (retired) and a `permissions` section
 *    in `settings.json` → fail-loud `toml_and_json_present` (ADR-0084).
 *  - ajv schema violation → fail-loud `schema_violation`.
 *  - Legacy `schema_version` + `rule[]` shape → fail-loud
 *    `legacy_predicate_form` with a new-form example in the message.
 *  - `defaultMode: "full_auto"` → fail-loud `forbidden_default_mode`; a
 *    shared repo cannot self-grant full-auto mode.
 *
 * The actual rule compilation (parsing `Tool(specifier)`, the Bash / path /
 * domain matchers) lives in `./declarative.ts` and is invoked here.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";

import type { NormalRuleSpec, ProjectSettingsPolicySource } from "./types.js";
import {
  compileDeclarativePermissions,
  type DeclarativeCompileOpts,
} from "./declarative.js";

/* -----------------------------------------------------------------------------
 * JSON Schema (ajv, `additionalProperties: false`)
 * -------------------------------------------------------------------------- */

const PROJECT_PERMISSIONS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    defaultMode: { enum: ["default", "plan"] },
    allow: { type: "array", items: { type: "string" } },
    ask: { type: "array", items: { type: "string" } },
    deny: { type: "array", items: { type: "string" } },
  },
});

const NEW_FORM_EXAMPLE = JSON.stringify(
  {
    permissions: {
      allow: ["Bash(git status:*)"],
      deny: ["Read(**/.pem)"],
    },
  },
  null,
  2
);

function makeAjv(): Ajv.default {
  return new Ajv.default({ strict: true, allErrors: true });
}

/* -----------------------------------------------------------------------------
 * Typed failure
 * -------------------------------------------------------------------------- */

export type ProjectSettingsErrorKind =
  | "toml_and_json_present"
  | "schema_violation"
  | "legacy_predicate_form"
  | "forbidden_default_mode";

/**
 * ADR-0084 / ADR-0090 typed fail-loud signals. Every kind is a hard
 * configuration error (two live SSOTs / wrong rule shape / repo
 * self-grant of full-auto) — callers must rethrow verbatim, not swallow
 * into "no project rules". Catch handlers discriminate on `kind`
 * (`code-quality.md` typed-error catch contract).
 */
export class ProjectSettingsError extends Error {
  override readonly name = "ProjectSettingsError";
  readonly kind: ProjectSettingsErrorKind;

  constructor(kind: ProjectSettingsErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/* -----------------------------------------------------------------------------
 * Loader
 * -------------------------------------------------------------------------- */

export interface LoadProjectSettingsOpts {
  /** Explicit absolute or relative path to the JSON settings file. */
  readonly filePath?: string;
  /** Project cwd; used to resolve `.iknow/settings.json` when filePath absent. */
  readonly cwd?: string;
  /** Compile anchor — relative path patterns without `/` resolve here. */
  readonly workRoot?: string;
  /** Tool names registry — surfaced as `knownToolNames` to the compiler. */
  readonly knownToolNames?: ReadonlySet<string>;
  /** Diagnostic sink forwarded to the compiler. */
  readonly onWarn?: (message: string) => void;
}

interface RawSection {
  readonly defaultMode?: unknown;
  readonly allow?: readonly unknown[];
  readonly ask?: readonly unknown[];
  readonly deny?: readonly unknown[];
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
 * Load the `permissions` section of the project settings file and return
 * the parsed project policy source.
 *
 *  - filePath absent → resolves to `<cwd>/.iknow/settings.json`.
 *  - Settings absent / no `permissions` section / malformed JSON →
 *    `undefined` (built-in defaults stand).
 *  - Legacy `.iknow/permissions.toml` AND a JSON `permissions` section →
 *    fail-loud `toml_and_json_present`.
 *  - Legacy `schema_version` + `rule[]` shape → fail-loud
 *    `legacy_predicate_form` with a new-form example.
 *  - `defaultMode: "full_auto"` → fail-loud `forbidden_default_mode`.
 *  - Any other schema violation → fail-loud `schema_violation`.
 */
export function loadProjectSettings(
  opts: LoadProjectSettingsOpts = {}
): ProjectSettingsPolicySource | undefined {
  const filePath = opts.filePath ?? resolveProjectSettingsPath(opts.cwd);
  const raw = readSettingsJson(filePath);
  if (raw === undefined) return undefined;

  const section = raw.permissions;
  if (section === undefined) return undefined;

  if (opts.filePath === undefined) {
    const tomlPath = resolveLegacyTomlPath(opts.cwd);
    if (existsSync(tomlPath)) {
      throw new ProjectSettingsError(
        "toml_and_json_present",
        `project-settings: toml_and_json_present: legacy ${tomlPath} and ` +
          `permissions section in ${filePath} both exist; remove one ` +
          `(ADR-0084: toml is retired as the permission source)`
      );
    }
  }

  // Legacy shape detection must run before ajv — the new schema does not
  // know about `schema_version` / `rule` keys (additionalProperties: false
  // would turn them into a generic `schema_violation` and lose the
  // actionable hint).
  if (
    typeof section === "object" &&
    section !== null &&
    !Array.isArray(section) &&
    ("schema_version" in section || "rule" in section)
  ) {
    throw new ProjectSettingsError(
      "legacy_predicate_form",
      `project-settings: legacy_predicate_form: ${filePath} uses the old ` +
        `"schema_version" + "rule" predicate DSL. Migrate to the new ` +
        `declarative form, e.g.:\n${NEW_FORM_EXAMPLE}`
    );
  }

  // `defaultMode: "full_auto"` is rejected here rather than by ajv (ajv
  // enum doesn't include it; ajv would misreport `schema_violation`).
  const dm = (section as { defaultMode?: unknown }).defaultMode;
  if (dm === "full_auto") {
    throw new ProjectSettingsError(
      "forbidden_default_mode",
      `project-settings: forbidden_default_mode: ${filePath} sets ` +
        `'defaultMode: "full_auto"'. Shared repositories must not ` +
        `self-grant automatic mode; automatic mode is a per-session ` +
        `operator choice (ADR-0090).`
    );
  }

  const ajv = makeAjv();
  const validate: ValidateFunction = ajv.compile(PROJECT_PERMISSIONS_SCHEMA);
  if (!validate(section)) {
    throw new ProjectSettingsError(
      "schema_violation",
      `project-settings: schema violation at ${filePath}: ${ajvErrorMessage(
        validate.errors
      )}`
    );
  }

  const typed = section as RawSection;
  const compileOpts: DeclarativeCompileOpts = {
    workRoot: opts.workRoot ?? opts.cwd ?? process.cwd(),
    ...(opts.cwd !== undefined ? { projectIdentityRoot: opts.cwd } : {}),
    ...(opts.knownToolNames !== undefined
      ? { knownToolNames: opts.knownToolNames }
      : {}),
    ...(opts.onWarn !== undefined ? { onWarn: opts.onWarn } : {}),
  };
  const rules: ReadonlyArray<NormalRuleSpec> = compileDeclarativePermissions(
    {
      allow: typed.allow as readonly string[] | undefined,
      ask: typed.ask as readonly string[] | undefined,
      deny: typed.deny as readonly string[] | undefined,
    },
    compileOpts
  );

  const defaultMode =
    typed.defaultMode === "default" || typed.defaultMode === "plan"
      ? typed.defaultMode
      : undefined;

  return Object.freeze({
    kind: "project",
    filePath,
    rules,
    ...(defaultMode !== undefined ? { defaultMode } : {}),
  }) as ProjectSettingsPolicySource;
}

/**
 * Read the JSON settings file: ENOENT / malformed JSON / non-object root →
 * undefined (mirrors `config/settings.ts` `readSettingsFile`).
 */
function readSettingsJson(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
  if (!isPlainObjectRoot(parsed)) return undefined;
  return parsed;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function isPlainObjectRoot(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveProjectSettingsPath(cwd: string | undefined): string {
  const base = cwd ?? process.cwd();
  return isAbsolute(base)
    ? `${base}/.iknow/settings.json`
    : resolve(base, ".iknow/settings.json");
}

function resolveLegacyTomlPath(cwd: string | undefined): string {
  const base = cwd ?? process.cwd();
  return isAbsolute(base)
    ? `${base}/.iknow/permissions.toml`
    : resolve(base, ".iknow/permissions.toml");
}

/* -----------------------------------------------------------------------------
 * Default-mode seed reader (frozen seam for the startup-mode window)
 * -------------------------------------------------------------------------- */

export interface ReadProjectDefaultModeOpts {
  readonly cwd?: string;
  readonly filePath?: string;
}

/**
 * Light-read of the project's `defaultMode` only. Returns `undefined`
 * when the file is absent, has no `permissions` section, or has no
 * `defaultMode` field. Fail-loud applies to the legacy shape and to
 * `defaultMode: "full_auto"` (same discipline as `loadProjectSettings`).
 */
export function readProjectDefaultMode(
  opts: ReadProjectDefaultModeOpts = {}
): "default" | "plan" | undefined {
  const filePath = opts.filePath ?? resolveProjectSettingsPath(opts.cwd);
  const raw = readSettingsJson(filePath);
  if (raw === undefined) return undefined;
  const section = raw.permissions;
  if (section === undefined) return undefined;
  if (
    typeof section === "object" &&
    section !== null &&
    !Array.isArray(section) &&
    ("schema_version" in section || "rule" in section)
  ) {
    throw new ProjectSettingsError(
      "legacy_predicate_form",
      `project-settings: legacy_predicate_form: ${filePath} uses the old ` +
        `"schema_version" + "rule" predicate DSL. Migrate to the new ` +
        `declarative form, e.g.:\n${NEW_FORM_EXAMPLE}`
    );
  }
  const dm = (section as { defaultMode?: unknown }).defaultMode;
  if (dm === "full_auto") {
    throw new ProjectSettingsError(
      "forbidden_default_mode",
      `project-settings: forbidden_default_mode: ${filePath} sets ` +
        `'defaultMode: "full_auto"'. Shared repositories must not ` +
        `self-grant automatic mode; automatic mode is a per-session ` +
        `operator choice (ADR-0090).`
    );
  }
  return dm === "default" || dm === "plan" ? dm : undefined;
}

/* -----------------------------------------------------------------------------
 * Assembly seam
 * -------------------------------------------------------------------------- */

export interface ResolveProjectPermissionSourceOpts {
  readonly projectIdentityRoot: string;
  /** Compile anchor (defaults to `projectIdentityRoot`). */
  readonly workRoot?: string;
  /** Tool registry — surfaces unknown-tool warnings. */
  readonly knownToolNames?: ReadonlySet<string>;
  /** Diagnostic sink forwarded to the compiler. */
  readonly onWarn?: (message: string) => void;
}

/**
 * Single read path shared by `build-engine.ts` and `worker.ts`. fail-loud
 * propagates (`ProjectSettingsError`); "no project rules" returns
 * `undefined` and the policy layer treats that as a missing key.
 */
export function resolveProjectPermissionSource(
  opts: ResolveProjectPermissionSourceOpts
): ProjectSettingsPolicySource | undefined {
  return loadProjectSettings({
    cwd: opts.projectIdentityRoot,
    ...(opts.workRoot !== undefined ? { workRoot: opts.workRoot } : {}),
    ...(opts.knownToolNames !== undefined
      ? { knownToolNames: opts.knownToolNames }
      : {}),
    ...(opts.onWarn !== undefined ? { onWarn: opts.onWarn } : {}),
  });
}
