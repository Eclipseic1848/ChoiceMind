import { buildSyntheticLaptopRunOutput } from "./synthetic-laptop-fixture.js";
import type { AgentRuntimePort } from "./port.js";

export function createFakeAgentRuntimeAdapter(): AgentRuntimePort {
  return {
    async run(command) {
      return buildSyntheticLaptopRunOutput(command);
    },
    async runPersistent(command) {
      return buildSyntheticLaptopRunOutput(command);
    },
    async resume(command) {
      return {
        ok: false,
        code: "RUNTIME_RESUME_DENIED",
        message: `Fake Runtime 不提供恢复能力：${command.snapshot.snapshotId}`
      };
    },
    async cancel(command) {
      return {
        ok: false,
        code: "RUNTIME_CANCEL_RACE",
        message: `Fake Runtime 没有活动运行：${command.agentRunId}`
      };
    },
    subscribe() {
      return () => undefined;
    }
  };
}
