import { Router, type IRouter } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db, employeeVaultProducts as products, employeeVaultRequests as requests, employeeVaultReceipts as receipts,
  employeeVaultDocuments as docs, employeeVaultIssuers as issuers, organizationsTable, onbCases,
  onbSensitiveLifecyclePolicies,
} from "@workspace/db";
import { UpdateEmployeeVaultSettingsBody, RequestCaseVaultReuseBody, ConsumeCaseVaultReuseBody } from "@workspace/api-zod";
import { fail, vaultWrite, VaultError, liveVaultPolicy, auditVault, invalidateVaultReuse, type VaultTx } from "../lib/employee-vault/core";
import { caseVaultRequirements, evaluateVaultReuse, shareProjection } from "../lib/employee-vault/reuse";
import { resolveSensitiveAccessInTransaction } from "../lib/onboarding/sensitive-access";
import { appendProtectedAuditInTransaction } from "../lib/onboarding/protected-audit";
import { getPrivateFile } from "../lib/objectStorage";
import { VAULT_MAX_BYTES } from "../lib/employee-vault/policy";
import { configuredMalwareScanner } from "../lib/onboarding/malware-scanner";
import { reconcileDocumentationReadiness } from "../lib/onboarding/document-validation";
import { evaluateSensitiveLifecycleGate } from "../lib/onboarding/sensitive-lifecycle";
import { evaluateProviderGovernanceGate, PROVIDER_GOVERNANCE_WORKFLOW } from "../lib/onboarding/governance-provider-boundary";

