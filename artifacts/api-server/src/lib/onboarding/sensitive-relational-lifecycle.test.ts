import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  db,
  onbAuditEntries,
  onbCandidateLinks,
  onbCandidateSessions,
  onbCases,
  onbCommunications,
  onbConnectors,
  onbSensitiveLifecycleDeletionJobs,
  onbSensitiveLifecycleHolds,
  onbSensitiveLifecyclePolicies,
  onbStandardIntakeEvents,
  onbStandardProviderConfigs,
  onbStandardProviderDecisions,
  onbStandardProviderSourceRecords,
  onbVoiceSessions,
  organizationsTable,
} from "@workspace/db";
import { cleanupCandidateAccess } from "./candidate-portal";
import { runSensitiveLifecycleDeletionWorker } from "./sensitive-lifecycle";

const organizationId = `sensitive-relational-${randomUUID()}`;
const old = new Date(Date.now() - 3 * 86_400_000);

async function makeCase(label: string) {
  const [row] = await db.insert(onbCases).values({
    organizationId,
    workerName: `Lifecycle ${label}`,
    workerEmail: `${label}@example.test`,
    hireType: "employee",
    workerCategory: "employee",
    role: "Engineer",
    department: "Engineering",
    geography: "GB",
    legalEntity: "Employer Ltd",
    managerName: "Manager",
    recruiterName: "Recruiter",
    joiningDate: "2030-01-01",
    workforceContext: { workCountry: "GB" },
  }).returning({ id: onbCases.id });
  assert.ok(row);
  return row.id;
}

async function currentPolicy(dataClass: "candidate-contact" | "candidate-voice" | "candidate-portal" | "bgv") {
  const [policy] = await db.insert(onbSensitiveLifecyclePolicies).values({
    organizationId,
    dataClass,
    jurisdiction: "GB",
    revision: 1,
    purpose: `Reviewed ${dataClass} lifecycle`,
    lawfulBasis: "Recorded approved basis",
    retentionDays: 0,
    providerSharingApproved: false,
    permittedProviders: [],
    policyReference: `policy-${dataClass}`,
    approvalReference: `approval-${dataClass}`,
    approvedByUserId: "test-privacy-reviewer",
    approvedAuthorityAssignmentId: 1,
  }).returning({ id: onbSensitiveLifecyclePolicies.id });
  assert.ok(policy);
  return policy.id;
}

async function job(input: {
  dataClass: "candidate-contact" | "candidate-voice" | "candidate-portal" | "bgv";
  caseId: number;
  recordKind: "communication" | "voice-session" | "candidate-link" | "candidate-session";
  recordId: string;
  policyId: number;
  policyRevision?: number;
  status?: "queued" | "processing";
}) {
  const [row] = await db.insert(onbSensitiveLifecycleDeletionJobs).values({
    organizationId,
    dataClass: input.dataClass,
    caseId: input.caseId,
    recordKind: input.recordKind,
    recordId: input.recordId,
    policyId: input.policyId,
    policyRevision: input.policyRevision ?? 1,
    status: input.status ?? "queued",
    claimOwner: input.status === "processing" ? "crashed-relational-worker" : null,
    claimUntil: input.status === "processing" ? new Date(Date.now() - 1_000) : null,
  }).returning({ id: onbSensitiveLifecycleDeletionJobs.id });
  assert.ok(row);
  return row.id;
}

async function worker() {
  await runSensitiveLifecycleDeletionWorker({ now: new Date(), limit: 100, organizationId });
}

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Sensitive relational lifecycle tests",
    slug: organizationId,
    joinCodeHash: `hash-${organizationId}`,
    createdByUserId: "test-creator",
  });
});

after(async () => {
  await db.delete(onbStandardProviderSourceRecords).where(eq(onbStandardProviderSourceRecords.organizationId, organizationId));
  await db.delete(onbStandardIntakeEvents).where(eq(onbStandardIntakeEvents.organizationId, organizationId));
  await db.delete(onbStandardProviderDecisions).where(eq(onbStandardProviderDecisions.organizationId, organizationId));
  await db.delete(onbStandardProviderConfigs).where(eq(onbStandardProviderConfigs.organizationId, organizationId));
  await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, organizationId));
  await db.delete(onbCandidateSessions).where(eq(onbCandidateSessions.organizationId, organizationId));
  await db.delete(onbCandidateLinks).where(eq(onbCandidateLinks.organizationId, organizationId));
  await db.delete(onbCommunications).where(eq(onbCommunications.organizationId, organizationId));
  await db.delete(onbVoiceSessions).where(eq(onbVoiceSessions.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.organizationId, organizationId));
  await db.delete(onbSensitiveLifecycleHolds).where(eq(onbSensitiveLifecycleHolds.organizationId, organizationId));
  await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
  await db.delete(onbCases).where(eq(onbCases.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});

