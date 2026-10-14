/** Isolated regression child: a fresh process rebuilds context from durable records.
 * No endpoint, login bypass or production maintenance command is registered. */
import { readOnboardingContext } from "../lib/transaction-context/onboarding";
import { pool } from "@workspace/db";
if (process.env.NODE_ENV !== "test" || !pool.options.connectionString?.includes("search_path"))
  throw new Error("Transaction context probe requires a disposable test database.");
const [organizationId, caseId, userId] = process.argv.slice(2);
try {
  const context = await readOnboardingContext({ organizationId, caseId: Number(caseId), userId });
  process.stdout.write(JSON.stringify({ sourceRevision: context.sourceRevision, revisions: context.annotations.map(n => n.revision) }));
} finally { await pool.end(); }