const router: IRouter = Router();
async function settings(tx: Pick<VaultTx, "select">, org: string) {
  const [p] = await tx.select().from(products).where(eq(products.organizationId, org));
  const configured = await tx.select().from(issuers).where(eq(issuers.approved, true));
  return { enabled: p?.enabled ?? false, version: p?.version ?? 0,
    providerReadiness: configured.some(i => i.expiresAt > new Date())
      ? "An approved issuer is registered; each signed result and exact evidence revision is still checked live."
      : "Unavailable — no approved authoritative verification issuer configured.",
    requirementPolicy: "All checks from the applicable approved employer/country Governance decision and the case's explicitly adopted revision. No identity-only BGV shortcut." };
}
const caseId = (raw: unknown) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) return fail(400, "Invalid case.");
  return id;
};
async function authorizedCase(tx: VaultTx, org: string, id: number, actor: string, edit = false) {
  const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, org), eq(onbCases.id, id)));
  if (!c) return fail(404, "Case unavailable.");
  const access = await resolveSensitiveAccessInTransaction(tx, { organizationId: org, caseId: id, actorUserId: actor });
  if (!(edit ? access.edit?.bgv : access.bgv)) return fail(403, "Current sensitive BGV record authority required.");
  return { c, access };
}
async function reuseGates(c: typeof onbCases.$inferSelect, raw = false) {
  const governance = await evaluateProviderGovernanceGate(c, PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing);
  if (!governance.allowed) return fail(409, governance.reason ?? "Governance approval is required.");
  const jurisdiction = (await caseVaultRequirements(db, c))?.jurisdiction;
  const classes = raw ? ["identity", "bgv", "medical", "payroll"] as const : ["bgv"] as const;
  for (const dataClass of classes) {
    const gate = await evaluateSensitiveLifecycleGate({ organizationId: c.organizationId, jurisdiction: jurisdiction ?? null, dataClass, disclosure: false });
    if (!gate.allowed) return fail(409, gate.reason ?? "Sensitive lifecycle approval is required.");
  }
}
router.get("/employee-vault/settings", async (req, res, next) => {
  try { res.setHeader("Cache-Control", "private, no-store"); res.json(await settings(db, req.organizationId!)); } catch (e) { next(e); }
});
router.put("/employee-vault/settings", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") return fail(403, "Tenant owner required.");
    const input = UpdateEmployeeVaultSettingsBody.parse(req.body);
    const result = await vaultWrite({ organizationId: req.organizationId!, withdrawal: !input.enabled }, async tx => {
      const current = await settings(tx, req.organizationId!);
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== current.version) return fail(409, "Settings changed; refresh before saving.");
      await tx.insert(products).values({
        organizationId: req.organizationId!, enabled: input.enabled, version: current.version + 1, updatedBy: req.authUserId!,
      }).onConflictDoUpdate({ target: products.organizationId, set: {
        enabled: input.enabled, version: current.version + 1, updatedBy: req.authUserId!, updatedAt: new Date(),
      } });
      if (!input.enabled) {
        await invalidateVaultReuse(tx, { organizationId: req.organizationId! });
        // A later enable cannot revive old consent silently.
        await tx.update(requests).set({ state: "disabled", documentIds: [], checkIds: [] }).where(eq(requests.organizationId, req.organizationId!));
      }
      await appendProtectedAuditInTransaction(tx, {
        organizationId: req.organizationId!, actorId: req.authUserId!, actorKind: "authenticated",
        actorAuthority: "tenant-owner:product-configuration", action: "employee-vault.feature-configured",
        outcome: "success", objectType: "product", objectId: "employee-vault", source: "employee-vault",
        payload: { enabled: input.enabled, version: current.version + 1 },
      });
      return settings(tx, req.organizationId!);
    });
    res.json(result);
  } catch (e) { next(e); }
});
router.get("/onboarding/cases/:caseId/employee-vault", async (req, res, next) => {
  try {
    const id = caseId(req.params.caseId);
    const result = await vaultWrite({ organizationId: req.organizationId! }, async tx => {
      const { c, access } = await authorizedCase(tx, req.organizationId!, id, req.authUserId!);
      const result = await evaluateVaultReuse(tx, c);
      if (result.enabled) await reuseGates(c);
      if (result.requirements?.scope.includes("medical") && !access.medical) return fail(403, "Current medical authority required for this scope.");
      if (result.matchedRequest?.profileId) await auditVault(tx, result.matchedRequest.profileId, req.authUserId!, "employer-summary-read", result.matchedRequest.id);
      return result;
    });
    // Private internals, check IDs, employee ownership keys never leak.
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ enabled: result.enabled, complete: result.complete, reused: result.reused,
      outstanding: result.outstanding, requests: result.requests, explanation: result.explanation });
  } catch (e) { next(e); }
});
router.post("/onboarding/cases/:caseId/employee-vault", async (req, res, next) => {
  try {
    const id = caseId(req.params.caseId), input = RequestCaseVaultReuseBody.parse(req.body);
    const expiry = new Date(input.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry <= new Date() || expiry.getTime() > Date.now() + 90 * 86400000) return fail(400, "Request expiry must be within the next 90 days.");
    const result = await vaultWrite({ organizationId: req.organizationId! }, async tx => {
      const { c } = await authorizedCase(tx, req.organizationId!, id, req.authUserId!, true);
      const [p] = await tx.select().from(products).where(eq(products.organizationId, req.organizationId!));
      if (!p?.enabled) return fail(409, "Employee Vault consumption is off.");
      if (c.lifecycleStage === "complete") return fail(409, "Completed cases cannot request new disclosure.");
      await reuseGates(c);
      const requirements = await caseVaultRequirements(tx, c);
      if (!requirements) return fail(409, "Approve and adopt applicable employer/country requirements first.");
      const [org] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, req.organizationId!));
      const [r] = await tx.insert(requests).values({
        id: randomUUID(), organizationId: req.organizationId!, caseId: id, employerName: org!.name,
        purpose: input.purpose, scope: requirements.scope, jurisdiction: requirements.jurisdiction,
        requirementsDigest: requirements.digest, requestedBy: req.authUserId!, expiresAt: expiry,
      }).returning();
      await appendProtectedAuditInTransaction(tx, {
        organizationId: req.organizationId!, actorId: req.authUserId!, actorKind: "authenticated",
        actorAuthority: "sensitive-bgv:edit", action: "employee-vault.reuse-requested",
        outcome: "success", objectType: "vault-request", objectId: r!.id, caseReference: `case:${id}`, source: "employee-vault",
      });
      return r!;
    });
    res.status(201).json(shareProjection(result));
  } catch (e) { next(e); }
});
router.post("/onboarding/cases/:caseId/employee-vault/consume", async (req, res, next) => {
  try {
    const id = caseId(req.params.caseId), input = ConsumeCaseVaultReuseBody.parse(req.body);
    if (!input.acknowledgeEmployeeBinding) return fail(400, "Independent employee-to-case identity confirmation required.");
    const result = await vaultWrite({ organizationId: req.organizationId! }, async tx => {
      const { c, access } = await authorizedCase(tx, req.organizationId!, id, req.authUserId!, true);
      if (c.lifecycleStage === "complete") return fail(409, "Completed case history is not live reuse.");
      if (c.offerAcceptanceComplete !== true) return fail(409, "Offer acceptance must be recorded first.");
      await reuseGates(c);
      const [r] = await tx.select().from(requests).where(and(eq(requests.organizationId, req.organizationId!), eq(requests.caseId, id), eq(requests.id, input.requestId)));
      if (!r || r.profileId !== input.vaultId || r.state !== "approved" || r.expiresAt <= new Date()) return fail(404, "Employee-consented request unavailable.");
      if (r.scope.includes("medical") && !access.medical) return fail(403, "Medical authority required.");
      // Separate explicit human binding; never an email/ID lookup.
      await tx.update(requests).set({ bindingConfirmedBy: req.authUserId! }).where(eq(requests.id, r.id));
      const evaluation = await evaluateVaultReuse(tx, c, r.id);
      if (!evaluation.enabled || !evaluation.requirements || !evaluation.matchedRequest || !evaluation.reused.length) return fail(409, "No current authoritative checks are reusable.");
      const policy = await liveVaultPolicy(tx, { scanner: true });
      const [retention] = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
        eq(onbSensitiveLifecyclePolicies.organizationId, req.organizationId!),
        eq(onbSensitiveLifecyclePolicies.dataClass, "bgv"),
        eq(onbSensitiveLifecyclePolicies.jurisdiction, evaluation.requirements.jurisdiction),
        eq(onbSensitiveLifecyclePolicies.isCurrent, true),
      ));
      if (!retention || retention.retentionDays < 1) return fail(409, "Approved employer BGV receipt retention must permit reuse.");
      const [oldReceipt] = await tx.select().from(receipts).where(and(eq(receipts.requestId, r.id), eq(receipts.requestVersion, r.version), eq(receipts.requirementsDigest, evaluation.requirements.digest)));
      if (oldReceipt?.invalidatedAt) return fail(409, "This consumption was invalidated; obtain renewed employee consent through a new request.");
      await tx.insert(receipts).values({
        id: randomUUID(), organizationId: req.organizationId!, caseId: id, requestId: r.id, requestVersion: r.version,
        requirementsDigest: evaluation.requirements.digest, checkIds: evaluation.validCheckIds, satisfied: evaluation.reused,
        retainUntil: new Date(Date.now() + Math.min(policy.receiptRetentionDays, retention.retentionDays) * 86400000),
      }).onConflictDoNothing();
      await auditVault(tx, r.profileId!, req.authUserId!, "case-consumption-receipt", r.id);
      await appendProtectedAuditInTransaction(tx, {
        organizationId: req.organizationId!, actorId: req.authUserId!, actorKind: "authenticated", actorAuthority: "sensitive-bgv:edit",
        action: "employee-vault.consumed", outcome: "success", objectType: "vault-receipt", objectId: r.id,
        caseReference: `case:${id}`, source: "employee-vault", payload: { complete: evaluation.complete, satisfiedCount: evaluation.reused.length },
      });
      return evaluation;
    });
    await reconcileDocumentationReadiness(req.organizationId!, id);
    res.json({ enabled: result.enabled, complete: result.complete, reused: result.reused, outstanding: result.outstanding,
      requests: result.requests, explanation: result.explanation });
  } catch (e) { next(e); }
});
router.get("/onboarding/cases/:caseId/employee-vault/requests/:requestId/documents/:documentId", async (req, res, next) => {
  try {
    const id = caseId(req.params.caseId);
    const result = await vaultWrite({ organizationId: req.organizationId! }, async tx => {
      const { c, access } = await authorizedCase(tx, req.organizationId!, id, req.authUserId!);
      if (!access.identity || !access.medical || !access.payroll || !access.bgv) return fail(403, "Opaque documents require all current sensitive-record authorities.");
      await reuseGates(c, true);
      await liveVaultPolicy(tx, { storage: true, scanner: true });
      const [p] = await tx.select().from(products).where(eq(products.organizationId, req.organizationId!));
      const [r] = await tx.select().from(requests).where(and(eq(requests.organizationId, req.organizationId!), eq(requests.caseId, id), eq(requests.id, String(req.params.requestId))));
      const requirements = await caseVaultRequirements(tx, c);
      if (!p?.enabled || !requirements || !r || !r.profileId || !r.bindingConfirmedBy || r.state !== "approved" ||
        r.expiresAt <= new Date() || r.requirementsDigest !== requirements.digest || !r.documentIds.includes(String(req.params.documentId))) return fail(404, "Document grant unavailable.");
      const [d] = await tx.select().from(docs).where(and(eq(docs.profileId, r.profileId), eq(docs.id, String(req.params.documentId))));
      if (!d || d.state !== "clean" || !d.sha256 || d.sha256 !== d.scanSha256 || !configuredMalwareScanner()) return fail(409, "Current safe document evidence unavailable.");
      const documentPolicy = await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: d.jurisdiction });
      if (d.jurisdiction !== r.jurisdiction || d.policyRevision !== documentPolicy.revision) return fail(409, "Document jurisdictional approval is no longer applicable.");
      const [bytes] = await getPrivateFile(d.objectPath).download({ start: 0, end: VAULT_MAX_BYTES });
      if (bytes.length !== d.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== d.sha256) return fail(409, "Stored bytes changed; access blocked.");
      await auditVault(tx, r.profileId, req.authUserId!, "employer-separate-document-download", d.id);
      return { bytes, type: d.contentType };
    });
    res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "attachment; filename=\"authorized-vault-document\"");
    res.type(result.type).send(result.bytes);
  } catch (e) { next(e); }
});
router.use((err: unknown, _req: unknown, res: any, next: any) => {
  if (err instanceof VaultError) return res.status(err.status).json({ message: err.message });
  next(err);
});
export default router;
