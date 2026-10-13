import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { hasHumanPermissions } from "../human-permissions";
import { db, offbPolicies, type SeparationPolicy } from "@workspace/db";
import { withSensitiveLifecycleFence } from "../onboarding/sensitive-lifecycle";
import { access, authority, receipt } from "./authority";
import { audit } from "./service";
import { compilePlan, endOfLwd, facts, initialState, object, text, SeparationError } from "./model";
import { AUTHORITY_SCOPES } from "../onboarding/decision-authority";

export function validatePolicy(input: unknown): SeparationPolicy {
  const b = object(input);
  const p: SeparationPolicy = {
    country: text(b.country, "country", 2), role: text(b.role, "role", 160), workerCategory: text(b.workerCategory, "workerCategory", 160),
    timeZone: text(b.timeZone, "timeZone", 160), endOfLwd: text(b.endOfLwd, "endOfLwd", 5),
    rulesReference: text(b.rulesReference, "approved rules reference"), retentionReference: text(b.retentionReference, "approved privacy/retention reference"),
    obligations: [], defaultAssets: [],
  };
  if (!/^[A-Z]{2}$/.test(p.country)) throw new SeparationError("Use an uppercase two-letter policy country.", 400);
  try { endOfLwd("2030-01-15", p.endOfLwd, p.timeZone); } catch { throw new SeparationError("Use a valid policy IANA time zone and HH:mm LWD end.", 400); }
  if (!Array.isArray(b.defaultAssets) || b.defaultAssets.length > 100 || !Array.isArray(b.obligations) || b.obligations.length > 100) throw new SeparationError("Supply bounded defaultAssets and obligations arrays.", 400);
  p.defaultAssets = b.defaultAssets.map(v => text(v, "default asset", 160));
  p.obligations = b.obligations.map(raw => {
    const o = object(raw), id = text(o.id, "obligation id", 64);
    if (!/^[a-z0-9][a-z0-9-]+$/.test(id) || !AUTHORITY_SCOPES.includes(o.scope as typeof AUTHORITY_SCOPES[number])) throw new SeparationError("Obligation requires a stable ID and supported reviewer routing label; labels do not grant permissions.", 400);
    if (!Array.isArray(o.prerequisites) || !Number.isInteger(o.dueOffsetDays) || Number(o.dueOffsetDays) < -90 || Number(o.dueOffsetDays) > 180) throw new SeparationError("Supply prerequisites and integer dueOffsetDays (-90 to 180).", 400);
    return { id, label: text(o.label, "obligation label", 160), scope: String(o.scope), stream: text(o.stream, "stream", 80), prerequisites: o.prerequisites.map(v => text(v, "prerequisite", 64)), dueOffsetDays: Number(o.dueOffsetDays) };
  });
  if (new Set(p.obligations.map(o => o.id)).size !== p.obligations.length) throw new SeparationError("Duplicate policy obligation.", 400);
  const f = facts({ employeeId: "POLICY-VALIDATION", workerName: "Policy validation", exitType: "review", exitReason: "Policy validation only", lastWorkingDay: "2030-01-15", terminationDate: "2030-01-15", timeZone: p.timeZone, role: p.role, department: "Review", country: p.country, legalEntity: "Review", workerCategory: p.workerCategory, manager: "Review" });
  const s = initialState(); s.gatewayA = "clear"; s.classification = "review"; s.urgency = "High"; s.flags = { privileged: true, highRisk: true, clientFacing: true, peopleManager: true, statutory: false };
  compilePlan(f, s, p);
  return p;
}
export async function listPolicies(org: string, actor: string) {
  return db.transaction(async tx => {
    await access(tx, org, actor, false);
    const rows = await tx.select().from(offbPolicies).where(eq(offbPolicies.organizationId, org)).orderBy(desc(offbPolicies.createdAt));
    const visible = [];
    for (const p of rows) {
      let allowed = false;
      for (const scope of ["hr-compliance-approve", "legal-approve"]) {
        try { await authority(tx, org, actor, scope, p.policy.country); allowed = true; break; }
        catch (e) { if (!(e instanceof SeparationError)) throw e; }
      }
      if (allowed) visible.push(p);
    }
    return visible;
  });
}
export async function savePolicy(org: string, actor: string, raw: unknown) {
  const b = object(raw), p = validatePolicy(b.policy), id = b.id ? text(b.id, "policy ID", 160) : randomUUID();
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await access(tx, org, actor, true);
    if (!await hasHumanPermissions(tx, { organizationId: org, actorUserId: actor, requiredKeys: ["tool.policy.manage"] }))
      throw new SeparationError("Current policy-management permission is required.", 403);
    await authority(tx, org, actor, "hr-compliance-approve", p.country);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`offb-policy:${org}:${id}`}, 0))`);
    const [last] = await tx.select().from(offbPolicies).where(and(eq(offbPolicies.organizationId, org), eq(offbPolicies.id, id))).orderBy(desc(offbPolicies.version));
    if ((last?.version ?? 0) !== b.expectedVersion) throw new SeparationError("Policy changed; supply its latest expectedVersion (0 for a new policy).");
    const [result] = await tx.insert(offbPolicies).values({ organizationId: org, id, version: (last?.version ?? 0) + 1, policy: p, createdBy: actor }).returning();
    await audit(tx, org, actor, "policy-proposed", id, result.version);
    return result;
  }));
}
export async function decidePolicy(org: string, actor: string, id: string, version: number, raw: unknown) {
  const b = object(raw), reference = text(b.reference, "policy review reference");
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await access(tx, org, actor, true);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`offb-policy:${org}:${id}`}, 0))`);
    const [p] = await tx.select().from(offbPolicies).where(and(eq(offbPolicies.organizationId, org), eq(offbPolicies.id, id), eq(offbPolicies.version, version))).for("update");
    if (!p) throw new SeparationError("Policy not found.", 404);
    const approval = await receipt(tx, { organizationId: org, actor, scope: "legal-approve", country: p.policy.country, reference, generation: version, policyAction: true });
    if (!["approve", "withdraw"].includes(String(b.decision))) throw new SeparationError("Choose approve or withdraw.", 400);
    if (b.decision === "approve") {
      if (p.status !== "proposal") throw new SeparationError("A withdrawn policy cannot be reactivated; propose a new version.");
      if (actor === p.createdBy) throw new SeparationError("An independent member with current policy-management permission must approve the proposal.", 403);
      await authority(tx, org, p.createdBy, "hr-compliance-approve", p.policy.country);
    }
    const [result] = await tx.update(offbPolicies).set({ status: b.decision === "approve" ? "approved" : "withdrawn", approval: b.decision === "approve" ? approval : null }).where(and(eq(offbPolicies.organizationId, org), eq(offbPolicies.id, id), eq(offbPolicies.version, version))).returning();
    await audit(tx, org, actor, `policy-${b.decision}`, id, version);
    return result;
  }));
}
