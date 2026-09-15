import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  DEMO_ORGANIZATION_ID,
  db,
  onbAuthorityAssignments,
  onbCandidateLinks,
  onbCaseLogistics,
  onbCases,
  onbCommunications,
  onbEffectJournal,
  onbEvents,
  onbReadinessSlaCaseState,
  onbReadinessSlaLedger,
  onbReadinessSlaOutbox,
  onbReadinessSlaSnapshots,
  onbSensitiveLifecyclePolicies,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { SENSITIVE_DATA_CLASSES } from "../lib/onboarding/sensitive-lifecycle";
import {
  SYNTHETIC_DEMO_AUTHORITY_SOURCE,
  SYNTHETIC_OFFLINE_MARKER,
} from "../lib/onboarding/synthetic-offline";
import { AUTHORITY_ROLES } from "../lib/onboarding/decision-authority";
import { demoPrincipalSettingKey } from "../lib/demo-principal";
import {
  createTenantContextMiddleware,
  lookupMembership,
} from "../middlewares/tenant-context";
import { errorHandler } from "../middlewares/error-handler";
import onboardingRouter from "./onboarding";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `${process.pid}-${randomUUID()}`;
const administrator = `synthetic-create-admin-${suffix}`;
const reviewer = `synthetic-create-reviewer-${suffix}`;
const foreignOrganizationId = `synthetic-create-foreign-${suffix}`;
const policyRevision = 1_000_000 + Number.parseInt(
  randomUUID().replaceAll("-", "").slice(0, 6),
  16,
);
const fixtureWorkerName = `Synthetic Route Worker ${suffix}`;
let server: Server | undefined;
let baseUrl = "";
const createdCaseIds: number[] = [];

function intake(workerName = fixtureWorkerName) {
  return {
    workerName,
    workerEmail: `synthetic-route-${suffix}@example.invalid`,
    channelPreference: "both",
    hireType: "external-fte",
    workerCategory: "employee",
    role: "Demo Engineer",
    department: "Quality",
    geography: "US",
    legalEntity: "Demo Organization",
    managerName: "Demo Manager",
    recruiterName: "Demo Recruiter",
    joiningDate: "2035-01-01",
    urgency: "normal",
    offerAcceptanceComplete: false,
    workforceContext: {
      workCountry: "US",
      workEnvironment: "office",
      siteExposure: false,
      safetyCritical: false,
    },
  };
}

async function request(userId: string, organizationId: string, path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      "x-organization-id": organizationId,
      ...(init?.headers ?? {}),
    },
  });
}

