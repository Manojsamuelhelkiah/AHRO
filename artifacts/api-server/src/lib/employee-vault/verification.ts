import { and, eq, ne, lte, inArray } from "drizzle-orm";
import { db, employeeVaultChecks as checks, employeeVaultDocuments as docs, employeeVaultIssuers as issuers } from "@workspace/db";
import { authenticSource, digest, exactBindings, safeDates, sourcePayload, VAULT_CHECK_KINDS, type VaultSourceResult } from "./policy";
import { auditVault, fail, invalidateVaultReuse, liveVaultPolicy, vaultWrite, type VaultTx } from "./core";
import { configuredMalwareScanner } from "../onboarding/malware-scanner";

/** Public-key authenticated result intake. There is no trusted status-label API. */
export async function acceptVaultSourceResult(result: VaultSourceResult, signature: string): Promise<boolean> {
  const [initial] = await db.select().from(checks).where(eq(checks.id, result.submissionId));
  if (!initial) return false;
  return vaultWrite({ profileId: initial.profileId }, async tx => {
    const policy = await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: result.jurisdiction });
    const [c] = await tx.select().from(checks).where(eq(checks.id, initial.id));
    const [issuer] = await tx.select().from(issuers).where(eq(issuers.id, result.issuerId));
    const verifiedAt = new Date(result.verifiedAt), expiresAt = new Date(result.expiresAt);
    if (!c || !issuer || !issuer.approved || !issuer.approvalReference || issuer.expiresAt <= new Date() ||
      !issuer.allowedKinds.includes(result.kind) || !issuer.jurisdictions.includes(result.jurisdiction) ||
      !VAULT_CHECK_KINDS.includes(result.kind as typeof VAULT_CHECK_KINDS[number]) ||
      !["clear", "adverse", "inconclusive"].includes(result.outcome) ||
      c.profileId !== result.profileId || c.kind !== result.kind || c.jurisdiction !== result.jurisdiction ||
      !exactBindings(c.bindings, result.bindings) || !safeDates(verifiedAt, expiresAt) ||
      result.verifiedAt !== verifiedAt.toISOString() || result.expiresAt !== expiresAt.toISOString() ||
      !result.sourceReference?.trim() || result.sourceReference.length > 400 ||
      !authenticSource(result, signature, issuer.publicKeyPem)) return false;
    // Exact signed replay is idempotent, not a new verdict/revision.
    const evidenceDigest = digest(sourcePayload(result));
    if (c.evidenceDigest === evidenceDigest && c.sourceSignature === signature) return true;
    if (!["pending", "unavailable"].includes(c.state)) return false;
    const rows = await tx.select().from(docs).where(eq(docs.profileId, c.profileId));
    if (!c.bindings.every(b => rows.some(d => d.id === b.id && d.revision === b.revision && d.sha256 === b.sha256 &&
      d.state === "clean" && d.scanSha256 === b.sha256 && d.jurisdiction === result.jurisdiction && d.policyRevision === policy.revision))) return false;
    // A delayed callback must not restore an older verdict. Authenticated
    // newer outcomes (including adverse/inconclusive) retire earlier results
    // for the same subject/check/jurisdiction; a new consent cannot select an
    // old clearance instead of the newer outcome.
    const prior = await tx.select().from(checks).where(and(eq(checks.profileId, c.profileId),
      eq(checks.kind, c.kind), eq(checks.jurisdiction, c.jurisdiction), ne(checks.id, c.id)));
    const superseded = prior.some(p => p.verifiedAt && p.sourceSignature && p.evidenceDigest &&
      (p.verifiedAt > verifiedAt || (p.verifiedAt.getTime() === verifiedAt.getTime() && p.state !== "clear")));
    if (!superseded) await tx.update(checks).set({ state: "superseded" }).where(and(
      eq(checks.profileId, c.profileId), eq(checks.kind, c.kind), eq(checks.jurisdiction, c.jurisdiction),
      ne(checks.id, c.id), lte(checks.verifiedAt, verifiedAt),
      inArray(checks.state, ["clear", "adverse", "inconclusive", "expired"]),
    ));
    await tx.update(checks).set({
      state: superseded ? "superseded" : result.outcome, issuerId: issuer.id, issuerApprovalReference: issuer.approvalReference,
      sourceReference: result.sourceReference, evidenceDigest, sourceSignature: signature, verifiedAt, expiresAt,
    }).where(eq(checks.id, c.id));
    await invalidateVaultReuse(tx, { profileId: c.profileId });
    await auditVault(tx, c.profileId, `issuer:${issuer.id}`, "authenticated-source-result", c.id);
    return true;
  });
}
export async function authoritativeCheckIsCurrent(tx: Pick<VaultTx, "select">, c: typeof checks.$inferSelect, maxAgeDays: number): Promise<boolean> {
  let policy;
  try { policy = await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: c.jurisdiction }); }
  catch { return false; }
  if (!configuredMalwareScanner()) return false;
  if (c.state !== "clear" || !c.issuerId || !c.sourceReference || !c.sourceSignature || !c.evidenceDigest ||
    !c.verifiedAt || !c.expiresAt || !safeDates(c.verifiedAt, c.expiresAt) ||
    c.verifiedAt.getTime() < Date.now() - maxAgeDays * 86400000) return false;
  const [issuer] = await tx.select().from(issuers).where(eq(issuers.id, c.issuerId));
  if (!issuer?.approved || issuer.expiresAt <= new Date() || issuer.approvalReference !== c.issuerApprovalReference ||
    !issuer.allowedKinds.includes(c.kind) || !issuer.jurisdictions.includes(c.jurisdiction)) return false;
  const result: VaultSourceResult = {
    submissionId: c.id, profileId: c.profileId, issuerId: c.issuerId, kind: c.kind, jurisdiction: c.jurisdiction,
    bindings: c.bindings, outcome: "clear", sourceReference: c.sourceReference,
    verifiedAt: c.verifiedAt.toISOString(), expiresAt: c.expiresAt.toISOString(),
  };
  if (!authenticSource(result, c.sourceSignature, issuer.publicKeyPem) || digest(sourcePayload(result)) !== c.evidenceDigest) return false;
  const rows = await tx.select().from(docs).where(eq(docs.profileId, c.profileId));
  return c.bindings.length > 0 && c.bindings.every(b => rows.some(d =>
    d.id === b.id && d.revision === b.revision && d.sha256 === b.sha256 && d.scanSha256 === b.sha256 && d.state === "clean" &&
    d.jurisdiction === c.jurisdiction && d.policyRevision === policy.revision));
}
