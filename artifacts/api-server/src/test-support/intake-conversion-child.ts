/** Hard-crash regression process. Never mounts an API or touches real providers. */
import assert from "node:assert/strict";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runIntakeConversions } from "../lib/intake-conversion-worker";

assert.equal(process.env.INTAKE_CONVERSION_CHILD, "true");
assert.notEqual(process.env.NODE_ENV, "production");
const schema = await db.execute(sql`select current_schema() as name`);
assert.match(String(schema.rows[0]?.name), /^workspace_regression_[0-9]+_[a-f0-9]+$/);
const [org, mailbox] = process.argv.slice(2);
assert.ok(org?.startsWith("conversion-") && mailbox?.endsWith("@example.invalid"));
await runIntakeConversions({ get: async path => {
  assert.equal(path, "/gmail/v1/users/me/profile", "No real provider read or effect is permitted");
  return { ok: true, json: async () => ({ emailAddress: mailbox }) };
} }, org);
await pool.end();