describe("Demo Administrator synthetic Create Case", { skip: !hasDb }, () => {
  before(async () => {
    const existing = await db.select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, DEMO_ORGANIZATION_ID))
      .limit(1);
    if (!existing.length) {
      await db.insert(organizationsTable).values({
        id: DEMO_ORGANIZATION_ID,
        name: "Development Demo",
        slug: "development-demo",
        joinCodeHash: `test-demo-${suffix}`,
        createdByUserId: administrator,
      });
    }
    await db.insert(organizationsTable).values({
      id: foreignOrganizationId,
      name: "Foreign tenant",
      slug: foreignOrganizationId,
      joinCodeHash: `test-foreign-${suffix}`,
      createdByUserId: administrator,
    });
    await db.insert(organizationMembershipsTable).values([
      { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: administrator, role: "member" },
      { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: reviewer, role: "member" },
      // The registered profile ceiling, rather than the absence of a foreign
      // membership, must deny the foreign-tenant request.
      { organizationId: foreignOrganizationId, clerkUserId: administrator, role: "owner" },
    ]);
    await db.insert(onbSettings).values([
      {
        organizationId: DEMO_ORGANIZATION_ID,
        key: demoPrincipalSettingKey(administrator),
        value: "administrator",
      },
      {
        organizationId: DEMO_ORGANIZATION_ID,
        key: demoPrincipalSettingKey(reviewer),
        value: "reviewer",
      },
    ]);
    // The production route continues to use the normal sensitive-lifecycle
    // gate. These short-lived, test-owned approvals establish that the
    // synthetic path does not bypass that protection.
    await db.insert(onbSensitiveLifecyclePolicies).values(
      SENSITIVE_DATA_CLASSES.map((dataClass) => ({
        organizationId: DEMO_ORGANIZATION_ID,
        dataClass,
        jurisdiction: "US",
        revision: policyRevision,
        purpose: "Synthetic route test lifecycle policy",
        lawfulBasis: "Synthetic route test lifecycle basis",
        retentionDays: 1,
        providerSharingApproved: false,
        permittedProviders: [],
        policyReference: `synthetic-route-test:${suffix}:${dataClass}`,
        approvalReference: `synthetic-route-test:${suffix}:${dataClass}`,
        approvedByUserId: administrator,
        approvedAuthorityAssignmentId: 1,
        isCurrent: true,
      })),
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.authUserId = String(req.header("x-test-user") ?? "");
      next();
    });
    app.use(createTenantContextMiddleware(lookupMembership));
    app.use(onboardingRouter);
    app.use(errorHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()),
    );
    if (createdCaseIds.length > 0) {
      await db.delete(onbAuthorityAssignments).where(and(
        inArray(onbAuthorityAssignments.caseId, createdCaseIds),
        eq(onbAuthorityAssignments.personUserId, administrator),
      ));
      await db.delete(onbCases).where(inArray(onbCases.id, createdCaseIds));
    }
    await db.delete(onbSensitiveLifecyclePolicies).where(and(
      eq(onbSensitiveLifecyclePolicies.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSensitiveLifecyclePolicies.revision, policyRevision),
    ));
    await db.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
      inArray(onbSettings.key, [
        demoPrincipalSettingKey(administrator),
        demoPrincipalSettingKey(reviewer),
      ]),
    ));
    await db.delete(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.clerkUserId, administrator),
      inArray(organizationMembershipsTable.organizationId, [
        DEMO_ORGANIZATION_ID,
        foreignOrganizationId,
      ]),
    ));
    await db.delete(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
      eq(organizationMembershipsTable.clerkUserId, reviewer),
    ));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  });

  test("creates an offline case, immediately grants only case-bound authority, and opens it", async () => {
    const response = await request(administrator, DEMO_ORGANIZATION_ID, "/onboarding/cases", {
      method: "POST",
      body: JSON.stringify(intake()),
    });
    const responseBody = await response.text();
    assert.equal(response.status, 201, responseBody);
    const created = JSON.parse(responseBody) as {
      id: number;
      scenarioKey: string | null;
      offlineSample: boolean;
    };
    createdCaseIds.push(created.id);
    assert.equal(created.scenarioKey, null);
    assert.equal(created.offlineSample, true);

    const opened = await request(administrator, DEMO_ORGANIZATION_ID, `/onboarding/cases/${created.id}`);
    assert.equal(opened.status, 200, await opened.text());

    const [caseRow] = await db.select().from(onbCases).where(and(
      eq(onbCases.id, created.id),
      eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
    ));
    assert.ok(caseRow);
    assert.ok(caseRow.notes?.includes(SYNTHETIC_OFFLINE_MARKER));
    assert.equal(caseRow.scenarioKey, null);
    assert.equal(caseRow.orchestrationStatus, "blocked");
    assert.equal(caseRow.orchestrationCheckpoint, "synthetic-offline");
    assert.equal(caseRow.candidateEmailAuthorizedAt, null);
    assert.equal(caseRow.candidateEmailAuthorizedBy, null);

    const grants = await db.select().from(onbAuthorityAssignments).where(and(
      eq(onbAuthorityAssignments.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbAuthorityAssignments.personUserId, administrator),
      eq(onbAuthorityAssignments.caseId, created.id),
      eq(onbAuthorityAssignments.source, SYNTHETIC_DEMO_AUTHORITY_SOURCE),
    ));
    assert.deepEqual(grants.map((grant) => grant.authorityRole).sort(), [...AUTHORITY_ROLES].sort());
    assert.ok(grants.every((grant) => grant.caseId === created.id && grant.status === "active"));
    const [membership] = await db.select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, DEMO_ORGANIZATION_ID),
        eq(organizationMembershipsTable.clerkUserId, administrator),
      ));
    assert.equal(membership?.role, "member");

    const [events, communications, effects, links, logistics, slaSnapshots, slaState, slaLedger, slaOutbox] =
      await Promise.all([
        db.select().from(onbEvents).where(eq(onbEvents.caseId, created.id)),
        db.select().from(onbCommunications).where(eq(onbCommunications.caseId, created.id)),
        db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, created.id)),
        db.select().from(onbCandidateLinks).where(eq(onbCandidateLinks.caseId, created.id)),
        db.select().from(onbCaseLogistics).where(eq(onbCaseLogistics.caseId, created.id)),
        db.select().from(onbReadinessSlaSnapshots).where(eq(onbReadinessSlaSnapshots.caseId, created.id)),
        db.select().from(onbReadinessSlaCaseState).where(eq(onbReadinessSlaCaseState.caseId, created.id)),
        db.select().from(onbReadinessSlaLedger).where(eq(onbReadinessSlaLedger.caseId, created.id)),
        db.select().from(onbReadinessSlaOutbox).where(eq(onbReadinessSlaOutbox.caseId, created.id)),
      ]);
    assert.deepEqual([events, communications, effects, links, slaSnapshots, slaState, slaLedger, slaOutbox].map((rows) => rows.length),
      [0, 0, 0, 0, 0, 0, 0, 0]);
    // Case-local logistics is a persisted planning record, not an outreach or
    // provider effect. Its existence is permitted by normal case creation.
    assert.equal(logistics.length, 1);
  });

  test("uses an explicit country geography for synthetic lifecycle jurisdiction", async () => {
    const body = intake(`Synthetic geography fallback ${suffix}`);
    body.geography = "USA";
    delete (body as Partial<typeof body>).workforceContext;
    const response = await request(administrator, DEMO_ORGANIZATION_ID, "/onboarding/cases", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const responseBody = await response.text();
    assert.equal(response.status, 201, responseBody);
    const created = JSON.parse(responseBody) as { id: number; offlineSample: boolean };
    createdCaseIds.push(created.id);
    assert.equal(created.offlineSample, true);
    const [caseRow] = await db.select({ workforceContext: onbCases.workforceContext })
      .from(onbCases)
      .where(eq(onbCases.id, created.id));
    assert.equal(caseRow?.workforceContext?.workCountry, "US");
  });

  test("keeps the Demo Reviewer denied with no case or authority side effect", async () => {
    const response = await request(reviewer, DEMO_ORGANIZATION_ID, "/onboarding/cases", {
      method: "POST",
      body: JSON.stringify(intake(`Reviewer denied ${suffix}`)),
    });
    assert.equal(response.status, 403);
    const [cases, grants] = await Promise.all([
      db.select().from(onbCases).where(and(
        eq(onbCases.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbCases.workerName, `Reviewer denied ${suffix}`),
      )),
      db.select().from(onbAuthorityAssignments).where(and(
        eq(onbAuthorityAssignments.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbAuthorityAssignments.personUserId, reviewer),
      )),
    ]);
    assert.equal(cases.length, 0);
    assert.equal(grants.length, 0);
  });

  test("denies a registered Demo Administrator's foreign-tenant request before route effects", async () => {
    const response = await request(administrator, foreignOrganizationId, "/onboarding/cases", {
      method: "POST",
      body: JSON.stringify(intake(`Foreign denied ${suffix}`)),
    });
    assert.equal(response.status, 403);
    const rows = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, foreignOrganizationId),
      eq(onbCases.workerName, `Foreign denied ${suffix}`),
    ));
    assert.equal(rows.length, 0);
  });
});