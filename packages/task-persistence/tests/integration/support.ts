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
      "TRUNCATE outbox_messages, agent_run_operations, decision_task_submissions"
    );
  } finally {
    await client.end();
  }
}
