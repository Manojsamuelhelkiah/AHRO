import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, offbExchangePilots, offbExchanges, offbExchangeQuarantine, offbExchangeMailboxState, onbEffectJournal } from "@workspace/db";
import { audit } from "./service";
import { withSensitiveLifecycleFence, evaluateSensitiveLifecycleGate, SENSITIVE_DATA_CLASSES } from "../onboarding/sensitive-lifecycle";
import { acquireCaseDispatchMutationLock } from "../onboarding/dispatch-guard";
import { externalProviderDispatchDenied, runWithProviderDeny } from "../onboarding/provider-policy";
import { sendEmail } from "../onboarding/channels";
import { withGmailConsumerCoordination } from "../onboarding/gmail-consumer-coordination";
import { makeSharedTick } from "../onboarding/shared-tick";
import { boundedEmailContent } from "../hro-email-ingestion";
import { header, type GmailMessage } from "../onboarding/inbound-email";
import { ensureEffectJournalEntry, claimEffectDispatch, confirmEffect, markAmbiguousEffectForManualRepair } from "../onboarding/effect-journal";
import { verifyGmailSourceTransport, isVerifiedSourceTransport, type VerifiedSourceAttestation } from "../onboarding/verified-email-transport";
import { type DNSResolver } from "mailauth";
import { loadPilot, stateOf, namedOperator, agentGate, verifiedRecipient, verifyHandlingOwner, policyGate, persistState, queueExchangeInTransaction, type ExchangeRow } from "./exchange-service";
import { hash } from "./service";
import { interpretReply, uncertainObservation } from "./exchange-agent";
import { explicitAttestation, communicationAllowed, type Observation } from "./exchange-contract";
import { SeparationError } from "./model";
import { receipt } from "./authority";
import { logger } from "../logger";
import { sourceHandling } from "./source-handling";

