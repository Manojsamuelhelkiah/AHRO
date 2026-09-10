import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  onbCases,
  onbCommunications,
  organizationsTable,
} from "@workspace/db";
import {
  collectCaseExplainabilityEvidence,
  redactExplainabilityText,
} from "./case-explainability-evidence";

const suffix = `${process.pid}-${randomUUID()}`;
const organizationId = `explain-evidence-${suffix}`;
const workerEmail = `evidence-worker-${suffix}@example.com`;
const hasDb = Boolean(process.env.DATABASE_URL);
let caseId: number | undefined;

test("redacts candidate identifiers, contacts, URLs, and token-shaped values", () => {
  const redacted = redactExplainabilityText(
    `Candidate Ada Lovelace can be reached at ada@example.com or +1 (555) 010-2020. Visit https://private.example.test/token?x=1. Bearer abcdefghijklmnopqrstuvwxyz123456.`,
    ["Ada Lovelace", "ada@example.com", "+1 (555) 010-2020"],
  );
  assert.doesNotMatch(redacted, /Ada Lovelace|ada@example\.com|555|https:\/\/|Bearer|abcdefghijklmnopqrstuvwxyz/i);
  assert.match(redacted, /\[redacted identifier\]/);
  assert.match(redacted, /\[redacted URL\]/);
  assert.match(redacted, /\[redacted token\]/);
});

describe("case evidence communications (real DB, read-only collector)", { skip: !hasDb }, () => {
  before(async () => {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Explainability evidence test",
      slug: organizationId,
      joinCodeHash: `hash-${organizationId}`,
      createdByUserId: `user-${suffix}`,
    });
    const [row] = await db.insert(onbCases).values({
      organizationId,
      workerName: "Evidence Worker",
      workerEmail,
      hireType: "external",
      workerCategory: "full-time",
      role: "Engineer",
      department: "Engineering",
      geography: "US",
      legalEntity: "Example",
      managerName: "Manager",
      recruiterName: "Recruiter",
      joiningDate: "2030-01-01",
    }).returning({ id: onbCases.id });
    caseId = row!.id;
    await db.insert(onbCommunications).values([
      {
        organizationId,
        caseId,
        channel: "email",
        direction: "outbound",
        audience: "candidate",
        toAddress: workerEmail,
        subject: "Private sensitive message",
        body: `Sensitive private content for ${workerEmail}`,
        status: "sent",
        sensitive: true,
      },
      {
        organizationId,
        caseId,
        channel: "voice",
        direction: "outbound",
        audience: "candidate",
        toAddress: "masked",
        subject: "Check-in transcript",
        body: `We spoke with Evidence Worker. Contact ${workerEmail}; see https://private.example.test and token=secret-value.`,
        status: "completed",
        sensitive: false,
      },
    ]);
  });

  after(async () => {
    if (caseId !== undefined) {
      await db.delete(onbCases).where(and(
        eq(onbCases.organizationId, organizationId),
        eq(onbCases.id, caseId),
      ));
    }
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  });

  test("excludes sensitive communications, includes redacted voice excerpts, and does not mutate DB", async () => {
    const beforeRows = await db.select({
      id: onbCommunications.id,
      body: onbCommunications.body,
      sensitive: onbCommunications.sensitive,
    }).from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, organizationId),
      eq(onbCommunications.caseId, caseId!),
    ));
    const evidence = await collectCaseExplainabilityEvidence(organizationId, caseId!);
    assert.ok(evidence);
    const communications = evidence.sources.filter((source) =>
      source.tab === "communications");
    assert.equal(communications.length, 1);
    assert.equal(communications[0]?.kind, "voice-transcript");
    assert.doesNotMatch(communications[0]?.excerpt ?? "", /evidence-worker-|private\.example|secret-value/i);
    assert.match(communications[0]?.excerpt ?? "", /redacted/i);

    const afterRows = await db.select({
      id: onbCommunications.id,
      body: onbCommunications.body,
      sensitive: onbCommunications.sensitive,
    }).from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, organizationId),
      eq(onbCommunications.caseId, caseId!),
    ));
    assert.deepEqual(afterRows, beforeRows);
  });
});