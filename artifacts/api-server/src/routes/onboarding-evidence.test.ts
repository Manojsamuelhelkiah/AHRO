import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbCandidateUploads,
  onbCases,
  onbDocuments,
  onbSystemChecks,
  organizationsTable,
} from "@workspace/db";
import onboardingRouter from "./onboarding";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `evidence-a-${suffix}`;
const orgB = `evidence-b-${suffix}`;
const user = `evidence-user-${suffix}`;
let baseUrl: string;
let caseA: number;
let caseB: number;
let documentA: number;
let uploadA: number;
let server: Server;

const caseValues = (organizationId: string, name: string) => ({
  organizationId,
  workerName: name,
  workerEmail: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
  hireType: "external",
  workerCategory: "full-time",
  role: "Engineer",
  department: "Engineering",
  geography: "US",
  legalEntity: "Example",
  managerName: "Manager",
  recruiterName: "Recruiter",
  joiningDate: "2030-01-01",
  readiness: [{ key: "documentation", label: "Documentation", status: "in-progress" }],
});

async function call(path: string, organizationId: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-organization-id": organizationId,
      "x-test-user": user,
      "x-test-role": "owner",
      ...(init?.headers ?? {}),
    },
  });
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Evidence A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: user },
    { id: orgB, name: "Evidence B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: user },
  ]);
  [caseA, caseB] = (await db.insert(onbCases).values([
    caseValues(orgA, "Evidence Alpha"),
    caseValues(orgB, "Evidence Beta"),
  ]).returning({ id: onbCases.id })).map((row) => row.id);
  [documentA] = (await db.insert(onbDocuments).values({
    organizationId: orgA, caseId: caseA, key: "id-proof", label: "ID proof",
    category: "identity", required: true, status: "received",
  }).returning({ id: onbDocuments.id })).map((row) => row.id);
  [uploadA] = (await db.insert(onbCandidateUploads).values({
    organizationId: orgA, caseId: caseA, documentId: documentA,
    objectPath: `test/${suffix}/id-proof.pdf`, originalName: "id-proof.pdf",
    contentType: "application/pdf", sizeBytes: 10, validationState: "manual_review",
    checksumSha256: "a".repeat(64), malwareScanState: "clean", malwareScanSha256: "a".repeat(64),
    malwareScannedAt: new Date(),
    validationReasons: [{ code: "manual_review", message: "Needs HR review." }],
  }).returning({ id: onbCandidateUploads.id })).map((row) => row.id);
  await db.insert(onbSystemChecks).values({
    organizationId: orgA, caseId: caseA, system: "bgv", status: "done",
    mode: "poll", externalRef: "bgv-test", requestedAt: new Date(), dueAt: new Date("2030-01-03"),
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    const role = req.header("x-test-role");
    req.organizationRole = role === "member" || role === "admin" ? role : "owner";
    req.authUserId = user;
    next();
  });
  app.use(onboardingRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(onbCases).where(inArray(onbCases.id, [caseA, caseB]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgA, orgB]));
});

test("evidence and BGV lists are tenant scoped", async () => {
  assert.equal((await call(`/onboarding/cases/${caseA}/evidence`, orgA)).status, 200);
  assert.equal((await call(`/onboarding/cases/${caseA}/bgv`, orgA)).status, 200);
  assert.equal((await call(`/onboarding/cases/${caseA}/evidence`, orgB)).status, 404);
  assert.equal((await call(`/onboarding/cases/${caseA}/bgv`, orgB)).status, 404);
});

