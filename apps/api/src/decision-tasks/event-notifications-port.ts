export interface DecisionTaskEventNotificationsPort {
  waitFor(decisionTaskId: string, signal: AbortSignal): Promise<void>;
}
