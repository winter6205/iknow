import type {
  IknowSettings,
  IknowSettingsLlmProvider,
} from "../../src/config/settings.ts";

export const TEST_LLM_PROVIDER_API_KEY_ENV = "IKNOW_TEST_API_KEY";

export const TEST_LLM_PROVIDER: IknowSettingsLlmProvider = {
  id: "test",
  baseUrl: "http://localhost:20128/v1",
  apiKeyEnv: TEST_LLM_PROVIDER_API_KEY_ENV,
  models: [{ id: "model" }],
};

/** 为 loadIknowEnv 注入最小 provider 注册表（默认 `test/model`）。 */
export function withTestLlmProvider(
  llm: Partial<NonNullable<IknowSettings["llm"]>> = {}
): IknowSettings {
  const rawModel = llm.model ?? "test/model";
  const slash = rawModel.indexOf("/");
  const providerId =
    slash === -1 ? TEST_LLM_PROVIDER.id : rawModel.slice(0, slash);
  const modelId =
    slash === -1 ? rawModel.trim() : rawModel.slice(slash + 1).trim();
  const routeModel =
    slash === -1 ? `${TEST_LLM_PROVIDER.id}/${modelId}` : rawModel;
  const providers = llm.providers ?? [
    {
      id: providerId,
      baseUrl: TEST_LLM_PROVIDER.baseUrl,
      apiKeyEnv: TEST_LLM_PROVIDER.apiKeyEnv,
      models: [{ id: modelId }],
    },
  ];
  const { model: _model, providers: _providers, ...rest } = llm;
  return { llm: { model: routeModel, providers, ...rest } };
}

export function installTestProviderApiKey(value = "test-key"): void {
  process.env[TEST_LLM_PROVIDER_API_KEY_ENV] = value;
}

export function llmSettingsJson(
  llm: Partial<NonNullable<IknowSettings["llm"]>> = {}
): { llm: NonNullable<IknowSettings["llm"]> } {
  const settings = withTestLlmProvider(llm);
  if (settings.llm === undefined) {
    throw new Error("withTestLlmProvider produced empty llm");
  }
  return { llm: settings.llm };
}