type GmailProvider = {
  get(path: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  send(to: string, subject: string, body: string): Promise<{ status: string; externalMessageId: string | null; externalThreadId?: string | null }>;
  resolver?: DNSResolver;
};
const connectors = new ReplitConnectors();
const controlled = new AsyncLocalStorage<GmailProvider>();
const live: GmailProvider = {
  get: path => {
    if (externalProviderDispatchDenied() || process.env.ONBOARDING_AUTOMATED_TEST === "true" || process.env.NODE_ENV === "test") throw new Error("Live Gmail reads denied.");
    return connectors.proxy("google-mail", path, { method: "GET" });
  },
  send: (to, subject, body) => {
    if (externalProviderDispatchDenied() || process.env.ONBOARDING_AUTOMATED_TEST === "true" || process.env.NODE_ENV === "test") throw new Error("Live Gmail sends denied.");
    return sendEmail(to, subject, body);
  },
};
/** Stubs never clear the unconditional external-provider fence and cannot be installed from HTTP. */
export function withOffboardingTestProvider<T>(provider: GmailProvider, action: () => T): T {
  if (process.env.NODE_ENV !== "test" || process.env.ONBOARDING_AUTOMATED_TEST !== "true") throw new Error("Isolated test-only provider.");
  return controlled.run(provider, () => runWithProviderDeny(action));
}
const provider = () => controlled.getStore() ?? live;
const frozenArgumentsHash = (message: ExchangeRow) => hash({
  caseId: message.caseId, generation: message.generation, taskId: message.taskId, taskRevision: message.taskRevision,
  enrollmentRevision: message.enrollmentRevision, recipient: message.recipient, mailbox: message.mailbox,
  subject: message.subject, body: message.body, reference: message.reference,
});
async function mailboxHealth(): Promise<string> {
  const r = await provider().get("/gmail/v1/users/me/profile");
  const p = await r.json() as { emailAddress?: string };
  if (!r.ok || !p.emailAddress) throw new SeparationError("Gmail mailbox health is unavailable.");
  return p.emailAddress.toLowerCase();
}
async function privacyGate(org: string, country: string, disclosure: boolean) {
  for (const dataClass of SENSITIVE_DATA_CLASSES) {
    const gate = await evaluateSensitiveLifecycleGate({ organizationId: org, jurisdiction: country, dataClass, disclosure, ...(disclosure ? { providerId: "gmail" } : {}) });
    if (!gate.allowed) throw new SeparationError(gate.reason ?? "Current private-data policy approval is required.");
  }
}
/** Frozen content is journal-bound before claim. Non-idempotent unknown outcomes are never resent. */
export async function dispatchExchange(id: string): Promise<void> {
  const [prepared] = await db.select().from(offbExchanges).where(eq(offbExchanges.id, id));
  if (!prepared || prepared.direction !== "outbound" || prepared.status === "accepted") return;
  const identity = { logicalOperationKey: `offboarding-exchange:${id}`, organizationId: prepared.organizationId,
    tenantId: prepared.organizationId, caseId: prepared.caseId, toolName: "send-email", argumentsHash: frozenArgumentsHash(prepared), providerIdempotency: false };
  const entry = await ensureEffectJournalEntry(identity);
  const mailbox = await mailboxHealth();
  await withSensitiveLifecycleFence(prepared.organizationId, () => db.transaction(async tx => {
    await acquireCaseDispatchMutationLock(tx, prepared.organizationId, prepared.caseId);
    const { pilot, row } = await loadPilot(tx, prepared.organizationId, prepared.caseId), state = stateOf(pilot);
    const e = state.enrollment, task = state.tasks.find(t => t.id === prepared.taskId);
    const [message] = await tx.select().from(offbExchanges).where(eq(offbExchanges.id, id)).for("update");
    if (!message || message.status === "accepted") return;
    if (!task) throw new SeparationError("Task no longer exists.");
    if (!communicationAllowed(state) || e.revision !== message.enrollmentRevision || e.generation !== pilot.generation ||
        message.generation !== pilot.generation || task?.revision !== message.taskRevision || (task.status === "resolved" && message.kind !== "receipt") ||
        e.mailbox !== mailbox || message.mailbox !== mailbox || e.operator !== message.operator || e.agentId !== message.agentId) throw new SeparationError("Communication approval, task revision or mailbox changed. Re-enroll and prepare a new request.");
    await namedOperator(tx, prepared.organizationId, message.operator, message.caseId);
    await agentGate(tx, prepared.organizationId, message.operator, message.agentId, message.caseId);
    await policyGate(tx, row);
    await privacyGate(prepared.organizationId, row.facts.country, true);
    const binding = e.recipients.find(r => r.taskId === task.id);
    if (!binding || (message.kind === "escalation" ? binding.escalationAddress !== message.recipient || binding.escalationMemberId !== message.memberId : binding.address !== message.recipient || binding.memberId !== message.memberId)) throw new SeparationError("Exact approved recipient binding required.");
    await verifiedRecipient(tx, prepared.organizationId, message.memberId, message.recipient, message.caseId, message.kind !== "escalation", false);
    if (task.prerequisites.some(p => state.tasks.find(t => t.id === p)?.status !== "resolved")) throw new SeparationError("Task prerequisites were reopened.");
    // Persisted database rate limit spans cases, instances and restarts.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('offb-gmail-dispatch-rate:v1', 0))`);
    const rate = await tx.execute(sql`SELECT count(*)::int AS n FROM onb_effect_journal WHERE logical_operation_key LIKE 'offboarding-exchange:%' AND status IN ('confirmed','dispatching','unknown_effect_manual_repair') AND updated_at > now() - interval '1 hour'`);
    if (Number((rate.rows[0] as { n: number }).n) >= 20) throw new SeparationError("Hourly Gmail rate limit reached.");
    const owner = randomUUID(), claim = await claimEffectDispatch({ ...identity, owner, expectedFencingToken: entry.fencingToken, leaseMs: 60000 });
    if (claim.kind === "reuse_confirmed") {
      await tx.update(offbExchanges).set({ status: "accepted", providerMessageId: claim.externalEffectId }).where(eq(offbExchanges.id, id)); return;
    }
    if (claim.kind === "manual_repair_required") { await tx.update(offbExchanges).set({ status: "ambiguous" }).where(eq(offbExchanges.id, id)); return; }
    if (claim.kind !== "claimed") return;
    await tx.update(offbExchanges).set({ status: "dispatching", attemptedAt: new Date() }).where(eq(offbExchanges.id, id));
    try {
      const result = await provider().send(message.recipient, message.subject, message.body);
      if (result.status !== "sent" || !result.externalMessageId) throw new Error("Provider acceptance unconfirmed.");
      const accepted = await confirmEffect({ logicalOperationKey: identity.logicalOperationKey, organizationId: identity.organizationId, owner, fencingToken: claim.fencingToken, externalEffectId: result.externalMessageId });
      if (!accepted) throw new Error("Stale journal completion.");
      await tx.update(offbExchanges).set({ status: "accepted", providerMessageId: result.externalMessageId, providerThreadId: result.externalThreadId ?? null }).where(eq(offbExchanges.id, id));
    } catch {
      await markAmbiguousEffectForManualRepair({ logicalOperationKey: identity.logicalOperationKey, organizationId: identity.organizationId, owner, fencingToken: claim.fencingToken, error: "Gmail outcome requires reconciliation; automatic resend prohibited." });
      await tx.update(offbExchanges).set({ status: "ambiguous" }).where(eq(offbExchanges.id, id));
    }
  }));
}

/** Read-only provider reconciliation never retries or infers delivery/read acknowledgment. */
export async function reconcileAcceptedExchange(id: string): Promise<void> {
  const [prepared] = await db.select().from(offbExchanges).where(eq(offbExchanges.id, id));
  if (!prepared || prepared.status !== "ambiguous") return;
  const mailbox = await mailboxHealth();
  await withSensitiveLifecycleFence(prepared.organizationId, () => db.transaction(async tx => {
    await acquireCaseDispatchMutationLock(tx, prepared.organizationId, prepared.caseId);
    const { pilot, row } = await loadPilot(tx, prepared.organizationId, prepared.caseId), s = stateOf(pilot), e = s.enrollment;
    const [message] = await tx.select().from(offbExchanges).where(eq(offbExchanges.id, id)).for("update");
    // Acceptance-only recovery can inspect an old frozen request after this
    // same named operator re-enrolls the mailbox. It never resumes that old
    // task/generation or sends again. Otherwise an uncertain old request would
    // permanently prevent safe preparation in the new generation.
    if (!message || message.status !== "ambiguous" || !e.enabled || e.mailbox !== mailbox || message.mailbox !== mailbox ||
        message.operator !== e.operator) return;
    await namedOperator(tx, message.organizationId, message.operator, message.caseId);
    await agentGate(tx, message.organizationId, message.operator, message.agentId, message.caseId);
    await privacyGate(message.organizationId, row.facts.country, false);
    const result = await provider().get(`/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:sent "${message.reference}"`)}&maxResults=10`);
    if (!result.ok) throw new Error("Gmail acceptance reconciliation unavailable.");
    const list = await result.json() as { messages?: Array<{ id: string }> };
    const matches: Array<{ id: string; threadId?: string }> = [];
    for (const ref of list.messages ?? []) {
      const full = await provider().get(`/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`);
      const raw = await provider().get(`/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=raw`);
      if (!full.ok || !raw.ok) throw new Error("Gmail acceptance source unavailable.");
      const msg = await full.json() as GmailMessage & { threadId?: string }, source = await raw.json() as { id?: string; raw?: string };
      const to = (header(msg, "To").match(/<([^<>]+)>/)?.[1] ?? header(msg, "To")).trim().toLowerCase();
      if (source.id !== msg.id || msg.id !== ref.id || !source.raw || !msg.labelIds?.includes("SENT") ||
          header(msg, "Subject") !== message.subject || to !== message.recipient ||
          !msg.internalDate || Number(msg.internalDate) < message.createdAt.getTime() ||
          boundedEmailContent(msg).body.trim() !== message.body.trim()) continue;
      const proof = await verifyGmailSourceTransport({ rawMessage: Buffer.from(source.raw, "base64url").toString("utf8"), sourceMessageId: msg.id,
        expectedFromAddress: mailbox, reference: message.reference, statement: message.body,
        ...(provider().resolver ? { resolver: provider().resolver } : {}) });
      if (proof) matches.push({ id: msg.id, threadId: msg.threadId });
    }
    if (matches.length !== 1) return; // Zero/multiple observations require human investigation, not retry.
    const key = `offboarding-exchange:${id}`;
    const [journal] = await tx.select().from(onbEffectJournal).where(and(eq(onbEffectJournal.organizationId, message.organizationId), eq(onbEffectJournal.logicalOperationKey, key))).for("update");
    if (!journal || journal.argumentsHash !== frozenArgumentsHash(message) ||
        !["unknown_effect_manual_repair", "confirmed"].includes(journal.status) || journal.status === "confirmed" && journal.externalEffectId !== matches[0].id) return;
    await tx.update(onbEffectJournal).set({ status: "confirmed", externalEffectId: matches[0].id, updatedAt: new Date(), claimUntil: null, lastError: null })
      .where(and(eq(onbEffectJournal.organizationId, message.organizationId), eq(onbEffectJournal.logicalOperationKey, key), eq(onbEffectJournal.fencingToken, journal.fencingToken)));
    await tx.update(offbExchanges).set({ status: "accepted", providerMessageId: matches[0].id, providerThreadId: matches[0].threadId ?? null,
      observation: { evidenceType: "gmail-api-acceptance", reconciliation: "exact-signed-sent-message", deliveryAcknowledged: false, readAcknowledged: false } }).where(eq(offbExchanges.id, id));
    await audit(tx, message.organizationId, message.operator, "gmail-acceptance-reconciled", message.caseId, pilot.version);
  }));
}

/** Correlation ownership before any tenant choice; missing/duplicate/foreign refs cannot select a case. */
export async function ingestExchangeMessage(msg: GmailMessage, rawMessage: string): Promise<boolean> {
  const content = boundedEmailContent(msg), subject = header(msg, "Subject");
  const authored = content.body.split(/\n\s*(?:On .+wrote:|From:|>{1,})/i)[0];
  const refs = [...new Set(`${subject}\n${authored}`.match(/\bOX-[a-f0-9]{48}\b/g) ?? [])];
  if (!refs.length) return false;
  if (msg.labelIds?.some(label => ["SENT", "DRAFT"].includes(label))) return true;
  const quarantine = async (reason: string) => {
    await db.insert(offbExchangeQuarantine).values({ providerMessageId: msg.id, reason, referenceHashes: refs.map(r => hash(r)) }).onConflictDoNothing();
    return true;
  };
  if (refs.length !== 1 || content.blocked || content.attachments.length) return quarantine("ambiguous-reference-or-unsupported-content");
  const [outbound] = await db.select().from(offbExchanges).where(and(eq(offbExchanges.reference, refs[0]), eq(offbExchanges.direction, "outbound"))).limit(2);
  if (!outbound || outbound.kind === "escalation") return quarantine("unowned-reference-or-non-source-contact");
  const [existing] = await db.select().from(offbExchanges).where(eq(offbExchanges.providerMessageId, msg.id));
  if (existing) return true; // Includes own outbound echo.
  const fromHeader = header(msg, "From");
  const address = (fromHeader.match(/<([^<>]+)>/)?.[1] ?? fromHeader).trim().toLowerCase();
  const statement = content.body;
  const proof = await verifyGmailSourceTransport({ rawMessage, sourceMessageId: msg.id, expectedFromAddress: address,
    reference: refs[0], statement, ...(provider().resolver ? { resolver: provider().resolver } : {}) });
  await recordExchangeReply({ outbound, msg, body: content.body.slice(0, 4000), address, proof, statement });
  return true;
}

async function recordExchangeReply(input: { outbound: ExchangeRow; msg: GmailMessage; body: string; address: string; proof: VerifiedSourceAttestation | null; statement: string }) {
  const { outbound, msg } = input;
  await withSensitiveLifecycleFence(outbound.organizationId, () => db.transaction(async tx => {
    await acquireCaseDispatchMutationLock(tx, outbound.organizationId, outbound.caseId);
    const { pilot, row } = await loadPilot(tx, outbound.organizationId, outbound.caseId), state = stateOf(pilot);
    const prior = await tx.select().from(offbExchanges).where(eq(offbExchanges.providerMessageId, msg.id));
    if (prior.length) return;
    await privacyGate(outbound.organizationId, row.facts.country, false);
    const task = state.tasks.find(t => t.id === outbound.taskId)!;
    const e = state.enrollment, binding = e.recipients.find(r => r.taskId === task.id);
    let authorized = false, blocker = "";
    try {
      if (!communicationAllowed(state) || outbound.status !== "accepted" || outbound.enrollmentRevision !== e.revision ||
          outbound.generation !== pilot.generation || outbound.taskRevision !== task.revision || !binding ||
          binding.memberId !== task.owner || binding.memberId !== outbound.memberId || binding.address !== input.address ||
          !msg.internalDate || !Number.isFinite(Number(msg.internalDate)) || Number(msg.internalDate) < Date.parse(e.approvedAt!) ||
          Number(msg.internalDate) < outbound.createdAt.getTime() ||
          !isVerifiedSourceTransport(input.proof, { fromAddress: binding.address, sourceMessageId: msg.id, reference: outbound.reference, statement: input.statement })) {
        throw new SeparationError("Reply identity, exact source statement, enrollment or task reference is unverified/stale.");
      }
      await namedOperator(tx, outbound.organizationId, e.operator!, outbound.caseId);
      await agentGate(tx, outbound.organizationId, e.operator!, e.agentId!, outbound.caseId);
      await verifiedRecipient(tx, outbound.organizationId, binding.memberId, binding.address, outbound.caseId, true);
      await policyGate(tx, row);
      if (task.prerequisites.some(p => state.tasks.find(t => t.id === p)?.status !== "resolved")) throw new SeparationError("Fresh prerequisites required.");
      if (task.notBeforeAt && (Date.parse(state.clock) < Date.parse(task.notBeforeAt) || Date.now() < Date.parse(task.notBeforeAt))) throw new SeparationError("Access confirmation cannot precede approved end of LWD.");
      authorized = true;
    } catch (error) { blocker = error instanceof SeparationError ? error.message : "Current source permission could not be verified."; }
    const history = await tx.select().from(offbExchanges).where(eq(offbExchanges.caseId, outbound.caseId)).orderBy(desc(offbExchanges.createdAt)).limit(6);
    const interpret = () => interpretReply({ organizationId: outbound.organizationId, country: row.facts.country, caseId: row.id, task,
      reference: outbound.reference, body: input.body, clock: state.clock, history: history.reverse() });
    let observation = await (authorized ? interpret() : runWithProviderDeny(interpret));
    const portions = explicitAttestation(input.body, outbound.reference, task);
    const handling = sourceHandling(task, input.body, state.clock);
    let handlingBlocker = handling.question;
    if (authorized && portions && handling.handling) {
      try { await verifyHandlingOwner(tx, outbound.organizationId, outbound.caseId, handling.handling); }
      catch { handlingBlocker = "Please name an independently current case member as the account/KT owner, or use an authenticated handoff."; }
    }
    if (authorized && portions && handlingBlocker) observation = { kind: "clarification", confirmed: [], outstanding: [...task.outstanding],
      question: handlingBlocker, explanation: "Source confirmation lacks current ownership or time-bounded KT handling; no completed portions applied." };
    const canApply = authorized && !handlingBlocker && portions !== null && ["confirmation", "partial", "exception"].includes(observation.kind);
    const id = randomUUID();
    await tx.insert(offbExchanges).values({
      id, organizationId: outbound.organizationId, caseId: outbound.caseId, taskId: task.id, generation: outbound.generation,
      taskRevision: outbound.taskRevision, enrollmentRevision: outbound.enrollmentRevision, reference: outbound.reference,
      direction: "inbound", kind: observation.kind, status: canApply ? "source-confirmed" : authorized ? "received" : "proposed-unverified",
      recipient: input.address, memberId: authorized ? binding!.memberId : "", operator: outbound.operator, agentId: outbound.agentId,
      persona: outbound.persona, mailbox: outbound.mailbox, subject: header(msg, "Subject"), body: input.body,
      providerMessageId: msg.id, providerThreadId: (msg as GmailMessage & { threadId?: string }).threadId ?? null, replyToId: outbound.id,
      observation: { ...observation, blocker }, sourceTransportVerified: input.proof ? 1 : 0, applied: canApply ? 1 : 0,
    });
    if (canApply) {
      if (handling.handling) task.handling = handling.handling;
      await receipt(tx, { organizationId: outbound.organizationId, actor: binding!.memberId, scope: "it-security-approve",
        country: row.facts.country, caseId: row.id, reference: `${outbound.reference}:${msg.id}`, generation: pilot.generation });
      task.confirmed = [...new Set([...task.confirmed, ...portions])];
      task.outstanding = task.expected.filter(v => !task.confirmed.includes(v));
      task.status = task.exception && !task.exception.disposition ? "review" : task.outstanding.length ? "partial" : "resolved";
      task.evidence.push({ type: "email-source-attestation", sourceId: msg.id, actor: binding!.memberId, interpreter: outbound.agentId,
        generation: pilot.generation, revision: task.revision, recordedAt: new Date().toISOString() });
      if (observation.kind === "exception") {
        task.status = "review";
        task.exception = { revision: (task.exception?.revision ?? 0) + 1, sourceId: msg.id, explanation: observation.explanation, disposition: null, reviewedBy: null };
      }
    } else if (authorized && observation.kind === "exception") {
      // Verified, scoped observation can open review, but never approve it.
      task.status = "review";
      task.exception = { revision: (task.exception?.revision ?? 0) + 1, sourceId: msg.id, explanation: observation.explanation, disposition: null, reviewedBy: null };
    } else if (authorized && observation.kind === "acknowledgment" && task.status === "pending") task.status = "acknowledged";
    const saved = await persistState(tx, pilot, state);
    // Queue a factual receipt/follow-up, not a claim that real operations happened.
    if (communicationAllowed(state) && outbound.enrollmentRevision === e.revision && input.address === binding?.address) {
      const response: Observation = canApply ? { ...observation, explanation: `Recorded ${portions!.join(", ")}; ${task.outstanding.join(", ")} remains outstanding.`,
        question: `Please confirm the outstanding portions: ${task.outstanding.join(", ")}.` } : { ...observation,
        explanation: blocker ? "Received your response; no completion was applied." : observation.explanation,
        question: blocker ? "Please provide an explicit task-specific source attestation, or use authenticated review if your ownership or permissions need correction." : observation.question };
      if (task.status === "resolved") response.explanation = `Recorded source confirmation for ${task.confirmed.join(", ")}. No real account or physical-return outcome was established.`;
      try { await queueExchangeInTransaction(tx, saved, task, task.status === "resolved" ? "receipt" : "follow-up", response); } catch (err) { if (!(err instanceof SeparationError)) throw err; }
    }
  }));
}

async function pollReplies() {
  await withGmailConsumerCoordination(async () => {
    const cursorId = "connected-gmail-offboarding";
    const [saved] = await db.select().from(offbExchangeMailboxState).where(eq(offbExchangeMailboxState.id, cursorId));
    // Retain pagination across heartbeats. The query has no rolling seven-day
    // cutoff that could silently discard a delayed reply to an active task.
    const query = saved?.query ?? "OX- -in:sent -in:drafts";
    const result = await provider().get(`/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50${saved?.pageToken ? `&pageToken=${encodeURIComponent(saved.pageToken)}` : ""}`);
    if (!result.ok) throw new Error("Offboarding Gmail search failed.");
    const list = await result.json() as { messages?: Array<{ id: string }>; nextPageToken?: string };
    for (const ref of list.messages ?? []) {
      const [seen] = await db.select().from(offbExchanges).where(eq(offbExchanges.providerMessageId, ref.id));
      if (seen) continue;
      const [held] = await db.select().from(offbExchangeQuarantine).where(eq(offbExchangeQuarantine.providerMessageId, ref.id));
      if (held) continue;
      const detail = await provider().get(`/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`);
      const raw = await provider().get(`/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=raw`);
      if (!detail.ok || !raw.ok) throw new Error("Offboarding Gmail message fetch failed.");
      const msg = await detail.json() as GmailMessage, source = await raw.json() as { id?: string; raw?: string };
      await ingestExchangeMessage(msg, source.id === msg.id && source.raw ? Buffer.from(source.raw, "base64url").toString("utf8") : "");
    }
    await db.insert(offbExchangeMailboxState).values({ id: cursorId, query, pageToken: list.nextPageToken ?? null })
      .onConflictDoUpdate({ target: offbExchangeMailboxState.id, set: { query, pageToken: list.nextPageToken ?? null, updatedAt: new Date() } });
  });
}
async function scheduleOutstanding() {
  const pilots = await db.select().from(offbExchangePilots);
  for (const p of pilots) {
    if (!communicationAllowed(stateOf(p))) continue;
    try {
      await withSensitiveLifecycleFence(p.organizationId, () => db.transaction(async tx => {
        await acquireCaseDispatchMutationLock(tx, p.organizationId, p.caseId);
        const { pilot, row } = await loadPilot(tx, p.organizationId, p.caseId), state = stateOf(pilot);
        if (!communicationAllowed(state)) return;
        await namedOperator(tx, p.organizationId, state.enrollment.operator!, p.caseId);
        await agentGate(tx, p.organizationId, state.enrollment.operator!, state.enrollment.agentId!, p.caseId);
        await policyGate(tx, row);
        const messages = await tx.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, p.caseId), eq(offbExchanges.direction, "outbound"))).orderBy(desc(offbExchanges.createdAt)).limit(100);
        for (const task of state.tasks) {
          if (task.status === "resolved" || !state.enrollment.recipients.some(r => r.taskId === task.id)) continue;
          const last = messages.find(m => m.taskId === task.id && m.generation === pilot.generation && m.taskRevision === task.revision);
          // Enrollment/opening/estate setup sends nothing. Only explicitly initiated tasks get reminders.
          if (!last || last.status !== "accepted" || Date.now() - (last.attemptedAt ?? last.createdAt).getTime() < 24 * 3600000) continue;
          const overdue = Date.now() > Date.parse(task.dueAt);
          if (overdue && messages.some(m => m.taskId === task.id && m.kind === "escalation" && m.enrollmentRevision === state.enrollment.revision)) continue;
          await queueExchangeInTransaction(tx, pilot, task, overdue ? "escalation" : "follow-up", uncertainObservation("The requested source confirmation remains outstanding."));
        }
      }));
    } catch { logger.warn({ caseId: p.caseId, component: "offboarding-exchanges" }, "Conversation continuation blocked by current admission checks"); }
  }
}
export const runOffboardingExchangeTick = makeSharedTick(async () => {
  if (!controlled.getStore() && (externalProviderDispatchDenied() || process.env.NODE_ENV === "test" || process.env.ONBOARDING_AUTOMATED_TEST === "true")) return;
  const enabled = (await db.select().from(offbExchangePilots)).filter(p => stateOf(p).enrollment.enabled);
  if (!enabled.length) return;
  await pollReplies();
  const uncertain = await db.select().from(offbExchanges).where(eq(offbExchanges.status, "ambiguous")).limit(5);
  for (const m of uncertain) {
    try { await reconcileAcceptedExchange(m.id); }
    catch { logger.warn({ caseId: m.caseId }, "Gmail acceptance reconciliation blocked; no resend attempted"); }
  }
  await scheduleOutstanding();
  const messages = await db.select().from(offbExchanges).where(eq(offbExchanges.status, "queued")).limit(20);
  for (const message of messages) {
    try { await dispatchExchange(message.id); }
    catch { logger.warn({ caseId: message.caseId, component: "offboarding-exchanges" }, "Gmail request blocked; no send acceptance recorded"); }
  }
});
