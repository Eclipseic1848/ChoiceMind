import { buildSyntheticLaptopRunOutput } from "./synthetic-laptop-fixture.js";
import type { AgentRuntimeRunPort } from "./port.js";

export function createFakeAgentRuntimeAdapter(): AgentRuntimeRunPort {
  return {
    async run(command) {
      return buildSyntheticLaptopRunOutput(command);
    }
  };
}