test("recovered communication job redacts content while retaining ID and protected audit evidence", async () => {
  const policyId = await currentPolicy("candidate-contact");
  const caseId = await makeCase("communication");
  const [communication] = await db.insert(onbCommunications).values({
    organizationId, caseId, channel: "email", direction: "inbound", audience: "candidate",
    toAddress: "candidate@example.test", subject: "Private subject", body: "Private onboarding detail",
    status: "received", failureReason: "Private failure", externalMessageId: `mail-${randomUUID()}`, createdAt: old,
  }).returning({ id: onbCommunications.id });
  assert.ok(communication);
  const jobId = await job({
    dataClass: "candidate-contact", caseId, recordKind: "communication",
    recordId: String(communication.id), policyId, status: "processing",
  });

  await worker();

  const [redacted] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, communication.id));
  const [finished] = await db.select().from(onbSensitiveLifecycleDeletionJobs)
    .where(eq(onbSensitiveLifecycleDeletionJobs.id, jobId));
  const [audit] = await db.select().from(onbAuditEntries).where(and(
    eq(onbAuditEntries.organizationId, organizationId),
    eq(onbAuditEntries.objectType, "communication"),
    eq(onbAuditEntries.action, "privacy.sensitive-lifecycle.relational-record-minimized"),
  ));
  assert.equal(redacted?.id, communication.id);
  assert.equal(redacted?.caseId, caseId);
  assert.equal(redacted?.body, "[redacted by approved retention policy]");
  assert.equal(redacted?.toAddress, "[redacted]");
  assert.equal(redacted?.externalMessageId, null);
  assert.equal(finished?.status, "completed");
  assert.equal(audit?.action, "privacy.sensitive-lifecycle.relational-record-minimized");
});

test("in-flight voice remains intact while a terminal voice session is redacted", async () => {
  const policyId = await currentPolicy("candidate-voice");
  const caseId = await makeCase("voice");
  const terminalToken = `terminal-${randomUUID()}`;
  const liveToken = `live-${randomUUID()}`;
  await db.insert(onbVoiceSessions).values([
    {
      organizationId, caseId, token: terminalToken, scenario: "day-before", reason: "private reason",
      turns: [{ role: "hire", text: "private voice content" }], decisions: [{ decision: "x", note: "private" }],
      lastSpeech: "private speech", lastResponse: { say: "private response", done: false },
      providerFailureReason: "private failure", finalized: true, startedAt: old,
    },
    {
      organizationId, caseId, token: liveToken, scenario: "day-before", reason: "must remain",
      turns: [{ role: "hire", text: "must remain" }], finalized: false, startedAt: old,
    },
  ]);
  const terminalJob = await job({
    dataClass: "candidate-voice", caseId, recordKind: "voice-session", recordId: terminalToken, policyId,
  });
  const liveJob = await job({
    dataClass: "candidate-voice", caseId, recordKind: "voice-session", recordId: liveToken, policyId,
  });

  await worker();

  const [terminal] = await db.select().from(onbVoiceSessions).where(and(
    eq(onbVoiceSessions.organizationId, organizationId), eq(onbVoiceSessions.token, terminalToken),
  ));
  const [live] = await db.select().from(onbVoiceSessions).where(and(
    eq(onbVoiceSessions.organizationId, organizationId), eq(onbVoiceSessions.token, liveToken),
  ));
  const [terminalState] = await db.select().from(onbSensitiveLifecycleDeletionJobs)
    .where(eq(onbSensitiveLifecycleDeletionJobs.id, terminalJob));
  const [liveState] = await db.select().from(onbSensitiveLifecycleDeletionJobs)
    .where(eq(onbSensitiveLifecycleDeletionJobs.id, liveJob));
  assert.equal(terminal?.token, terminalToken);
  assert.equal(terminal?.reason, null);
  assert.deepEqual(terminal?.turns, []);
  assert.equal(terminal?.lastSpeech, null);
  assert.equal(terminalState?.status, "completed");
  assert.equal(live?.reason, "must remain");
  assert.deepEqual(live?.turns, [{ role: "hire", text: "must remain" }]);
  assert.equal(liveState?.status, "blocked");
  assert.match(liveState?.lastError ?? "", /in-flight/i);
});

