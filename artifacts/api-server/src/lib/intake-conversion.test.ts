import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { accessAgents, agentCatalogueBindings, agentInvocationAudit, db, pool, hroEmailRequests, hroEmailSources, onbWatchEmails,
  onbCases, onbCommunications, onbEvents, onbAuditEntries, organizationMembershipsTable, organizationsTable } from "@workspace/db";
import { AGENT_CATALOGUE_VERSION } from "./agent-catalogue";
import { seedApprovedSensitiveLifecyclePolicies } from "../test-utils/sensitive-lifecycle-fixtures";
import { HRO_EMAIL_TEMPLATES, emailExample } from "./hro-email-registry";
import { receiveIntakeMessage, type EmailProvider } from "./hro-email-ingestion";
import { configureEmailIntake, convertEmailRequest, getEmailRequest, reviewEmailRequest } from "./hro-email-service";
import { runIntakeConversions } from "./intake-conversion-worker";
import { resolveIntakeConversion } from "./intake-conversion-authorization";
import { emailReviewTurnaround } from "./hro-email-turnaround";
import type { GmailMessage } from "./onboarding/inbound-email";

test("standing registration converts only new valid intakes, durably and without human review or downstream effects", { timeout: 180_000 }, async () => {
  const org = `conversion-${randomUUID()}`, other = `${org}-other`, owner = `${org}-owner`, agentId = randomUUID();
  const mailbox = `${org}@example.invalid`;
  let available = true;
  const provider: EmailProvider = { get: async path => {
    assert.equal(path, "/gmail/v1/users/me/profile", "This suite must never read real mail or dispatch.");
    return { ok: available, json: async () => ({ emailAddress: mailbox }) };
  } };
  const memory = new Map<string, Buffer>();
  const deps = { storage: {
    save: async (p: string, b: Buffer) => { memory.set(p, b); },
    read: async (p: string) => memory.get(p)!,
    delete: async (p: string) => { memory.delete(p); },
  }, scan: async () => "clean" };
  for (const id of [org, other]) {
    await db.insert(organizationsTable).values({ id, name: "Isolated conversion client", slug: id, joinCodeHash: id, createdByUserId: owner });
    await db.insert(organizationMembershipsTable).values({ organizationId: id, clerkUserId: owner, role: "admin" });
    await seedApprovedSensitiveLifecyclePolicies(id);
  }
  const route = await configureEmailIntake(org, owner, { reference: "isolated-independent-mailbox-review", backfillHours: 1 }, provider);
  const otherRoute = await configureEmailIntake(other, owner, { reference: "isolated-other-client", backfillHours: 1 }, provider);
  const get = async (id: string) => (await db.select().from(hroEmailRequests).where(eq(hroEmailRequests.id, id)))[0];
  let sequence = 0;
  async function receive(templateId: string, options: { body?: string; attachment?: boolean; timestamp?: number; marker?: string } = {}) {
    const template = HRO_EMAIL_TEMPLATES.find(t => t.id === templateId)!;
    const n = ++sequence;
    const body = options.body ?? emailExample(template)
      .replace(/request_id: .*/, `request_id: fixture-${n}`)
      .replace(/worker_email: .*/, `worker_email: worker-${n}@example.invalid`)
      .replace(/employee_id: .*/, `employee_id: employee-${n}`);
    const payload: NonNullable<GmailMessage["payload"]> = {
      mimeType: "text/plain", headers: [{ name: "Subject", value: options.marker ?? route.subjectMarker },
        { name: "From", value: "sender@example.invalid" }], body: { data: Buffer.from(body).toString("base64url") },
    };
    if (options.attachment) {
      payload.mimeType = "multipart/mixed";
      payload.parts = [{ mimeType: "text/plain", body: payload.body },
        { filename: "private.txt", mimeType: "text/plain", body: { data: Buffer.from("private unverified source").toString("base64url"), size: 25 } }];
      delete payload.body;
    }
    const msg = { id: `${org}-message-${n}`, internalDate: String(options.timestamp ?? Date.now()), payload } as GmailMessage;
    await receiveIntakeMessage(mailbox, msg, [], provider, deps);
    const [row] = await db.select().from(hroEmailRequests).where(eq(hroEmailRequests.providerMessageId, msg.id));
    return row;
  }
  const manual = await receive("leave-request");
  await runIntakeConversions(provider, org);
  assert.equal((await get(manual.id)).caseId, null);
  await assert.rejects(convertEmailRequest(org, owner, manual.id, { expectedVersion: manual.version }, provider), /review/);
  await db.insert(accessAgents).values({ organizationId: org, id: agentId, name: "Intake principal", ownerUserId: owner, createdByUserId: owner });
  let generation = 0;
  async function register() {
    generation++;
    const values = { organizationId: org, catalogueKey: "intake-conversion", catalogueVersion: AGENT_CATALOGUE_VERSION,
      agentId, principalVersion: 1, version: generation, requestId: randomUUID(), requestDigest: randomUUID(), actorUserId: owner,
      intakeAuthorization: { capability: "intake-conversion/v1" as const, ownerUserId: owner, ownerMembershipRevision: 0, activatedAt: new Date().toISOString() } };
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${org}))`);
      await tx.insert(agentCatalogueBindings).values(values).onConflictDoUpdate({
        target: [agentCatalogueBindings.organizationId, agentCatalogueBindings.catalogueKey], set: values,
      });
    });
  }
  await register();
  const historical = await receive("leave-request", { timestamp: Date.now() - 3_600_000 });
  assert.equal(historical.automationGeneration, null, "Mailbox backfill predating activation stays manual");
  const foreign = await receive("leave-request", { marker: otherRoute.subjectMarker });
  assert.equal(foreign.automationGeneration, null, "One client's registration never authorizes another");
  assert.equal(await db.transaction(tx => resolveIntakeConversion(tx, other)), null);
  const converted = [];
  for (const template of HRO_EMAIL_TEMPLATES) {
    const row = await receive(template.id, { attachment: template.id === "leave-request" });
    assert.equal(row.automationGeneration, 1);
    await Promise.all(Array.from({ length: 12 }, () => runIntakeConversions(provider, org)));
    const result = await get(row.id);
    assert.equal(result.status, "converted", `${template.id}: ${result.automationReason}`);
    assert.equal(result.conversionOrigin, "automatic");
    assert.equal(result.reviewedBy, null, "Never fabricate reviewedBy");
    assert.equal(result.conversionAgentId, agentId);
    assert.equal(result.conversionOwnerUserId, owner);
    const [created] = await db.select().from(onbCases).where(eq(onbCases.id, result.caseId!));
    assert.equal(created.createdByUserId, `agent:${agentId}`, "Do not impersonate the owner");
    assert.equal(created.offerAcceptanceComplete, false);
    assert.equal(created.candidateEmailAuthorizedAt, null);
    assert.equal(created.orchestrationCheckpoint, null);
    assert.deepEqual(created.workstreams, []);
    if (template.id === "offboarding-separation") assert.equal(result.caseKind, "separation");
    else if (template.hireType) assert.equal(result.caseKind, "onboarding");
    else {
      assert.equal(result.caseKind, "service-request");
      assert.equal(created.orchestrationStatus, "hro-request-pending-review");
      assert.ok(created.checklistSnapshot.some(i => i.evidenceRequired && i.completionAuthority === "designated-human"));
    }
    if (row.attachments.length) {
      assert.deepEqual(result.attachments, row.attachments, "Conversion never promotes attachments");
      assert.ok((await db.select().from(hroEmailSources).where(eq(hroEmailSources.requestId, row.id))).some(s => s.kind !== "body"));
    }
    await assert.rejects(getEmailRequest(other, owner, row.id), /not found/);
    const invocations = await db.select().from(agentInvocationAudit).where(and(eq(agentInvocationAudit.organizationId, org), eq(agentInvocationAudit.caseId, result.caseId!)));
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].initiatingUserId, owner);
    assert.equal(invocations[0].agentId, agentId);
    converted.push(result);
  }
  // A real process is killed while its creator is blocked before commit. The
  // owned schema's trigger is temporary test instrumentation, never migration
  // or production code. The restarted process has no in-memory claim state.
  const crashRow = await receive("leave-request", { body: emailExample(HRO_EMAIL_TEMPLATES.find(t => t.id === "leave-request")!)
    .replace(/request_id: .*/, "request_id: crash-recovery")
    .replace(/worker_name: .*/, "worker_name: Crash Fixture")
    .replace(/worker_email: .*/, "worker_email: crash@example.invalid") });
  const key = Math.floor(Math.random() * 1_000_000_000);
  const locker = await pool.connect();
  const childPath = path.resolve("dist-test/test-support/intake-conversion-child.mjs");
  let child: ReturnType<typeof spawn> | undefined;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let childOutput = "";
  const startChild = () => {
    const process = spawn(globalThis.process.execPath, [childPath, org, mailbox], {
      env: { ...globalThis.process.env, NODE_ENV: "test", INTAKE_CONVERSION_CHILD: "true" }, stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout?.on("data", chunk => { childOutput += chunk; });
    process.stderr?.on("data", chunk => { childOutput += chunk; });
    return process;
  };
  try {
    await locker.query("select pg_advisory_lock(541, $1)", [key]);
    const owned = await locker.query("select current_schema() as name");
    assert.match(owned.rows[0].name, /^workspace_regression_/);
    await locker.query(`CREATE FUNCTION intake_conversion_crash_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.worker_name = 'Crash Fixture' THEN PERFORM pg_advisory_xact_lock(541, ${key}); END IF; RETURN NEW; END $$`);
    await locker.query("CREATE TRIGGER intake_conversion_crash_gate BEFORE INSERT ON onb_cases FOR EACH ROW EXECUTE FUNCTION intake_conversion_crash_gate()");
    child = startChild();
    childExit = new Promise((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      const waiting = await locker.query("select 1 from pg_locks where locktype='advisory' and classid=541 and objid=$1 and not granted", [key]);
      if (waiting.rows.length) { blocked = true; break; }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(blocked, `Crash worker must actually reach the insert before being killed: ${childOutput}`);
    child.kill("SIGKILL");
    assert.equal((await childExit).signal, "SIGKILL");
    assert.equal((await get(crashRow.id)).caseId, null, "The interrupted transaction cannot retain a partial case link");
    assert.equal((await get(crashRow.id)).automationState, "pending");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childExit;
    await locker.query("select pg_advisory_unlock(541, $1)", [key]);
    await locker.query("DROP TRIGGER IF EXISTS intake_conversion_crash_gate ON onb_cases");
    await locker.query("DROP FUNCTION IF EXISTS intake_conversion_crash_gate()");
    locker.release();
  }
  const recovered = startChild();
  const recoveredCode = await new Promise<number | null>((resolve, reject) => {
    recovered.once("error", reject); recovered.once("exit", resolve);
  });
  assert.equal(recoveredCode, 0, childOutput);
  assert.equal((await get(crashRow.id)).conversionOrigin, "automatic");
  const crashCases = await db.select().from(onbCases).where(and(eq(onbCases.organizationId, org), eq(onbCases.workerName, "Crash Fixture")));
  assert.equal(crashCases.length, 1, "A restart must not duplicate a partially attempted case");
  const sourceOwned = await receive("leave-request");
  await db.insert(onbWatchEmails).values({ organizationId: org, gmailMessageId: sourceOwned.providerMessageId,
    system: "fixture", fromAddress: "fixture@example.invalid", parsedStatus: "update", action: "fixture-owned-status" });
  await runIntakeConversions(provider, org);
  assert.match((await get(sourceOwned.id)).automationReason!, /provider message belongs/);
  assert.equal((await get(sourceOwned.id)).caseId, null);
  const invalid = await receive("leave-request", { body: "template_id: leave-request\nwork_country: US" });
  const ambiguous = await receive("leave-request", { body: "Payroll and leave request\nwork_country: US" });
  const unsafe = await receive("leave-request", { body: "template_id: leave-request\nwork_country: US\nbank_account: 123456789012345" });
  const conflict = await receive("leave-request", { body: emailExample(HRO_EMAIL_TEMPLATES.find(t => t.id === "leave-request")!) + "\nwork_country: GB" });
  const duplicate = await receive("leave-request", { body: emailExample(HRO_EMAIL_TEMPLATES.find(t => t.id === "leave-request")!)
    .replace(/request_id: .*/, `request_id: ${converted.find(r => r.templateId === "leave-request")!.fields.request_id}`) });
  const keyword = await receive("leave-request", { body: emailExample(HRO_EMAIL_TEMPLATES.find(t => t.id === "leave-request")!)
    .replace(/template_id: .*\n/, "") });
  await runIntakeConversions(provider, org);
  for (const row of [invalid, ambiguous, unsafe, conflict, duplicate, keyword]) {
    const result = await get(row.id);
    assert.equal(result.caseId, null);
    assert.equal(result.automationState, "exception");
    assert.ok(result.automationReason);
  }
  const previousAttempts = (await get(invalid.id)).automationAttempts;
  await runIntakeConversions(provider, org);
  assert.equal((await get(invalid.id)).automationAttempts, previousAttempts, "Permanent exceptions do not retry every tick");
  // Human correction remains available; it deliberately exits automation.
  const fixedFields = { ...converted.find(r => r.templateId === "leave-request")!.fields, request_id: "human-corrected", worker_email: "corrected@example.invalid" };
  const reviewed = await reviewEmailRequest(org, owner, invalid.id, { expectedVersion: invalid.version, action: "save", templateId: "leave-request", fields: fixedFields });
  const race = await Promise.all([runIntakeConversions(provider, org), convertEmailRequest(org, owner, invalid.id, { expectedVersion: reviewed.version }, provider),
    convertEmailRequest(org, owner, invalid.id, { expectedVersion: reviewed.version }, provider)]);
  assert.equal(race[1]!.caseId, race[2]!.caseId);
  assert.equal((await get(invalid.id)).conversionOrigin, "manual");
  // Worker has selected the queue item, but an authorized human wins the
  // tenant transaction before it. The worker must reread, not use its snapshot.
  const raced = await receive("leave-request");
  {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const worker = runIntakeConversions({ get: async path => { entered(); await gate; return provider.get(path); } }, org);
    await started;
    try {
      const saved = await reviewEmailRequest(org, owner, raced.id, {
        expectedVersion: raced.version, action: "save", templateId: raced.templateId, fields: raced.fields,
      });
      await convertEmailRequest(org, owner, raced.id, { expectedVersion: saved.version }, provider);
    } finally { release(); }
    await worker;
    const result = await get(raced.id);
    assert.equal(result.conversionOrigin, "manual");
    assert.equal(result.reviewedBy, owner);
    assert.equal((await db.select().from(onbCases).where(and(eq(onbCases.organizationId, org),
      eq(onbCases.workerEmail, raced.fields.worker_email)))).length, 1);
  }
  // Transient failure survives a fresh worker invocation without a new message.
  const retry = await receive("leave-request");
  available = false;
  await runIntakeConversions(provider, org);
  assert.equal((await get(retry.id)).automationState, "pending");
  assert.equal((await get(retry.id)).automationAttempts, 1);
  available = true;
  await db.update(hroEmailRequests).set({ automationRetryAt: new Date(0) }).where(eq(hroEmailRequests.id, retry.id));
  await runIntakeConversions(provider, org);
  assert.equal((await get(retry.id)).conversionOrigin, "automatic");
  const stale = await receive("leave-request");
  let profileEntered!: () => void, releaseProfile!: () => void;
  const entered = new Promise<void>(resolve => { profileEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseProfile = resolve; });
  const processing = runIntakeConversions({ get: async path => {
    profileEntered(); await released; return provider.get(path);
  } }, org);
  await entered;
  await register();
  releaseProfile();
  await processing;
  assert.equal((await get(stale.id)).automationState, "paused", "Replacement fences the queued generation");
  assert.equal((await get(manual.id)).caseId, null, "Registration never processes backlog");
  const revoked = await receive("leave-request");
  await db.update(accessAgents).set({ revokedAt: new Date() }).where(eq(accessAgents.id, agentId));
  await runIntakeConversions(provider, org);
  assert.equal((await get(revoked.id)).automationState, "paused");
  await db.update(accessAgents).set({ revokedAt: null, version: 2 }).where(eq(accessAgents.id, agentId));
  assert.equal(await db.transaction(tx => resolveIntakeConversion(tx, org)), null, "Stale principal version cannot authorize receipt");
  const stalePrincipal = await receive("leave-request");
  assert.equal(stalePrincipal.automationState, null);
  await db.update(accessAgents).set({ version: 1 }).where(eq(accessAgents.id, agentId));
  const lostOwner = await receive("leave-request");
  await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(
    eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, owner)));
  await runIntakeConversions(provider, org);
  assert.equal((await get(lostOwner.id)).automationState, "paused");
  await db.update(organizationMembershipsTable).set({ revokedAt: null, membershipRevision: 2 }).where(and(
    eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, owner)));
  assert.equal(await db.transaction(tx => resolveIntakeConversion(tx, org)), null,
    "Restoring a member cannot revive the old standing instruction");
  assert.equal((await db.select().from(onbCommunications).where(eq(onbCommunications.organizationId, org))).length, 0);
  const automatedHumanAudits = await db.select().from(onbAuditEntries).where(and(eq(onbAuditEntries.organizationId, org),
    eq(onbAuditEntries.actorKind, "authenticated"), eq(onbAuditEntries.action, "offboarding.email-intake-converted-held")));
  assert.equal(automatedHumanAudits.length, 2, "Only actual manual conversions have human audit attribution");
  const turnaround = await db.transaction(tx => emailReviewTurnaround(tx, org));
  assert.equal(turnaround.firstReview.sampleCount, 2);
  assert.equal(turnaround.firstReview.missingEvidenceCount, 0);
  assert.equal(turnaround.heldConversion.sampleCount, 2);
  assert.equal(turnaround.heldConversion.missingEvidenceCount, 0);
  const events = await db.select().from(onbEvents).where(eq(onbEvents.organizationId, org));
  assert.ok(events.filter(e => e.agent === agentId).every(e => e.engine !== "human"));
});
