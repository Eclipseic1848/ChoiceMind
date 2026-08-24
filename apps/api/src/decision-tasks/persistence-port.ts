import type {
  DecisionTaskResultV1,
  DecisionTaskSnapshotV1,
  ExecuteDecisionTaskCommandV1,
  PersistedRunEventV1
} from "@choicemind/contracts/decision/v1";

type PersistedDecisionTaskResultV1 = Extract<
  DecisionTaskResultV1,
  Readonly<{ taskStatus: unknown }>
>;

export interface DecisionTaskPersistencePort {
  submit(command: ExecuteDecisionTaskCommandV1): Promise<DecisionTaskSnapshotV1>;
  get(
    decisionTaskId: string
  ): Promise<DecisionTaskSnapshotV1 | PersistedDecisionTaskResultV1 | undefined>;
  listEvents(decisionTaskId: string, afterCursor?: string): Promise<readonly PersistedRunEventV1[]>;
}