test("case/class hold blocks relational redaction", async () => {
  const [policy] = await db.select({ id: onbSensitiveLifecyclePolicies.id }).from(onbSensitiveLifecyclePolicies)
    .where(and(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId), eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-contact")));
  assert.ok(policy);
  const caseId = await makeCase("held-contact");
  const [communication] = await db.insert(onbCommunications).values({
    organizationId, caseId, channel: "email", direction: "inbound", toAddress: "held@example.test",
    subject: "held", body: "must remain under hold", status: "received", createdAt: old,
  }).returning({ id: onbCommunications.id });
  const jobId = await job({
    dataClass: "candidate-contact", caseId, recordKind: "communication", recordId: String(communication!.id), policyId: policy.id,
  });
  await db.insert(onbSensitiveLifecycleHolds).values({
    organizationId, dataClass: "candidate-contact", caseId, reason: "Litigation hold",
    reference: "RELATIONAL-HOLD-1", setByUserId: "privacy-reviewer", setAuthorityAssignmentId: 1,
  });

  await worker();

  const [unchanged] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, communication!.id));
  const [state] = await db.select().from(onbSensitiveLifecycleDeletionJobs)
    .where(eq(onbSensitiveLifecycleDeletionJobs.id, jobId));
  assert.equal(unchanged?.body, "must remain under hold");
  assert.equal(state?.status, "blocked");
  assert.match(state?.lastError ?? "", /hold/i);
});

test("a stale policy revision blocks a queued relational job", async () => {
  const policyId = await currentPolicy("candidate-portal");
  const caseId = await makeCase("stale-policy");
  const [link] = await db.insert(onbCandidateLinks).values({
    organizationId, caseId, tokenHash: `hash-${randomUUID()}`, issuedBy: "test",
    expiresAt: new Date(Date.now() + 2 * 86_400_000), createdAt: new Date(Date.now() + 86_400_000),
  }).returning({ id: onbCandidateLinks.id });
  const jobId = await job({
    dataClass: "candidate-portal", caseId, recordKind: "candidate-link", recordId: String(link!.id), policyId,
  });
  await db.update(onbSensitiveLifecyclePolicies).set({ revision: 2 }).where(eq(onbSensitiveLifecyclePolicies.id, policyId));

  await worker();

  const [preserved] = await db.select().from(onbCandidateLinks).where(eq(onbCandidateLinks.id, link!.id));
  const [state] = await db.select().from(onbSensitiveLifecycleDeletionJobs)
    .where(eq(onbSensitiveLifecycleDeletionJobs.id, jobId));
  assert.equal(preserved?.id, link?.id);
  assert.equal(state?.status, "blocked");
  assert.match(state?.lastError ?? "", /revision/i);
});

test("legacy portal cleanup respects a sensitive lifecycle hold and resumes after release", async () => {
  const caseId = await makeCase("portal-hold");
  const ancient = new Date(Date.now() - 100 * 86_400_000);
  const [link] = await db.insert(onbCandidateLinks).values({
    organizationId, caseId, tokenHash: `portal-${randomUUID()}`, issuedBy: "test", expiresAt: ancient, createdAt: ancient,
  }).returning({ id: onbCandidateLinks.id });
  await db.insert(onbCandidateSessions).values({
    organizationId, caseId, linkId: link!.id, idHash: `session-${randomUUID()}`, expiresAt: ancient, createdAt: ancient,
  });
  const [hold] = await db.insert(onbSensitiveLifecycleHolds).values({
    organizationId, dataClass: "candidate-portal", caseId, reason: "Portal preservation",
    reference: "PORTAL-HOLD-1", setByUserId: "privacy-reviewer", setAuthorityAssignmentId: 1,
  }).returning({ id: onbSensitiveLifecycleHolds.id });

  assert.deepEqual(await cleanupCandidateAccess({ organizationId, now: new Date() }), {
    expiredSessions: 0, retainedLinksDeleted: 0,
  });
  assert.equal((await db.select().from(onbCandidateLinks).where(eq(onbCandidateLinks.id, link!.id))).length, 1);

  await db.update(onbSensitiveLifecycleHolds).set({ active: false }).where(eq(onbSensitiveLifecycleHolds.id, hold!.id));
  const cleaned = await cleanupCandidateAccess({ organizationId, now: new Date() });
  assert.equal(cleaned.expiredSessions, 1);
  assert.equal(cleaned.retainedLinksDeleted, 1);
  assert.equal((await db.select().from(onbCandidateLinks).where(eq(onbCandidateLinks.id, link!.id))).length, 0);
});

test("BGV-class hold protects BGV email instead of treating it as generic contact", async () => {
  const policyId = await currentPolicy("bgv");
  const caseId = await makeCase("bgv-held");
  const [notice] = await db.insert(onbCommunications).values({
    organizationId, caseId, channel: "email", direction: "outbound", audience: "admin",
    toAddress: "reviewer@example.test", subject: "BGV notice", body: "screening detail",
    status: "sent", sensitive: true, sensitiveDataClass: "bgv", createdAt: old,
  }).returning({ id: onbCommunications.id });
  const jobId = await job({ dataClass: "bgv", caseId, recordKind: "communication", recordId: String(notice!.id), policyId });
  await db.insert(onbSensitiveLifecycleHolds).values({
    organizationId, dataClass: "bgv", caseId, reason: "BGV evidence hold", reference: "BGV-HOLD",
    setByUserId: "privacy-reviewer", setAuthorityAssignmentId: 1,
  });
  await worker();
  const [state] = await db.select().from(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.id, jobId));
  const [preserved] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, notice!.id));
  assert.equal(state?.status, "blocked");
  assert.equal(preserved?.body, "screening detail");
});

