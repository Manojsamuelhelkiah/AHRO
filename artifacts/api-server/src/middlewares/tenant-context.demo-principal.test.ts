import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  onbSettings,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import {
  demoPrincipalSettingKey,
  registerDemoPrincipal,
} from "../lib/demo-principal";
import { lookupMembership } from "./tenant-context";

const suffix = randomUUID();
const userId = `demo-principal-${suffix}`;
const otherOrganizationId = `demo-principal-other-${suffix}`;

after(async () => {
  await db.delete(organizationMembershipsTable).where(
    eq(organizationMembershipsTable.clerkUserId, userId),
  );
  await db.delete(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, demoPrincipalSettingKey(userId)),
  ));
  await deleteTestOrganizations(
    eq(organizationsTable.id, otherOrganizationId),
  );
});

test("registered shared demo principals can resolve only Demo Organization", async () => {
  await db.insert(organizationsTable).values([
    {
      id: DEMO_ORGANIZATION_ID,
      name: "Demo Organization",
      slug: "demo",
      joinCodeHash: "4ff006ca6b88e752f08cb7881714505ceb3d2079eea432acfda8e158e0d1d82e",
      createdByUserId: "system",
    },
    {
      id: otherOrganizationId,
      name: "Other organization",
      slug: otherOrganizationId,
      joinCodeHash: `${otherOrganizationId}-join`,
      createdByUserId: userId,
    },
  ]).onConflictDoNothing();
  await db.insert(organizationMembershipsTable).values([
    { organizationId: DEMO_ORGANIZATION_ID, clerkUserId: userId, role: "owner" },
    { organizationId: otherOrganizationId, clerkUserId: userId, role: "owner" },
  ]);
  await registerDemoPrincipal(userId, "administrator");

  assert.equal(await lookupMembership(userId, otherOrganizationId), null);
  assert.deepEqual(await lookupMembership(userId), {
    organizationId: DEMO_ORGANIZATION_ID,
    organizationName: "Demo Organization",
    role: "member",
  });
});