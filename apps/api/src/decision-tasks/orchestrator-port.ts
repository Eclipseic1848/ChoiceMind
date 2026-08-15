import type {
  DecisionTaskResultV1,
  ExecuteDecisionTaskCommandV1
} from "@choicemind/contracts/decision/v1";

export interface DecisionOrchestratorPort {
  execute(command: ExecuteDecisionTaskCommandV1): Promise<DecisionTaskResultV1>;
}
