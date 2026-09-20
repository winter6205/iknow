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
