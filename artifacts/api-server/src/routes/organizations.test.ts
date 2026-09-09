import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  DEMO_ORGANIZATION_ID,
  organizationsTable,
} from "@workspace/db";
import { ensureDemoOrganization } from "./organizations";

test("demo organization request bootstrap is idempotent", async () => {
  await ensureDemoOrganization();
  await ensureDemoOrganization();

  const rows = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      createdByUserId: organizationsTable.createdByUserId,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, DEMO_ORGANIZATION_ID));

  assert.deepEqual(rows, [
    {
      id: "demo",
      name: "Demo Organization",
      slug: "demo",
      createdByUserId: "system",
    },
  ]);
});