/**
 * Unified copy for LLM assembly guards.
 *
 * Single carrier: settings.llm.model / settings.llm.apiKey (literal / ${VAR}
 * placeholder). Guard copy must point to the same address and the same
 * placeholder syntax, avoiding "where exactly do I configure model/apiKey"
 * ambiguity.
 *
 * `llm` is a **user-layer key** — project files only adopt verify / secrets /
 * permissions; an `llm` section in a project file is dropped and has no
 * effect. The copy points only to `~/.iknow/settings.json`; never guide users
 * to write `<cwd>/.iknow/settings.json`.
 *
 * Consumers: build-engine / tui-deps / thinking-override assembly guards.
 */

export const LLM_MODEL_MISSING_MESSAGE =
  "iknow: no LLM model configured in settings.llm.model. Set it in " +
  "~/.iknow/settings.json. llm is a user-layer key (ADR-0084): the project file " +
  "<cwd>/.iknow/settings.json carries only verify/secrets/permissions.";

export const LLM_API_KEY_MISSING_MESSAGE =
  "LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder) " +
  "in ~/.iknow/settings.json. llm is a user-layer key (ADR-0084): the project file " +
  "<cwd>/.iknow/settings.json carries only verify/secrets/permissions.";

/**
 * Value-domain copy for the per-model request output budget. Single carrier for
 * the wording used by `formatLlmBudgetConfigError`, so the settings-file error
 * and the env-migration error describe the same field the same way.
 */
export const LLM_MAX_TOKENS_EXPECTED_MESSAGE =
  "models[].maxTokens must be a positive whole number of tokens (a JSON integer " +
  "within Number.MAX_SAFE_INTEGER); leaving the field out uses the 32,000-token " +
  "fallback. Fix it in ~/.iknow/settings.json — llm is a user-layer key (ADR-0084) " +
  "and iknow never rewrites that file.";

/** Migration copy for the retired global output-token environment setting. */
export const LLM_LEGACY_MAX_OUTPUT_TOKENS_MIGRATION_MESSAGE =
  "IKNOW_LLM_MAX_OUTPUT_TOKENS is retired: a global output-token cap must not " +
  "silently override a model entry. Set the budget per model as " +
  "models[].maxTokens in ~/.iknow/settings.json (positive whole number; absent " +
  "means the 32,000-token fallback), then remove IKNOW_LLM_MAX_OUTPUT_TOKENS from " +
  "the process environment and from .env / .env.local. iknow never rewrites your " +
  "settings file — edit it yourself.";
