/**
 * LLM 装配守卫的统一文案（settings-model-extension，ADR-0015）。
 *
 * 单一承载：settings.llm.model / settings.llm.apiKey（字面 / ${VAR} 占位符）。
 * 守卫文案必须指向同一地址 + 同一占位符语法，避免「model/apiKey 到底在哪配」
 * 的多版本歧义（issue #353 / #164）。
 *
 * ADR-0084：`llm` 是**用户层键**——项目文件只采纳 verify / secrets /
 * permissions，项目文件里的 `llm` 段被丢弃且不生效。文案只指向
 * `~/.iknow/settings.json`；不得再引导用户写 `<cwd>/.iknow/settings.json`。
 *
 * 消费点：build-engine / tui-deps / thinking-override 装配期守卫。
 */

export const LLM_MODEL_MISSING_MESSAGE =
  "iknow: no LLM model configured in settings.llm.model. Set it in " +
  "~/.iknow/settings.json. llm is a user-layer key (ADR-0084): the project file " +
  "<cwd>/.iknow/settings.json carries only verify/secrets/permissions.";

export const LLM_API_KEY_MISSING_MESSAGE =
  "LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder) " +
  "in ~/.iknow/settings.json. llm is a user-layer key (ADR-0084): the project file " +
  "<cwd>/.iknow/settings.json carries only verify/secrets/permissions.";
