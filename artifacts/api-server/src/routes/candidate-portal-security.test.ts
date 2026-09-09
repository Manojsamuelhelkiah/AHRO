import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { and, count, eq } from "drizzle-orm";
import {
  db,
  onbCandidateLinks,
  onbCandidateSessions,
  onbCases,
  onbConnectors,
  onbDocuments,
  onbEvents,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import candidateAdminRouter from "./candidate-admin";
import candidatePublicRouter from "./candidate-public";
import {
  CANDIDATE_COOKIE,
  MAX_CANDIDATE_FILE_BYTES,
  hashSecret,
} from "../lib/onboarding/candidate-portal";

const suffix = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const orgA = `candidate-security-a-${suffix}`;
const orgB = `candidate-security-b-${suffix}`;
const userId = `candidate-security-user-${suffix}`;
const tokens = {
  active: `active-${"a".repeat(40)}`,
  expired: `expired-${"b".repeat(40)}`,
  revoked: `revoked-${"c".repeat(40)}`,
};

let server: Server;
let baseUrl: string;
let caseA: number;
let caseA2: number;
let caseB: number;
let documentA: number;
let activeLinkId: number;

const caseValues = (organizationId: string, workerName: string) => ({
  organizationId,
  workerName,
  workerEmail: `${workerName.toLowerCase().replaceAll(" ", ".")}@example.com`,
  hireType: "external",
  workerCategory: "full-time",
  role: "Engineer",
  department: "Engineering",
  geography: "US",
  legalEntity: "Example",
  managerName: "Manager",
  recruiterName: "Recruiter",
  joiningDate: "2030-01-01",
});

async function createSession(
  secret: string,
  organizationId: string,
  targetCaseId: number,
  linkId = activeLinkId,
  expiresAt = new Date(Date.now() + 10 * 60_000),
) {
  await db.insert(onbCandidateSessions).values({
    idHash: hashSecret(secret),
    organizationId,
    caseId: targetCaseId,
    linkId,
    expiresAt,
  });
}

async function portal(secret: string) {
  return fetch(`${baseUrl}/candidate/portal`, {
    headers: { cookie: `${CANDIDATE_COOKIE}=${secret}` },
  });
}

function oversizedUpload(secret: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/candidate/documents/${documentA}/upload`);
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        cookie: `${CANDIDATE_COOKIE}=${secret}`,
        "x-file-name": "too-large.pdf",
        "x-file-type": "application/pdf",
        "content-length": String(MAX_CANDIDATE_FILE_BYTES + 1),
      },
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: orgA, name: "Candidate Security A", slug: orgA, joinCodeHash: `hash-${orgA}`, createdByUserId: userId },
    { id: orgB, name: "Candidate Security B", slug: orgB, joinCodeHash: `hash-${orgB}`, createdByUserId: userId },
  ]);
  await db.insert(organizationMembershipsTable).values([
    { organizationId: orgA, clerkUserId: userId, role: "owner" },
    { organizationId: orgB, clerkUserId: userId, role: "owner" },
  ]);
  [caseA, caseA2, caseB] = (await db.insert(onbCases).values([
    caseValues(orgA, "Candidate Alpha"),
    caseValues(orgA, "Candidate Alpha Two"),
    caseValues(orgB, "Candidate Beta"),
  ]).returning({ id: onbCases.id })).map((row) => row.id);
  [documentA] = (await db.insert(onbDocuments).values({
    organizationId: orgA,
    caseId: caseA,
    key: "id-proof",
    label: "ID proof",
    category: "identity",
  }).returning({ id: onbDocuments.id })).map((row) => row.id);
  [activeLinkId] = (await db.insert(onbCandidateLinks).values([
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(tokens.active), expiresAt: new Date(Date.now() + 60 * 60_000), issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(tokens.expired), expiresAt: new Date(Date.now() - 60_000), issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(tokens.revoked), expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: new Date(), issuedBy: userId },
  ]).returning({ id: onbCandidateLinks.id })).map((row) => row.id);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(candidatePublicRouter);
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    next();
  });
  app.use(candidateAdminRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgA));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgB));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgA));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgB));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgA));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgB));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB));
});

test("expired and revoked links cannot be exchanged", async () => {
  for (const token of [tokens.expired, tokens.revoked]) {
    const response = await fetch(`${baseUrl}/candidate/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(response.status, 401);
  }
});

