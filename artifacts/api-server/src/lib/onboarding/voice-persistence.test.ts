import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
/**
 * DB persistence + crash-recovery tests for AI voice-call sessions (real DB).
 *
 * These exercise the durability contract of onb_voice_sessions:
 *  - a session written by one "process" is readable by another (restart)
 *  - a late/expired callback still finalizes: transcript row + decisions
 *  - finalization is claim-based and idempotent (no duplicate side effects)
 *  - a stale in-flight turn save cannot flip a finalized row back
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import {
  onbCases,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbGovernanceDecisions,
  onbGovernanceRequirements,
  onbSensitiveLifecyclePolicies,
  onbVoiceSessions,
  organizationsTable,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import {
  getVoiceSession,
  finalizeVoiceCall,
  recoverStaleVoiceSessions,
  saveSession,
  markOutcomeStep,
  claimCallStart,
  FencedFinalizationError,
  type Session,
} from "./voice";
import { onbApprovals, onbCallSlots } from "@workspace/db/schema";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

const organizationId = `voice-persistence-${process.pid}-${Date.now()}`;

async function makeCase(): Promise<number> {
  const [c] = await db
    .insert(onbCases)
    .values({
      organizationId,
      workerName: "Voice Test Hire",
      workerEmail: "voice-test@example.com",
      workerPhone: "+15550001111",
      hireType: "experienced",
      workerCategory: "employee",
      role: "Engineer",
      department: "R&D",
      geography: "India",
      legalEntity: "TestCo",
      managerName: "M Manager",
      recruiterName: "R Recruiter",
      joiningDate: "2026-09-01",
      workforceContext: { workCountry: "US" },
    })
    .returning({ id: onbCases.id });
  return c.id;
}

function liveSession(token: string, caseId: number, startedAt = Date.now()): Session {
  return {
    token,
    caseId,
    scenario: "day-before",
    reason: null,
    turns: [
      { role: "agent", text: "Hello, are you ready for tomorrow?" },
      { role: "hire", text: "Yes, all set." },
    ],
    decisions: [{ decision: "confirmed-ready", note: "test decision" }],
    finalized: false,
    simulated: false,
    startedAt,
    callSid: null,
    lastSpeech: null,
    lastResponse: null,
  };
}

async function insertSessionRow(s: Session): Promise<void> {
  await db.insert(onbVoiceSessions).values({
    token: s.token,
    organizationId: s.organizationId ?? organizationId,
    caseId: s.caseId,
    scenario: s.scenario,
    reason: s.reason,
    turns: s.turns,
    decisions: s.decisions,
    startedAt: new Date(s.startedAt),
  });
}

describe("voice session persistence (real DB)", () => {
  const caseIds: number[] = [];
  before(async () => {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Voice persistence test",
      slug: organizationId,
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: "voice-persistence-test",
    });
    // Voice outcome persistence retains a candidate-voice transcript. These
    // are explicit collection-only lifecycle approvals, not a provider bypass.
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
  });
  after(async () => {
    for (const id of caseIds) await db.delete(onbCases).where(eq(onbCases.id, id));
    await db.delete(onbEffectJournal).where(eq(onbEffectJournal.organizationId, organizationId));
    await db.delete(onbSensitiveLifecyclePolicies).where(
      eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    );
    await db.delete(onbGovernanceRequirements).where(
      eq(onbGovernanceRequirements.organizationId, organizationId),
    );
    await db.delete(onbGovernanceDecisions).where(
      eq(onbGovernanceDecisions.organizationId, organizationId),
    );
    await deleteTestOrganizations(eq(organizationsTable.id, organizationId));
  });

  test("a session survives a 'restart': fresh read sees turns and binds CallSid", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-restart-${caseId}`, caseId);
    await insertSessionRow(s);

    // Simulates a new process: no in-memory state, read straight from DB.
    const loaded = await getVoiceSession(s.token, "CAtest-restart");
    assert.ok(loaded, "session should load from the DB after a restart");
    assert.equal(loaded.turns.length, 2);
    assert.equal(loaded.callSid, "CAtest-restart");

    // A different CallSid must be rejected.
    assert.equal(await getVoiceSession(s.token, "CAother"), undefined);
  });

  test("an expired callback still yields a transcript row and executes decisions", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-expired-${caseId}`, caseId, Date.now() - 45 * 60_000);
    await insertSessionRow(s);

    const loaded = await getVoiceSession(s.token);
    assert.equal(loaded, undefined, "expired session is not returned live");

    const comms = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "voice")));
    assert.equal(comms.length, 1, "transcript row must land despite expiry");
    assert.match(comms[0].body, /all set/);

    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    assert.ok(
      events.some((e) => e.title === "Hire confirmed ready on call"),
      "confirmed-ready decision must be executed",
    );

    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true);
  });

  test("startup recovery finalizes stale sessions exactly once", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-recover-${caseId}`, caseId, Date.now() - 45 * 60_000);
    await insertSessionRow(s);

    const first = await recoverStaleVoiceSessions();
    assert.ok(first >= 1);
    await recoverStaleVoiceSessions(); // second sweep must be a no-op for this session

    const comms = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "voice")));
    assert.equal(comms.length, 1, "recovery must not duplicate the transcript");
  });

  test("concurrent finalization: exactly one transcript row and one decision execution", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-race-${caseId}`, caseId);
    await insertSessionRow(s);

    // Two independent snapshots (e.g. status callback on two instances).
    const snapA = liveSession(s.token, caseId, s.startedAt);
    const snapB = liveSession(s.token, caseId, s.startedAt);
    await Promise.all([
      finalizeVoiceCall(snapA, "completed"),
      finalizeVoiceCall(snapB, "completed"),
    ]);

    const comms = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "voice")));
    assert.equal(comms.length, 1, "DB claim must dedupe concurrent finalizations");

    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    assert.equal(
      events.filter((e) => e.title === "Hire confirmed ready on call").length,
      1,
      "decision side effects must run exactly once",
    );
  });

  test("a stale in-flight turn save cannot unfinalize or mutate a finalized call", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-staleturn-${caseId}`, caseId);
    await insertSessionRow(s);

    // Turn handler took a snapshot, then the status callback finalized.
    const staleTurnSnapshot = liveSession(s.token, caseId, s.startedAt);
    staleTurnSnapshot.turns.push({ role: "agent", text: "LATE TURN that must not persist" });
    await finalizeVoiceCall(liveSession(s.token, caseId, s.startedAt), "completed");

    const saved = await saveSession(staleTurnSnapshot);
    assert.equal(saved, false, "guarded save must refuse to touch a finalized row");

    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true, "row must stay finalized");
    assert.ok(
      !JSON.stringify(row.turns).includes("LATE TURN"),
      "stale turn must not overwrite the persisted transcript",
    );
  });

  test("crash after lease claim, before any persistence: recovery resumes and records everything", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-crashclaim-${caseId}`, caseId);
    await insertSessionRow(s);
    // Simulate: a finalizer claimed the lease, then the process died.
    await db
      .update(onbVoiceSessions)
      .set({ finalizeLeaseAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(onbVoiceSessions.token, s.token));

    const recovered = await recoverStaleVoiceSessions();
    assert.ok(recovered >= 1, "expired-lease session must be picked up by recovery");

    const comms = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "voice")));
    assert.equal(comms.length, 1);
    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    assert.equal(events.filter((e) => e.title === "Hire confirmed ready on call").length, 1);
    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true);
  });

  test("crash mid-persistence: recovery finishes remaining steps without duplicating done ones", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-crashmid-${caseId}`, caseId);
    await insertSessionRow(s);
    // Simulate: transcript step completed (comm row + progress marker),
    // then the process died before the decision/summary steps.
    await db.insert(onbCommunications).values({
      caseId,
      organizationId,
      channel: "voice",
      direction: "outbound",
      toAddress: "masked",
      subject: "Day-before check-in call",
      body: "Assistant: partial transcript",
      status: "completed",
      failureReason: null,
      sensitive: false,
      externalMessageId: `voice-call:${s.token}`,
    });
    await db
      .update(onbVoiceSessions)
      .set({
        finalizeLeaseAt: new Date(Date.now() - 10 * 60_000),
        outcomeProgress: { transcript: true },
      })
      .where(eq(onbVoiceSessions.token, s.token));

    await recoverStaleVoiceSessions();

    const comms = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "voice")));
    assert.equal(comms.length, 1, "already-persisted transcript must not be duplicated");
    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    assert.equal(
      events.filter((e) => e.title === "Hire confirmed ready on call").length,
      1,
      "pending decision must be executed on resume",
    );
    assert.equal(
      events.filter((e) => e.title.startsWith("Day-before check-in call completed")).length,
      1,
      "summary event must land on resume",
    );
    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true);
  });

  test("a live (unexpired) lease blocks a competing finalizer", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-lease-${caseId}`, caseId);
    await insertSessionRow(s);
    await db
      .update(onbVoiceSessions)
      .set({ finalizeLeaseAt: new Date() })
      .where(eq(onbVoiceSessions.token, s.token));

    await finalizeVoiceCall(liveSession(s.token, caseId, s.startedAt), "completed");

    const comms = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "voice")));
    assert.equal(comms.length, 0, "competing finalizer must yield to the live lease");
    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, false);
  });

  test("crash after a side effect but before its marker: resume does not duplicate it", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-crashfx-${caseId}`, caseId);
    await insertSessionRow(s);
    // Simulate: the confirmed-ready event WAS written (idempotency key
    // present) but the process died before markOutcomeStep committed.
    await db.insert(onbEvents).values({
      caseId,
      organizationId,
      agent: "channel",
      engine: "llm",
      title: "Hire confirmed ready on call",
      detail: "written just before the crash",
      idempotencyKey: `voice:${s.token}:confirmed-ready`,
    });
    await db
      .update(onbVoiceSessions)
      .set({
        finalizeLeaseAt: new Date(Date.now() - 10 * 60_000),
        finalizeOwner: "crashed-owner",
        outcomeProgress: { transcript: true },
      })
      .where(eq(onbVoiceSessions.token, s.token));

    await recoverStaleVoiceSessions();

    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    assert.equal(
      events.filter((e) => e.title === "Hire confirmed ready on call").length,
      1,
      "unique idempotency key must swallow the resumed re-insert",
    );
    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true);
  });

  test("a finalizer that lost its lease is fenced out of progress and terminal writes", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-fence-${caseId}`, caseId);
    await insertSessionRow(s);
    // Owner A claimed, then stalled past its lease; recovery reclaimed and finalized.
    await db
      .update(onbVoiceSessions)
      .set({ finalizeLeaseAt: new Date(Date.now() - 10 * 60_000), finalizeOwner: "slow-owner-A" })
      .where(eq(onbVoiceSessions.token, s.token));
    await recoverStaleVoiceSessions();
    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true, "recovery reclaimed the expired lease and finalized");

    // The stalled owner A wakes up and tries to write progress — must be fenced.
    const stale = { ...liveSession(s.token, caseId), finalizeOwner: "slow-owner-A" };
    await assert.rejects(
      markOutcomeStep(stale, {}, "decision:confirmed-ready"),
      FencedFinalizationError,
      "stale owner must not be able to write after losing the lease",
    );
  });

  test("turn saves are blocked while a finalization lease is held", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-leaseblock-${caseId}`, caseId);
    await insertSessionRow(s);
    await db
      .update(onbVoiceSessions)
      .set({ finalizeLeaseAt: new Date(), finalizeOwner: "live-finalizer" })
      .where(eq(onbVoiceSessions.token, s.token));

    s.turns.push({ role: "hire", text: "one more thing..." });
    assert.equal(await saveSession(s), false, "turn save must be rejected while the lease is live");

    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal((row.turns as unknown[]).length, 2, "late turn must not slip behind the finalizer's snapshot");
  });

  test("crash after committing email intent: resume never resends, raises a verify approval", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-emailintent-${caseId}`, caseId);
    s.decisions = [{ decision: "reschedule-kickoff", note: "test reschedule" }];
    await insertSessionRow(s);
    await db
      .update(onbVoiceSessions)
      .set({
        finalizeLeaseAt: new Date(Date.now() - 10 * 60_000),
        finalizeOwner: "crashed-owner",
        decisions: s.decisions,
        outcomeProgress: { transcript: true, "decision:reschedule-kickoff:email-intent": true },
      })
      .where(eq(onbVoiceSessions.token, s.token));

    await recoverStaleVoiceSessions();

    const approvals = await db.select().from(onbApprovals).where(eq(onbApprovals.caseId, caseId));
    assert.equal(
      approvals.filter((a) => a.recommendation.startsWith("Verify the promised kick-off reschedule email")).length,
      1,
      "uncertain email window must surface a human-verify approval instead of a resend",
    );
    // No reschedule email event (which would indicate an actual send attempt).
    const events = await db.select().from(onbEvents).where(eq(onbEvents.caseId, caseId));
    assert.equal(events.filter((e) => e.title === "Kick-off reschedule agreed on call").length, 0);
    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true);
  });

  test("crash after slot proposal but before its marker: resume does not duplicate the proposal", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-crashslots-${caseId}`, caseId);
    s.decisions = [{ decision: "reschedule-kickoff", note: "test reschedule" }];
    await insertSessionRow(s);
    // Simulate: proposeSlots committed (dedupe-keyed row exists) but the
    // process died before the email-intent marker was written.
    const storedSlots = [{ n: 1, startIso: "2026-08-20T10:00:00.000Z", label: "Thu 20 Aug, 10:00 AM IST" }];
    await db.insert(onbCallSlots).values({
      caseId,
      organizationId,
      slots: storedSlots,
      status: "proposed",
      dedupeKey: `voice:${s.token}:reschedule-slots`,
    });
    await db
      .update(onbVoiceSessions)
      .set({
        finalizeLeaseAt: new Date(Date.now() - 10 * 60_000),
        finalizeOwner: "crashed-owner",
        decisions: s.decisions,
        outcomeProgress: { transcript: true },
      })
      .where(eq(onbVoiceSessions.token, s.token));

    await recoverStaleVoiceSessions();

    const proposals = await db
      .select()
      .from(onbCallSlots)
      .where(eq(onbCallSlots.caseId, caseId));
    assert.equal(proposals.length, 1, "resumed proposeSlots must conflict on the dedupe key, not insert again");
    assert.equal(proposals[0].status, "proposed", "the original proposal must not be superseded by its own rerun");
    // The resumed email must offer the ORIGINALLY stored slots.
    // Only the reschedule email itself must carry the stored slots — the
    // case may also hold unrelated emails (e.g. the HR-approver
    // notification raised when delivery is blocked).
    const comms = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "email")));
    const rescheduleEmails = comms.filter((c) => (c.subject ?? "").includes("New kick-off call times"));
    assert.ok(rescheduleEmails.length > 0, "the resumed recovery must compose the reschedule email");
    for (const comm of rescheduleEmails) {
      assert.ok(comm.body.includes("Thu 20 Aug"), "emailed slots must match the stored proposal");
    }
    const [row] = await db.select().from(onbVoiceSessions).where(eq(onbVoiceSessions.token, s.token));
    assert.equal(row.finalized, true);
  });

  test("concurrent call-start claims: exactly one wins the live-call slot per case", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    // Ten simultaneous starts (each with a fresh token, as startVoiceCall
    // generates) race for the same case's live slot; the partial unique
    // index must let exactly one through — only that one may dial Twilio.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claimCallStart(liveSession(`vt-race-${caseId}-${i}`, caseId))),
    );
    assert.equal(results.filter(Boolean).length, 1, "exactly one concurrent claim must win");
    const rows = await db
      .select()
      .from(onbVoiceSessions)
      .where(and(eq(onbVoiceSessions.caseId, caseId), eq(onbVoiceSessions.finalized, false)));
    assert.equal(rows.length, 1, "only one live session row may exist for the case");

    // While that call is live, another start attempt must lose too.
    assert.equal(await claimCallStart(liveSession(`vt-race-${caseId}-late`, caseId)), false);

    // Once finalized, the slot frees up for a new call.
    await finalizeVoiceCall(liveSession(rows[0].token, caseId, rows[0].startedAt.getTime()), "completed");
    assert.equal(await claimCallStart(liveSession(`vt-race-${caseId}-next`, caseId)), true);
  });

  test("finalization picks up turns saved after the finalizer's snapshot was taken", async () => {
    const caseId = await makeCase();
    caseIds.push(caseId);
    const s = liveSession(`vt-fresh-${caseId}`, caseId);
    await insertSessionRow(s);

    // A turn lands in the DB after the (stale) finalizer snapshot was taken.
    const turnSnapshot = liveSession(s.token, caseId, s.startedAt);
    turnSnapshot.turns.push({ role: "agent", text: "FRESH CLOSING LINE" });
    assert.equal(await saveSession(turnSnapshot), true);

    const staleFinalizerSnapshot = liveSession(s.token, caseId, s.startedAt);
    await finalizeVoiceCall(staleFinalizerSnapshot, "completed");

    const [comm] = await db
      .select()
      .from(onbCommunications)
      .where(and(eq(onbCommunications.caseId, caseId), eq(onbCommunications.channel, "voice")));
    assert.match(comm.body, /FRESH CLOSING LINE/, "finalize must use the freshest DB state");
  });
});
