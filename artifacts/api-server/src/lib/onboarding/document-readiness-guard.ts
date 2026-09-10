import { and, eq, sql } from "drizzle-orm";
import { onbCandidateUploads, onbDocuments } from "@workspace/db";
import type { OnboardingDbTransaction } from "./settings";
import { documentMalwareGateSql } from "./document-malware-gate";

/**
 * Return the latest uploads for required documents which have not passed the
 * malware gate.  This is deliberately a query rather than a projection of
 * onb_cases.readiness: old rows can say documentation is ready while the
 * migration has correctly defaulted their existing upload to `pending`.
 *
 * Callers must hold the case row lock before invoking this helper. Candidate
 * replacement takes that same lock before changing the document/upload pair,
 * so the result is serialized with a replacement commit.
 */
export async function latestRequiredUploadMalwareBlockers(
  tx: OnboardingDbTransaction,
  organizationId: string,
  caseId: number,
): Promise<number[]> {
  const blocked = await tx
    .select({ uploadId: onbCandidateUploads.id })
    .from(onbCandidateUploads)
    .innerJoin(
      onbDocuments,
      and(
        eq(onbDocuments.organizationId, onbCandidateUploads.organizationId),
        eq(onbDocuments.caseId, onbCandidateUploads.caseId),
        eq(onbDocuments.id, onbCandidateUploads.documentId),
      ),
    )
    .where(and(
      eq(onbCandidateUploads.organizationId, organizationId),
      eq(onbCandidateUploads.caseId, caseId),
      eq(onbDocuments.required, true),
      // A document is represented by its newest upload only. The same
      // predicate is also part of documentMalwareGateSql; keeping it here
      // makes the set being inspected explicit and gives callers useful ids.
      sql`not exists (
        select 1 from onb_candidate_uploads newer
        where newer.organization_id = ${onbCandidateUploads.organizationId}
          and newer.case_id = ${onbCandidateUploads.caseId}
          and newer.document_id = ${onbCandidateUploads.documentId}
          and newer.id > ${onbCandidateUploads.id}
      )`,
      sql`not (${documentMalwareGateSql()})`,
    ));

  return blocked.map(({ uploadId }) => uploadId);
}
