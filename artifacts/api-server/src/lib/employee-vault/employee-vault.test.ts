import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, employeeVaultProfiles as profiles, employeeVaultDocuments as docs, employeeVaultChecks as checks,
  employeeVaultRequests as requests, employeeVaultReceipts as receipts, employeeVaultProducts as products,
  employeeVaultIssuers as issuers, employeeVaultPolicies as policies, employeeVaultAudit as audit,
  organizationsTable, organizationMembershipsTable, onbCases,
  onbGovernanceAuthorityAssignments, onbGovernanceDecisions, onbGovernanceDecisionReviews,
  onbApprovals, onbApprovalNotifications, onbEvents, onbConnectors, onbSettings,
} from "@workspace/db";
import employeeRouter, { employeeVaultSourceRouter } from "../../routes/employee-vault";
import employerRouter from "../../routes/employee-vault-employer";
import { VaultError, ownProfile, vaultWrite, invalidateDocumentChecks, liveVaultPolicy } from "./core";
import { acceptVaultSourceResult, authoritativeCheckIsCurrent } from "./verification";
import { allRequiredChecks, authenticSource, exactBindings, safeDates, sourcePayload, type VaultSourceResult } from "./policy";
import { evaluateVaultReuse, hasCurrentVaultBgvReceipt } from "./reuse";
import { runEmployeeVaultTick } from "./worker";
import { deleteTestOrganizations } from "../../test-support/organization-fixtures";

