/**
 * src/harness/permission/project-settings.ts
 *
 * Project settings loader (T6 / #122 Q2b / ticket #169; ADR-0084 move).
 *
 * Reads the `permissions` section of `<cwd>/.iknow/settings.json` and converts
 * the entries into `NormalRuleSpec` so they slot into the project layer of the
 * permission three-tier policy. ADR-0084 moved the rule DSL out of
 * `.iknow/permissions.toml` — the toml file is no longer a source (stop
 * reading). While both the toml file and a `permissions` section exist, load
 * fails loud (`toml_and_json_present`): two live SSOTs are unrecoverable
 * ambiguity, not a precedence question.
 *
 * Design constraints:
 *  - Synchronous load at construction time; no hot-reload (spec §T6).
 *  - Missing settings file / missing `permissions` section → `undefined`
 *    (graceful: built-in defaults stand).
 *  - Schema violation → throws Error with a descriptive message including the
 *    failing JSON path so the operator can locate the issue.
 *  - Only a narrow predicate DSL is supported:
 *      * `match_tool` — string equality on the tool name.
 *      * `match_input` — table of supported predicates against the input
 *        object. Each predicate is mapped to a specific shape check.
 *    Unknown predicates fail the ajv schema at load time (fail-loud).
 *  - `filePath` injection (tests) keeps pointing at the JSON file that carries
 *    the section; the toml coexistence probe is skipped for injected paths
 *    (no cwd to derive `permissions.toml` from).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import type {
  NormalRuleSpec,
  PermissionDecision,
  ProjectSettingsPolicySource,
} from "./types.js";
import { isBashNetworkInput } from "./policy.js";

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
    // #952 — bash network:true 资格门禁谓词。语义 SSOT = policy.ts
    // isBashNetworkInput 的严格 === true（与 isBashNetworkTrue 共享 helper）。
    "network_equals",
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
              // #952 — 只接受布尔 true（const 钉死）。TOML 里写成字符串
              // "true" 在 load 时即抛错（fail-loud），不会落地成一条永不
              // 命中的静默死规则。
              network_equals: { type: "boolean", const: true },
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
 * Typed failure
 * -------------------------------------------------------------------------- */

export type ProjectSettingsErrorKind =
  "toml_and_json_present" | "schema_violation";

