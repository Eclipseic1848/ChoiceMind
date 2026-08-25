import type { AuthenticatedPrincipal } from "./identity.js";

export type AuditRecord = Readonly<{
  actor: AuthenticatedPrincipal;
  action:
    | "DECISION_TASK_EVENTS_READ"
    | "DECISION_TASK_READ"
    | "DECISION_TASK_SUBMIT"
    | "DECISION_TASK_RESUME"
    | "DECISION_TASK_CANCEL";
  object: Readonly<{ id: string; type: "DECISION_TASK" }>;
  result: "ALLOWED" | "NOT_FOUND";
  correlationId: string;
}>;

export interface AuditLogPort {
  append(record: AuditRecord): Promise<void>;
}
