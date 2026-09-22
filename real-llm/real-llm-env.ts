// Shared load seam for real-LLM runners: a successful load without a key is
// the Not-run signal; a load failure is a config fault and must propagate.
import { loadIknowEnv, type IknowEnv } from "../src/config/env.ts";

export function loadRealLlmEnv(root: string): IknowEnv | undefined {
  const env = loadIknowEnv(root);
  // EXIT: apiKey empty → Not run
  return env.llm.apiKey ? env : undefined;
}
