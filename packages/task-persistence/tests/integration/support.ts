import { Client } from "pg";

import { openPersistentDecisionTaskModule } from "../../src/index.js";

export async function resetPersistentDecisionTaskTestData(databaseUrl: string): Promise<void> {
  const module = await openPersistentDecisionTaskModule({ databaseUrl });
  await module.close();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(
      "DROP TRIGGER IF EXISTS test_reject_outbox_published_mark ON outbox_messages"
    );
    await client.query("DROP FUNCTION IF EXISTS test_reject_outbox_published_mark()");
    await client.query(
      "DROP TRIGGER IF EXISTS test_reject_run_event_notification_insert ON decision_task_run_event_notifications"
    );
    await client.query("DROP FUNCTION IF EXISTS test_reject_run_event_notification_insert()");
    await client.query(
      "TRUNCATE runtime_control_requests, runtime_control_states, runtime_effect_receipts, runtime_recovery_facts, runtime_snapshot_objects, egress_records, encrypted_credentials, audit_records, decision_task_run_event_notifications, decision_task_run_events, decision_task_agent_runs, outbox_messages, agent_run_operations, decision_task_submissions"
    );
  } finally {
    await client.end();
  }
}
