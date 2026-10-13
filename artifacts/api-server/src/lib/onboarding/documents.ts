import { isRestrictedHistoricalCase as isHistoricalTestRecord } from "./operational-eligibility";

import { db } from "@workspace/db";
import { onbCases, onbDocuments } from "@workspace/db/schema";
import { and, eq, ne, notExists, sql } from "drizzle-orm";
import { isRestrictedOfflineCase as isSyntheticOfflineCase } from "./operational-eligibility";
import { currentOperationalRecordSql } from "./operational-eligibility";
import { getUatCaseIsolation } from "./uat-isolation";
import { sensitiveClassForDocument } from "./sensitive-access";
import { SensitiveLifecycleConflictError } from "./sensitive-lifecycle";
import { ConnectorDispatchRejectedError } from "./connector-adapters";

/**
 * Document checklist ("documentation pack") — real per-case records for
 * the identity/statutory/contract/policy items every hire must submit.
 * Seeded when a case starts; idempotently backfilled at startup so demo
 * cases created before this feature also get a pack.
 */

type CaseRow = typeof onbCases.$inferSelect;
export type DocumentSeedCase = Pick<
  CaseRow,
  "id" | "organizationId" | "workerCategory" | "geography" | "hireType" | "lifecycleStage"
> & { synthetic?: boolean };
export type DocumentRow = typeof onbDocuments.$inferSelect;

type PackItem = {
  key: string;
  label: string;
  category: "identity" | "statutory" | "contract" | "policy";
  required: boolean;
};

/** The pack varies by worker category and geography. */
export function documentPackFor(c: Pick<DocumentSeedCase, "workerCategory" | "geography" | "hireType">): PackItem[] {
  const nonEmployee = c.workerCategory === "contractor" || c.workerCategory === "vendor";
  const india = /india/i.test(c.geography);
  const items: PackItem[] = [
    { key: "id-proof", label: "Government photo ID (passport / national ID)", category: "identity", required: true },
    { key: "address-proof", label: "Proof of current address", category: "identity", required: true },
    { key: "education-certs", label: "Highest education certificate", category: "identity", required: !nonEmployee },
    { key: "prior-employment", label: "Relieving / experience letter from previous employer", category: "identity", required: c.hireType === "external" },
    ...(india
      ? [
          { key: "pan-card", label: "PAN card (tax identification)", category: "statutory", required: !nonEmployee } as PackItem,
          { key: "uan-epf", label: "UAN / EPF details for provident fund transfer", category: "statutory", required: !nonEmployee } as PackItem,
        ]
      : [
          { key: "tax-form", label: "Tax withholding form for payroll", category: "statutory", required: !nonEmployee } as PackItem,
        ]),
    { key: "bank-details", label: "Bank account details for salary/fee disbursement", category: "statutory", required: true },
    { key: "work-authorization", label: "Work authorization / right-to-work evidence", category: "statutory", required: true },
    {
      key: nonEmployee ? "signed-sow" : "signed-offer",
      label: nonEmployee ? "Countersigned statement of work" : "Signed offer letter & employment contract",
      category: "contract",
      required: true,
    },
    { key: "nda-coc", label: "Signed NDA & code-of-conduct acknowledgement", category: "policy", required: true },
    { key: "policy-ack", label: "IT & data-protection policy acknowledgement", category: "policy", required: false },
  ];
  return items;
}

/** Seed the pack for one case. Idempotent per (caseId, key). Returns only rows
 * actually inserted, so recovery reporting never counts a gated no-op. */
export async function seedDocumentsForCase(c: DocumentSeedCase): Promise<number> {
  return db.transaction(async tx => {
  const [current] = await tx.select().from(onbCases).where(and(
    eq(onbCases.id, c.id), eq(onbCases.organizationId, c.organizationId),
  )).for("share");
  if (!current) return 0;
  const pack = documentPackFor(current);
  // Demo realism for already-progressed cases: earlier-stage docs arrive
  // first. Deterministic per case+key (no randomness) so restarts agree.
  const progressed = c.synthetic === true && !current.operationalActivation &&
    c.lifecycleStage !== "intake" && c.lifecycleStage !== "profile-validated";
  const inserted = await tx
    .insert(onbDocuments)
    .values(
      pack.map((p, i) => {
        const seeded = progressed && (c.id + i) % 3 !== 0;
        const verified = seeded && (c.id + i) % 3 === 1;
        return {
          organizationId: c.organizationId,
          caseId: c.id,
          key: p.key,
          label: p.label,
          category: p.category,
          required: p.required,
          status: verified ? "verified" : seeded ? "received" : "pending",
          note: verified
            ? "Checked against source and accepted"
            : seeded
              ? "Received from new hire — verification queued"
              : p.required
                ? "Requested in the documentation pack email"
                : "Optional — requested, not blocking",
        };
      }),
    )
    .onConflictDoNothing()
    .returning({ id: onbDocuments.id });
  return inserted.length;
  });
}

