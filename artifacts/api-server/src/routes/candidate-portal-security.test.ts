import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import { after, before, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  db,
  onbCandidateLinks,
  onbCandidateExchangeFailures,
  onbCandidateSessions,
  onbCases,
  onbConnectors,
  onbDocuments,
  onbEvents,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import candidateAdminRouter from "./candidate-admin";
import candidatePublicRouter from "./candidate-public";
import {
  CANDIDATE_COOKIE,
  CANDIDATE_EXCHANGE_COOLDOWN_MS,
  CANDIDATE_EXCHANGE_FAILURE_LIMIT,
  CandidateExchangeLimiter,
  CANDIDATE_LINK_RETENTION_MS,
  MAX_CANDIDATE_FILE_BYTES,
  cleanupCandidateAccess,
  hashSecret,
} from "../lib/onboarding/candidate-portal";
import { CANDIDATE_LINK_RETENTION_DAYS_KEY, setSetting } from "../lib/onboarding/settings";

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
  app.set("trust proxy", 1);
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
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, [orgA, orgB]));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgA));
  await db.delete(onbCases).where(eq(onbCases.organizationId, orgB));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgA));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, orgB));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgA));
  await db.delete(organizationMembershipsTable).where(eq(organizationMembershipsTable.organizationId, orgB));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB));
  await db.delete(onbCandidateExchangeFailures);
});

test("expired and revoked links cannot be exchanged", async () => {
  for (const token of [tokens.expired, tokens.revoked]) {
    const response = await fetch(`${baseUrl}/onboarding/cases/${caseA2}/portal-links`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organization-id": orgA },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401);
  }
});

test("mixed invalid token formats share one privacy-safe client throttle", async () => {
  const clientAddress = `198.51.100.${Math.floor(Math.random() * 100) + 1}`;
  const otherClientAddress = "203.0.113.200";
  const invalidTokens = [
    "",
    "short",
    42,
    null,
    `unknown-${"x".repeat(40)}`,
  ];
  for (let index = 0; index < CANDIDATE_EXCHANGE_FAILURE_LIMIT; index += 1) {
    const response = await fetch(`${baseUrl}/onboarding/cases/${caseA2}/portal-links`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organization-id": orgA },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401);
  }

  const throttled = await fetch(`${baseUrl}/candidate/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.99, ${clientAddress}`,
    },
    body: JSON.stringify({ token: `another-${"y".repeat(40)}` }),
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "60");

  const independent = await fetch(`${baseUrl}/candidate/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.99, ${otherClientAddress}`,
    },
    body: JSON.stringify({ token: "short" }),
  });
  assert.equal(independent.status, 401);

  const key = hashSecret(clientAddress);

  const limiter = new CandidateExchangeLimiter();

  const limiter = new CandidateExchangeLimiter();
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
  const secret = `upload-session-${"h".repeat(40)}`;
  assert.ok(secret);
  assert.equal((await portal(secret)).status, 200);

  const revoke = await fetch(`${baseUrl}/onboarding/cases/${caseA}/portal-links/${activeLinkId}`, {
    method: "DELETE",
    headers: { "x-organization-id": orgA },
  });
  assert.equal(revoke.status, 204);
  assert.equal((await portal(secret)).status, 401);
});

test("candidate access cleanup is tenant-safe, idempotent, and preserves active and recently revoked links", async () => {
  const now = new Date();
  const old = new Date(now.getTime() - CANDIDATE_LINK_RETENTION_MS - 1);
  const recent = new Date(now.getTime() - CANDIDATE_LINK_RETENTION_MS + 1);
  const future = new Date(now.getTime() + 60_000);
  const links = await db.insert(onbCandidateLinks).values([
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`policy-a-expired-${suffix}`), expiresAt: expired45DaysAgo, issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`policy-a-active-${suffix}`), expiresAt: future, issuedBy: userId },
    { organizationId: orgB, caseId: caseB, tokenHash: hashSecret(`policy-b-expired-${suffix}`), expiresAt: expired45DaysAgo, issuedBy: userId },
  ]).returning({ id: onbCandidateLinks.id });
  const expiredSessionSecret = `cleanup-session-${suffix}`;
  await createSession(expiredSessionSecret, orgA, caseA, links[3].id, old);

  const cleanup = await cleanupCandidateAccess({ now });
  assert.ok(cleanup.retainedLinksDeleted >= 1);
  const survivors = await db.select({ id: onbCandidateLinks.id }).from(onbCandidateLinks)
    .where(inArray(onbCandidateLinks.id, links.map((link) => link.id)));
  assert.equal(survivors.length, 2);
  const [otherTenant] = await db.select({ id: onbCandidateLinks.id })
    .from(onbCandidateLinks)
    .where(eq(onbCandidateLinks.id, links[4].id));
  assert.equal(otherTenant.id, links[4].id);
});

test("candidate access cleanup honors each tenant retention policy without deleting active links", async () => {
  const now = new Date();
  await setSetting(orgA, CANDIDATE_LINK_RETENTION_DAYS_KEY, "30");
  await setSetting(orgB, CANDIDATE_LINK_RETENTION_DAYS_KEY, "180");
  const expired45DaysAgo = new Date(now.getTime() - 45 * 24 * 60 * 60_000);
  const future = new Date(now.getTime() + 60_000);
  const links = await db.insert(onbCandidateLinks).values([
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`policy-a-expired-${suffix}`), expiresAt: expired45DaysAgo, issuedBy: userId },
    { organizationId: orgA, caseId: caseA, tokenHash: hashSecret(`policy-a-active-${suffix}`), expiresAt: future, issuedBy: userId },
    { organizationId: orgB, caseId: caseB, tokenHash: hashSecret(`policy-b-expired-${suffix}`), expiresAt: expired45DaysAgo, issuedBy: userId },
  ]).returning({ id: onbCandidateLinks.id });

  const cleanup = await cleanupCandidateAccess({ now });
  assert.ok(cleanup.retainedLinksDeleted >= 1);
  const survivors = await db.select({ id: onbCandidateLinks.id }).from(onbCandidateLinks)
    .where(inArray(onbCandidateLinks.id, links.map((link) => link.id)));
  assert.deepEqual(
    new Set(survivors.map((link) => link.id)),
    new Set([links[1].id, links[2].id]),
  );
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

  const clientKey = hashSecret(`expired-window-${suffix}`);

  const firstInstance = new CandidateExchangeLimiter();

  const secondInstance = new CandidateExchangeLimiter();

  const [stored] = await db.select({
    failures: onbCandidateExchangeFailures.failures,
    expiresAt: onbCandidateExchangeFailures.expiresAt,
  }).from(onbCandidateExchangeFailures)
    .where(eq(onbCandidateExchangeFailures.clientKey, clientKey));
