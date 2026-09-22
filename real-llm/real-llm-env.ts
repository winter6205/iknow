// Shared load seam for real-LLM runners: a successful load without a key is
// the Not-run signal, and so is the registry's typed `provider_api_key_missing`
// fault — the runner contract maps exactly that kind to Not run here. Every
// other load failure (model missing, any other typed kind) is a config fault
// and must propagate.
import {
  isLlmProviderConfigError,
  loadIknowEnv,
  type IknowEnv,
} from "../src/config/env.ts";

export function loadRealLlmEnv(root: string): IknowEnv | undefined {
  let env: IknowEnv;
  try {
    env = loadIknowEnv(root);
  } catch (err) {
    // The provider registry reports a missing key as a typed fault, and Not
    // run is the runner contract for it — fold this one kind, nothing else.
    if (
      isLlmProviderConfigError(err) &&
      err.kind === "provider_api_key_missing"
    ) {
      // EXIT: provider key env unset → Not run
      return undefined;
    }
    throw err;
  }
  // EXIT: apiKey empty → Not run
  return env.llm.apiKey ? env : undefined;
}