test("current workforce jurisdiction is rechecked before relational redaction", async () => {
  const [policy] = await db.select({ id: onbSensitiveLifecyclePolicies.id }).from(onbSensitiveLifecyclePolicies)
    .where(and(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId), eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-contact")));
  const caseId = await makeCase("jurisdiction-corrected");
  const [message] = await db.insert(onbCommunications).values({
    organizationId, caseId, channel: "email", direction: "inbound", toAddress: "person@example.test",
    subject: "jurisdiction", body: "must remain", status: "received", createdAt: old,
  }).returning({ id: onbCommunications.id });
  const jobId = await job({ dataClass: "candidate-contact", caseId, recordKind: "communication", recordId: String(message!.id), policyId: policy!.id });
  await db.update(onbCases).set({ workforceContext: { workCountry: "US" } }).where(eq(onbCases.id, caseId));
  await worker();
  const [state] = await db.select().from(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.id, jobId));
  assert.equal(state?.status, "blocked");
  assert.match(state?.lastError ?? "", /jurisdiction/i);
});

test("eligible portal records beyond leading wrong-jurisdiction rows are not starved", async () => {
  const [policy] = await db.select({ id: onbSensitiveLifecyclePolicies.id }).from(onbSensitiveLifecyclePolicies)
    .where(and(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId), eq(onbSensitiveLifecyclePolicies.dataClass, "candidate-portal")));
  assert.ok(policy);
  for (let n = 0; n < 6; n++) {
    const caseId = await makeCase(`portal-wrong-jurisdiction-${n}`);
    await db.update(onbCases).set({ workforceContext: { workCountry: "US" } }).where(eq(onbCases.id, caseId));
    await db.insert(onbCandidateLinks).values({
      organizationId, caseId, tokenHash: `wrong-jurisdiction-${n}-${randomUUID()}`, issuedBy: "test",
      expiresAt: old, createdAt: new Date(old.getTime() - 1_000),
    });
  }
  const caseId = await makeCase("portal-eligible-after-wrong-jurisdiction");
  const [eligible] = await db.insert(onbCandidateLinks).values({
    organizationId, caseId, tokenHash: `eligible-after-wrong-${randomUUID()}`, issuedBy: "test",
    expiresAt: old, createdAt: old,
  }).returning({ id: onbCandidateLinks.id });
  await runSensitiveLifecycleDeletionWorker({ now: new Date(), limit: 1, organizationId });
  assert.equal((await db.select().from(onbCandidateLinks).where(eq(onbCandidateLinks.id, eligible!.id))).length, 0);
});

test("legacy BGV backfill conservatively unclassifies a NULL key but retains server BGV namespace", async () => {
  const caseId = await makeCase("legacy-bgv-backfill");
  const [ambiguous, authoritative] = await db.insert(onbCommunications).values([
    {
      organizationId, caseId, channel: "email", direction: "inbound", toAddress: "candidate@example.test",
      body: "legacy sensitive inbound", status: "received", sensitive: true, sensitiveDataClass: "bgv",
      idempotencyKey: null,
    },
    {
      organizationId, caseId, channel: "email", direction: "outbound", audience: "admin", toAddress: "bgv@example.test",
      body: "BGV notice", status: "sent", sensitive: true, sensitiveDataClass: "bgv",
      idempotencyKey: `bgv:${caseId}:cycle:hr:purpose`,
    },
  ]).returning({ id: onbCommunications.id });
  await db.update(onbCommunications).set({ sensitiveDataClass: "unclassified-legacy" }).where(and(
    eq(onbCommunications.organizationId, organizationId),
    eq(onbCommunications.sensitiveDataClass, "bgv"),
    or(isNull(onbCommunications.idempotencyKey), sql`${onbCommunications.idempotencyKey} !~ '^bgv:'`),
  ));
  const rows = await db.select().from(onbCommunications).where(and(
    eq(onbCommunications.organizationId, organizationId),
    sql`${onbCommunications.id} in (${ambiguous!.id}, ${authoritative!.id})`,
  ));
  assert.equal(rows.find((row) => row.id === ambiguous!.id)?.sensitiveDataClass, "unclassified-legacy");
  assert.equal(rows.find((row) => row.id === authoritative!.id)?.sensitiveDataClass, "bgv");
});