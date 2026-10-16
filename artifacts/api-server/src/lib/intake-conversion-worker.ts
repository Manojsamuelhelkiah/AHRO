import { and, eq, sql } from "drizzle-orm";
import { db, hroEmailRequests } from "@workspace/db";
import { connectedIntakeMailbox, type EmailProvider } from "./hro-email-ingestion";
import { convertEmailRequestInTransaction, loadRequest } from "./hro-email-service";
import { resolveIntakeConversion } from "./intake-conversion-authorization";
import { SeparationError } from "./offboarding/model";
import { withSensitiveLifecycleFence } from "./onboarding/sensitive-lifecycle";
import { withoutPlatformAdminContext } from "./private-platform-admin";

/** Durable bounded queue: the transaction itself is the claim. No claim lease
 * can outlive a crashed process; creation, linkage and audit commit together.
 * Generation is captured at receipt, never inferred from a later registration. */
export async function runIntakeConversions(provider?: EmailProvider, organizationId?: string) {
  return withoutPlatformAdminContext(() => db.transaction(async claimTx => {
    // Do not wait for a lifecycle session lock in every concurrent scanner.
    // One nonblocking batch claim leaves pooled connections for the winner.
    // Isolated schemas must not contend with the real mailbox worker.
    const claim = await claimTx.execute(sql`SELECT pg_try_advisory_xact_lock(
      hashtextextended(current_schema() || ':intake-conversion-worker', 0)) AS acquired`);
    if (!claim.rows[0]?.acquired) return;
    const pending = await db.select({ id: hroEmailRequests.id, org: hroEmailRequests.organizationId })
      .from(hroEmailRequests).where(and(
        eq(hroEmailRequests.automationState, "pending"),
        sql`(${hroEmailRequests.automationRetryAt} is null or ${hroEmailRequests.automationRetryAt} <= now())`,
        organizationId ? eq(hroEmailRequests.organizationId, organizationId) : undefined,
      )).orderBy(hroEmailRequests.createdAt, hroEmailRequests.id).limit(25);
    if (!pending.length) return;
    const mailbox = await connectedIntakeMailbox(provider);
    for (const item of pending) {
      if (!item.org) continue;
      const org = item.org;
      const process = async () => withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
        // Nonblocking tenant claim prevents concurrent ticks from exhausting
        // the pool. Human conversion/governance writers use this same lock.
        const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${org})) AS acquired`);
        if (!lock.rows[0]?.acquired) return;
        const row = await loadRequest(tx, org, item.id);
        if (row.automationState !== "pending") return;
        if (row.status === "converted" || row.status === "rejected") {
          await tx.update(hroEmailRequests).set({ automationState: "manual" }).where(eq(hroEmailRequests.id, row.id));
          return;
        }
        const context = row.automationGeneration === null ? null : await resolveIntakeConversion(tx, org, row.automationGeneration);
        if (!context) {
          await tx.update(hroEmailRequests).set({ automationState: "paused",
            automationReason: "Registration generation or accountable owner access changed. Manual review is required; re-registration does not revive this queued request.",
          }).where(eq(hroEmailRequests.id, row.id));
          return;
        }
        if (!mailbox) throw new Error("MAILBOX_TEMPORARILY_UNAVAILABLE");
        await convertEmailRequestInTransaction(tx, org, `agent:${context.agentId}`, row,
          { expectedVersion: row.version }, mailbox, context);
      }));
      try { await process(); }
      catch (error) {
        // A failed creator must roll back *all* case writes before persisting
        // its queue outcome. No employee/provider error text is retained.
        await db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${org}))`);
          const row = await loadRequest(tx, org, item.id);
          if (row.automationState !== "pending" || ["converted", "rejected"].includes(row.status)) return;
          const permanent = error instanceof SeparationError && error.status < 500;
          await tx.update(hroEmailRequests).set({
            automationState: permanent ? "exception" : "pending",
            automationReason: permanent ? error.message
              : "Temporary conversion failure. The saved request will retry automatically; no new email or browser is needed.",
            automationAttempts: row.automationAttempts + 1,
            automationRetryAt: permanent ? null : new Date(Date.now() + Math.min(900_000, 15_000 * 2 ** Math.min(row.automationAttempts, 6))),
          }).where(eq(hroEmailRequests.id, row.id));
        });
      }
    }
  }));
}