/**
 * ADR-0084 装配期 fail-loud 的 typed 信号。两种 kind 都是**不可恢复的配置
 * 歧义**（两份 SSOT 并存 / 规则 DSL 违反 schema），不是可降级的建议：
 * 调用方（build-engine / worker 装配）原路上抛，由进程顶层转成可见启动
 * 错误。调用方 catch 时必须按 `kind` 判别，不得把消息压成泛型字符串
 * （code-quality.md typed-error catch 契约）。
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
  /** Explicit absolute or relative path to the JSON settings file. Overrides cwd lookup. */
  readonly filePath?: string;
  /** Project cwd; used to resolve `.iknow/settings.json` when filePath absent. */
  readonly cwd?: string;
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
  // network_equals — #952 资格门禁谓词（bash network:true）。expected 已被
  // ajv schema（boolean const true）钉死；此处仍按宽松防御式实现：非 true
  // 的 expected（schema gap 兜底）一律不命中。shape check 复用 policy.ts
  // isBashNetworkInput（isBashNetworkTrue 的 input 侧），tool gate 由
  // buildRuleMatcher 的 `ctx.tool === toolName`（match_tool = "bash"）承担，
  // 故非 bash 工具的同名字段不会走到这里。
  if (predicate === "network_equals") {
    if (expected !== true) return false;
    return isBashNetworkInput(inputObj);
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
 * Load the `permissions` section of the project settings file and return the
 * parsed project policy source.
 *
 *  - filePath absent → resolves to `<cwd>/.iknow/settings.json`.
 *  - Settings file absent / no `permissions` section → returns undefined
 *    (built-in defaults stand).
 *  - Settings JSON malformed → returns undefined (mirrors `readSettingsFile`:
 *    a file the config layer treats as empty cannot be a permission source).
 *  - `.iknow/permissions.toml` also present **and** the JSON carries a
 *    `permissions` section (cwd form only) → throws
 *    (`toml_and_json_present`, ADR-0084 fail-loud). The toml alone is inert:
 *    ADR-0084 makes two live SSOTs the unrecoverable ambiguity, not the
 *    leftover file.
 *  - Schema violation (ajv) → throws with descriptive message including the
 *    JSON path of the first error.
 */
export function loadProjectSettings(
  opts: LoadProjectSettingsOpts = {}
): ProjectSettingsPolicySource | undefined {
  const filePath = opts.filePath ?? resolveProjectSettingsPath(opts.cwd);
  const raw = readSettingsJson(filePath);
  if (raw === undefined) return undefined;

  const section = raw.permissions;
  if (section === undefined) return undefined;

  // ADR-0084 fail-loud requires BOTH sources live: the JSON must actually
  // carry a `permissions` section. A repo still holding the retired toml with
  // no JSON section has exactly one source and must not fail startup.
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

  const ajv = makeAjv();
  const validate: ValidateFunction = ajv.compile(PROJECT_SETTINGS_SCHEMA);
  if (!validate(section)) {
    throw new ProjectSettingsError(
      "schema_violation",
      `project-settings: schema violation at ${filePath}: ${ajvErrorMessage(
        validate.errors
      )}`
    );
  }

  const settings = section as RawProjectSettingsFile;
  const rules = settings.rule.map((r) => ruleFromRaw(r));

  return Object.freeze({
    kind: "project",
    filePath,
    rules: Object.freeze(rules) as ReadonlyArray<NormalRuleSpec>,
  });
}

/**
 * Read the JSON settings file: ENOENT / malformed JSON / non-object root →
 * undefined (same tolerance as `readSettingsFile` in config/settings.ts —
 * the toml era threw a parse error here, but a file the rest of the config
 * layer discards must not become a permissions hard failure).
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

/**
 * 读失败是否「文件不存在」这一合法态（与真实 I/O 故障区分）。
 * 刻意不复用 `config/settings.ts` 的读法：那边用 `existsSync` 前置探测 +
 * 「坏 JSON → 丢弃」（drop-not-throw），本层要求 `permissions` 段的 schema
 * 违规 fail-loud；共用 helper 会把两套失败纪律搅在一起。
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * JSON 根须为普通对象（排除 null / 数组 / 标量）。与 `config/settings.ts`
 * 的同名谓词字面相同但**不同源**：本层只解析 `permissions` 段、
 * 违规即抛，settings.ts 的谓词服务整份宽松合并（非法字段丢弃）。
 * 抽公共 helper 会把两条失败纪律耦合成一条。
 */
function isPlainObjectRoot(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `<cwd>/.iknow/settings.json`。与 `config/settings.ts` 的内联派生**不是
 * 重复**：那边传的是会话 cwd（`loadIknowSettings({cwd})`），本函数的调用方
 * 传的是 `projectIdentityRoot`（ADR-0037 §4：改绑后 cwd 是裸 task worktree，
 * 读它会让项目规则静默消失）。根不同 → 派生不可合并；本层多出的
 * `permissions.toml` 探测路径（见下）config 侧没有。
 */
function resolveProjectSettingsPath(cwd: string | undefined): string {
  const base = cwd ?? process.cwd();
  return isAbsolute(base)
    ? `${base}/.iknow/settings.json`
    : resolve(base, ".iknow/settings.json");
}

/** 退役 toml 的探测路径 —— 只为 ADR-0084「两份 SSOT 并存」fail-loud 服务。 */
function resolveLegacyTomlPath(cwd: string | undefined): string {
  const base = cwd ?? process.cwd();
  return isAbsolute(base)
    ? `${base}/.iknow/permissions.toml`
    : resolve(base, ".iknow/permissions.toml");
}

/* -----------------------------------------------------------------------------
 * Assembly seam
 * -------------------------------------------------------------------------- */

export interface ResolveProjectPermissionSourceOpts {
  /**
   * 项目身份根（ADR-0037 §4）—— 项目契约（rules / AGENTS.md / skills /
   * `settings.permissions`）的唯一读根。改绑后会话 cwd 是一棵没有 `.iknow`
   * 的裸 task worktree，读 cwd 会静默丢掉项目规则；两条引擎（主链 /
   * worker）必须读同一份。
   */
  readonly projectIdentityRoot: string;
}

/**
 * 装配期项目权限源：主链（build-engine）与 worker 共用这一条读路径，避免
 * 两处各自内联 `loadProjectSettings` 后在读根 / 失败策略上漂移。
 *
 * 契约：fail-loud 原路出（`ProjectSettingsError`），不吞、不降级 ——
 * schema 违规 / 两份 SSOT 并存都是操作员必须看见的启动错误；「无项目规则」
 * 是合法态，返回 `undefined` 交策略层用内建默认。
 */
export function resolveProjectPermissionSource(
  opts: ResolveProjectPermissionSourceOpts
): ProjectSettingsPolicySource | undefined {
  return loadProjectSettings({ cwd: opts.projectIdentityRoot });
}
