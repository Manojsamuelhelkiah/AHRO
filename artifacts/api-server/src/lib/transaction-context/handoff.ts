import { and, eq, sql } from "drizzle-orm";
import { db, onbCases, transactionHandoffRevisions } from "@workspace/db";
import { SaveTransactionHandoffBody } from "@workspace/api-zod";
import {
  withSensitiveLifecycleFence, assertCaseDerivedLifecycleWriteAllowedInTransaction,
} from "../onboarding/sensitive-lifecycle";
import { isHistoricalTestRecord } from "../onboarding/historical-test-record";
import { appendProtectedAuditInTransaction } from "../onboarding/protected-audit";
import { contextAccess, projectOnboardingContext, TransactionContextError, type ContextReader } from "./onboarding";

/** All-class classified storage; only the submitted kind changes.
 * The authority lock, case lock and lifecycle fence cover the entire write.
 * No note bodies enter events, audit, telemetry or context-history tables. */
export async function saveHandoff(input: ContextReader, raw: unknown) {
  const parsed = SaveTransactionHandoffBody.strict().safeParse(raw);
  if (!parsed.success || !Number.isSafeInteger(parsed.data.expectedRevision) || parsed.data.expectedRevision < 0)
    throw new TransactionContextError(400, "Use a valid annotation kind, bounded text and non-negative integer revision.");
  const body = parsed.data;
  if (input.agentId) throw new TransactionContextError(403, "Handoff annotations require a named human author.");
  return withSensitiveLifecycleFence(input.organizationId, () => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.organizationId}))`);
    const [row] = await tx.select().from(onbCases).where(and(
      eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
    )).for("update");
    if (!row) throw new TransactionContextError(404, "Case unavailable.");
    const context = await projectOnboardingContext(tx, input);
    if (!(await contextAccess(tx, input)).edit)
      throw new TransactionContextError(403, "Current confidential note edit access is required.");
    // Retained examples, controller and UAT cases remain read-only. No
    // annotation endpoint becomes a new way to resume retired operations.
    if (isHistoricalTestRecord(row)) throw new TransactionContextError(409, "Retained history is read-only.");
    if (!context.canAnnotate)
      throw new TransactionContextError(409, "Current source, lifecycle or retained-record restrictions do not permit handoff collection.");
    if (context.sourceRevision !== body.sourceRevision)
      throw new TransactionContextError(409, "The case sources changed. Reload and review before submitting a handoff.");
    const previous = context.annotations.filter(n => n.kind === body.kind).at(-1);
    if ((previous?.revision ?? 0) !== body.expectedRevision)
      throw new TransactionContextError(409, "A newer handoff revision exists. Nothing was overwritten.");
    await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, input);
    const [saved] = await tx.insert(transactionHandoffRevisions).values({
      organizationId: input.organizationId, caseId: input.caseId, kind: body.kind,
      body: body.body.trim(), revision: body.expectedRevision + 1,
      authorUserId: input.userId, sourceRevision: body.sourceRevision,
    }).returning({ id: transactionHandoffRevisions.id });
    await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId, actorId: input.userId, actorKind: "authenticated",
      actorAuthority: "live-confidential-note-permissions", action: "case.handoff.revised",
      outcome: "success", objectType: "handoff-annotation", objectId: String(saved!.id),
      caseReference: `case:${input.caseId}`, reviewedRevision: body.expectedRevision + 1,
      source: "transaction-context",
    });
    return projectOnboardingContext(tx, input);
  }, { isolationLevel: "serializable" }));
}
