import type { AgentRuntimeRunPort } from "./port.js";
import { createCoreMindAgentRuntimeAdapter } from "./coremind-agent-runtime-adapter.js";
import { createFakeAgentRuntimeAdapter } from "./fake-agent-runtime-adapter.js";

type AgentRuntimeFactoryOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configDir?: string;
}>;

export function createAgentRuntimeAdapter(
  options: AgentRuntimeFactoryOptions = {}
): AgentRuntimeRunPort {
  const env = options.env ?? process.env;
  const runtime = env.CHOICEMIND_RUNTIME ?? "fake";

  if (runtime === "fake") {
    return createFakeAgentRuntimeAdapter();
  }

  if (runtime !== "coremind") {
    throw new Error(`未知 CHOICEMIND_RUNTIME：${runtime}`);
  }

  const providerBaseUrl = env.CHOICEMIND_COREMIND_PROVIDER_BASE_URL;
  const model = env.CHOICEMIND_COREMIND_MODEL;
  if (providerBaseUrl === undefined || providerBaseUrl.trim() === "") {
    throw new Error("CoreMind Runtime 缺少 CHOICEMIND_COREMIND_PROVIDER_BASE_URL");
  }
  if (model === undefined || model.trim() === "") {
    throw new Error("CoreMind Runtime 缺少 CHOICEMIND_COREMIND_MODEL");
  }

  return createCoreMindAgentRuntimeAdapter({
    providerBaseUrl,
    model,
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(env.CHOICEMIND_COREMIND_PROVIDER_API_KEY === undefined
      ? {}
      : { apiKey: env.CHOICEMIND_COREMIND_PROVIDER_API_KEY })
  });
}
