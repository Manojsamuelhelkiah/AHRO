import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db, employeeVaultProducts as products, employeeVaultRequests as requests, employeeVaultChecks as checks,
  employeeVaultReceipts as receipts, onbCases, onbGovernanceDecisions as decisions,
  onbGovernanceDecisionReviews as reviews, onbGovernanceAuthorityAssignments as assignments,
  organizationMembershipsTable as memberships,
} from "@workspace/db";
import { allRequiredChecks, digest, VAULT_CHECK_KINDS } from "./policy";
import { authoritativeCheckIsCurrent } from "./verification";
import { liveVaultPolicy, type VaultTx } from "./core";
import { jurisdictionForWorkforceContext } from "../onboarding/sensitive-lifecycle";
import { recordedHumanPermissionDecisionCurrent } from "../human-permissions";

export const shareProjection = (r: typeof requests.$inferSelect) => ({
  id: r.id, employer: r.employerName, caseId: r.caseId, purpose: r.purpose, scope: r.scope, jurisdiction: r.jurisdiction,
  expiresAt: r.expiresAt.toISOString(), state: r.expiresAt <= new Date() ? "expired" : r.state,
  version: r.version, documentIds: r.documentIds, employeeBound: Boolean(r.bindingConfirmedBy),
});
export type VaultRequirements = { scope: string[]; jurisdiction: string; maxAgeDays: number; digest: string };
/**
 * Requirements use the existing reviewed governance decision register and
 * adopted case revision. No product-toggle defaults invent check coverage.
 * The decision's typed value is {jurisdiction, checks, maxAgeDays}.
 */
export async function caseVaultRequirements(tx: Pick<VaultTx, "select">, c: typeof onbCases.$inferSelect): Promise<VaultRequirements | null> {
  const jurisdiction = jurisdictionForWorkforceContext(c.workforceContext);
  if (!jurisdiction) return null;
  const key = `employee-verification-requirements:${jurisdiction}`;
  const snapshot = c.processPolicySnapshot?.governanceDecisionSnapshot as { decisions?: { key: string; revision: number; status: string }[] } | undefined;
  const adopted = snapshot?.decisions?.find(d => d.key === key && d.status === "approved");
  if (!adopted) return null;
  const [d] = await tx.select().from(decisions).where(and(eq(decisions.organizationId, c.organizationId), eq(decisions.key, key), eq(decisions.revision, adopted.revision)));
  if (!d || d.status !== "approved" || d.isProvisional || !d.approvedAt || !d.approvedByUserId ||
    !d.sourceReference || (d.reviewDueAt && d.reviewDueAt <= new Date())) return null;
  const [review] = await tx.select().from(reviews).where(and(
    eq(reviews.organizationId, c.organizationId), eq(reviews.decisionKey, key),
    eq(reviews.decisionRevision, d.revision), eq(reviews.outcome, "approved"),
    eq(reviews.reviewedByUserId, d.approvedByUserId),
  ));
  if (!review?.verificationReference || !await recordedHumanPermissionDecisionCurrent(tx as VaultTx, c.organizationId,
    review.authorityAssignmentId, ["tool.policy.manage"], d.revision)) return null;
  const [member] = await tx.select().from(memberships).where(and(eq(memberships.organizationId, c.organizationId), eq(memberships.clerkUserId, d.approvedByUserId), isNull(memberships.revokedAt)));
  if (!member) return null;
  const value = d.proposedValue as { jurisdiction?: unknown; checks?: unknown; maxAgeDays?: unknown;
    governanceRuntime?: { domain?: string; impactedWorkflows?: string[] } };
  if (!value || Object.keys(value).some(k => !["jurisdiction", "checks", "maxAgeDays", "governanceRuntime"].includes(k)) ||
    value.jurisdiction !== jurisdiction || !Array.isArray(value.checks) || !value.checks.some(k => k !== "identity") ||
    value.checks.some(k => !VAULT_CHECK_KINDS.includes(k as typeof VAULT_CHECK_KINDS[number])) ||
    new Set(value.checks).size !== value.checks.length || !Number.isInteger(value.maxAgeDays) ||
    Number(value.maxAgeDays) < 1 || Number(value.maxAgeDays) > 3650 ||
    value.governanceRuntime?.domain !== "legal" ||
    !value.governanceRuntime.impactedWorkflows?.includes("background-verification") ||
    !value.governanceRuntime.impactedWorkflows?.includes("it-identity-access")) return null;
  return { scope: value.checks as string[], jurisdiction, maxAgeDays: Number(value.maxAgeDays),
    digest: digest([key, d.revision, value, c.workforceContextVersion]) };
}
export async function evaluateVaultReuse(tx: Pick<VaultTx, "select">, c: typeof onbCases.$inferSelect, requestId?: string) {
  const [product] = await tx.select().from(products).where(eq(products.organizationId, c.organizationId));
  const rows = await tx.select().from(requests).where(and(eq(requests.organizationId, c.organizationId), eq(requests.caseId, c.id)));
  const requirements = await caseVaultRequirements(tx, c);
  const result = {
    enabled: product?.enabled === true, complete: false, reused: [] as string[],
    outstanding: requirements?.scope ?? ["Approved employer/country check requirements are not established"],
    requests: product?.enabled ? rows.map(shareProjection) : [],
    explanation: !product?.enabled ? "Employee Vault consumption is off. Existing employer checks remain available." :
      !requirements ? "Approve employer/country requirements in Governance and explicitly adopt the revision for this case." :
        "Consent, independent case binding, authoritative evidence and current requirements are required for every reused check.",
  };
  if (!product?.enabled || !requirements) return { ...result, requirements, matchedRequest: null as typeof requests.$inferSelect | null, validCheckIds: [] as string[] };
  try { await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: requirements.jurisdiction }); } catch { return { ...result, explanation: "Approved Vault processing policy is unavailable for this jurisdiction.", requirements, matchedRequest: null, validCheckIds: [] as string[] }; }
  const valid = rows.filter(r => (!requestId || r.id === requestId) && r.state === "approved" && r.bindingConfirmedBy &&
    r.profileId && r.expiresAt > new Date() && r.requirementsDigest === requirements.digest &&
    r.jurisdiction === requirements.jurisdiction && allRequiredChecks(requirements.scope, r.scope));
  // Never combine different employees, employers or grants into a fictitious full set.
  let best: { r: typeof requests.$inferSelect; kinds: string[]; ids: string[] } | null = null;
  for (const r of valid) {
    const candidates = r.checkIds.length ? await tx.select().from(checks).where(and(eq(checks.profileId, r.profileId!), inArray(checks.id, r.checkIds))) : [];
    const current: typeof candidates = [];
    for (const c of candidates) if (c.jurisdiction === requirements.jurisdiction && r.scope.includes(c.kind) &&
      await authoritativeCheckIsCurrent(tx, c, requirements.maxAgeDays)) current.push(c);
    const kinds = [...new Set(current.map(c => c.kind))].filter(k => requirements.scope.includes(k));
    if (!best || kinds.length > best.kinds.length) best = { r, kinds, ids: current.map(c => c.id) };
  }
  const reused = best?.kinds ?? [];
  return { ...result, complete: allRequiredChecks(requirements.scope, reused), reused,
    outstanding: requirements.scope.filter(k => !reused.includes(k)), requirements,
    matchedRequest: best?.r ?? null, validCheckIds: best?.ids ?? [],
  };
}
/** Explicit Vault provenance, not an existing-provider status relabel. Case lock held at execution gates. */
export async function hasCurrentVaultBgvReceipt(tx: Pick<VaultTx, "select">, organizationId: string, caseId: number): Promise<boolean> {
  const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId)));
  if (!c) return false;
  const candidates = await tx.select().from(receipts).where(and(
    eq(receipts.organizationId, organizationId), eq(receipts.caseId, caseId), isNull(receipts.invalidatedAt),
  ));
  for (const receipt of candidates) {
    const evaluation = await evaluateVaultReuse(tx, c, receipt.requestId);
    if (evaluation.complete && evaluation.matchedRequest && evaluation.requirements &&
      receipt.requestVersion === evaluation.matchedRequest.version && receipt.requirementsDigest === evaluation.requirements.digest &&
      receipt.retainUntil > new Date() && allRequiredChecks(evaluation.requirements.scope, receipt.satisfied) &&
      evaluation.validCheckIds.every(id => receipt.checkIds.includes(id))) return true;
  }
  return false;
}
export async function currentVaultBgvForCase(organizationId: string, caseId: number): Promise<boolean> {
  return hasCurrentVaultBgvReceipt(db, organizationId, caseId);
}

