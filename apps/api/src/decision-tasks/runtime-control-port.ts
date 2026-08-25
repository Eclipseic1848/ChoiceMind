import type { AuthenticatedPrincipal } from "../security/identity.js";
import type { RuntimeControlStatusV1 } from "@choicemind/contracts/decision/v1";

export interface DecisionTaskRuntimeControlPort {
  requestResume(input: Readonly<{
    actor: AuthenticatedPrincipal;
    controlRequestId: string;
    decisionTaskId: string;
    runtimeSnapshotId: string;
    correlationId: string;
    egressConfirmation: Readonly<{ operationId: string; userId: string }>;
  }>): Promise<RuntimeControlStatusV1 | undefined>;
  requestCancel(input: Readonly<{
    actor: AuthenticatedPrincipal;
    controlRequestId: string;
    decisionTaskId: string;
    cancellationId: string;
    correlationId: string;
  }>): Promise<RuntimeControlStatusV1 | undefined>;
}
