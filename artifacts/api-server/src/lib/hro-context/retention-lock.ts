import { sql } from "drizzle-orm";

/** Shared by open and sweep: an anchor/parent cannot disappear during a new attempt. */
export async function lockHroContextRetention(tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }, organizationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 317))`);
}
