import { and, eq, inArray, sql } from "drizzle-orm";
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
  return (await requiredUploadMalwareBlockersForCases(tx, organizationId, [caseId])).get(caseId) ?? [];
}

/** Display-only batch read. Mutations still require the caller's case lock. */
export async function requiredUploadMalwareBlockersForCases(
  tx: OnboardingDbTransaction,
  organizationId: string,
  caseIds: readonly number[],
): Promise<Map<number, number[]>> {
  if (!caseIds.length) return new Map();
  const blocked = await tx
    .select({ uploadId: onbCandidateUploads.id, caseId: onbCandidateUploads.caseId })
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
      inArray(onbCandidateUploads.caseId, [...caseIds]),
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

  const result = new Map<number, number[]>();
  for (const { uploadId, caseId } of blocked) {
    const ids = result.get(caseId) ?? [];
    ids.push(uploadId);
    result.set(caseId, ids);
  }
  return result;
}
