import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { onbCaseLogistics } from "@workspace/db/schema";
import { logisticsForCase } from "./logistics-defaults";
import { getDay1LogisticsDefault } from "./settings";

export async function ensureCaseLogistics(
  organizationId: string,
  caseId: number,
  joiningDate: string,
) {
  const [existing] = await db.select()
    .from(onbCaseLogistics)
    .where(and(
      eq(onbCaseLogistics.organizationId, organizationId),
      eq(onbCaseLogistics.caseId, caseId),
    ));
  if (existing) return existing;

  const defaults = await getDay1LogisticsDefault(organizationId);
  const [inserted] = await db.insert(onbCaseLogistics)
    .values({
      organizationId,
      caseId,
      ...logisticsForCase(defaults, joiningDate),
    })
    .onConflictDoNothing({
      target: [onbCaseLogistics.organizationId, onbCaseLogistics.caseId],
    })
    .returning();
  if (inserted) return inserted;

  const [concurrent] = await db.select()
    .from(onbCaseLogistics)
    .where(and(
      eq(onbCaseLogistics.organizationId, organizationId),
      eq(onbCaseLogistics.caseId, caseId),
    ));
  if (!concurrent) throw new Error("Unable to initialize case logistics.");
  return concurrent;
}