/** Backfill packs for active existing cases that have none (startup, idempotent).
 * Returns the number of document rows actually inserted, never the number of
 * attempted, held, completed, or Gate-A-blocked cases. */
export async function backfillDocumentPacks(scope?: {
  organizationId?: string;
  caseId?: number;
}): Promise<number> {
  const missing = await db
    .select()
    .from(onbCases)
    .where(and(
      ne(onbCases.lifecycleStage, "complete"),
      notExists(db.select({ id: onbDocuments.id }).from(onbDocuments).where(and(
        eq(onbDocuments.organizationId, onbCases.organizationId),
        eq(onbDocuments.caseId, onbCases.id),
        currentOperationalRecordSql(onbDocuments.organizationId, onbDocuments.caseId, onbDocuments.createdAt),
      ))),
      ...(scope?.organizationId ? [eq(onbCases.organizationId, scope.organizationId)] : []),
      ...(scope?.caseId ? [eq(onbCases.id, scope.caseId)] : []),
    ));
  const { dispatchDocumentPackRecovery } = await import("./workstream-connectors");
  let insertedDocuments = 0;
  for (const c of missing) {
    if (isHistoricalTestRecord(c) || isSyntheticOfflineCase(c) || (await getUatCaseIsolation(c)).isolated) continue;
    try {
      await dispatchDocumentPackRecovery(c);
      const documents = await db.select({ id: onbDocuments.id }).from(onbDocuments).where(
        sql`${onbDocuments.organizationId} = ${c.organizationId}
          and ${onbDocuments.caseId} = ${c.id}`,
      );
      insertedDocuments += documents.length;
    } catch (error) {
      if (error instanceof SensitiveLifecycleConflictError) {
        // A missing/blocked lifecycle jurisdiction is a restricted state, not
        // completion. Skip only this legacy case so another eligible tenant's
        // startup backfill can proceed; the case remains without a pack until
        // an operator resolves its policy/context.
        console.warn(
          `[onboarding documents] restricted lifecycle backfill skipped case ${c.id}: ${error.message.slice(0, 300)}`,
        );
        continue;
      }
      if (!(error instanceof ConnectorDispatchRejectedError)) throw error;
      // A known connector/governance denial is an expected safe hold, not an
      // infrastructure failure. Preserve the established recovery path that
      // creates a durable human authorization task when a trusted requester
      // already exists; never invent one for legacy no-principal records.
      if (!c.createdByUserId) continue;
      const { createApproval } = await import("./engine");
      try {
        await createApproval({
          caseId: c.id,
          authorityScope: "legal-approve",
          agent: "workstreams",
          ruleRef: "Execution authorization — documents envelope",
          hitlPattern: "approve-before-act",
          recommendation: "Authorize recovery of the missing document envelope.",
          rationale: "Startup found no persisted document pack. A current legal specialist must authorize only this missing provider operation.",
          resumeAction: "recover-document-envelope",
          idempotencyKey: `orchestration:${c.id}:approval:execution:documents`,
        });
      } catch (approvalError) {
        if (!(approvalError instanceof SensitiveLifecycleConflictError)) throw approvalError;
        console.warn(
          `[onboarding documents] restricted lifecycle recovery approval skipped case ${c.id}: ${approvalError.message.slice(0, 300)}`,
        );
      }
    }
  }
  if (insertedDocuments > 0) {
    console.log(`[onboarding documents] recovered ${insertedDocuments} document row(s) through guarded dispatch`);
  }
  return insertedDocuments;
}

export async function listDocuments(caseId: number): Promise<DocumentRow[]> {
  return db
    .select()
    .from(onbDocuments)
    .where(and(eq(onbDocuments.caseId, caseId),
      currentOperationalRecordSql(onbDocuments.organizationId, onbDocuments.caseId, onbDocuments.createdAt)))
    .orderBy(onbDocuments.id);
}

/** Compact one-line-per-doc summary for LLM context. */
export function documentsSummary(docs: DocumentRow[]): string {
  if (docs.length === 0) return "No document checklist on file.";
  return docs
    .map(
      (d) => {
        // LLM callers have no live specialist assignment. They receive only
        // the operational state for protected document classes, never labels
        // or notes that disclose bank/tax, identity, medical, or BGV detail.
        if (sensitiveClassForDocument(d).length > 0) {
          return `- Restricted document [${d.status}${d.required ? "" : ", optional"}]`;
        }
        return `- ${d.label} [${d.status}${d.required ? "" : ", optional"}]${d.status === "pending" && d.required ? " — still needed from the new hire" : ""}`;
      },
    )
    .join("\n");
}
