import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, organizationsTable, organizationMembershipsTable, accessNamedGrants, onbAuthorityAssignments,
  onbAuthorityGovernance, hroMailboxIngress, hroEmailRequests, hroEmailSources, hroEmailScan,
  onbCases, onbEvents, onbSensitiveLifecyclePolicies, onbSensitiveLifecycleHolds, offbCases, offbSources, offbCheckpoints, onbConnectors, onbSettings, onbReadinessSlaPolicies,
  type OnbAuthorityRole, type OnbAuthorityScope } from "@workspace/db";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { classifyEmail, HRO_EMAIL_TEMPLATES, emailExample, validateEmailReview } from "./hro-email-registry";
import { boundedEmailContent, intakeMessageReserved, receiveIntakeMessage, resolveEmailRoute, runHroEmailIntakeScan, type EmailProvider } from "./hro-email-ingestion";
import { configureEmailIntake, reviewEmailRequest, convertEmailRequest, getEmailRequest, listEmailRequests, updateEmailRoute } from "./hro-email-service";
import { readEmailPrivateBody } from "./hro-email-private-source";
import { getEmailRotation, stageEmailRotation, readmitEmailRequests } from "./hro-email-rotation";
import type { GmailMessage } from "./onboarding/inbound-email";
const mailbox = `provider-denied-${randomUUID()}@example.invalid`;
const provider: EmailProvider = { get: async path => {
  assert.equal(path, "/gmail/v1/users/me/profile", "No real provider reads or mutations are permitted in fixture tests.");
  return { ok: true, json: async () => ({ emailAddress: mailbox }) };
}};
const mem = new Map<string, Buffer>();
const sourceDeps = { storage: {
  save: async (p: string, b: Buffer) => { mem.set(p, Buffer.from(b)); },
  read: async (p: string) => Buffer.from(mem.get(p)!),
  delete: async (p: string) => { mem.delete(p); },
}, scan: async () => "clean" };
const message = (id: string, subject: string, body: string, extra = {}): GmailMessage => ({
  id, internalDate: String(Date.now()), payload: { mimeType: "text/plain",
    headers: [{ name: "From", value: "shared-sender@example.invalid" }, { name: "Subject", value: subject }, { name: "To", value: mailbox }],
    body: { data: Buffer.from(body).toString("base64url") },
  }, ...extra,
} as GmailMessage);
test("all 12 families, every registered template and onboarding variant have valid review examples", () => {
  assert.equal(new Set(HRO_EMAIL_TEMPLATES.map(t => t.family)).size, 12);
  assert.ok(["external-fte", "contractor", "rehire", "campus-cohort", "expedited"].every(h => HRO_EMAIL_TEMPLATES.some(t => t.hireType === h)));
  assert.ok(HRO_EMAIL_TEMPLATES.some(t => t.id === "employee-changes-internal-transfer"));
  for (const t of HRO_EMAIL_TEMPLATES) {
    const c = classifyEmail("", emailExample(t));
    assert.equal(c.templateId, t.id);
    assert.equal(c.blockedReason, null, t.id);
    const validation = validateEmailReview(t.id, c.fields);
    assert.equal(validation.valid, true, `${t.id}: ${JSON.stringify(validation.issues)}`);
  }
  assert.equal(classifyEmail("Hello", "I have an HR question").templateId, null);
  assert.equal(classifyEmail("Payroll and leave request", "").templateId, null);
  assert.equal(classifyEmail("Leave request", "Employee name is Example Worker\nEmployee id is UNVERIFIED-1\nWork country is US\nEffective date is 2030-01-15").fields.employee_id, "UNVERIFIED-1");
  assert.throws(() => validateEmailReview("payroll-bank-change", { bank_account: "123456789" }));
  assert.ok(classifyEmail("Bank account change", "Bank account: 123456789012").blockedReason);
  assert.ok(classifyEmail("", "template_id: leave-request\nwork_country: US\nwork_country: GB").blockedReason);
});
test("MIME is bounded, remote links are inert and operational mail ownership is excluded", () => {
  const huge = message("huge", "New hire", "A".repeat(40_000));
  assert.equal(boundedEmailContent(huge).blocked, true);
  assert.equal(boundedEmailContent(message("html", "", "", { payload: { mimeType: "text/html", body: { data: Buffer.from('<script>attack()</script><p>Safe</p><img src=\"https://bad.invalid/a\">').toString("base64url") } } })).body.includes("attack"), false);
  for (const ref of ["[CR:case:token]", "[AP:approval:token]", "[SIM-REPLY:ref]", "[SYS-REPLY:ref]"]) {
    assert.equal(intakeMessageReserved(message("reserved", ref, ""), ""), true, ref);
  }
  assert.equal(intakeMessageReserved(message("sent", "New hire", "", { labelIds: ["SENT"] }), ""), true);
});
test("tenant isolation, full conversion matrix, private source retention, stale edits and concurrent exactly-once conversion", { timeout: 180_000 }, async () => {
  const org = `email-intake-${randomUUID()}`, other = `${org}-other`, actor = `${org}:reviewer`;
  const roles: Array<[OnbAuthorityRole, OnbAuthorityScope]> = [["hr-compliance", "hr-compliance-approve"], ["legal", "legal-approve"], ["payroll", "payroll-approve"], ["occupational-health", "occupational-health-approve"]];
  const setup = async (id: string) => {
    await db.insert(organizationsTable).values({ id, name: "Denied provider email fixture", slug: id, joinCodeHash: `${id}:unused`, createdByUserId: actor });
    await seedApprovedSensitiveLifecyclePolicies(id);
    await db.insert(organizationMembershipsTable).values({ organizationId: id, clerkUserId: actor, role: "member" });
    await db.insert(onbAuthorityGovernance).values({ organizationId: id, status: "governance-approved", revision: 1, approvedByUserId: "fixture-independent", approvedAt: new Date(), governanceSource: "provider-denied-regression-only" });
    for (const key of ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", "data.case.notes.read", "data.case.notes.edit", "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"])
      await db.insert(accessNamedGrants).values({ organizationId: id, principalType: "human", principalId: actor, scope: "tenant", resourceType: key.startsWith("flow.") ? "flow" : "field", resourceKey: key, source: "named", effect: "allow", status: "active", createdByUserId: "fixture-independent", approvedByUserId: "fixture-independent", approvedAt: new Date() });
    for (const [role, scope] of roles) await db.insert(onbAuthorityAssignments).values({ id: `${id}:${role}`, organizationId: id, personUserId: actor, authorityRole: role, scopes: [scope], validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() + 3600_000), grantorUserId: "fixture-independent", source: "provider-denied-regression-only", governanceDecisionRef: "fixture-independent" });
  };
  const requestFor = async (providerId: string) => (await db.select().from(hroEmailRequests).where(eq(hroEmailRequests.providerMessageId, providerId)))[0];
  try {
    await setup(org); await setup(other);
    const a = await configureEmailIntake(org, actor, { reference: "fixture-reviewed-primary-mailbox", backfillHours: 1 }, provider);
    const b = await configureEmailIntake(other, actor, { reference: "fixture-reviewed-second-client", backfillHours: 1 }, provider);
    const routes = await db.select().from(hroMailboxIngress).where(inArray(hroMailboxIngress.id, [a.id, b.id]));
    assert.equal(resolveEmailRoute(a.subjectMarker, mailbox, new Date(), routes)?.organizationId, org);
    assert.equal(resolveEmailRoute(`${a.subjectMarker} ${b.subjectMarker}`, mailbox, new Date(), routes), null);
    assert.equal(resolveEmailRoute("Client name in body is not a route", mailbox, new Date(), routes), null);
    for (const tpl of HRO_EMAIL_TEMPLATES) {
      const providerId = `${org}:${tpl.id}`, msg = message(providerId, `${a.subjectMarker} ${tpl.name}`, emailExample(tpl));
      await Promise.all([receiveIntakeMessage(mailbox, msg, [], provider, sourceDeps), receiveIntakeMessage(mailbox, msg, [], provider, sourceDeps)]);
      const initial = await requestFor(providerId);
      assert.equal(initial.organizationId, org);
      assert.equal((await db.select().from(hroEmailRequests).where(eq(hroEmailRequests.providerMessageId, providerId))).length, 1);
      assert.equal(initial.status, "needs-review", `${tpl.id}: ${initial.reason}`);
      assert.ok(mem.size > 0, "Source content stored only in injected private memory, never real App Storage");
      await assert.rejects(getEmailRequest(other, actor, initial.id), /not found/);
      await assert.rejects(convertEmailRequest(org, actor, initial.id, { expectedVersion: initial.version }, provider), /reviewed/);
      const reviewed = await reviewEmailRequest(org, actor, initial.id, { expectedVersion: initial.version, action: "save", templateId: tpl.id, fields: initial.fields });
      await assert.rejects(reviewEmailRequest(org, actor, initial.id, { expectedVersion: initial.version, action: "reject" }), /changed/);
      const conversions = await Promise.all(Array.from({ length: 3 }, () => convertEmailRequest(org, actor, initial.id, { expectedVersion: reviewed.version }, provider)));
      assert.ok(conversions.every(r => r.caseId === conversions[0].caseId));
      const [created] = await db.select().from(onbCases).where(eq(onbCases.id, conversions[0].caseId!));
      assert.equal(created.offerAcceptanceComplete, false);
      assert.equal(created.orchestrationCheckpoint, null);
      assert.equal(created.candidateEmailAuthorizedAt, null);
      if (!tpl.hireType && tpl.id !== "offboarding-separation") {
        assert.equal(created.hireType, "service-request");
        assert.equal(created.joiningDate, "");
        assert.equal(created.orchestrationStatus, "hro-request-pending-review");
      }
    }
    const ambiguous = message(`${org}:unbound`, `${a.subjectMarker} ${b.subjectMarker}`, "Worker name: CONFIDENTIAL");
    await receiveIntakeMessage(mailbox, ambiguous, [], provider, sourceDeps);
    const unbound = await requestFor(ambiguous.id);
    assert.equal(unbound.organizationId, null); assert.deepEqual(unbound.fields, {});
    assert.ok(!(await listEmailRequests(org, actor)).some(r => r.id === unbound.id));
    const unmarked = message(`${org}:spoof`, "Payroll change for client " + org, "Worker email: shared-sender@example.invalid");
    await receiveIntakeMessage(mailbox, unmarked, [], provider, sourceDeps);
    assert.equal((await requestFor(unmarked.id)).organizationId, null);
    const otherMsg = message(`${org}:second-client`, b.subjectMarker, emailExample(HRO_EMAIL_TEMPLATES[0]));
    await receiveIntakeMessage(mailbox, otherMsg, [], provider, sourceDeps);
    assert.equal((await requestFor(otherMsg.id)).organizationId, other, "Same sender never determines client");
    const retryMail = message(`${org}:retry`, a.subjectMarker, emailExample(HRO_EMAIL_TEMPLATES.find(t => t.id === "leave-request")!));
    await receiveIntakeMessage(mailbox, retryMail, [], provider, sourceDeps);
    const pending = await requestFor(retryMail.id);
    const edited = await reviewEmailRequest(org, actor, pending.id, { expectedVersion: pending.version, action: "save", templateId: pending.templateId, fields: pending.fields });
    assert.ok(edited.potentialDuplicates > 0, "Independent repeated requests are flagged, not merged");
    await assert.rejects(convertEmailRequest(org, actor, pending.id, { expectedVersion: edited.version }, provider), /duplicate/);
    const paused = await updateEmailRoute(org, actor, a.id, { expectedVersion: a.version, enabled: false });
    await assert.rejects(convertEmailRequest(org, actor, pending.id, { expectedVersion: edited.version, duplicateAcknowledged: true }, provider), /paused/);
    await updateEmailRoute(org, actor, a.id, { expectedVersion: paused.version, enabled: true }, provider);
    await assert.rejects(convertEmailRequest(org, actor, pending.id, { expectedVersion: edited.version, duplicateAcknowledged: true }, provider), /changed/);
    const refreshed = await reviewEmailRequest(org, actor, pending.id, { expectedVersion: edited.version, action: "save", templateId: pending.templateId, fields: pending.fields });
    const repeated = await convertEmailRequest(org, actor, pending.id, { expectedVersion: refreshed.version, duplicateAcknowledged: true }, provider);
    assert.notEqual(repeated.caseId, (await db.select().from(hroEmailRequests).where(and(eq(hroEmailRequests.organizationId, org), eq(hroEmailRequests.templateId, "leave-request")))).find(r => r.id !== pending.id)?.caseId);
    const pageMessages = [message(`${org}:page1`, a.subjectMarker, emailExample(HRO_EMAIL_TEMPLATES[0])), message(`${org}:page2`, b.subjectMarker, emailExample(HRO_EMAIL_TEMPLATES[0]))];
    let queries = 0, failSecond = true;
    const paged: EmailProvider = { get: async path => {
      if (path.endsWith("/profile")) return provider.get(path);
      if (path.includes("/messages?")) {
        queries++;
        const second = path.includes("pageToken=continuation");
        return { ok: true, json: async () => ({ messages: [{ id: pageMessages[second ? 1 : 0].id }], ...(second ? {} : { nextPageToken: "continuation" }) }) };
      }
      const msg = pageMessages.find(m => path.includes(encodeURIComponent(m.id)));
      assert.ok(msg, "Stub never fetches real provider data");
      if (msg.id === pageMessages[1].id && failSecond) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => msg };
    }};
    await Promise.all([runHroEmailIntakeScan(paged, sourceDeps), runHroEmailIntakeScan(paged, sourceDeps)]);
    assert.equal(queries, 1, "Concurrent scan claims are fenced across database connections");
    assert.equal((await db.select().from(hroEmailScan).where(eq(hroEmailScan.mailboxAddress, mailbox)))[0].pageToken, "continuation");
    await assert.rejects(runHroEmailIntakeScan(paged, sourceDeps), /failed/);
    assert.equal((await db.select().from(hroEmailScan).where(eq(hroEmailScan.mailboxAddress, mailbox)))[0].pageToken, "continuation", "Crash/failure cannot advance a saved page");
    failSecond = false;
    await runHroEmailIntakeScan(paged, sourceDeps);
    assert.ok(await requestFor(pageMessages[0].id)); assert.ok(await requestFor(pageMessages[1].id));
    assert.equal((await db.select().from(hroEmailScan).where(eq(hroEmailScan.mailboxAddress, mailbox)))[0].pageToken, null);
    const sensitive = message(`${org}:sensitive`, a.subjectMarker, "template: leave-request\nwork_country: US\nbank_account: 1234567890123456");
    await receiveIntakeMessage(mailbox, sensitive, [], provider, sourceDeps);
    const sensitiveRow = await requestFor(sensitive.id);
    assert.equal(sensitiveRow.status, "blocked");
    assert.deepEqual(sensitiveRow.fields, { work_country: "US" }, "Only the explicit collection jurisdiction survives; sensitive values never enter typed intake fields");
    const attached = message(`${org}:attachment`, a.subjectMarker, emailExample(HRO_EMAIL_TEMPLATES.find(t => t.id === "leave-request")!));
    attached.payload = { mimeType: "multipart/mixed", headers: attached.payload!.headers, parts: [
      { mimeType: "text/plain", body: attached.payload!.body },
      { filename: "private-bank-medical-document.txt", mimeType: "application/octet-stream", body: { data: Buffer.from("opaque-private-source").toString("base64url"), size: 21 } },
    ] };
    await receiveIntakeMessage(mailbox, attached, [], provider, { ...sourceDeps, scan: async () => "unavailable" });
    const attachmentRow = await requestFor(attached.id);
    assert.equal(attachmentRow.attachments.length, 1);
    assert.ok(!JSON.stringify(await getEmailRequest(org, actor, attachmentRow.id)).includes("private-bank-medical"));
    assert.deepEqual(await readEmailPrivateBody(org, actor, attachmentRow.id), { state: "unavailable", subject: null, body: null });
    await assert.rejects(readEmailPrivateBody(other, actor, attachmentRow.id), /not found/);
    const operational = message(`${org}:ambiguous-ownership`, a.subjectMarker, "[CR:malformed] This is not a safely attributable new request");
    await receiveIntakeMessage(mailbox, operational, [], provider, sourceDeps);
    assert.equal((await requestFor(operational.id)).organizationId, null, "Uncertain ownership is platform-only quarantine, never an arbitrary client case");

    // Rotation never relies on shared sender identity and cannot reopen the old marker.
    const independent = `${org}:independent-routing-reviewer`;
    await db.insert(organizationMembershipsTable).values({ organizationId: org, clerkUserId: independent, role: "member" });
    for (const key of ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", "data.case.notes.edit", "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"])
      await db.insert(accessNamedGrants).values({ organizationId: org, principalType: "human", principalId: independent, scope: "tenant", resourceType: key.startsWith("flow.") ? "flow" : "field", resourceKey: key, source: "named", effect: "allow", status: "active", createdByUserId: "fixture-independent", approvedByUserId: "fixture-independent", approvedAt: new Date() });
    for (const [role, scope] of roles) await db.insert(onbAuthorityAssignments).values({ id: `${org}:independent:${role}`, organizationId: org, personUserId: independent, authorityRole: role, scopes: [scope], validFrom: new Date(Date.now() - 60_000), validUntil: new Date(Date.now() + 3600_000), grantorUserId: "fixture-independent", source: "provider-denied-regression-only", governanceDecisionRef: "fixture-independent" });
    const priorRoute = (await db.select().from(hroMailboxIngress).where(eq(hroMailboxIngress.id, a.id)))[0];
    const [retentionHold] = await db.insert(onbSensitiveLifecycleHolds).values({
      organizationId: org, dataClass: "identity", reason: "Fixture conservative pre-case retention hold", reference: "fixture-retention-hold",
      setByUserId: actor, setAuthorityAssignmentId: -1,
    }).returning();
    const beforeSources = await db.select().from(hroEmailSources).where(eq(hroEmailSources.requestId, attachmentRow.id));
    const preview = await getEmailRotation(org, actor, a.id);
    assert.ok(preview.requests.some(r => r.id === attachmentRow.id));
    assert.ok(preview.requests.some(r => r.id === sensitiveRow.id));
    assert.ok(!preview.requests.some(r => r.id === pending.id || r.id === unbound.id));
    for (const row of preview.requests) assert.deepEqual(Object.keys(row).sort(), ["id", "receivedAt", "status", "version"]);
    assert.ok(!JSON.stringify(preview).includes("opaque-private-source"));
    await assert.rejects(getEmailRotation(other, actor, a.id), /not found/);
    const rotationInput = { expectedVersion: priorRoute.revision, reference: "fixture-permanent-retirement", retirementAcknowledged: true };
    const changedMailbox: EmailProvider = { get: async () => ({ ok: true, json: async () => ({ emailAddress: "different@example.invalid" }) }) };
    await assert.rejects(stageEmailRotation(org, actor, a.id, rotationInput, changedMailbox), /same verified/);
    await assert.rejects(stageEmailRotation(org, actor, a.id, { ...rotationInput, retirementAcknowledged: false }, provider), /Acknowledge/);
    const staged = await stageEmailRotation(org, actor, a.id, rotationInput, provider);
    assert.ok(staged.route.retiredAt); assert.equal(staged.route.enabled, false);
    assert.ok(staged.replacement); assert.equal(staged.replacement.enabled, false); assert.equal(staged.replacement.reviewRequired, true);
    assert.notEqual(staged.replacement.subjectMarker, a.subjectMarker);
    await assert.rejects(stageEmailRotation(org, actor, a.id, rotationInput, provider), /version changed/);
    await assert.rejects(updateEmailRoute(org, actor, a.id, { expectedVersion: staged.route.version, enabled: true }, provider), /permanently retired/);
    await assert.rejects(configureEmailIntake(org, actor, { routeId: a.id, expectedVersion: staged.route.version, reference: "try-reopen", backfillHours: 0 }, provider), /permanently retired/);
    const replacementInput = { routeId: staged.replacement.id, expectedVersion: staged.replacement.version, reference: "fixture-independent-replacement", backfillHours: 0 };
    await assert.rejects(updateEmailRoute(org, actor, staged.replacement.id, { expectedVersion: staged.replacement.version, enabled: true }, provider), /Independently review/);
    await assert.rejects(configureEmailIntake(org, actor, replacementInput, provider), /different verified reviewer/);
    await assert.rejects(configureEmailIntake(org, independent, replacementInput, changedMailbox), /same verified/);
    await assert.rejects(configureEmailIntake(org, independent, { ...replacementInput, backfillHours: 1 }, provider), /future mail only/);
    const select = (row: typeof attachmentRow) => ({ id: row.id, expectedVersion: row.version });
    const reAdmissionInput = { expectedVersion: staged.route.version, expectedReplacementVersion: staged.replacement.version,
      reference: "fixture-explicit-held-request-review", requests: [select(attachmentRow), select(sensitiveRow)] };
    await assert.rejects(readmitEmailRequests(org, actor, a.id, reAdmissionInput, provider), /current independent review/);
    const approved = await configureEmailIntake(org, independent, replacementInput, provider);
    await assert.rejects(stageEmailRotation(org, actor, approved.id, {
      expectedVersion: approved.version, reference: "fixture-do-not-strand-earlier-held-requests", retirementAcknowledged: true,
    }, provider), /recovery path must remain available/);
    const admittedInput = { ...reAdmissionInput, expectedReplacementVersion: approved.version };
    await assert.rejects(readmitEmailRequests(org, actor, a.id, { ...admittedInput, expectedVersion: priorRoute.revision }, provider), /version changed/);
    await assert.rejects(readmitEmailRequests(org, actor, a.id, { ...admittedInput, expectedReplacementVersion: 999 }, provider), /version changed/);
    await assert.rejects(readmitEmailRequests(org, actor, a.id, { ...admittedInput, requests: [select(attachmentRow), select(attachmentRow)] }, provider), /only once/);
    await assert.rejects(readmitEmailRequests(org, actor, a.id, admittedInput, changedMailbox), /same verified/);
    await assert.rejects(readmitEmailRequests(org, actor, a.id, { ...admittedInput, requests: [select(attachmentRow), { id: sensitiveRow.id, expectedVersion: 999 }] }, provider), /version changed/);
    assert.equal((await requestFor(attached.id)).ingressId, a.id, "One stale selection rolls back the entire batch");
    const otherRow = await requestFor(otherMsg.id);
    for (const invalid of [select(otherRow), select(unbound), select(await requestFor(retryMail.id))])
      await assert.rejects(readmitEmailRequests(org, actor, a.id, { ...admittedInput, requests: [invalid] }, provider), /no longer held/);
    const countCases = (await db.select({ id: onbCases.id }).from(onbCases).where(eq(onbCases.organizationId, org))).length;
    const concurrent = await Promise.allSettled([
      readmitEmailRequests(org, actor, a.id, admittedInput, provider),
      readmitEmailRequests(org, actor, a.id, admittedInput, provider),
    ]);
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1, "Concurrent re-admission happens once");
    const readmitted = await requestFor(attached.id), readmittedBlocked = await requestFor(sensitive.id);
    assert.equal(readmitted.ingressId, approved.id); assert.equal(readmitted.originalIngressId, a.id);
    assert.equal(readmitted.originalRouteRevision, attachmentRow.routeRevision);
    assert.equal(readmitted.routeRevision, approved.version);
    assert.equal(readmitted.mailboxAddress, attachmentRow.mailboxAddress);
    assert.equal(readmitted.providerMessageId, attachmentRow.providerMessageId);
    assert.equal(readmitted.organizationId, org);
    assert.equal(readmitted.createdAt.toISOString(), attachmentRow.createdAt.toISOString());
    assert.deepEqual(readmitted.fields, attachmentRow.fields);
    assert.deepEqual(readmitted.fieldSources, attachmentRow.fieldSources);
    assert.deepEqual(readmitted.attachments, attachmentRow.attachments);
    assert.equal(readmitted.reviewedBy, null); assert.equal(readmitted.version, attachmentRow.version + 1);
    assert.equal(readmitted.routingAdmissions.length, 1); assert.equal(readmitted.routingAdmissions[0].reference, admittedInput.reference);
    assert.equal(readmittedBlocked.status, "blocked"); assert.equal(readmittedBlocked.reason, sensitiveRow.reason);
    assert.deepEqual(await db.select().from(hroEmailSources).where(eq(hroEmailSources.requestId, attachmentRow.id)), beforeSources, "Private source scan and retention state is never changed by rotation");
    assert.deepEqual((await db.select().from(onbSensitiveLifecycleHolds).where(eq(onbSensitiveLifecycleHolds.id, retentionHold.id)))[0], retentionHold, "An active retention hold remains unchanged");
    assert.deepEqual(await readEmailPrivateBody(org, actor, attachmentRow.id), { state: "unavailable", subject: null, body: null });
    await assert.rejects(convertEmailRequest(org, actor, attachmentRow.id, { expectedVersion: readmitted.version }, provider), /reviewed/);
    assert.equal((await db.select({ id: onbCases.id }).from(onbCases).where(eq(onbCases.organizationId, org))).length, countCases);
    assert.equal((await requestFor(pageMessages[0].id)).ingressId, a.id, "Unselected held requests remain fenced to the retired route");
    const newOldMarkerMail = message(`${org}:retired-marker-mail`, a.subjectMarker, emailExample(HRO_EMAIL_TEMPLATES[0]));
    await receiveIntakeMessage(mailbox, newOldMarkerMail, [], provider, sourceDeps);
    const retiredMail = await requestFor(newOldMarkerMail.id);
    assert.equal(retiredMail.organizationId, null); assert.deepEqual(retiredMail.fields, {});
    assert.match(retiredMail.reason!, /Permanently retired marker/);
    assert.ok(!(await getEmailRotation(org, actor, a.id)).requests.some(r => r.id === retiredMail.id));
    const currentRoutes = await db.select().from(hroMailboxIngress).where(inArray(hroMailboxIngress.id, [a.id, approved.id]));
    assert.equal(resolveEmailRoute(a.subjectMarker, mailbox, new Date(), currentRoutes), null);
    assert.equal(resolveEmailRoute(approved.subjectMarker, mailbox, new Date(), currentRoutes)?.id, approved.id);
    await db.update(onbAuthorityAssignments).set({ status: "revoked", revision: 2 }).where(eq(onbAuthorityAssignments.id, `${org}:independent:legal`));
    const unselected = await requestFor(pageMessages[0].id);
    await assert.rejects(readmitEmailRequests(org, actor, a.id, { ...admittedInput, requests: [select(unselected)] }, provider), /current independent review/);
  } finally {
    await db.delete(hroEmailSources).where(inArray(hroEmailSources.organizationId, [org, other]));
    await db.delete(hroEmailRequests).where(and(eq(hroEmailRequests.mailboxAddress, mailbox)));
    await db.delete(hroEmailScan).where(eq(hroEmailScan.mailboxAddress, mailbox));
    for (const id of [org, other]) await deleteTestOrganizations(eq(organizationsTable.id, id), async tx => {
      await tx.delete(onbSensitiveLifecycleHolds).where(eq(onbSensitiveLifecycleHolds.organizationId, id));
      await tx.delete(hroMailboxIngress).where(eq(hroMailboxIngress.organizationId, id));
      await tx.delete(offbCheckpoints).where(eq(offbCheckpoints.organizationId, id));
      await tx.delete(offbSources).where(eq(offbSources.organizationId, id));
      await tx.delete(offbCases).where(eq(offbCases.organizationId, id));
      await tx.delete(onbCases).where(eq(onbCases.organizationId, id));
      await tx.delete(onbConnectors).where(eq(onbConnectors.organizationId, id));
      await tx.delete(onbSettings).where(eq(onbSettings.organizationId, id));
      await tx.delete(onbReadinessSlaPolicies).where(eq(onbReadinessSlaPolicies.organizationId, id));
      await tx.delete(onbEvents).where(eq(onbEvents.organizationId, id));
      await tx.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, id));
    });
    for (const bytes of mem.values()) bytes.fill(0); mem.clear();
    await pool.end();
  }
});