const suffix = randomUUID(), employeeA = `vault-test-employee-a:${suffix}`, employeeB = `vault-test-employee-b:${suffix}`;
const orgA = `vault-test-employer-a:${suffix}`, orgB = `vault-test-employer-b:${suffix}`;
const ownerA = `vault-test-owner-a:${suffix}`, ownerB = `vault-test-owner-b:${suffix}`;
const issuerId = `vault-test-source:${suffix}`;
const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const bytes = Buffer.from("%PDF-1.4\nSynthetic non-personal vault test");
const sha256 = createHash("sha256").update(bytes).digest("hex");
let server: Server, url: string, profileA: string, profileB: string, caseA: number, caseB: number;
let insertedPolicy = false;
const docId = randomUUID(), checkId = randomUUID(), requestA = randomUUID(), requestB = randomUUID();
const signed = (r: VaultSourceResult) => sign(null, Buffer.from(sourcePayload(r)), keys.privateKey).toString("base64");
const source = (): VaultSourceResult => ({
  submissionId: checkId, profileId: profileA, issuerId, kind: "identity", jurisdiction: "IN",
  bindings: [{ id: docId, revision: 1, sha256 }], outcome: "clear", sourceReference: `synthetic-source:${suffix}`,
  verifiedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
async function call(path: string, user: string | null, method = "GET", body?: unknown, org = orgA) {
  const res = await fetch(`${url}${path}`, { method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": user } : {}), "x-test-organization": org },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}
before(async () => {
  profileA = (await ownProfile(employeeA)).id; profileB = (await ownProfile(employeeB)).id;
  for (const [id, owner] of [[orgA, ownerA], [orgB, ownerB]]) {
    await db.insert(organizationsTable).values({ id, name: id, slug: id, createdByUserId: owner, joinCodeHash: randomUUID() });
    await db.insert(organizationMembershipsTable).values({ organizationId: id, clerkUserId: owner, role: "owner" });
    const [c] = await db.insert(onbCases).values({
      organizationId: id, workerName: "Synthetic Vault Person", workerEmail: `${randomUUID()}@example.test`,
      hireType: "external-fte", workerCategory: "white-collar", role: "Fixture", department: "Fixture",
      geography: "India", legalEntity: "Synthetic Employer", managerName: "Fixture", recruiterName: "Fixture",
      joiningDate: "2030-01-01", workforceContext: { workCountry: "IN" },
      lifecycleStage: "trigger-received", orchestrationStatus: "idle",
      notes: "Synthetic non-production fixture, no real recipients or provider dispatch.",
      syntheticProvenance: "onboarding-demo-fictional",
    }).returning();
    if (id === orgA) caseA = c!.id; else caseB = c!.id;
  }
  const [existing] = await db.select().from(policies).where(eq(policies.id, "independent-vault"));
  if (!existing) {
    insertedPolicy = true;
    await db.insert(policies).values({
      id: "independent-vault", revision: 1, approved: true, approvalReference: `synthetic-policy:${suffix}`,
      privacyNotice: "Synthetic test processing only. No real identity evidence or external verification.",
      jurisdiction: "IN", retentionDays: 30, receiptRetentionDays: 30, storageApproved: true, scannerApproved: true,
      expiresAt: new Date(Date.now() + 10 * 60000),
    });
  }
  await db.insert(issuers).values({
    id: issuerId, name: "Synthetic cryptographic test source — not a production provider",
    publicKeyPem, allowedKinds: ["identity"], jurisdictions: ["IN"], approved: true,
    approvalReference: `synthetic-source-approval:${suffix}`, expiresAt: new Date(Date.now() + 10 * 60000),
  });
  await db.insert(docs).values({
    id: docId, profileId: profileA, name: "Synthetic identity document", contentType: "application/pdf",
    sizeBytes: bytes.length, revision: 1, policyRevision: 1, jurisdiction: "IN", objectPath: `/objects/employee-vault/${profileA}/${docId}`,
    state: "clean", sha256, scanSha256: sha256,
  });
  await db.insert(checks).values({ id: checkId, profileId: profileA, kind: "identity", jurisdiction: "IN",
    bindings: [{ id: docId, revision: 1, sha256 }], state: "unavailable" });
  await db.insert(products).values([
    { organizationId: orgA, enabled: true, version: 1, updatedBy: ownerA },
    { organizationId: orgB, enabled: true, version: 1, updatedBy: ownerB },
  ]);
  await db.insert(requests).values([
    { id: requestA, organizationId: orgA, caseId: caseA, employerName: "Synthetic Employer A",
      purpose: "Synthetic case-specific identity reuse", scope: ["identity", "criminal"], jurisdiction: "IN",
      requirementsDigest: "unapproved-fixture", requestedBy: ownerA, expiresAt: new Date(Date.now() + 3600000) },
    { id: requestB, organizationId: orgB, caseId: caseB, employerName: "Synthetic Employer B",
      purpose: "Different synthetic employer", scope: ["identity"], jurisdiction: "IN",
      requirementsDigest: "unapproved-fixture", requestedBy: ownerB, expiresAt: new Date(Date.now() + 3600000) },
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.header("x-test-user");
    if ([employeeA, employeeB, ownerA, ownerB].includes(user ?? "")) req.authUserId = user!;
    next();
  });
  app.use((req, res, next) => {
    if (!req.authUserId && req.path !== "/vault/source-results") { res.status(401).json({ message: "Authentication required." }); return; }
    next();
  });
  app.use(employeeVaultSourceRouter, employeeRouter);
  app.use(async (req, res, next) => {
    const org = req.header("x-test-organization");
    const [member] = await db.select().from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, org ?? ""), eq(organizationMembershipsTable.clerkUserId, req.authUserId ?? ""),
    ));
    if (!member) { res.status(403).json({ message: "Membership required for employer operations." }); return; }
    req.organizationId = member.organizationId; req.organizationRole = member.role; next();
  });
  app.use(employerRouter);
  app.use((err: unknown, _req: unknown, res: any, _next: unknown) => res.status(err instanceof VaultError ? err.status : 500).json({ message: err instanceof Error ? err.message : "Error" }));
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); assert(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db.delete(receipts).where(inArray(receipts.organizationId, [orgA, orgB]));
  await db.delete(requests).where(inArray(requests.organizationId, [orgA, orgB]));
  await db.delete(products).where(inArray(products.organizationId, [orgA, orgB]));
  await db.delete(checks).where(inArray(checks.profileId, [profileA, profileB]));
  await db.delete(audit).where(inArray(audit.profileId, [profileA, profileB]));
  await db.delete(docs).where(inArray(docs.profileId, [profileA, profileB]));
  await db.delete(profiles).where(inArray(profiles.id, [profileA, profileB]));
  await db.delete(issuers).where(eq(issuers.id, issuerId));
  if (insertedPolicy) await db.delete(policies).where(and(eq(policies.id, "independent-vault"), eq(policies.approvalReference, `synthetic-policy:${suffix}`)));
  await db.delete(onbCases).where(inArray(onbCases.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceDecisionReviews).where(inArray(onbGovernanceDecisionReviews.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceDecisions).where(inArray(onbGovernanceDecisions.organizationId, [orgA, orgB]));
  await db.delete(onbGovernanceAuthorityAssignments).where(inArray(onbGovernanceAuthorityAssignments.organizationId, [orgA, orgB]));
  await deleteTestOrganizations(inArray(organizationsTable.id, [orgA, orgB]), async (tx, ids) => {
    await tx.delete(onbConnectors).where(inArray(onbConnectors.organizationId, ids));
    await tx.delete(onbSettings).where(inArray(onbSettings.organizationId, ids));
  });
});

test("public identity authentication creates no employer membership, directory or ID credential", async () => {
  assert.equal((await call("/vault/profile", employeeA)).status, 200);
  const b = await call("/vault/profile", employeeB);
  assert.equal(b.body.vaultId, profileB); assert.equal(b.body.documents.length, 0);
  assert.equal((await call("/vault/profile", null)).status, 401);
  assert.equal((await call("/vault/profile/" + profileA, employeeB)).status, 404);
  const memberships = await db.select().from(organizationMembershipsTable).where(inArray(organizationMembershipsTable.clerkUserId, [employeeA, employeeB]));
  assert.equal(memberships.length, 0);
  assert.equal((await call("/employee-vault/settings", employeeA)).status, 403);
  assert.equal((await call(`/vault/documents/${docId}/bytes`, employeeB)).status, 404);
  assert.equal((await call(`/vault/documents/${docId}`, employeeB, "DELETE")).status, 404);
});
test("source authenticity binds subject, exact revision, issuer, jurisdiction, outcome and expiry", () => {
  assert.equal(allRequiredChecks(["identity"], ["identity"]), false, "Identity alone is never full BGV");
  const r = source(), signature = signed(r);
  assert(authenticSource(r, signature, publicKeyPem));
  for (const altered of [
    { ...r, profileId: profileB }, { ...r, outcome: "adverse" as const }, { ...r, jurisdiction: "US" },
    { ...r, bindings: [{ id: docId, revision: 2, sha256 }] }, { ...r, issuerId: "attacker" },
  ]) assert.equal(authenticSource(altered, signature, publicKeyPem), false);
  assert.equal(authenticSource(r, "clear", publicKeyPem), false);
  assert.equal(exactBindings(r.bindings, []), false);
  assert.equal(exactBindings(r.bindings, [r.bindings[0]!, r.bindings[0]!]), false);
  assert.equal(safeDates(new Date(Date.now() + 60000), new Date(Date.now() + 120000)), false);
  assert.equal(safeDates(new Date("bad"), new Date()), false);
  assert.equal(allRequiredChecks([], []), false);
  assert.equal(allRequiredChecks(["identity", "criminal"], ["identity"]), false);
});
let acceptedSource: VaultSourceResult;
test("unapproved or forged labels cannot clear BGV; exact authenticated callback is idempotent", async () => {
  const forged = await call("/vault/source-results", null, "POST", { result: source(), signature: "A".repeat(86) + "==" });
  assert.equal(forged.status, 403);
  acceptedSource = source();
  assert.equal(await acceptVaultSourceResult(acceptedSource, signed(acceptedSource)), true);
  assert.equal(await acceptVaultSourceResult(acceptedSource, signed(acceptedSource)), true);
  const different = { ...acceptedSource, outcome: "adverse" as const };
  assert.equal(await acceptVaultSourceResult(different, signed(different)), false);
  const [c] = await db.select().from(checks).where(eq(checks.id, checkId));
  assert.equal(c!.state, "clear");
  const [caseRow] = await db.select().from(onbCases).where(eq(onbCases.id, caseA));
  const reuse = await evaluateVaultReuse(db, caseRow!);
  assert.equal(reuse.complete, false, "Identity source evidence without approved complete policy/consent is not BGV");
  assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false);
});
test("consent shows actual employer and scope; summary is default, not a raw-file grant", async () => {
  const info = await call(`/vault/requests/${requestA}`, employeeA);
  assert.equal(info.body.employer, "Synthetic Employer A");
  assert.deepEqual(info.body.scope, ["identity", "criminal"]);
  assert.equal("profileId" in info.body, false);
  assert.equal((await call(`/vault/requests/${requestA}`, null)).status, 401);
  const decision = { decision: "approve", expectedVersion: 1, acknowledgeCaseBinding: true, documentIds: [] };
  const attempts = await Promise.all([call(`/vault/requests/${requestA}`, employeeA, "POST", decision), call(`/vault/requests/${requestA}`, employeeB, "POST", decision)]);
  assert.deepEqual(attempts.map(a => a.status).sort(), [200, 404]);
  const [r] = await db.select().from(requests).where(eq(requests.id, requestA));
  // Both simultaneous employees may click a non-authorizing link. Exactly one
  // owns the consent; only the intended employee can be independently bound.
  assert(r?.profileId === profileA || r?.profileId === profileB);
  assert.deepEqual(r.documentIds, []); assert.equal(r.bindingConfirmedBy, null);
  const winner = r.profileId === profileA ? employeeA : employeeB;
  const loser = winner === employeeA ? employeeB : employeeA;
  assert.equal((await call(`/vault/requests/${requestA}`, loser)).status, 404);
  assert.equal((await call(`/vault/requests/${requestA}`, winner, "POST", decision)).status, 409);
  assert.equal((await call(`/vault/requests/${requestA}/revoke`, loser, "POST")).status, 404);
  assert.equal((await call(`/vault/requests/${requestA}/revoke`, winner, "POST")).status, 204);
  assert.equal((await call(`/vault/requests/${requestA}/revoke`, winner, "POST")).status, 204);
  assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false);
});
test("all-required authoritative consented receipt is live; disablement, revoke, expiry and forged evidence invalidate it", async () => {
  const scannerKey = "MALWARE_SCANNER_CLAMAV_SOCKET_PATH", previous = process.env[scannerKey];
  // Config only in this isolated test process. No runtime worker, real socket,
  // real provider or production issuer is enabled by this fixture.
  process.env[scannerKey] = `/tmp/vault-synthetic-scanner-${suffix}`;
  const fullRequest = randomUUID(), criminalId = randomUUID();
  try {
    await db.update(issuers).set({ allowedKinds: ["identity", "criminal"] }).where(eq(issuers.id, issuerId));
    const key = "employee-verification-requirements:IN";
    const [authority] = await db.insert(onbGovernanceAuthorityAssignments).values({
      organizationId: orgA, authorityRole: "legal", assigneeUserId: ownerA,
      verificationStatus: "verified", verifiedByUserId: "synthetic-independent-operator",
      verificationReference: `synthetic-authority:${suffix}`, expiresAt: new Date(Date.now() + 3600000),
    }).returning();
    await db.insert(onbGovernanceDecisions).values({
      organizationId: orgA, key, revision: 1, title: "Synthetic country requirements", status: "approved", isProvisional: false,
      proposedValue: { jurisdiction: "IN", checks: ["identity", "criminal"], maxAgeDays: 30,
        governanceRuntime: { domain: "legal", impactedWorkflows: ["background-verification", "it-identity-access"] } },
      rationale: "Synthetic evidence coverage test only", risk: "Not a live legal approval",
      accountableRole: "legal", createdByUserId: ownerA, approvedByUserId: ownerA, approvedAt: new Date(),
      sourceReference: `synthetic-country-policy:${suffix}`,
    });
    await db.insert(onbGovernanceDecisionReviews).values({
      organizationId: orgA, decisionKey: key, decisionRevision: 1, outcome: "approved",
      reason: "Synthetic independent review fixture", authorityAssignmentId: authority!.id,
      reviewedByUserId: ownerA, verificationReference: `synthetic-review:${suffix}`,
    });
    await db.update(onbCases).set({ processPolicySnapshot: { governanceDecisionSnapshot: {
      schemaVersion: 1, version: 1, adoptedAt: new Date().toISOString(),
      decisions: [{ key, revision: 1, status: "approved", domain: "legal", impactedWorkflows: ["background-verification", "it-identity-access"] }],
    } } }).where(eq(onbCases.id, caseA));
    const { caseVaultRequirements } = await import("./reuse");
    const [c] = await db.select().from(onbCases).where(eq(onbCases.id, caseA));
    const requirements = await caseVaultRequirements(db, c!); assert(requirements);
    await db.insert(requests).values({
      id: fullRequest, organizationId: orgA, caseId: caseA, employerName: "Synthetic Employer A", purpose: "Synthetic full-set reuse",
      scope: requirements.scope, jurisdiction: "IN", requirementsDigest: requirements.digest, profileId: profileA,
      state: "approved", version: 2, requestedBy: ownerA, bindingConfirmedBy: ownerA, checkIds: [checkId],
      documentIds: [], expiresAt: new Date(Date.now() + 3600000),
    });
    let evaluation = await evaluateVaultReuse(db, c!, fullRequest);
    assert.deepEqual(evaluation.reused, ["identity"]);
    assert.deepEqual(evaluation.outstanding, ["criminal"]); assert.equal(evaluation.complete, false);
    await db.insert(checks).values({ id: criminalId, profileId: profileA, kind: "criminal", jurisdiction: "IN",
      bindings: [{ id: docId, revision: 1, sha256 }], state: "pending" });
    const criminal = { ...source(), submissionId: criminalId, kind: "criminal" };
    assert.equal(await acceptVaultSourceResult(criminal, signed(criminal)), true);
    await db.update(requests).set({ checkIds: [checkId, criminalId] }).where(eq(requests.id, fullRequest));
    evaluation = await evaluateVaultReuse(db, c!, fullRequest);
    assert.equal(evaluation.complete, true);
    await db.update(policies).set({ jurisdiction: "US" }).where(eq(policies.id, "independent-vault"));
    try {
      const outside = await evaluateVaultReuse(db, c!, fullRequest);
      assert.equal(outside.complete, false, "A US-only processing policy must not authorize an IN employer case");
      assert.deepEqual(outside.reused, []);
    } finally { await db.update(policies).set({ jurisdiction: "IN" }).where(eq(policies.id, "independent-vault")); }
    assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false, "Grant is not itself a consumption receipt");
    await db.insert(receipts).values({ id: randomUUID(), organizationId: orgA, caseId: caseA, requestId: fullRequest,
      requestVersion: 2, requirementsDigest: requirements.digest, checkIds: [checkId, criminalId], satisfied: ["identity", "criminal"],
      retainUntil: new Date(Date.now() + 3600000) });
    assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), true);
    await db.update(products).set({ enabled: false }).where(eq(products.organizationId, orgA));
    assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false);
    await db.update(products).set({ enabled: true }).where(eq(products.organizationId, orgA));
    await db.update(requests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(requests.id, fullRequest));
    assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false, "Expiry is live, even before worker sweep");
    await db.update(requests).set({ expiresAt: new Date(Date.now() + 3600000) }).where(eq(requests.id, fullRequest));
    await db.update(checks).set({ sourceSignature: "A".repeat(86) + "==" }).where(eq(checks.id, criminalId));
    assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false, "Stored clear label without authentic source is insufficient");
    assert.equal((await call(`/vault/requests/${fullRequest}/revoke`, employeeA, "POST")).status, 204);
    assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false);
    const [receipt] = await db.select().from(receipts).where(eq(receipts.requestId, fullRequest));
    assert(receipt?.consumedAt && receipt.invalidatedAt, "Minimal dated history remains; no active authorization");
  } finally {
    if (previous === undefined) delete process.env[scannerKey]; else process.env[scannerKey] = previous;
  }
});
test("tenant owners are not sensitive-record specialists and cannot self-assert verification", async () => {
  assert.equal((await call(`/onboarding/cases/${caseA}/employee-vault`, ownerA)).status, 403);
  assert.equal((await call(`/onboarding/cases/${caseA}/employee-vault/consume`, ownerA, "POST",
    { requestId: requestA, vaultId: profileA, acknowledgeEmployeeBinding: true })).status, 403);
  assert.equal((await call(`/onboarding/cases/${caseA}/employee-vault`, ownerB, "GET", undefined, orgB)).status, 404);
  assert.equal((await call(`/onboarding/cases/${caseA}/employee-vault/requests/${requestA}/documents/${docId}`, ownerA)).status, 403);
});
test("feature off and expiry prevent new approvals without destroying an independent account", async () => {
  await vaultWrite({ organizationId: orgB, withdrawal: true }, async tx => {
    await tx.update(products).set({ enabled: false }).where(eq(products.organizationId, orgB));
  });
  assert.equal((await call(`/vault/requests/${requestB}`, employeeA)).status, 404);
  assert.equal((await call(`/vault/requests/${requestB}`, employeeA, "POST",
    { decision: "approve", expectedVersion: 1, acknowledgeCaseBinding: true, documentIds: [docId] })).status, 404);
  assert.equal((await call("/vault/profile", employeeA)).status, 200);
  await db.update(requests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(requests.id, requestB));
  await runEmployeeVaultTick({ profileId: profileB });
  assert.equal((await call(`/vault/requests/${requestB}`, employeeA)).status, 404);
});
test("replacement/deletion invalidate bound checks; late source callbacks cannot restore a verdict", async () => {
  await vaultWrite({ profileId: profileA, withdrawal: true }, async tx => {
    await tx.update(docs).set({ state: "superseded" }).where(eq(docs.id, docId));
    await invalidateDocumentChecks(tx, profileA, docId);
  });
  const [c] = await db.select().from(checks).where(eq(checks.id, checkId));
  assert.equal(c!.state, "superseded");
  assert.equal(await authoritativeCheckIsCurrent(db, c!, 365), false);
  const late = { ...acceptedSource, expiresAt: new Date(Date.now() + 7200000).toISOString() };
  assert.equal(await acceptVaultSourceResult(late, signed(late)), false);
  assert.equal((await call(`/vault/documents/${docId}/bytes`, employeeA)).status, 409);
});
test("policy revision, integer size, quota and bounded upload contract cannot be bypassed", async () => {
  const policy = await liveVaultPolicy(db);
  const data = { name: "Synthetic", contentType: "application/pdf", sizeBytes: 100, policyAccepted: true, policyRevision: policy.revision, jurisdiction: "IN" };
  assert.equal((await call("/vault/documents", employeeA, "POST", { ...data, sizeBytes: 1.5 })).status, 400);
  assert.equal((await call("/vault/documents", employeeA, "POST", { ...data, sizeBytes: 11 * 1024 * 1024 })).status, 400);
  assert.equal((await call("/vault/documents", employeeA, "POST", { ...data, policyAccepted: false })).status, 400);
  assert.equal((await call("/vault/documents", employeeA, "POST", { ...data, policyRevision: policy.revision + 1 })).status, 409);
  assert.equal((await call("/vault/documents", employeeA, "POST", { ...data, jurisdiction: "US" })).status, 503);
  assert.equal((await call("/vault/checks", employeeA, "POST",
    { kind: "identity", jurisdiction: "US", documentIds: [docId] })).status, 503);
  const foreignId = randomUUID();
  await db.insert(checks).values({ id: foreignId, profileId: profileA, kind: "identity", jurisdiction: "US",
    state: "pending", bindings: [{ id: docId, revision: 1, sha256 }] });
  const foreign = { ...source(), submissionId: foreignId, jurisdiction: "US" };
  await assert.rejects(() => acceptVaultSourceResult(foreign, signed(foreign)), /jurisdiction/);
  const [unchanged] = await db.select().from(checks).where(eq(checks.id, foreignId));
  assert.equal(unchanged!.state, "pending");
});
test("interrupted reservations and scan leases recover durably, with private safety and hold controls", async () => {
  const id = randomUUID(), scanId = randomUUID();
  await db.insert(docs).values([
    { id, profileId: profileB, name: "Interrupted", contentType: "application/pdf", sizeBytes: 100, revision: 1,
      objectPath: `/objects/employee-vault/${profileB}/${id}`, policyRevision: 1, jurisdiction: "IN", state: "reserved", leaseUntil: new Date(Date.now() - 1000) },
    { id: scanId, profileId: profileB, name: "Interrupted scan", contentType: "application/pdf", sizeBytes: bytes.length, revision: 1,
      objectPath: `/objects/employee-vault/${profileB}/${scanId}`, policyRevision: 1, jurisdiction: "IN", state: "scanning", scanId: randomUUID(),
      sha256, leaseUntil: new Date(Date.now() - 1000) },
  ]);
  const deleted: string[] = [];
  await runEmployeeVaultTick({ profileId: profileB, deleteBytes: async d => { deleted.push(d.id); } });
  const [expired] = await db.select().from(docs).where(eq(docs.id, id));
  const [scan] = await db.select().from(docs).where(eq(docs.id, scanId));
  assert.equal(expired!.state, "deleted"); assert(deleted.includes(id));
  assert.equal(scan!.state, "timeout"); assert.equal(scan!.scanSha256, null);
  await db.update(docs).set({ state: "pending", holdUntil: new Date(Date.now() + 3600000) }).where(eq(docs.id, scanId));
  assert.equal((await call(`/vault/documents/${scanId}`, employeeB, "DELETE")).status, 409);
  await runEmployeeVaultTick({ profileId: profileB, scanner: { scan: async () => "infected" }, readBytes: async () => bytes, deleteBytes: async () => {} });
  const [infected] = await db.select().from(docs).where(eq(docs.id, scanId));
  assert.equal(infected!.state, "infected"); assert.equal(infected!.scanSha256, null);
  assert.equal((await call(`/vault/documents/${scanId}/bytes`, employeeB)).status, 409);
});
test("independent-owner multi-employer revocation is serialized with consumption and needs no collection policy", async () => {
  const a = randomUUID(), b = randomUUID();
  await db.update(products).set({ enabled: true }).where(inArray(products.organizationId, [orgA, orgB]));
  await db.insert(requests).values([orgA, orgB].map((org, index) => ({
    id: index ? b : a, organizationId: org, caseId: index ? caseB : caseA,
    employerName: `Synthetic employer ${index}`, purpose: "Multi-employer revocation test", scope: ["identity"],
    jurisdiction: "IN", requirementsDigest: "synthetic-only", profileId: profileA, state: "approved", version: 2,
    requestedBy: index ? ownerB : ownerA, bindingConfirmedBy: index ? ownerB : ownerA,
    checkIds: [], documentIds: [], expiresAt: new Date(Date.now() + 3600000),
  })));
  const [approval] = await db.insert(onbApprovals).values({
    organizationId: orgA, caseId: caseA, agent: "synthetic-test", recommendation: "Synthetic final review", rationale: "Synthetic only",
    idempotencyKey: `gateway-c:${caseA}:human-queue`, status: "approved", version: 1, decidedBy: ownerA,
  }).returning();
  const receiptId = randomUUID();
  const consuming = vaultWrite({ profileId: profileA, withdrawal: true }, async tx => {
    const [r] = await tx.select().from(requests).where(eq(requests.id, a));
    if (r!.state !== "approved") return false;
    // This simulates the consumption commit boundary, not a verifier result.
    await new Promise(resolve => setTimeout(resolve, 20));
    await tx.insert(receipts).values({ id: receiptId, organizationId: orgA, caseId: caseA,
      requestId: a, requestVersion: 2, requirementsDigest: "synthetic-only", checkIds: [], satisfied: [],
      retainUntil: new Date(Date.now() + 3600000) });
    return true;
  });
  const revoking = call(`/vault/requests/${a}/revoke`, employeeA, "POST");
  const [, revoked] = await Promise.all([consuming, revoking]);
  assert.equal(revoked.status, 204);
  const [r] = await db.select().from(requests).where(eq(requests.id, a));
  assert.equal(r!.state, "revoked");
  const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  if (receipt) assert(receipt.invalidatedAt, "Consumption before withdrawal becomes dated history, never a live receipt");
  assert.equal(await hasCurrentVaultBgvReceipt(db, orgA, caseA), false);
  const [reset] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval!.id));
  if (receipt) { assert.equal(reset!.status, "pending"); assert.equal(reset!.version, 2); assert.equal(reset!.comment, null); }
  assert.equal((await call(`/vault/requests/${a}/revoke`, employeeA, "POST")).status, 204);
  const [unchanged] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approval!.id));
  assert.equal(unchanged!.version, reset!.version, "Repeated withdrawal must not reset HR authority again");
  assert.equal((await call(`/vault/requests/${b}`, employeeA)).status, 200, "Other employer's consent remains independent");
  assert.equal((await call(`/vault/requests/${b}/revoke`, employeeB, "POST")).status, 404);
  assert.equal((await call(`/vault/requests/${b}/revoke`, employeeA, "POST")).status, 204);
  await db.delete(onbApprovalNotifications).where(eq(onbApprovalNotifications.approvalId, approval!.id));
  await db.delete(onbApprovals).where(eq(onbApprovals.id, approval!.id));
  await db.delete(onbEvents).where(and(eq(onbEvents.organizationId, orgA), eq(onbEvents.caseId, caseA)));
});
test("newer authenticated adverse outcomes supersede clearances and delayed callbacks cannot restore them", async () => {
  const documentId = randomUUID(), good = randomUUID(), adverse = randomUUID(), late = randomUUID();
  await db.insert(docs).values({ id: documentId, profileId: profileA, name: "synthetic-source.pdf",
    contentType: "application/pdf", sizeBytes: bytes.length, objectPath: `synthetic-never-downloaded/${documentId}`,
    state: "clean", sha256, scanSha256: sha256, revision: 1, policyRevision: 1, jurisdiction: "IN" });
  await db.insert(checks).values([good, adverse, late].map(id => ({ id, profileId: profileA, kind: "criminal",
    jurisdiction: "IN", state: "pending", bindings: [{ id: documentId, revision: 1, sha256 }] })));
  const result = (id: string, outcome: "clear" | "adverse", verifiedAt: Date): VaultSourceResult => ({
    ...source(), submissionId: id, kind: "criminal", outcome, verifiedAt: verifiedAt.toISOString(),
    bindings: [{ id: documentId, revision: 1, sha256 }],
  });
  const clearDate = new Date();
  const clear = result(good, "clear", clearDate);
  assert.equal((await call("/vault/source-results", null, "POST", { result: clear, signature: signed(clear) })).status, 204);
  const newer = result(adverse, "adverse", new Date());
  assert.equal((await call("/vault/source-results", null, "POST", { result: newer, signature: signed(newer) })).status, 204);
  const delayed = result(late, "clear", new Date(clearDate.getTime() - 1000));
  assert.equal((await call("/vault/source-results", null, "POST", { result: delayed, signature: signed(delayed) })).status, 204);
  const rows = await db.select().from(checks).where(inArray(checks.id, [good, adverse, late]));
  assert.equal(rows.find(c => c.id === good)!.state, "superseded");
  assert.equal(rows.find(c => c.id === adverse)!.state, "adverse");
  assert.equal(rows.find(c => c.id === late)!.state, "superseded");
  for (const c of rows) assert.equal(await authoritativeCheckIsCurrent(db, c, 30), false);
});
