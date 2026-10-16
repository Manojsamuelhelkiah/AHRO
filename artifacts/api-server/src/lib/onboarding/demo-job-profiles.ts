import { and, eq, sql } from "drizzle-orm";
import { db, DEMO_ORGANIZATION_ID, onbJobProfiles, organizationsTable } from "@workspace/db";

/** Fictional editable context, not approved policy or execution authority. */
export const DEMO_JOB_PROFILE_STARTERS = [
  { profileId: "JP-OPS-1047", name: "Operations" },
  { profileId: "JP-HR-1001", name: "Human Resources" },
  { profileId: "JP-IT-1001", name: "Information Technology" },
  { profileId: "JP-FIN-1001", name: "Finance" },
  { profileId: "JP-CS-1001", name: "Customer Service" },
] as const;

export const DEMO_JOB_PROFILE_PROVENANCE = "provision:demo-fictional-job-context:v1";

export function assertDemoJobProfileDevelopment(environment = process.env): void {
  if (environment.NODE_ENV !== "development" || environment.REPLIT_DEPLOYMENT === "1") {
    throw new Error("Job-profile starters may only be provisioned explicitly in development.");
  }
}

/** Never imported by startup. No tenant argument, updates, or case-side effects. */
export async function provisionDemoJobProfiles() {
  assertDemoJobProfileDevelopment();
  return db.transaction(async tx => {
    // Also fences ordinary catalog INSERTs, whose writers do not take advisory
    // locks. Short-lived table lock prevents an absent-ID check racing a manual
    // insert at any version, including a retired version without version one.
    await tx.execute(sql`LOCK TABLE ${onbJobProfiles} IN SHARE ROW EXCLUSIVE MODE`);
    const [tenant] = await tx.select().from(organizationsTable)
      .where(eq(organizationsTable.id, DEMO_ORGANIZATION_ID)).for("share");
    if (tenant?.slug !== "demo" || tenant.name !== "Demo Organization") {
      throw new Error("Demo Organization identity could not be verified; nothing was added.");
    }
    const added: string[] = [];
    const preserved: string[] = [];
    for (const starter of DEMO_JOB_PROFILE_STARTERS) {
      const existing = await tx.select({ version: onbJobProfiles.version }).from(onbJobProfiles).where(and(
        eq(onbJobProfiles.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbJobProfiles.profileId, starter.profileId),
      )).limit(1);
      if (existing.length) { preserved.push(starter.profileId); continue; }
      const inserted = await tx.insert(onbJobProfiles).values({
        organizationId: DEMO_ORGANIZATION_ID, ...starter, version: 1,
        context: { roleFamily: starter.name }, enabled: true,
        createdBy: DEMO_JOB_PROFILE_PROVENANCE,
      }).onConflictDoNothing().returning({ profileId: onbJobProfiles.profileId });
      (inserted.length ? added : preserved).push(starter.profileId);
    }
    return { organizationId: DEMO_ORGANIZATION_ID, added, preserved };
  });
}
