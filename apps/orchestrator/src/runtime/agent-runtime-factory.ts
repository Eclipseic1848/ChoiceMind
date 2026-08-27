import type { AgentRuntimePort } from "./port.js";
import type { EgressGuard } from "@choicemind/security";
import type { RuntimeRecoveryStore } from "@choicemind/task-persistence";
import { createFakeAgentRuntimeAdapter } from "./fake-agent-runtime-adapter.js";

type AgentRuntimeFactoryOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configDir?: string;
  egressGuard?: EgressGuard;
  recoveryStore?: Pick<
    RuntimeRecoveryStore,
    | "putRawSnapshot"
    | "loadRawSnapshot"
    | "putEffectResult"
    | "loadEffectResult"
    | "saveRecoveryFacts"
    | "loadRecoveryFacts"
    | "recordRuntimeRunning"
    | "claimRuntimeResume"
    | "completeRuntimeControl"
    | "claimRuntimeCancel"
    | "isRuntimeCancelled"
  >;
}>;

export async function createAgentRuntimeAdapter(
  options: AgentRuntimeFactoryOptions = {}
): Promise<AgentRuntimePort> {
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
  if (options.egressGuard === undefined) {
    throw new Error("CoreMind Runtime 缺少服务端 EgressGuard");
  }

  const { createCoreMindAgentRuntimeAdapter } = await import(
    "./coremind-agent-runtime-adapter.js"
  );

  return createCoreMindAgentRuntimeAdapter({
    providerBaseUrl,
    model,
    egressGuard: options.egressGuard,
    ...(options.recoveryStore === undefined ? {} : { recoveryStore: options.recoveryStore }),
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(env.CHOICEMIND_COREMIND_PROVIDER_API_KEY === undefined
      ? {}
      : { apiKey: env.CHOICEMIND_COREMIND_PROVIDER_API_KEY })
  });
}
