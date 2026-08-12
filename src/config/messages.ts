/**
 * LLM 装配守卫的统一文案（settings-model-extension，ADR-0015）。
 *
 * 单一承载：settings.llm.model / settings.llm.apiKey（字面 / ${VAR} 占位符）。
 * 守卫文案必须指向同一地址 + 同一占位符语法，避免「model/apiKey 到底在哪配」
 * 的多版本歧义（issue #353 / #164）。
 *
 * 消费点：build-engine / tui-deps / thinking-override 装配期守卫。
 */

export const LLM_MODEL_MISSING_MESSAGE =
  "iknow: no LLM model configured in settings.llm.model. Set it in " +
  "~/.iknow/settings.json (or <cwd>/.iknow/settings.json).";

export const LLM_API_KEY_MISSING_MESSAGE =
  "LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder) " +
  "in ~/.iknow/settings.json or <cwd>/.iknow/settings.json.";
