import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { dkimSign, type DNSResolver } from "mailauth";
import { db, pool, organizationsTable, organizationMembershipsTable, accessNamedGrants, accessAgents,
  onbSensitiveLifecyclePolicies, offbCases, offbExchangePilots, offbExchanges, offbExchangeQuarantine, onbCases, onbEffectJournal } from "@workspace/db";
import { recordHumanPermissionDecision } from "../human-permissions";
import { SENSITIVE_DATA_CLASSES } from "../onboarding/sensitive-lifecycle";
import { externalProviderDispatchDenied } from "../onboarding/provider-policy";
import { provisionExchangePilots, enrollExchange, exchangeAction, stateOf, readExchange, updateCommunicationChecks, queueExchangeInTransaction, agentGate, verifiedRecipient } from "./exchange-service";
import { exchangeSetupChoices, saveGmailDefaults } from "./exchange-setup";
import { withExchangeTestIdentity } from "./exchange-test-boundary";
import { withOffboardingTestProvider, dispatchExchange, ingestExchangeMessage, reconcileAcceptedExchange } from "./exchange-runtime";
import { actionSeparation, createSeparations } from "./service";
import { savePolicy, decidePolicy } from "./policy";
import type { GmailMessage } from "../onboarding/inbound-email";

test("isolated contextual Gmail lifecycle: admission, partial/exception, replay, identity, revocation and unknown sends", { timeout: 120000 }, async () => {
  const oldMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  // The runner must own this disposable schema. Never put these exact Demo
  // fixtures in the shared development tenant reached by background workers.
  const schema = (await db.execute(sql`SELECT current_schema() AS s`)).rows[0] as { s: string };
  assert.match(schema.s, /^workspace_regression_/);
  const operator = "ox-fixture-operator", reviewer = "ox-fixture-reviewer", owner = "ox-fixture-owner", escalation = "ox-fixture-escalation";
  const ownerAddress = "source@offboarding-fixture.com", escalationAddress = "accountable@offboarding-fixture.com", mailbox = "channel@offboarding-fixture.com";
  const originalAllowlist = process.env.ONBOARDING_ALLOWED_RECIPIENTS;
  process.env.ONBOARDING_ALLOWED_RECIPIENTS = `${ownerAddress},${escalationAddress}`;
  const keys = ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", "tool.case.read",
    "tool.approval.decide", "tool.policy.manage", "tool.notification.send", "tool.external.dispatch",
    "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read"];
  const agentId = "ox-fixture-conversation-agent";
  let sendCount = 0, unknown = false;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ type: "pkcs1", format: "pem" });
  const dns = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const resolver: DNSResolver = async () => [[`v=DKIM1; k=rsa; p=${dns}`]];
  const acceptedSources = new Map<string, { msg: GmailMessage; raw: string }>();
  const provider = {
    resolver,
    get: async (path: string) => {
      assert.equal(externalProviderDispatchDenied(), true);
      if (path.endsWith("/profile")) return { ok: true, json: async () => ({ emailAddress: mailbox }) };
      const id = path.match(/\/messages\/([^?]+)\?/i)?.[1];
      if (id && acceptedSources.has(id)) {
        const s = acceptedSources.get(id)!;
        return { ok: true, json: async () => path.endsWith("format=raw") ? { id, raw: Buffer.from(s.raw).toString("base64url") } : s.msg };
      }
      return { ok: true, json: async () => ({ messages: [...acceptedSources.keys()].map(id => ({ id })) }) };
    },
    send: async (_to: string, _subject: string, _body: string) => {
      assert.equal(externalProviderDispatchDenied(), true);
      sendCount++;
      if (unknown) throw new Error("Stub lost the acceptance response");
      return { status: "sent", externalMessageId: `stub-accepted-${sendCount}`, externalThreadId: `stub-thread-${sendCount}` };
    },
  };
  const controlled = <T>(action: () => T) => withExchangeTestIdentity({ mailbox, members: [[ownerAddress, owner], [escalationAddress, escalation]] },
    () => withOffboardingTestProvider(provider, action));
  const pilot = async (id: number) => (await db.select().from(offbExchangePilots).where(eq(offbExchangePilots.caseId, id)))[0];
  const offb = async (id: number) => (await db.select().from(offbCases).where(eq(offbCases.id, id)))[0];
  const action = async (id: number, name: string, rest: object = {}, actor = operator) =>
    exchangeAction("demo", actor, id, { expectedVersion: (await pilot(id)).version, action: name, ...rest });
  const incoming = async (outbound: typeof offbExchanges.$inferSelect, body: string, from = ownerAddress, id = randomUUID(), tamper = false) => {
    const subject = `Re: ${outbound.subject}`;
    const unsigned = `From: Source <${from}>\r\nTo: ${mailbox}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
    const signed = await dkimSign(unsigned, { signingDomain: "offboarding-fixture.com", selector: "unit", privateKey: key,
      signatureData: [{ signingDomain: "offboarding-fixture.com", selector: "unit", privateKey: key, headerList: ["from", "subject"], canonicalization: "relaxed/relaxed" }] });
    const msg = { id, threadId: outbound.providerThreadId, internalDate: String(Date.now()), labelIds: ["INBOX"],
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: `Source <${from}>` }, { name: "Subject", value: subject }],
        body: { data: Buffer.from(body).toString("base64url") } } } as GmailMessage;
    await ingestExchangeMessage(msg, tamper ? unsigned : `${signed.signatures}${unsigned}`);
    return id;
  };
  try {
    await db.insert(organizationsTable).values({ id: "demo", slug: "demo", name: "Demo Organization", joinCodeHash: "isolated-unused", createdByUserId: operator }).onConflictDoNothing();
    await db.insert(organizationsTable).values({ id: "other", slug: "other", name: "Other Organization", joinCodeHash: "isolated-other-unused", createdByUserId: operator });
    for (const user of [operator, reviewer, owner, escalation]) {
      await db.insert(organizationMembershipsTable).values({ organizationId: "demo", clerkUserId: user, role: user === operator ? "admin" : "member" });
      if (user !== operator) await db.insert(accessNamedGrants).values(keys.map(resourceKey => ({ organizationId: "demo", principalType: "human" as const, principalId: user,
        scope: "tenant" as const, resourceType: resourceKey.startsWith("flow.") ? "flow" as const : resourceKey.startsWith("tool.") ? "tool" as const : "field" as const,
        resourceKey, source: "named" as const, effect: "allow" as const, status: "active" as const, createdByUserId: "fixture-grantor",
        approvedByUserId: "fixture-independent-grantor", approvedAt: new Date() })));
    }
    await db.insert(accessAgents).values({ organizationId: "demo", id: agentId, name: "Conversation agent", ownerUserId: operator, createdByUserId: operator });
    await controlled(async () => {
      const taskOwnerOnly = [{ taskId: "access-inventory", memberId: owner, address: ownerAddress, persona: "Access owner" }];
      const beforeCases = await exchangeSetupChoices("demo", operator);
      let clientSettings = await saveGmailDefaults("demo", operator, {
        expectedRevision: beforeCases.defaults.revision, agentId, recipients: taskOwnerOnly,
        enabled: true, escalationEnabled: false,
      });
      assert.equal(sendCount, 0, "enabling client email before cases exist sends nothing");
      await assert.rejects(saveGmailDefaults("demo", reviewer, {
        expectedRevision: clientSettings.revision, agentId: "", recipients: [],
        enabled: false, escalationEnabled: false,
      }), /administrator/);
      const provisioned = await provisionExchangePilots("demo", operator, { confirmAddThree: true });
      assert.equal(provisioned.caseIds.length, 3);
      for (const id of provisioned.caseIds) {
        const enrollment = stateOf(await pilot(id)).enrollment;
        assert.equal(enrollment.enabled, true, "future eligible cases inherit client enablement");
        assert.equal(enrollment.inheritsClientDefaults, true);
        assert.equal(enrollment.escalationEnabled, false);
        assert.equal(enrollment.recipients[0].escalationMemberId, undefined);
      }
      assert.equal((await db.select().from(offbExchanges)).length, 0, "inherited enablement never starts a request");
      await assert.rejects(action(provisioned.caseIds[0], "request", { taskId: "access-inventory" }), /standard voluntary-resignation plan/);
      const first = provisioned.caseIds[0];
      await db.transaction(tx => agentGate(tx, "demo", operator, agentId, first));
      await assert.rejects(db.transaction(tx => agentGate(tx, "other", operator, agentId, first)), /owned by/);
      await assert.rejects(db.transaction(tx => agentGate(tx, "demo", reviewer, agentId, first)), /owned by/);
      await db.update(accessAgents).set({ revokedAt: new Date() }).where(eq(accessAgents.id, agentId));
      await assert.rejects(db.transaction(tx => agentGate(tx, "demo", operator, agentId, first)), /active registered agent/);
      await db.update(accessAgents).set({ revokedAt: null }).where(eq(accessAgents.id, agentId));
      await db.update(organizationMembershipsTable).set({ role: "member" }).where(and(
        eq(organizationMembershipsTable.organizationId, "demo"), eq(organizationMembershipsTable.clerkUserId, operator)));
      await assert.rejects(db.transaction(tx => agentGate(tx, "demo", operator, agentId, first)), /requires delegated/);
      await db.update(organizationMembershipsTable).set({ role: "admin" }).where(and(
        eq(organizationMembershipsTable.organizationId, "demo"), eq(organizationMembershipsTable.clerkUserId, operator)));
      const removedContactRead = await db.delete(accessNamedGrants).where(and(
        eq(accessNamedGrants.organizationId, "demo"), eq(accessNamedGrants.principalId, owner),
        eq(accessNamedGrants.resourceKey, "flow.case.read"))).returning();
      assert.equal(removedContactRead.length, 1);
      await enrollExchange("demo", operator, first, { expectedRevision: stateOf(await pilot(first)).enrollment.revision,
        enabled: true, escalationEnabled: false, agentId, recipients: taskOwnerOnly, confirmCommunicationOnly: true });
      await assert.rejects(db.transaction(tx => verifiedRecipient(tx, "demo", owner, ownerAddress, first, false, false)),
        /scoped case permissions/, "saving a contact must not grant email disclosure or reply authority");
      assert.equal(sendCount, 0, "saving a contact with no case access sends no mail");
      await db.insert(accessNamedGrants).values(removedContactRead);
      assert.equal(stateOf(await pilot(first)).enrollment.inheritsClientDefaults, false,
        "a case override can be saved before the plan is ready without bypassing request readiness");
      const pausedCase = provisioned.caseIds[2];
      await enrollExchange("demo", operator, pausedCase, { expectedRevision: stateOf(await pilot(pausedCase)).enrollment.revision,
        enabled: false, escalationEnabled: false, recipients: [], confirmCommunicationOnly: true });
      clientSettings = await saveGmailDefaults("demo", operator, { expectedRevision: clientSettings.revision, agentId,
        recipients: taskOwnerOnly, enabled: false, escalationEnabled: false });
      const queuedPilot = await pilot(first);
      await assert.rejects(db.transaction(tx => queueExchangeInTransaction(tx, queuedPilot, stateOf(queuedPilot).tasks[0], "request")), /paused for this client/);
      assert.equal((await readExchange("demo", operator, first))!.enrollment.enabled, false,
        "tenant pause also hides effective enablement on case overrides");
      clientSettings = await saveGmailDefaults("demo", operator, { expectedRevision: clientSettings.revision, agentId,
        recipients: [{ ...taskOwnerOnly[0], escalationMemberId: escalation, escalationAddress }],
        enabled: true, escalationEnabled: true });
      assert.equal(stateOf(await pilot(pausedCase)).enrollment.enabled, false, "tenant re-enable does not erase a case-specific pause");
      assert.equal(stateOf(await pilot(provisioned.caseIds[1])).enrollment.enabled, true, "existing inherited cases receive settings updates");
      assert.equal(sendCount, 0, "client settings and overrides never send initial mail");
      assert.equal((await db.select().from(onbSensitiveLifecyclePolicies)).length, 0,
        "fixed fictional metadata does not create or approve tenant collection policies");
      await assert.rejects(createSeparations("demo", operator, {
        facts: { ...(await offb(provisioned.caseIds[0])).facts, employeeId: "S-FORGED" },
        sourceReference: "offboarding-contextual/v1:forged", fixedPilotMetadata: true,
      }, "contextual-offboarding"), /sensitive collection|policies are missing/i,
      "source labels and JSON flags cannot bypass ordinary collection gates");
      const choices = await exchangeSetupChoices("demo", operator);
      assert.equal((await db.select().from(accessNamedGrants).where(eq(accessNamedGrants.principalId, operator))).length, 0,
        "the client admin opens Gmail setup and provisions cases without individual grants");
      assert.deepEqual(choices.cases.map(c => c.id).sort(), [...provisioned.caseIds].sort());
      assert.equal(choices.agents.find(a => a.id === agentId)?.name, "Conversation agent");
      assert.ok(choices.members.some(m => m.id === owner));
      assert.equal(sendCount, 0, "reading Client Setup choices does not dispatch or enroll");
      const defaultRecipients = [{ taskId: "access-inventory", memberId: owner, address: ownerAddress, persona: "Access owner",
        escalationMemberId: escalation, escalationAddress }];
      const defaults = await saveGmailDefaults("demo", operator, { expectedRevision: choices.defaults.revision, agentId, recipients: defaultRecipients });
      assert.equal(defaults.recipients.length, 1);
      assert.deepEqual((await exchangeSetupChoices("demo", operator)).defaults, defaults);
      await assert.rejects(saveGmailDefaults("demo", operator, { expectedRevision: choices.defaults.revision, agentId, recipients: defaultRecipients }), /changed/);
      assert.equal(sendCount, 0, "reusable defaults never start a request");
      await assert.rejects(exchangeSetupChoices("other", operator), /Demo/);
      assert.deepEqual((await provisionExchangePilots("demo", operator, { confirmAddThree: true })).caseIds, provisioned.caseIds);
      assert.equal(sendCount, 0, "provisioning never sends");
      await assert.rejects(provisionExchangePilots("other", operator, { confirmAddThree: true }), /Demo/);
      // Real-channel processing still needs separately approved collection
      // policies. Only contact-free fixture construction preceded these.
      await db.transaction(async tx => {
        const decision = await recordHumanPermissionDecision(tx, { organizationId: "demo", actorUserId: reviewer, requiredKeys: ["tool.policy.manage"],
          reviewedRevision: 1, evidenceGeneration: 1, decision: "policy-approved" });
        for (const dataClass of SENSITIVE_DATA_CLASSES) await tx.insert(onbSensitiveLifecyclePolicies).values({
          organizationId: "demo", dataClass, jurisdiction: "US", revision: 1, purpose: "Isolated fixture only", lawfulBasis: "Isolated fixture basis",
          retentionDays: 30, providerSharingApproved: true, permittedProviders: ["gmail"], policyReference: "isolated-policy", approvalReference: "isolated-review",
          approvedByUserId: reviewer, approvedAuthorityAssignmentId: decision.id,
        });
      });
      const draft = await savePolicy("demo", operator, { expectedVersion: 0, policy: { country: "US", role: "Engineer", workerCategory: "Employee",
        timeZone: "America/New_York", endOfLwd: "18:00", rulesReference: "fixture-rules", retentionReference: "fixture-retention", defaultAssets: [], obligations: [] } });
      await decidePolicy("demo", reviewer, draft.id, draft.version, { decision: "approve", reference: "independent-fixture-review" });
      for (const id of provisioned.caseIds) {
        const upstream = async (name: string, rest: object) => actionSeparation("demo", operator, id, { expectedVersion: (await offb(id)).version,
          action: name, reference: `fixture:${name}`, ...rest });
        await upstream("screen", { sensitiveTriggers: [] });
        await upstream("classify", { classification: "Human-reviewed resignation", confirmed: true, urgency: "Standard",
          flags: { privileged: false, highRisk: false, clientFacing: false, peopleManager: false, statutory: false } });
        await upstream("adopt-policy", { policyId: draft.id, policyVersion: draft.version });
        const p = await pilot(id);
        await enrollExchange("demo", operator, id, { expectedRevision: stateOf(p).enrollment.revision, enabled: true, agentId,
          confirmCommunicationOnly: true, recipients: stateOf(p).tasks.map(t => ({ taskId: t.id, memberId: owner, address: ownerAddress,
            persona: "Source owner", escalationMemberId: escalation, escalationAddress })) });
      }
      assert.equal(sendCount, 0, "policy/enrollment/opening never sends");
      const id = provisioned.caseIds[0];
      let declarations = (await readExchange("demo", operator, id))!;
      assert.equal(declarations.communicationChecks.emailConsent, true);
      assert.equal(declarations.communicationChecks.emailVerified, true);
      assert.equal(declarations.communicationChecks.basis, "client-declared");
      const originalVersion = declarations.version;
      declarations = await updateCommunicationChecks("demo", operator, id, { expectedVersion: declarations.version, emailConsent: false, emailVerified: true });
      assert.equal(declarations.communicationChecks.reviewRequired, true);
      await assert.rejects(action(id, "request", { taskId: "access-inventory" }), /review/);
      await assert.rejects(updateCommunicationChecks("demo", operator, id, { expectedVersion: originalVersion, emailConsent: true, emailVerified: true }), /changed/);
      declarations = await updateCommunicationChecks("demo", operator, id, { expectedVersion: declarations.version, emailConsent: true, emailVerified: true });
      assert.equal(declarations.communicationChecks.reviewRequired, true, "reticking cannot bypass manual review");
      await assert.rejects(updateCommunicationChecks("other", operator, id, { expectedVersion: declarations.version, emailConsent: true, emailVerified: true }), /permissions|Demo|case/i);
      declarations = await updateCommunicationChecks("demo", operator, id, { expectedVersion: declarations.version, consentReference: "Human confirmed contact consent", emailReference: "Current source mailbox ownership checked" }, true);
      assert.equal(declarations.communicationChecks.reviewRequired, false);
      assert.equal(declarations.communicationChecks.reviewedBy, operator);
      assert.equal(sendCount, 0, "indicators and manual reviews send no email");
      await readExchange("demo", operator, id);
      assert.equal(sendCount, 0);
      await action(id, "request", { taskId: "access-inventory" });
      let outbound = (await db.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, id), eq(offbExchanges.direction, "outbound"))))[0];
      await dispatchExchange(outbound.id);
      outbound = (await db.select().from(offbExchanges).where(eq(offbExchanges.id, outbound.id)))[0];
      assert.equal(outbound.status, "accepted");
      assert.equal(stateOf(await pilot(id)).tasks[0].status, "pending", "Gmail acceptance is not source acknowledgment");
      const ackId = await incoming(outbound, "Received, working on it");
      assert.equal(stateOf(await pilot(id)).tasks[0].status, "acknowledged",
        JSON.stringify((await db.select().from(offbExchanges).where(eq(offbExchanges.providerMessageId, ackId))).map(m => ({ status: m.status, applied: m.applied }))));
      const ackVersion = (await pilot(id)).version;
      await incoming(outbound, "Received, working on it", ownerAddress, ackId);
      assert.equal((await pilot(id)).version, ackVersion, "inbox replay is atomic and idempotent");
      await incoming(outbound, `I confirm ${outbound.reference}: Entra account`, "unbound@offboarding-fixture.com");
      assert.deepEqual(stateOf(await pilot(id)).tasks[0].confirmed, [], "a signed but unbound sender has no authority");
      await incoming(outbound, `I confirm ${outbound.reference}: Entra account`, ownerAddress, randomUUID(), true);
      assert.deepEqual(stateOf(await pilot(id)).tasks[0].confirmed, [], "a forged header has no authority");
      await incoming(outbound, `I confirm ${outbound.reference}: Entra account\nshared account unresolved`);
      let current = stateOf(await pilot(id)).tasks[0];
      assert.deepEqual(current.confirmed, ["Entra account"]);
      assert.equal(current.status, "review");
      assert.equal(current.evidence[0].actor, owner);
      assert.equal(current.evidence[0].interpreter, agentId);
      assert.equal(current.evidence[0].type, "email-source-attestation");
      await incoming(outbound, `I confirm ${outbound.reference}: shared account, KT access`);
      current = stateOf(await pilot(id)).tasks[0];
      assert.equal(current.status, "review", "completion text cannot bypass the pending human exception review");
      await assert.rejects(action(id, "exception-review", { taskId: current.id, taskRevision: current.revision, exceptionRevision: 99,
        evidenceReference: current.exception!.sourceId, disposition: "resolved-with-reviewed-exception", confirmed: true }), /exact current/);
      await action(id, "exception-review", { taskId: current.id, taskRevision: current.revision, exceptionRevision: current.exception!.revision,
        evidenceReference: current.exception!.sourceId, disposition: "resolved-with-reviewed-exception", confirmed: true }, reviewer);
      assert.equal(stateOf(await pilot(id)).tasks[0].status, "resolved");
      await action(id, "inspect-interface", { taskId: "shared-accounts" });
      await action(id, "inspect-interface", { taskId: "kt-access-exception" });
      await action(id, "inspect-interface", { taskId: "access-closure" });
      assert.equal(stateOf(await pilot(id)).tasks.find(t => t.id === "access-closure")!.status, "pending", "mock access respects end-of-last-working-day");
      const cutoff = stateOf(await pilot(id)).tasks.find(t => t.id === "access-closure")!.notBeforeAt!;
      const mailCount = (await db.select().from(offbExchanges).where(eq(offbExchanges.direction, "outbound"))).length;
      await action(id, "advance-clock", { clock: cutoff });
      const closedAccess = stateOf(await pilot(id)).tasks.find(t => t.id === "access-closure")!;
      assert.equal(closedAccess.status, "resolved", "scheduled mock reconciles at the explicit operational cutoff");
      assert.equal(closedAccess.evidence[0].type, "simulated-api-response");
      assert.equal((await db.select().from(offbExchanges).where(eq(offbExchanges.direction, "outbound"))).length, mailCount, "clock advancement creates no mail storm");
      await action(id, "request", { taskId: "asset-inventory" });
      let staleDraft = (await db.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, id), eq(offbExchanges.taskId, "asset-inventory"), eq(offbExchanges.direction, "outbound"))))[0];
      const approved = stateOf(await pilot(id)).enrollment;
      await enrollExchange("demo", operator, id, { expectedRevision: approved.revision, enabled: true, agentId,
        recipients: approved.recipients, confirmCommunicationOnly: true });
      // Let only the fixture-created draft age beyond the per-task request limit.
      await db.update(offbExchanges).set({ createdAt: new Date(Date.now() - 120000) }).where(eq(offbExchanges.id, staleDraft.id));
      await action(id, "request", { taskId: "asset-inventory" });
      staleDraft = (await db.select().from(offbExchanges).where(eq(offbExchanges.id, staleDraft.id)))[0];
      assert.equal(staleDraft.status, "cancelled", "unsent old enrollment drafts cannot permanently block a fresh approved request");
      const draftCount = (await db.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, id), eq(offbExchanges.taskId, "asset-inventory"), eq(offbExchanges.direction, "outbound")))).length;
      await action(id, "request", { taskId: "asset-inventory" });
      assert.equal((await db.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, id), eq(offbExchanges.taskId, "asset-inventory"), eq(offbExchanges.direction, "outbound")))).length, draftCount, "rapid repeated requests reuse the exact frozen draft");
      const orphanId = randomUUID(), orphanReference = `OX-${"f".repeat(48)}`;
      await ingestExchangeMessage({ id: orphanId, payload: { headers: [{ name: "Subject", value: orphanReference }], body: { data: Buffer.from("received").toString("base64url") } } } as GmailMessage, "");
      const [quarantine] = await db.select().from(offbExchangeQuarantine).where(eq(offbExchangeQuarantine.providerMessageId, orphanId));
      assert.equal(quarantine.reason, "unowned-reference-or-non-source-contact");
      assert.ok(!JSON.stringify(quarantine).includes(orphanReference), "quarantine retains only opaque hashes, no sender or mailbox text");
      await assert.rejects(actionSeparation("demo", operator, id, { expectedVersion: (await offb(id)).version, action: "finalize", reference: "no closure" }), /4.6/);
      assert.equal((await offb(id)).status, "active");
      const envelope = (await db.select().from(onbCases).where(eq(onbCases.id, id)))[0];
      assert.equal(envelope.operationalActivation, null, "Gmail enrollment never grants operational activation");
      assert.equal(envelope.syntheticProvenance, "demo-full-coverage");
      const delayed = provisioned.caseIds[1];
      await action(delayed, "inspect-interface", { taskId: "asset-inventory" });
      await action(delayed, "inspect-interface", { taskId: "asset-return" });
      assert.equal(stateOf(await pilot(delayed)).tasks.find(t => t.id === "asset-return")!.status, "pending");
      const except = provisioned.caseIds[2];
      await action(except, "inspect-interface", { taskId: "asset-inventory" });
      await action(except, "inspect-interface", { taskId: "asset-return" });
      const assetTask = stateOf(await pilot(except)).tasks.find(t => t.id === "asset-return")!;
      assert.equal(assetTask.status, "review"); assert.deepEqual(assetTask.confirmed, ["laptop"]); assert.deepEqual(assetTask.outstanding, ["charger"]);
      const before = (await pilot(except)).version;
      await action(except, "inspect-interface", { taskId: "asset-return" });
      assert.equal((await pilot(except)).version, before, "interface reconciliation does not duplicate exceptional results");
      await action(delayed, "request", { taskId: "access-inventory" });
      const pending = (await db.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, delayed), eq(offbExchanges.direction, "outbound"))))[0];
      unknown = true;
      await dispatchExchange(pending.id);
      assert.equal((await db.select().from(offbExchanges).where(eq(offbExchanges.id, pending.id)))[0].status, "ambiguous");
      const attempts = sendCount;
      await dispatchExchange(pending.id);
      assert.equal(sendCount, attempts, "uncertain sends never retry blindly after recovery");
      assert.equal((await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.logicalOperationKey, `offboarding-exchange:${pending.id}`)))[0].status, "unknown_effect_manual_repair");
      const delayedEnrollment = stateOf(await pilot(delayed)).enrollment;
      await enrollExchange("demo", operator, delayed, { expectedRevision: delayedEnrollment.revision, enabled: true, agentId,
        recipients: delayedEnrollment.recipients, confirmCommunicationOnly: true });
      const recoveredId = "stub-reconciled-source", recoveredSubject = pending.subject;
      const unsigned = `From: ${mailbox}\r\nTo: ${pending.recipient}\r\nSubject: ${recoveredSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${pending.body}\r\n`;
      const signed = await dkimSign(unsigned, { signingDomain: "offboarding-fixture.com", selector: "unit", privateKey: key,
        signatureData: [{ signingDomain: "offboarding-fixture.com", selector: "unit", privateKey: key, headerList: ["from", "subject"], canonicalization: "relaxed/relaxed" }] });
      acceptedSources.set(recoveredId, { raw: `${signed.signatures}${unsigned}`, msg: { id: recoveredId, internalDate: String(Date.now()), labelIds: ["SENT"],
        payload: { mimeType: "text/plain", headers: [{ name: "From", value: mailbox }, { name: "To", value: pending.recipient }, { name: "Subject", value: recoveredSubject }],
          body: { data: Buffer.from(pending.body).toString("base64url") } } } as GmailMessage });
      await reconcileAcceptedExchange(pending.id);
      assert.equal((await db.select().from(offbExchanges).where(eq(offbExchanges.id, pending.id)))[0].status, "accepted");
      assert.equal(sendCount, attempts, "old enrollment acceptance reconciliation never resends or completes a task");
      assert.equal(stateOf(await pilot(delayed)).tasks[0].status, "pending");
      assert.equal((await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.logicalOperationKey, `offboarding-exchange:${pending.id}`)))[0].externalEffectId, recoveredId);
      await db.update(organizationMembershipsTable).set({ revokedAt: new Date() }).where(and(eq(organizationMembershipsTable.organizationId, "demo"), eq(organizationMembershipsTable.clerkUserId, owner)));
      const active = (await db.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, id), eq(offbExchanges.taskId, "asset-inventory"), eq(offbExchanges.status, "queued"))))[0];
      await assert.rejects(dispatchExchange(active.id), /membership/);
      assert.equal(sendCount, attempts, "revoked recipient stops dispatch before the provider");
      // Use a fresh accepted outbound reference from the current enrollment.
      await db.update(offbExchanges).set({ status: "accepted", providerMessageId: "stub-current-enrollment" }).where(eq(offbExchanges.id, active.id));
      await incoming({ ...active, status: "accepted" }, `I confirm ${active.reference}: laptop`);
      const revoked = (await db.select().from(offbExchanges).where(eq(offbExchanges.direction, "inbound"))).find(m => m.status === "proposed-unverified" && m.observation?.blocker?.toString().includes("membership"));
      assert.ok(revoked, "membership revocation stops source transitions");
    });
  } finally {
    process.env.NODE_ENV = oldMode;
    if (originalAllowlist === undefined) delete process.env.ONBOARDING_ALLOWED_RECIPIENTS;
    else process.env.ONBOARDING_ALLOWED_RECIPIENTS = originalAllowlist;
    await pool.end();
  }
});
