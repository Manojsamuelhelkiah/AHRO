import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
/** One connected Gmail consumer at a time, across managed instances and heartbeat calls. */
export async function withGmailConsumerCoordination(action: () => Promise<void>): Promise<boolean> {
  return db.transaction(async tx => {
    const result = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended('hro-connected-gmail-consumers', 0)) as acquired`);
    if (!(result.rows[0] as { acquired?: boolean })?.acquired) return false;
    await action();
    return true;
  });
}