test("sessions cannot cross organizations or cases", async () => {
  const crossOrg = `cross-org-${"d".repeat(40)}`;
  const crossCase = `cross-case-${"e".repeat(40)}`;
  await createSession(crossOrg, orgB, caseB);
  await createSession(crossCase, orgA, caseA2);
  assert.equal((await portal(crossOrg)).status, 401);
  assert.equal((await portal(crossCase)).status, 401);
});

test("expired sessions are rejected and revocation immediately ends active sessions", async () => {
  const expiredSession = `expired-session-${"f".repeat(40)}`;
  await createSession(expiredSession, orgA, caseA, activeLinkId, new Date(Date.now() - 1_000));
  assert.equal((await portal(expiredSession)).status, 401);

  const exchange = await fetch(`${baseUrl}/candidate/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokens.active }),
  });
  assert.equal(exchange.status, 204);
  const cookie = exchange.headers.get("set-cookie");
  assert.ok(cookie);
  const secret = /onb_candidate_session=([^;]+)/.exec(cookie)?.[1];
  assert.ok(secret);
  assert.equal((await portal(secret)).status, 200);

  const revoke = await fetch(`${baseUrl}/onboarding/cases/${caseA}/portal-links/${activeLinkId}`, {
    method: "DELETE",
    headers: { "x-organization-id": orgA },
  });
  assert.equal(revoke.status, 204);
  assert.equal((await portal(secret)).status, 401);
});

test("upload route enforces type and size boundaries before storage", async () => {
  const [link] = await db.insert(onbCandidateLinks).values({
    organizationId: orgA,
    caseId: caseA,
    tokenHash: hashSecret(`upload-${"g".repeat(40)}`),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    issuedBy: userId,
  }).returning({ id: onbCandidateLinks.id });
  const secret = `upload-session-${"h".repeat(40)}`;
  await createSession(secret, orgA, caseA, link.id);

  const unsupported = await fetch(`${baseUrl}/candidate/documents/${documentA}/upload`, {
    method: "POST",
    headers: {
      cookie: `${CANDIDATE_COOKIE}=${secret}`,
      "x-file-name": "malware.exe",
      "x-file-type": "application/octet-stream",
    },
    body: Buffer.from("MZ"),
  });
  assert.equal(unsupported.status, 415);

  const mismatched = await fetch(`${baseUrl}/candidate/documents/${documentA}/upload`, {
    method: "POST",
    headers: {
      cookie: `${CANDIDATE_COOKIE}=${secret}`,
      "x-file-name": "fake.pdf",
      "x-file-type": "application/pdf",
    },
    body: Buffer.from("not a pdf"),
  });
  assert.equal(mismatched.status, 415);
  assert.equal(await oversizedUpload(secret), 413);
});

test("issuing links with sendEmail omitted or false does not authorize or send email", async () => {
  const [{ count: eventsBefore }] = await db.select({ count: count() }).from(onbEvents)
    .where(and(eq(onbEvents.organizationId, orgA), eq(onbEvents.caseId, caseA2)));
  for (const body of [{ expiresInHours: 24 }, { expiresInHours: 24, sendEmail: false }]) {
    const response = await fetch(`${baseUrl}/onboarding/cases/${caseA2}/portal-links`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organization-id": orgA },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json() as { delivery: unknown }).delivery, null);
  }
  const [updatedCase] = await db.select({
    authorizedAt: onbCases.candidateEmailAuthorizedAt,
    authorizedBy: onbCases.candidateEmailAuthorizedBy,
  }).from(onbCases).where(and(eq(onbCases.organizationId, orgA), eq(onbCases.id, caseA2)));
  const [{ count: eventsAfter }] = await db.select({ count: count() }).from(onbEvents)
    .where(and(eq(onbEvents.organizationId, orgA), eq(onbEvents.caseId, caseA2)));
  assert.equal(updatedCase.authorizedAt, null);
  assert.equal(updatedCase.authorizedBy, null);
  assert.equal(eventsAfter, eventsBefore);
});