test("HR evidence decisions atomically update upload and document, with role and tenant fences", async () => {
  const denied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", headers: { "x-test-role": "member" },
    body: JSON.stringify({ decision: "approve", reason: "Looks good." }),
  });
  assert.equal(denied.status, 403);

  const crossTenant = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgB, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "No cross-tenant decisions." }),
  });
  assert.equal(crossTenant.status, 404);

  const metadata = await call(`/onboarding/cases/${caseA}/evidence`, orgA);
  assert.equal(metadata.status, 200);
  const [metadataRow] = await metadata.json() as Array<Record<string, unknown>>;
  assert.equal(metadataRow.malwareScanState, "clean");
  assert.equal(metadataRow.canReview, true);
  assert.equal(metadataRow.isLatest, true);
  assert.equal(metadataRow.canRequestCorrection, true);
  assert.ok(metadataRow.malwareScannedAt);
  assert.equal("malwareScanId" in metadataRow, false);

  const approved = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "Looks good." }),
  });
  assert.equal(approved.status, 200);
  const [upload] = await db.select().from(onbCandidateUploads).where(eq(onbCandidateUploads.id, uploadA));
  const [document] = await db.select().from(onbDocuments).where(eq(onbDocuments.id, documentA));
  assert.equal(upload.validationState, "passed");
  assert.equal(document.status, "verified");
  assert.equal(document.reminderNextAt, null);

  await db.update(onbCandidateUploads).set({ validationState: "manual_review" })
    .where(eq(onbCandidateUploads.id, uploadA));
  await db.update(onbDocuments).set({ status: "received" })
    .where(eq(onbDocuments.id, documentA));
  const correction = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "request_correction", reason: "Please upload a clearer copy." }),
  });
  assert.equal(correction.status, 200);
  const [correctedUpload] = await db.select().from(onbCandidateUploads).where(eq(onbCandidateUploads.id, uploadA));
  const [correctedDocument] = await db.select().from(onbDocuments).where(eq(onbDocuments.id, documentA));
  assert.equal(correctedUpload.validationState, "correction_requested");
  assert.equal(correctedDocument.status, "received");
  assert.equal(correctedDocument.note, "Please upload a clearer copy.");

  await db.update(onbCandidateUploads).set({
    validationState: "queued",
    malwareScanState: "infected",
    malwareScanSha256: null,
  }).where(eq(onbCandidateUploads.id, uploadA));
  const malwareCorrection = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "request_correction", reason: "Please submit a different file." }),
  });
  assert.equal(malwareCorrection.status, 200);

  const deniedMalwareStates = [
    "infected", "pending", "scanning", "unavailable", "timeout", "indeterminate",
  ] as const;
  for (const malwareScanState of deniedMalwareStates) {
    await db.update(onbCandidateUploads).set({
      validationState: "manual_review",
      malwareScanState,
      malwareScanSha256: null,
      checksumSha256: "a".repeat(64),
    }).where(eq(onbCandidateUploads.id, uploadA));
    await db.update(onbDocuments).set({ status: "received" }).where(eq(onbDocuments.id, documentA));
    const deniedMalware = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
      method: "POST", body: JSON.stringify({ decision: "approve", reason: `Blocked by ${malwareScanState}.` }),
    });
    assert.equal(deniedMalware.status, 409, `malware state ${malwareScanState} must block approval`);
  }

  await db.update(onbCandidateUploads).set({
    validationState: "manual_review",
    malwareScanState: "clean",
    checksumSha256: null,
    malwareScanSha256: null,
  }).where(eq(onbCandidateUploads.id, uploadA));
  await db.update(onbDocuments).set({ status: "received" }).where(eq(onbDocuments.id, documentA));
  const legacyDenied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "Legacy upload without a bound checksum." }),
  });
  assert.equal(legacyDenied.status, 409);

  const [newerUpload] = await db.insert(onbCandidateUploads).values({
    organizationId: orgA, caseId: caseA, documentId: documentA,
    objectPath: `test/${suffix}/id-proof-new.pdf`, originalName: "id-proof-new.pdf",
    contentType: "application/pdf", sizeBytes: 10, validationState: "manual_review",
    checksumSha256: "b".repeat(64), malwareScanState: "clean", malwareScanSha256: "b".repeat(64),
    malwareScannedAt: new Date(),
  }).returning({ id: onbCandidateUploads.id });
  const staleDenied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "approve", reason: "Stale upload must not be approved." }),
  });
  assert.equal(staleDenied.status, 409);
  const staleCorrectionDenied = await call(`/onboarding/cases/${caseA}/evidence/${uploadA}/decision`, orgA, {
    method: "POST", body: JSON.stringify({ decision: "request_correction", reason: "Obsolete upload must not alter the checklist." }),
  });
  assert.equal(staleCorrectionDenied.status, 409);

  await db.update(onbCandidateUploads).set({
    malwareScanState: "unavailable", malwareScanSha256: null, validationState: "manual_review",
  }).where(eq(onbCandidateUploads.id, newerUpload.id));
  const retryDenied = await call(`/onboarding/cases/${caseA}/evidence/${newerUpload.id}/retry-malware-scan`, orgA, {
    method: "POST", headers: { "x-test-role": "member" },
  });
  assert.equal(retryDenied.status, 403);
  const retryCrossTenant = await call(`/onboarding/cases/${caseA}/evidence/${newerUpload.id}/retry-malware-scan`, orgB, {
    method: "POST",
  });
  assert.equal(retryCrossTenant.status, 404);
  const retry = await call(`/onboarding/cases/${caseA}/evidence/${newerUpload.id}/retry-malware-scan`, orgA, {
    method: "POST",
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { malwareScanState: string }).malwareScanState, "pending");
});