/**
 * Most list rows have no Vault receipt. Batch that absence check, but never
 * replace live consent/policy/check verification for rows with a receipt.
 */
export async function currentVaultBgvForCases(organizationId: string, caseIds: readonly number[]) {
  const result = new Set<number>();
  if (!caseIds.length) return result;
  const candidates = await db.select({ caseId: receipts.caseId }).from(receipts).where(and(
    eq(receipts.organizationId, organizationId), inArray(receipts.caseId, [...caseIds]), isNull(receipts.invalidatedAt),
  ));
  for (const caseId of new Set(candidates.map(row => row.caseId))) {
    if (await currentVaultBgvForCase(organizationId, caseId)) result.add(caseId);
  }
  return result;
}
export async function currentVaultConsumedScope(c: typeof onbCases.$inferSelect) {
  const candidates = await db.select().from(receipts).where(and(eq(receipts.organizationId, c.organizationId), eq(receipts.caseId, c.id), isNull(receipts.invalidatedAt)));
  let best: { reused: string[]; outstanding: string[] } = { reused: [], outstanding: [] };
  for (const receipt of candidates) {
    const evaluation = await evaluateVaultReuse(db, c, receipt.requestId);
    if (!evaluation.matchedRequest || !evaluation.requirements || receipt.retainUntil <= new Date() ||
      receipt.requestVersion !== evaluation.matchedRequest.version || receipt.requirementsDigest !== evaluation.requirements.digest) continue;
    const reused = evaluation.reused.filter(k => receipt.satisfied.includes(k));
    if (reused.length > best.reused.length) best = { reused, outstanding: evaluation.requirements.scope.filter(k => !reused.includes(k)) };
  }
  return best;
}
