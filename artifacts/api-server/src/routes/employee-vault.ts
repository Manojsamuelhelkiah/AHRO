import { Router, type IRouter } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, employeeVaultDocuments as docs, employeeVaultChecks as checks,
  employeeVaultRequests as requests, employeeVaultIssuers as issuers, employeeVaultProducts as products,
} from "@workspace/db";
import { ReserveVaultDocumentBody, SubmitVaultCheckBody, DecideVaultShareRequestBody, AcceptVaultSourceResultBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";
import { getPrivateFile } from "../lib/objectStorage";
import { detectCandidateFile } from "../lib/onboarding/candidate-portal";
import {
  ownProfile, fail, vaultWrite, liveVaultPolicy, auditVault, invalidateDocumentChecks, invalidateVaultReuse,
  currentDocumentBindings, VaultError,
} from "../lib/employee-vault/core";
import { VAULT_MAX_BYTES, VAULT_QUOTA_BYTES, VAULT_MAX_DOCUMENTS } from "../lib/employee-vault/policy";
import { acceptVaultSourceResult, authoritativeCheckIsCurrent } from "../lib/employee-vault/verification";
import { shareProjection } from "../lib/employee-vault/reuse";
import { configuredMalwareScanner } from "../lib/onboarding/malware-scanner";

export const employeeVaultSourceRouter: IRouter = Router();
employeeVaultSourceRouter.post("/vault/source-results", async (req, res, next) => {
  try {
    // Signature is checked against approved issuer public keys, never Clerk role.
    const parsed = AcceptVaultSourceResultBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid source envelope" }); return; }
    const b = parsed.data;
    const result = { ...b.result, verifiedAt: b.result.verifiedAt.toISOString(), expiresAt: b.result.expiresAt.toISOString() };
    const accepted = await acceptVaultSourceResult(result, b.signature);
    if (accepted) res.status(204).send();
    else res.status(403).json({ message: "Source evidence rejected." });
  } catch (e) { next(e); }
});

const router: IRouter = Router();
router.use("/vault", requireAuth, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
export const documentProjection = (d: typeof docs.$inferSelect) => ({
  id: d.id, name: d.name, contentType: d.contentType, sizeBytes: d.sizeBytes, revision: d.revision,
  replacesId: d.replacesId, state: d.state, createdAt: d.createdAt.toISOString(),
  jurisdiction: d.jurisdiction,
});
export const checkProjection = (c: typeof checks.$inferSelect) => ({
  id: c.id, kind: c.kind, jurisdiction: c.jurisdiction, state: c.expiresAt && c.expiresAt <= new Date() ? "expired" : c.state,
  explanation: c.state === "unavailable" ? "No approved authoritative source is configured. Uploads and email verification do not establish clearance." :
    c.state === "clear" ? "Authenticated revision-bound source result. Employer reuse still needs consent, current requirements and freshness." :
      c.state === "adverse" ? "Source reported an adverse result. Human review is required; no automated employment decision." :
        c.state === "superseded" ? "Supporting evidence changed. A new authoritative check is required." : "Authoritative review is outstanding.",
  documentIds: c.bindings.map(b => b.id), issuer: c.issuerId, source: c.sourceReference,
  verifiedAt: c.verifiedAt?.toISOString() ?? null, expiresAt: c.expiresAt?.toISOString() ?? null,
});
router.get("/vault/profile", async (req, res, next) => {
  try {
    const p = await ownProfile(req.authUserId!);
    const [documents, verifications, sharing] = await Promise.all([
      db.select().from(docs).where(eq(docs.profileId, p.id)),
      db.select().from(checks).where(eq(checks.profileId, p.id)),
      db.select().from(requests).where(eq(requests.profileId, p.id)),
    ]);
    let readiness = "Authoritative verification is unavailable until a working approved source is configured. No universal BGV clearance is issued.";
    let policy: Awaited<ReturnType<typeof liveVaultPolicy>> | null = null;
    try { policy = await liveVaultPolicy(db); } catch (e) { readiness = (e as Error).message; }
    const checkViews = await Promise.all(verifications.map(async c => {
      const projection = checkProjection(c);
      const [issuer] = c.issuerId ? await db.select().from(issuers).where(eq(issuers.id, c.issuerId)) : [];
      if (issuer) projection.issuer = issuer.name;
      if (c.state === "clear" && c.expiresAt && c.expiresAt > new Date() &&
        (!policy || !await authoritativeCheckIsCurrent(db, c, 3650))) {
        projection.state = "unavailable";
        projection.explanation = "A prior source result is recorded, but current issuer, document, scanner or processing authority is unavailable. It is not live reusable clearance.";
      }
      return projection;
    }));
    res.json({ vaultId: p.id, documents: documents.filter(d => d.state !== "deleted").map(documentProjection),
      checks: checkViews, requests: sharing.map(shareProjection), readiness,
      privacyNotice: policy?.privacyNotice ?? null, policyRevision: policy?.revision ?? null, policyJurisdiction: policy?.jurisdiction ?? null });
  } catch (e) { next(e); }
});
router.post("/vault/documents", async (req, res, next) => {
  try {
    const input = ReserveVaultDocumentBody.parse(req.body);
    if (!input.policyAccepted || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > VAULT_MAX_BYTES) return fail(400, "Accept the processing policy and select a file of at most 10MB.");
    const p = await ownProfile(req.authUserId!);
    const d = await vaultWrite({ profileId: p.id }, async tx => {
      const policy = await liveVaultPolicy(tx, { storage: true, jurisdiction: input.jurisdiction });
      if (input.policyRevision !== policy.revision) return fail(409, "The processing notice changed. Review the current notice before uploading.");
      const existing = await tx.select().from(docs).where(eq(docs.profileId, p.id));
      // Queued deletion/replacement bytes still consume storage. Otherwise
      // repeated delete/upload cycles bypass the physical quota before cleanup.
      const current = existing.filter(d => d.state !== "deleted");
      if (current.length >= VAULT_MAX_DOCUMENTS || current.reduce((n, d) => n + d.sizeBytes, 0) + input.sizeBytes > VAULT_QUOTA_BYTES) return fail(409, "Vault quota exceeded (30 files / 100MB, including files awaiting cleanup). Retry after private cleanup completes.");
      const old = input.replacesId ? existing.find(d => d.id === input.replacesId && !["deleted", "superseded", "delete-pending"].includes(d.state)) : undefined;
      if (input.replacesId && !old) return fail(404, "Document unavailable.");
      if (old && old.holdUntil && old.holdUntil > new Date()) return fail(409, "Document is under a retention hold.");
      const id = randomUUID();
      const [row] = await tx.insert(docs).values({
        id, profileId: p.id, name: input.name, sizeBytes: input.sizeBytes, contentType: input.contentType,
        revision: old ? old.revision + 1 : 1, replacesId: old?.id, policyRevision: policy.revision, jurisdiction: input.jurisdiction,
        objectPath: `/objects/employee-vault/${p.id}/${id}`,
        leaseUntil: new Date(Date.now() + 15 * 60000),
      }).returning();
      await auditVault(tx, p.id, req.authUserId!, "upload-reserved", id);
      return row!;
    });
    res.status(201).json(documentProjection(d));
  } catch (e) { next(e); }
});
router.put("/vault/documents/:id/bytes", async (req, res, next) => {
  try {
    const p = await ownProfile(req.authUserId!);
    const [reservation] = await db.select().from(docs).where(and(eq(docs.profileId, p.id), eq(docs.id, String(req.params.id))));
    if (!reservation || reservation.state !== "reserved") return fail(404, "Upload reservation unavailable.");
    if (Number(req.headers["content-length"]) !== reservation.sizeBytes) return fail(400, "A matching bounded Content-Length is required.");
    req.setTimeout(30000, () => req.destroy());
    const chunks: Buffer[] = []; let size = 0;
    // Express JSON cannot parse this endpoint's required octet-stream payload.
    if (!req.is("application/octet-stream")) return fail(415, "Use application/octet-stream.");
    for await (const part of req) {
      const bytes = Buffer.from(part); size += bytes.length;
      if (size > VAULT_MAX_BYTES) return fail(413, "File exceeds 10MB."); chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    await vaultWrite({ profileId: p.id, withdrawal: true }, async tx => {
      const policy = await liveVaultPolicy(tx, { storage: true });
      const [d] = await tx.select().from(docs).where(and(eq(docs.profileId, p.id), eq(docs.id, String(req.params.id))));
      if (!d) return fail(404, "Document unavailable.");
      await liveVaultPolicy(tx, { storage: true, jurisdiction: d.jurisdiction });
      if (d.policyRevision !== policy.revision) return fail(409, "The document's processing approval is no longer current.");
      if (d.state !== "reserved" || !d.leaseUntil || d.leaseUntil <= new Date() || d.policyRevision !== policy.revision ||
          !d.jurisdiction || d.jurisdiction !== policy.jurisdiction) return fail(409, "Upload reservation is expired, outside approved jurisdiction or used. Reserve a new upload.");
      if (!size || size !== d.sizeBytes || detectCandidateFile(bytes) !== d.contentType) return fail(415, "Bytes do not match the declared size or permitted file type.");
      // Inventory predates I/O. Transaction owns the global writer/cleanup fence.
      await getPrivateFile(d.objectPath).save(bytes, { resumable: false, contentType: d.contentType });
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (d.replacesId) {
        const [old] = await tx.select().from(docs).where(and(eq(docs.profileId, p.id), eq(docs.id, d.replacesId)));
        if (!old || old.state === "superseded" || (old.holdUntil && old.holdUntil > new Date())) return fail(409, "Replacement changed or is held.");
        await tx.update(docs).set({ state: "superseded", updatedAt: new Date() }).where(eq(docs.id, old.id));
        await invalidateDocumentChecks(tx, p.id, old.id);
      }
      await tx.update(docs).set({ state: "pending", sha256: hash, leaseUntil: null, updatedAt: new Date() }).where(eq(docs.id, d.id));
      await auditVault(tx, p.id, req.authUserId!, "private-upload-quarantined", d.id);
    });
    res.status(204).send();
  } catch (e) { next(e); }
});
router.get("/vault/documents/:id/bytes", async (req, res, next) => {
  try {
    const p = await ownProfile(req.authUserId!);
    const result = await vaultWrite({ profileId: p.id, withdrawal: true }, async tx => {
      const policy = await liveVaultPolicy(tx, { storage: true, scanner: true });
      const [d] = await tx.select().from(docs).where(and(eq(docs.profileId, p.id), eq(docs.id, String(req.params.id))));
      if (!d) return fail(404, "Document unavailable.");
      await liveVaultPolicy(tx, { storage: true, scanner: true, jurisdiction: d.jurisdiction });
      if (d.policyRevision !== policy.revision) return fail(409, "The document's processing approval is no longer current.");
      if (d.state !== "clean" || !d.sha256 || d.sha256 !== d.scanSha256 || !configuredMalwareScanner()) return fail(409, "Quarantined: current malware clearance is unavailable.");
      const [bytes] = await getPrivateFile(d.objectPath).download({ start: 0, end: VAULT_MAX_BYTES });
      if (bytes.length !== d.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== d.sha256) return fail(409, "Stored evidence has changed; access blocked.");
      await auditVault(tx, p.id, req.authUserId!, "owner-download", d.id);
      return { bytes, type: d.contentType };
    });
    res.setHeader("Content-Disposition", "attachment; filename=\"vault-document\"");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(result.type).send(result.bytes);
  } catch (e) { next(e); }
});
router.delete("/vault/documents/:id", async (req, res, next) => {
  try {
    const p = await ownProfile(req.authUserId!);
    await vaultWrite({ profileId: p.id, withdrawal: true }, async tx => {
      const [d] = await tx.select().from(docs).where(and(eq(docs.profileId, p.id), eq(docs.id, String(req.params.id))));
      if (!d) return fail(404, "Document unavailable.");
      if (d.holdUntil && d.holdUntil > new Date()) return fail(409, "Deletion is blocked by a retention hold.");
      await tx.update(docs).set({ state: "delete-pending", scanSha256: null, updatedAt: new Date() }).where(eq(docs.id, d.id));
      await invalidateDocumentChecks(tx, p.id, d.id);
      await auditVault(tx, p.id, req.authUserId!, "deletion-requested", d.id);
    });
    res.status(204).send();
  } catch (e) { next(e); }
});
router.post("/vault/checks", async (req, res, next) => {
  try {
    const input = SubmitVaultCheckBody.parse(req.body), p = await ownProfile(req.authUserId!);
    const c = await vaultWrite({ profileId: p.id }, async tx => {
      const bindings = await currentDocumentBindings(tx, p.id, input.documentIds, input.jurisdiction);
      const configured = await tx.select().from(issuers).where(eq(issuers.approved, true));
      const ready = configured.some(i => i.expiresAt > new Date() && i.approvalReference && i.allowedKinds.includes(input.kind) && i.jurisdictions.includes(input.jurisdiction));
      const [c] = await tx.insert(checks).values({
        id: randomUUID(), profileId: p.id, kind: input.kind, jurisdiction: input.jurisdiction,
        bindings, state: ready ? "pending" : "unavailable",
      }).returning();
      await auditVault(tx, p.id, req.authUserId!, "verification-submitted", c!.id);
      return c!;
    });
    res.status(201).json(checkProjection(c));
  } catch (e) { next(e); }
});
router.get("/vault/requests/:id", async (req, res, next) => {
  try {
    const [r] = await db.select().from(requests).where(eq(requests.id, String(req.params.id)));
    const p = await ownProfile(req.authUserId!);
    const [product] = r ? await db.select().from(products).where(eq(products.organizationId, r.organizationId)) : [];
    if (!r || !product?.enabled || r.expiresAt <= new Date() || (r.profileId && r.profileId !== p.id)) return fail(404, "Request unavailable.");
    // Never returns employee identity, evidence, email, or document metadata.
    res.json(shareProjection(r));
  } catch (e) { next(e); }
});
router.post("/vault/requests/:id", async (req, res, next) => {
  try {
    const input = DecideVaultShareRequestBody.parse(req.body), p = await ownProfile(req.authUserId!);
    const r = await vaultWrite({ requestId: String(req.params.id) }, async tx => {
      const [r] = await tx.select().from(requests).where(eq(requests.id, String(req.params.id)));
      const [product] = r ? await tx.select().from(products).where(eq(products.organizationId, r.organizationId)) : [];
      if (!r || !product?.enabled || r.expiresAt <= new Date() || (r.profileId && r.profileId !== p.id)) return fail(404, "Request unavailable.");
      if (r.state !== "pending" || r.version !== input.expectedVersion) return fail(409, "Request has already changed. Refresh it.");
      if (!input.acknowledgeCaseBinding) return fail(400, "Confirm that this employer request is for your case.");
      const documents = input.documentIds.length ? await currentDocumentBindings(tx, p.id, input.documentIds, r.jurisdiction) : [];
      const owned = await tx.select().from(checks).where(and(eq(checks.profileId, p.id), inArray(checks.kind, r.scope)));
      const [updated] = await tx.update(requests).set({
        profileId: p.id, state: input.decision === "approve" ? "approved" : "declined",
        version: r.version + 1, checkIds: input.decision === "approve" ? owned.filter(c => c.jurisdiction === r.jurisdiction).map(c => c.id) : [],
        documentIds: input.decision === "approve" ? documents.map(d => d.id) : [],
      }).where(eq(requests.id, r.id)).returning();
      await auditVault(tx, p.id, req.authUserId!, input.decision === "approve" ? "consent-approved" : "consent-declined", r.id);
      return updated!;
    });
    res.json(shareProjection(r));
  } catch (e) { next(e); }
});
router.post("/vault/requests/:id/revoke", async (req, res, next) => {
  try {
    const p = await ownProfile(req.authUserId!);
    await vaultWrite({ profileId: p.id, withdrawal: true }, async tx => {
      const [r] = await tx.select().from(requests).where(and(eq(requests.id, String(req.params.id)), eq(requests.profileId, p.id)));
      if (!r) return fail(404, "Request unavailable.");
      await tx.update(requests).set({ state: "revoked", version: r.version + 1, documentIds: [], checkIds: [] }).where(eq(requests.id, r.id));
      await invalidateVaultReuse(tx, { requestId: r.id });
      await auditVault(tx, p.id, req.authUserId!, "consent-revoked", r.id);
    });
    res.status(204).send();
  } catch (e) { next(e); }
});
router.use("/vault", (_req, res) => { res.status(404).json({ message: "Vault route not found." }); });
router.use("/vault", (err: unknown, _req: unknown, res: any, next: any) => {
  if (err instanceof VaultError) return res.status(err.status).json({ message: err.message });
  next(err);
});
export default router;
