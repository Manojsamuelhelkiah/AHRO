import { deleteTestOrganizations } from "../../test-support/organization-fixtures";
import { after, before, test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { twilioSignatureValid } from "./twilio-signature";
import { stripQuotedReply, persistInbound, alreadyRecorded } from "./inbound-email";
import { db } from "@workspace/db";
import { onbCases, onbCommunications, onbSensitiveLifecyclePolicies, organizationsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

/* ------------------------- stripQuotedReply ------------------------- */

describe("stripQuotedReply", () => {
  test("keeps a plain message untouched", () => {
    assert.equal(stripQuotedReply("What time should I arrive?"), "What time should I arrive?");
  });

  test("cuts at an 'On ... wrote:' marker", () => {
    const text = "Thanks, that helps!\n\nOn Mon, Aug 10, 2026 at 9:00 AM Onboarding <x@y.com> wrote:\n> Welcome aboard";
    assert.equal(stripQuotedReply(text), "Thanks, that helps!");
  });

  test("drops '>'-quoted lines", () => {
    const text = "New question here\n> old quoted line\n> another quoted line";
    assert.equal(stripQuotedReply(text), "New question here");
  });

  test("cuts at an Original Message separator", () => {
    const text = "Reply body\n-----Original Message-----\nFrom: someone";
    assert.equal(stripQuotedReply(text), "Reply body");
  });

  test("cuts at an Outlook underscore separator", () => {
    const text =
      "Classification: Internal\n\nAPPROVE\n\nGet Outlook for Android<https://aka.ms/x>\n________________________________\nFrom: Onboarding <x@y.com>\nSent: Monday\nTo: approver\nSubject: [AP-31] Approval needed\nReply approve or reject to decide.";
    assert.equal(stripQuotedReply(text), "Classification: Internal\n\nAPPROVE\n\nGet Outlook for Android<https://aka.ms/x>");
  });

  test("cuts at a bare 'From:' header line", () => {
    const text = "approve\nFrom: Onboarding <x@y.com>\nSubject: contains reject wording";
    assert.equal(stripQuotedReply(text), "approve");
  });
});

/* ---------------------- Twilio signature check ---------------------- */

describe("twilioSignatureValid", () => {
  const token = "test-auth-token";
  const url = "https://example.replit.app/api/onboarding/webhooks/twilio/whatsapp";
  const params = { From: "whatsapp:+15551234567", Body: "hello", MessageSid: "SM123" };
  const sign = (u: string, p: Record<string, string>, t: string) =>
    createHmac("sha1", t)
      .update(u + Object.keys(p).sort().map((k) => k + p[k]).join(""), "utf8")
      .digest("base64");

  test("accepts a correctly signed request", () => {
    assert.equal(
      twilioSignatureValid({ token, signature: sign(url, params, token), url, params }),
      true,
    );
  });

  test("rejects a tampered body", () => {
    const signature = sign(url, params, token);
    assert.equal(
      twilioSignatureValid({ token, signature, url, params: { ...params, Body: "evil" } }),
      false,
    );
  });

  test("rejects a signature made with the wrong token", () => {
    assert.equal(
      twilioSignatureValid({ token, signature: sign(url, params, "other-token"), url, params }),
      false,
    );
  });

  test("rejects missing signature or token", () => {
    assert.equal(twilioSignatureValid({ token, signature: undefined, url, params }), false);
    assert.equal(
      twilioSignatureValid({ token: undefined, signature: sign(url, params, token), url, params }),
      false,
    );
  });
});

/* ------------------- inbound dedup (integration) --------------------- */

const hasDb = Boolean(process.env.DATABASE_URL);
const DEMO_ORGANIZATION_ID = `inbound-dedup-${process.pid}`;

describe("inbound dedup by provider message id", { skip: !hasDb }, () => {
  before(async () => {
    await db.insert(organizationsTable).values({
      id: DEMO_ORGANIZATION_ID,
      name: "Inbound dedup test",
      slug: DEMO_ORGANIZATION_ID,
      joinCodeHash: `hash-${DEMO_ORGANIZATION_ID}`,
      createdByUserId: "inbound-dedup-test",
    });
    await seedApprovedSensitiveLifecyclePolicies(DEMO_ORGANIZATION_ID);
  });
  after(async () => {
    await db.delete(onbSensitiveLifecyclePolicies).where(
      eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID),
    );
    await deleteTestOrganizations(eq(organizationsTable.id, DEMO_ORGANIZATION_ID));
  });

  test("duplicate provider ids and own outbound ids are skipped", async () => {
    const [c] = await db
      .insert(onbCases)
      .values({
        organizationId: DEMO_ORGANIZATION_ID,
        workerName: "__Test Inbound Dedup__",
        workerEmail: "dedup-test@example.com",
        hireType: "new-hire",
        workerCategory: "employee",
        role: "Test Role",
        department: "QA",
        geography: "US",
        legalEntity: "TestCo",
        managerName: "Mgr",
        recruiterName: "Rec",
        joiningDate: "2026-09-01",
        workforceContext: { workCountry: "US" },
      })
      .returning({ id: onbCases.id, organizationId: onbCases.organizationId });
    try {
      const msg = {
        caseId: c.id,
        organizationId: c.organizationId,
        channel: "email" as const,
        fromAddress: "dedup-test@example.com",
        subject: "Test",
        body: "hello",
        externalMessageId: `test-${Date.now()}`,
      };
      // First delivery is recorded, retry of the same provider id is not.
      assert.equal(await persistInbound(msg), true);
      assert.equal(await persistInbound(msg), false);

      // An id already stored on one of our own outbound sends (Gmail echo)
      // is recognised by the poller's alreadyRecorded check and never
      // re-ingested as inbound.
      const outboundId = `test-out-${Date.now()}`;
      await db.insert(onbCommunications).values({
        caseId: c.id,
        organizationId: c.organizationId,
        channel: "email",
        direction: "outbound",
        toAddress: "de***@example.com",
        subject: "Welcome",
        body: "welcome",
        status: "sent",
        externalMessageId: outboundId,
      });
      assert.equal(await alreadyRecorded(outboundId, c.organizationId), true);
      assert.equal(await persistInbound({ ...msg, externalMessageId: outboundId }), false);
    } finally {
      await db.delete(onbCases).where(eq(onbCases.id, c.id)); // cascades to communications
    }
  });
});
