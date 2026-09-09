import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbCases, onbCommunications } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { retryCandidateEmail } from "./channels";
import { DEMO_VOLUNTEERS_KEY, refreshDemoAllowlist } from "./demo-volunteers";
import { getSetting, setSetting } from "./settings";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("email retry durable claim", { skip: !hasDb }, () => {
  test("two concurrent retries claim one row and invoke the injected provider once", async () => {
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test Email Retry Claim__",
      workerEmail: "retry-claim@example.com",
      channelPreference: "email",
      candidateEmailAuthorizedAt: new Date(),
      candidateEmailAuthorizedBy: "test-reviewer",
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
    }).returning({ id: onbCases.id });
    try {
      const [message] = await db.insert(onbCommunications).values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        channel: "email",
        direction: "outbound",
        audience: "candidate",
        toAddress: "re***@example.com",
        subject: "Welcome",
        body: "Original durable body",
        status: "failed",
        failureReason: "Gmail 500: test failure",
      }).returning({ id: onbCommunications.id });
      let providerCalls = 0;
      const fakeProvider = async (_to: string, _subject: string, _body: string) => {
        providerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "sent", failureReason: null, externalMessageId: "fake-message-id" };
      };
      const [first, second] = await Promise.all([
        retryCandidateEmail(c.id, message.id, "reviewer-a", fakeProvider),
        retryCandidateEmail(c.id, message.id, "reviewer-b", fakeProvider),
      ]);
      assert.equal([first, second].filter((r) => r.ok).length, 1);
      assert.equal(providerCalls, 1);
      const [stored] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, message.id));
      assert.equal(stored.status, "sent");
      assert.equal(stored.externalMessageId, "fake-message-id");
      assert.equal(stored.body, "Original durable body");
    } finally {
      await db.delete(onbCases).where(eq(onbCases.id, c.id));
    }
  });

  test("a claimed retry stopped by the live-send cap is logged-only and never invokes provider", async () => {
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test Capped Email Retry__",
      workerEmail: "retry-capped@example.com",
      channelPreference: "email",
      candidateEmailAuthorizedAt: new Date(),
      candidateEmailAuthorizedBy: "test-reviewer",
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
    }).returning({ id: onbCases.id });
    try {
      const [message] = await db.insert(onbCommunications).values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        channel: "email",
        direction: "outbound",
        audience: "candidate",
        toAddress: "re***@example.com",
        subject: "Welcome",
        body: "Original capped body",
        status: "failed",
        failureReason: "Gmail 500: test failure",
      }).returning({ id: onbCommunications.id });
      let providerCalls = 0;
      const fakeProvider = async (_to: string, _subject: string, _body: string) => {
        providerCalls += 1;
        return { status: "sent", failureReason: null, externalMessageId: "must-not-send" };
      };
      const result = await retryCandidateEmail(
        c.id,
        message.id,
        "reviewer",
        fakeProvider,
        () => false,
      );
      assert.equal(result.ok, true);
      assert.equal(providerCalls, 0);
      const [stored] = await db.select().from(onbCommunications).where(eq(onbCommunications.id, message.id));
      assert.equal(stored.status, "logged-only");
      assert.equal(stored.failureReason, "Hourly live-send limit reached — message logged, not delivered.");
      assert.equal(stored.body, "Original capped body");
    } finally {
      await db.delete(onbCases).where(eq(onbCases.id, c.id));
    }
  });

  test("retry refreshes explicit demo-volunteer fallback without case autoauthorization", async () => {
    const previousVolunteers = await getSetting(DEMO_ORGANIZATION_ID, DEMO_VOLUNTEERS_KEY);
    const email = "retry-volunteer@example.com";
    await setSetting(DEMO_ORGANIZATION_ID, DEMO_VOLUNTEERS_KEY, JSON.stringify([{
      name: "Retry Volunteer",
      email,
      channelPreference: "email",
    }]));
    const [c] = await db.insert(onbCases).values({
      organizationId: DEMO_ORGANIZATION_ID,
      workerName: "__Test Volunteer Retry__",
      workerEmail: email,
      channelPreference: "email",
      candidateEmailAuthorizedAt: null,
      candidateEmailAuthorizedBy: null,
      hireType: "new-hire",
      workerCategory: "employee",
      role: "Test Role",
      department: "QA",
      geography: "US",
      legalEntity: "TestCo",
      managerName: "Mgr",
      recruiterName: "Rec",
      joiningDate: "2026-09-01",
    }).returning({ id: onbCases.id });
    try {
      const [message] = await db.insert(onbCommunications).values({
        organizationId: DEMO_ORGANIZATION_ID,
        caseId: c.id,
        channel: "email",
        direction: "outbound",
        audience: "candidate",
        toAddress: "re***@example.com",
        subject: "Welcome",
        body: "Volunteer body",
        status: "logged-only",
        failureReason: "Previously blocked",
      }).returning({ id: onbCommunications.id });
      let deliveredTo = "";
      const result = await retryCandidateEmail(
        c.id,
        message.id,
        "reviewer",
        async (to) => {
          deliveredTo = to;
          return { status: "sent", failureReason: null, externalMessageId: "fake-volunteer-message" };
        },
        () => true,
      );
      assert.equal(result.ok, true);
      assert.equal(deliveredTo, email);
    } finally {
      await db.delete(onbCases).where(eq(onbCases.id, c.id));
      await setSetting(DEMO_ORGANIZATION_ID, DEMO_VOLUNTEERS_KEY, previousVolunteers);
      await refreshDemoAllowlist(DEMO_ORGANIZATION_ID);
    }
  });
});