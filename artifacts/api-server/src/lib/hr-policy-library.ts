import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import {
  db,
  onbGovernanceAuthorityAssignments,
  onbHrPolicyExcerpts,
  onbHrPolicyHandoffs,
  onbHrPolicyReminders,
  onbHrPolicySources,
  onbHrPolicyVersions,
  organizationMembershipsTable,
} from "@workspace/db";
import {
  HrPolicyAiUnavailableError,
  selectApprovedPolicyExtract,
  type PolicyExtractSelection,
} from "./hr-policy-ai";
import { sentenceForQuestion, containsPromptInjection, policyPermitted, policyCurrent, policyTimely } from "./hr-policy-selection";

export type PolicyRole = "owner" | "admin" | "member";
type PolicyStatus = "draft" | "in_review" | "published" | "superseded" | "retired";
type PolicyApplicability = Record<string, string>;
type PolicyReviewAuthorityRole = "hr-compliance" | "legal" | "occupational-health" | "payroll";

export class HrPolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 | 422 | 503 = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HrPolicyError";
  }
}

const POLICY_AUDIENCE: readonly PolicyRole[] = ["owner", "admin", "member"];
const POLICY_REVIEW_AUTHORITIES: readonly PolicyReviewAuthorityRole[] = [
  "hr-compliance", "legal", "occupational-health", "payroll",
];
const APPLICABILITY_KEYS = new Set(["country", "workerType", "location"]);
const MAX_TEXT = 40_000;
const TOPIC_STOPWORDS = new Set(["about", "applies", "are", "can", "does", "for", "from", "how", "policy", "should", "that", "the", "this", "what", "when", "where", "which", "who", "with", "would"]);

function object(input: unknown, name = "request body"): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HrPolicyError(`A JSON ${name} is required.`);
  }
  return input as Record<string, unknown>;
}

function text(input: unknown, field: string, max = 4000): string {
  if (typeof input !== "string" || !input.trim() || input.trim().length > max) {
    throw new HrPolicyError(`${field} must be a non-empty string of at most ${max} characters.`);
  }
  return input.trim();
}

function optionalText(input: unknown, field: string, max = 4000): string | null {
  if (input === undefined || input === null) return null;
  return text(input, field, max);
}

function dateOnly(input: unknown, field: string, optional = false): string | null {
  if (input === undefined || input === null) {
    if (optional) return null;
    throw new HrPolicyError(`${field} is required.`);
  }
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new HrPolicyError(`${field} must be an ISO calendar date.`);
  }
  const parsed = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== input) {
    throw new HrPolicyError(`${field} must be a valid ISO calendar date.`);
  }
  return input;
}

function audience(input: unknown): PolicyRole[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > POLICY_AUDIENCE.length ||
      input.some((item) => typeof item !== "string" || !POLICY_AUDIENCE.includes(item as PolicyRole))) {
    throw new HrPolicyError("audience must be a non-empty list of membership roles.");
  }
  return [...new Set(input as PolicyRole[])];
}

function applicability(input: unknown): PolicyApplicability {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HrPolicyError("applicability must be an object of selected, non-sensitive work attributes.");
  }
  const entries = Object.entries(input);
  if (entries.length > APPLICABILITY_KEYS.size || entries.some(([key, value]) =>
    !APPLICABILITY_KEYS.has(key) ||
    typeof value !== "string" || !value.trim() || value.length > 160,
  )) throw new HrPolicyError("applicability contains an invalid attribute.");
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, (value as string).trim()]));
}

function inputPolicy(value: unknown) {
  const body = object(value);
  const effectiveFrom = dateOnly(body.effectiveFrom, "effectiveFrom")!;
  const effectiveUntil = dateOnly(body.effectiveUntil, "effectiveUntil", true);
  const reviewBy = dateOnly(body.reviewBy, "reviewBy", true);
  if (effectiveUntil && effectiveUntil < effectiveFrom) {
    throw new HrPolicyError("effectiveUntil must not precede effectiveFrom.");
  }
  return {
    title: text(body.title, "title"),
    sourceReference: text(body.sourceReference, "sourceReference"),
    text: text(body.text, "text", MAX_TEXT),
    audience: audience(body.audience),
    applicability: applicability(body.applicability),
    reviewAuthorityRole: POLICY_REVIEW_AUTHORITIES.includes(body.reviewAuthorityRole as PolicyReviewAuthorityRole)
      ? body.reviewAuthorityRole as PolicyReviewAuthorityRole
      : (() => { throw new HrPolicyError("reviewAuthorityRole must be hr-compliance, legal, occupational-health, or payroll."); })(),
    effectiveFrom,
    effectiveUntil,
    reviewBy,
  };
}

async function liveMember(tx: any, organizationId: string, userId: string): Promise<PolicyRole> {
  const [membership] = await tx.select({ role: organizationMembershipsTable.role })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, userId),
      isNull(organizationMembershipsTable.revokedAt),
    )).for("update");
  if (!membership) throw new HrPolicyError("Current tenant membership is required.", 403, "TENANT_MEMBERSHIP_REQUIRED");
  return membership.role;
}

/** Trusted governance records are intentionally the only specialist authority. */
export async function verifiedAuthority(tx: any, organizationId: string, userId: string, authorityRole: string) {
  await liveMember(tx, organizationId, userId);
  const now = new Date();
  const [grant] = await tx.select().from(onbGovernanceAuthorityAssignments).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.assigneeUserId, userId),
    eq(onbGovernanceAuthorityAssignments.authorityRole, authorityRole),
    eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
    isNull(onbGovernanceAuthorityAssignments.revokedAt),
    or(isNull(onbGovernanceAuthorityAssignments.expiresAt), gt(onbGovernanceAuthorityAssignments.expiresAt, now)),
  )).orderBy(desc(onbGovernanceAuthorityAssignments.createdAt)).limit(1).for("update");
  if (!grant) throw new HrPolicyError(
    "A current, verified governance authority assignment is required.",
    403,
    "VERIFIED_POLICY_AUTHORITY_REQUIRED",
  );
  return grant;
}

async function authorityStillCurrent(tx: any, organizationId: string, assignmentId: number | null, role: string): Promise<boolean> {
  if (!assignmentId) return false;
  const now = new Date();
  const [grant] = await tx.select().from(onbGovernanceAuthorityAssignments).where(and(
    eq(onbGovernanceAuthorityAssignments.id, assignmentId),
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.authorityRole, role),
    eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
    isNull(onbGovernanceAuthorityAssignments.revokedAt),
    or(isNull(onbGovernanceAuthorityAssignments.expiresAt), gt(onbGovernanceAuthorityAssignments.expiresAt, now)),
  ));
  if (!grant) return false;
  const [member] = await tx.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, grant.assigneeUserId),
    isNull(organizationMembershipsTable.revokedAt),
  ));
  return Boolean(member);
}

async function activeAuthorityRoles(tx: any, organizationId: string, userId: string): Promise<Set<string>> {
  const now = new Date();
  const grants = await tx.select({ authorityRole: onbGovernanceAuthorityAssignments.authorityRole })
    .from(onbGovernanceAuthorityAssignments)
    .where(and(
      eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
      eq(onbGovernanceAuthorityAssignments.assigneeUserId, userId),
      eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
      isNull(onbGovernanceAuthorityAssignments.revokedAt),
      or(isNull(onbGovernanceAuthorityAssignments.expiresAt), gt(onbGovernanceAuthorityAssignments.expiresAt, now)),
    ));
  return new Set(grants.map((grant: { authorityRole: string }) => grant.authorityRole));
}

function policyPublic(row: typeof onbHrPolicyVersions.$inferSelect) {
  return {
    policyId: row.policyId, version: row.version, title: row.title,
    sourceReference: row.sourceReference, audience: row.audience,
    applicability: row.applicability, effectiveFrom: row.effectiveFrom,
    reviewAuthorityRole: row.reviewAuthorityRole,
    effectiveUntil: row.effectiveUntil, reviewBy: row.reviewBy, status: row.status,
    createdByUserId: row.createdByUserId, reviewedByUserId: row.reviewedByUserId,
    reviewOutcome: row.reviewOutcome, reviewerVerificationReference: row.reviewerVerificationReference,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publisherUserId: row.publisherUserId,
    publicationVerificationReference: row.publicationVerificationReference,
    retiredAt: row.retiredAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function versionsForPolicy(tx: any, organizationId: string, policyId: string) {
  return tx.select().from(onbHrPolicyVersions).where(and(
    eq(onbHrPolicyVersions.organizationId, organizationId),
    eq(onbHrPolicyVersions.policyId, policyId),
  )).orderBy(desc(onbHrPolicyVersions.version)).for("update");
}

function isAudience(row: { audience: PolicyRole[] }, role: PolicyRole) {
  return row.audience.includes(role);
}

function utcDateOnly(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addUtcCalendarDays(dateValue: string, days: number): string {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateOnly(date);
}

function calendarDaysRemaining(dueOn: string, today: string): number {
  const due = Date.parse(`${dueOn}T00:00:00.000Z`);
  const current = Date.parse(`${today}T00:00:00.000Z`);
  return Math.round((due - current) / 86_400_000);
}

export async function listPolicies(organizationId: string, userId: string) {
  return db.transaction(async (tx) => {
    const role = await liveMember(tx, organizationId, userId);
    const authorities = await activeAuthorityRoles(tx, organizationId, userId);
    const rows = await tx.select().from(onbHrPolicyVersions).where(
      eq(onbHrPolicyVersions.organizationId, organizationId),
    ).orderBy(desc(onbHrPolicyVersions.createdAt));
    return rows.filter((row: any) => isAudience(row, role) && (
      row.status === "published" ||
      authorities.has("hr-policy-maintain") ||
      authorities.has(row.reviewAuthorityRole)
    )).map(policyPublic);
  });
}

/**
 * Lists durable, internal policy reminders. Generation is deliberately part of
 * an authorized read: no worker, external dispatch, or policy-date mutation is
 * involved. Authorization, persistence, and the final authorized read are
 * separate transactions so no reminder transaction holds membership/authority
 * locks while it inserts rows whose composite FK takes a version KEY SHARE.
 */
export async function listPolicyReminders(
  organizationId: string,
  userId: string,
  now = new Date(),
) {
  const today = utcDateOnly(now);
  const horizon = addUtcCalendarDays(today, 30);

  // Phase one is the only authorization gate before the persistence phase.
  // It deliberately touches no policy/version rows.
  const precheckedRole = await db.transaction(async (tx) => {
    await verifiedAuthority(tx, organizationId, userId, "hr-policy-maintain");
    return liveMember(tx, organizationId, userId);
  });

  // Phase two may observe a concurrent lifecycle transition. It takes no
  // explicit version locks and holds no membership/authority locks; stale candidates
  // are harmless because the final authorized read rechecks current state.
  await db.transaction(async (tx) => {
    const candidates = await tx.select({
      policyId: onbHrPolicyVersions.policyId,
      version: onbHrPolicyVersions.version,
      title: onbHrPolicyVersions.title,
      audience: onbHrPolicyVersions.audience,
      reviewBy: onbHrPolicyVersions.reviewBy,
      effectiveUntil: onbHrPolicyVersions.effectiveUntil,
    }).from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId),
      eq(onbHrPolicyVersions.status, "published"),
      or(
        and(isNotNull(onbHrPolicyVersions.reviewBy), lte(onbHrPolicyVersions.reviewBy, horizon)),
        and(isNotNull(onbHrPolicyVersions.effectiveUntil), lte(onbHrPolicyVersions.effectiveUntil, horizon)),
      ),
    )).orderBy(asc(onbHrPolicyVersions.policyId), asc(onbHrPolicyVersions.version));

    const reminderValues: Array<{
      organizationId: string;
      policyId: string;
      version: number;
      title: string;
      kind: "review_due" | "effective_end";
      dueOn: string;
    }> = [];
    for (const candidate of candidates) {
      if (!isAudience(candidate, precheckedRole)) continue;
      if (candidate.reviewBy && candidate.reviewBy <= horizon) {
        reminderValues.push({
          organizationId,
          policyId: candidate.policyId,
          version: candidate.version,
          title: candidate.title,
          kind: "review_due",
          dueOn: candidate.reviewBy,
        });
      }
      if (candidate.effectiveUntil && candidate.effectiveUntil <= horizon) {
        reminderValues.push({
          organizationId,
          policyId: candidate.policyId,
          version: candidate.version,
          title: candidate.title,
          kind: "effective_end",
          dueOn: candidate.effectiveUntil,
        });
      }
    }
    if (reminderValues.length > 0) {
      await tx.insert(onbHrPolicyReminders).values(reminderValues).onConflictDoNothing({
        target: [
          onbHrPolicyReminders.organizationId,
          onbHrPolicyReminders.policyId,
          onbHrPolicyReminders.version,
          onbHrPolicyReminders.kind,
          onbHrPolicyReminders.dueOn,
        ],
      });
    }
  });

  // Phase three is the only transaction that reads rows for the response.
  // Reauthorization and current status/audience/date checks make stale durable
  // rows invisible after revocation, supersession, retirement, or revision.
  return db.transaction(async (tx) => {
    await verifiedAuthority(tx, organizationId, userId, "hr-policy-maintain");
    const role = await liveMember(tx, organizationId, userId);
    const rows = await tx.select({
      id: onbHrPolicyReminders.id,
      policyId: onbHrPolicyVersions.policyId,
      version: onbHrPolicyVersions.version,
      title: onbHrPolicyVersions.title,
      audience: onbHrPolicyVersions.audience,
      kind: onbHrPolicyReminders.kind,
      dueOn: onbHrPolicyReminders.dueOn,
      createdAt: onbHrPolicyReminders.createdAt,
    }).from(onbHrPolicyReminders).innerJoin(onbHrPolicyVersions, and(
      eq(onbHrPolicyReminders.organizationId, onbHrPolicyVersions.organizationId),
      eq(onbHrPolicyReminders.policyId, onbHrPolicyVersions.policyId),
      eq(onbHrPolicyReminders.version, onbHrPolicyVersions.version),
    )).where(and(
      eq(onbHrPolicyReminders.organizationId, organizationId),
      eq(onbHrPolicyVersions.status, "published"),
      lte(onbHrPolicyReminders.dueOn, horizon),
      or(
        and(
          eq(onbHrPolicyReminders.kind, "review_due"),
          eq(onbHrPolicyReminders.dueOn, onbHrPolicyVersions.reviewBy),
        ),
        and(
          eq(onbHrPolicyReminders.kind, "effective_end"),
          eq(onbHrPolicyReminders.dueOn, onbHrPolicyVersions.effectiveUntil),
        ),
      ),
    )).orderBy(asc(onbHrPolicyReminders.dueOn), asc(onbHrPolicyReminders.id));

    // Recheck the per-version audience at return time. This keeps reminders
    // hidden after a role change even when the durable row predates it.
    return rows.filter((row) => isAudience(row, role)).map((row) => ({
      id: row.id,
      policyId: row.policyId,
      version: row.version,
      title: row.title,
      kind: row.kind,
      dueOn: row.dueOn,
      daysRemaining: calendarDaysRemaining(row.dueOn, today),
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/** Descriptive alias for callers that use the full HR-policy namespace. */
export const listHrPolicyReminders = listPolicyReminders;

export async function policyHistory(organizationId: string, userId: string, policyId: string) {
  return db.transaction(async (tx) => {
    const role = await liveMember(tx, organizationId, userId);
    const authorities = await activeAuthorityRoles(tx, organizationId, userId);
    const rows = await tx.select().from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId),
      eq(onbHrPolicyVersions.policyId, policyId),
    )).orderBy(desc(onbHrPolicyVersions.version));
    // Each historical revision retains its own audience. A maintainer's
    // authority does not bypass a restricted source's explicit access rule.
    return rows.filter((row: any) => {
      if (!isAudience(row, role)) return false;
      if (row.status === "published") return true;
      if (row.status === "in_review" || row.status === "draft") {
        return authorities.has("hr-policy-maintain") || authorities.has(row.reviewAuthorityRole);
      }
      return authorities.has("hr-policy-historical-review");
    }).map(policyPublic);
  });
}

export async function getPolicyVersion(organizationId: string, userId: string, policyId: string, version: number) {
  return db.transaction(async (tx) => {
    const role = await liveMember(tx, organizationId, userId);
    const [row] = await tx.select().from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId),
      eq(onbHrPolicyVersions.version, version),
    )).for("update");
    if (!row || !isAudience(row, role)) throw new HrPolicyError("Policy version not found.", 404);
    const authorities = await activeAuthorityRoles(tx, organizationId, userId);
    const contentAllowed = row.status === "published" ||
      ((row.status === "draft" || row.status === "in_review") &&
        (authorities.has("hr-policy-maintain") || authorities.has(row.reviewAuthorityRole))) ||
      ((row.status === "superseded" || row.status === "retired") && authorities.has("hr-policy-historical-review"));
    if (!contentAllowed) throw new HrPolicyError("Policy source permission required.", 403);
    return { policy: policyPublic(row), text: row.text };
  });
}

export async function policyCapabilities(organizationId: string, userId: string) {
  return db.transaction(async (tx) => {
    const role = await liveMember(tx, organizationId, userId);
    const can = async (scope: string) => {
      try { await verifiedAuthority(tx, organizationId, userId, scope); return true; } catch { return false; }
    };
    const reviewAuthorityRoles = await Promise.all(POLICY_REVIEW_AUTHORITIES.map(async (scope) => ({
      role: scope, current: await can(scope),
    })));
    return {
      membershipRole: role,
      canMaintain: await can("hr-policy-maintain"),
      canReview: reviewAuthorityRoles.some((item) => item.current),
      canPublish: reviewAuthorityRoles.some((item) => item.current),
      reviewAuthorityRoles,
      canReviewHistory: await can("hr-policy-historical-review"),
      canResolveHandoffs: await can("hr-policy-handoff-resolve"),
      answerMode: "approved-ai-only" as const,
      externalDispatch: false,
    };
  });
}

export async function createPolicy(organizationId: string, userId: string, input: unknown) {
  const data = inputPolicy(input);
  return db.transaction(async (tx) => {
    await verifiedAuthority(tx, organizationId, userId, "hr-policy-maintain");
    if (!data.audience.includes(await liveMember(tx, organizationId, userId))) {
      throw new HrPolicyError("Policy audience must include the acting maintainer's current membership role.", 403);
    }
    const policyId = randomUUID();
    await tx.insert(onbHrPolicySources).values({ organizationId, policyId, createdByUserId: userId });
    const [created] = await tx.insert(onbHrPolicyVersions).values({
      organizationId, policyId, version: 1, ...data, createdByUserId: userId,
    }).returning();
    return policyPublic(created!);
  });
}

export async function revisePolicy(organizationId: string, userId: string, policyId: string, input: unknown) {
  const data = inputPolicy(input);
  const expected = Number(object(input).expectedVersion);
  if (!Number.isInteger(expected) || expected < 1) throw new HrPolicyError("expectedVersion must be a positive integer.");
  return db.transaction(async (tx) => {
    await verifiedAuthority(tx, organizationId, userId, "hr-policy-maintain");
    const rows = await versionsForPolicy(tx, organizationId, policyId);
    const current = rows[0];
    if (!current) throw new HrPolicyError("Policy source not found.", 404);
    if (!isAudience(current, await liveMember(tx, organizationId, userId))) throw new HrPolicyError("Policy audience permission required.", 403);
    if (!data.audience.includes(await liveMember(tx, organizationId, userId))) {
      throw new HrPolicyError("Policy audience must include the acting maintainer's current membership role.", 403);
    }
    if (current.version !== expected) throw new HrPolicyError("Policy version changed; reload and retry.", 409, "STALE_POLICY_VERSION");
    if (current.status === "retired") throw new HrPolicyError("Retired policies cannot be revised.", 409);
    if (current.status === "in_review") throw new HrPolicyError("A policy under review cannot be edited.", 409);
    const [created] = await tx.insert(onbHrPolicyVersions).values({
      organizationId, policyId, version: current.version + 1, ...data, createdByUserId: userId,
    }).returning();
    return policyPublic(created!);
  });
}

export async function submitPolicyReview(organizationId: string, userId: string, policyId: string, input: unknown) {
  const expected = Number(object(input).expectedVersion);
  return db.transaction(async (tx) => {
    await verifiedAuthority(tx, organizationId, userId, "hr-policy-maintain");
    const rows = await versionsForPolicy(tx, organizationId, policyId);
    const current = rows[0];
    if (!current) throw new HrPolicyError("Policy source not found.", 404);
    if (current.version !== expected || current.status !== "draft" || current.reviewOutcome !== null) {
      throw new HrPolicyError("Only an unreviewed current draft can be submitted for review; create a successor after rejection.", 409);
    }
    if (!isAudience(current, await liveMember(tx, organizationId, userId))) throw new HrPolicyError("Policy audience permission required.", 403);
    const [updated] = await tx.update(onbHrPolicyVersions).set({
      status: "in_review", updatedAt: new Date(),
    }).where(and(eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, expected), eq(onbHrPolicyVersions.status, "draft"))).returning();
    if (!updated) throw new HrPolicyError("Policy changed; reload and retry.", 409);
    return policyPublic(updated);
  });
}

export async function reviewPolicy(organizationId: string, userId: string, policyId: string, input: unknown) {
  const body = object(input);
  const version = Number(body.version);
  const outcome = body.outcome === "approved" || body.outcome === "rejected" ? body.outcome : null;
  const verificationReference = text(body.verificationReference, "verificationReference");
  if (!Number.isInteger(version) || version < 1 || !outcome) throw new HrPolicyError("version and approved or rejected outcome are required.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId),
      eq(onbHrPolicyVersions.version, version),
    )).for("update");
    if (!row) throw new HrPolicyError("Policy version not found.", 404);
    const grant = await verifiedAuthority(tx, organizationId, userId, row.reviewAuthorityRole);
    if (!isAudience(row, await liveMember(tx, organizationId, userId))) throw new HrPolicyError("Policy audience permission required.", 403);
    if (row.status !== "in_review" || row.reviewOutcome !== null) throw new HrPolicyError("This exact policy version is not awaiting review.", 409);
    if (row.createdByUserId === userId) throw new HrPolicyError("The policy author cannot review their own version.", 403, "POLICY_REVIEW_SOD_REQUIRED");
    const [updated] = await tx.update(onbHrPolicyVersions).set({
      status: outcome === "approved" ? "in_review" : "draft", reviewOutcome: outcome,
      reviewedByUserId: userId, reviewerAuthorityAssignmentId: grant.id,
      reviewerVerificationReference: verificationReference, updatedAt: new Date(),
    }).where(and(eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, version), eq(onbHrPolicyVersions.status, "in_review"), isNull(onbHrPolicyVersions.reviewOutcome))).returning();
    if (!updated) throw new HrPolicyError("Policy review changed; reload and retry.", 409);
    return policyPublic(updated);
  });
}

export async function publishPolicy(organizationId: string, userId: string, policyId: string, input: unknown) {
  const body = object(input);
  const version = Number(body.expectedVersion);
  const publicationVerificationReference = text(
    body.publicationVerificationReference ?? body.reviewerDecisionRef,
    "publicationVerificationReference",
  );
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId),
      eq(onbHrPolicyVersions.version, version),
    )).for("update");
    if (!row) throw new HrPolicyError("Policy version not found.", 404);
    const publisherGrant = await verifiedAuthority(tx, organizationId, userId, row.reviewAuthorityRole);
    if (!isAudience(row, await liveMember(tx, organizationId, userId))) throw new HrPolicyError("Policy audience permission required.", 403);
    if (row.status !== "in_review" || row.reviewOutcome !== "approved" ||
        !await authorityStillCurrent(tx, organizationId, row.reviewerAuthorityAssignmentId, row.reviewAuthorityRole)) {
      throw new HrPolicyError("A current verified review for this exact version is required before publishing.", 409, "CURRENT_REVIEW_REQUIRED");
    }
    const today = new Date().toISOString().slice(0, 10);
    if (row.effectiveFrom > today) throw new HrPolicyError("Future-effective policies cannot be published as current guidance.", 409, "FUTURE_EFFECTIVE");
    if (row.effectiveUntil && row.effectiveUntil < today) throw new HrPolicyError("No-longer-effective policies cannot be published as current guidance.", 409, "OUTDATED_EFFECTIVE");
    if (row.reviewBy && row.reviewBy < today) throw new HrPolicyError("An overdue policy review cannot be published.", 409, "OUTDATED_REVIEW");
    await tx.update(onbHrPolicyVersions).set({ status: "superseded", updatedAt: new Date() }).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId),
      eq(onbHrPolicyVersions.status, "published"),
    ));
    const [updated] = await tx.update(onbHrPolicyVersions).set({
      status: "published", publisherUserId: userId, publisherAuthorityAssignmentId: publisherGrant.id,
      publicationVerificationReference, publishedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, version), eq(onbHrPolicyVersions.status, "in_review"), eq(onbHrPolicyVersions.reviewOutcome, "approved"))).returning();
    if (!updated) throw new HrPolicyError("Policy changed; reload and retry.", 409);
    return policyPublic(updated);
  });
}

export async function retirePolicy(organizationId: string, userId: string, policyId: string, input: unknown) {
  const version = Number(object(input).version);
  return db.transaction(async (tx) => {
    const [visible] = await tx.select({ audience: onbHrPolicyVersions.audience, reviewAuthorityRole: onbHrPolicyVersions.reviewAuthorityRole }).from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, version),
    )).for("update");
    if (!visible) throw new HrPolicyError("Policy version not found.", 404);
    await verifiedAuthority(tx, organizationId, userId, visible.reviewAuthorityRole);
    if (!isAudience(visible, await liveMember(tx, organizationId, userId))) throw new HrPolicyError("Policy audience permission required.", 403);
    const [updated] = await tx.update(onbHrPolicyVersions).set({
      status: "retired", retiredAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, version), or(eq(onbHrPolicyVersions.status, "published"), eq(onbHrPolicyVersions.status, "superseded")))).returning();
    if (!updated) throw new HrPolicyError("Only published or superseded policies can be retired.", 409);
    return policyPublic(updated);
  });
}

export async function supersedePolicy(organizationId: string, userId: string, policyId: string, input: unknown) {
  const body = object(input);
  const version = Number(body.version);
  const replacementVersion = Number(body.replacementVersion);
  if (!Number.isInteger(version) || version < 1 || !Number.isInteger(replacementVersion) || replacementVersion < 1) {
    throw new HrPolicyError("version and replacementVersion must be positive integers.");
  }
  return db.transaction(async (tx) => {
    const [[target], [replacement]] = await Promise.all([
      tx.select().from(onbHrPolicyVersions).where(and(eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, version))).for("update"),
      tx.select().from(onbHrPolicyVersions).where(and(eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, replacementVersion))).for("update"),
    ]);
    if (!target || !replacement) throw new HrPolicyError("Policy version not found.", 404);
    await verifiedAuthority(tx, organizationId, userId, target.reviewAuthorityRole);
    if (!isAudience(target, await liveMember(tx, organizationId, userId))) throw new HrPolicyError("Policy audience permission required.", 403);
    if (target.status !== "published" || replacement.status !== "published" || replacement.version <= target.version) {
      throw new HrPolicyError("A later published replacement version is required before superseding.", 409);
    }
    const [updated] = await tx.update(onbHrPolicyVersions).set({ status: "superseded", updatedAt: new Date() }).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId),
      eq(onbHrPolicyVersions.version, version), eq(onbHrPolicyVersions.status, "published"),
    )).returning();
    if (!updated) throw new HrPolicyError("Policy changed; reload and retry.", 409);
    return policyPublic(updated);
  });
}

function matchesApplicability(policy: PolicyApplicability, selected: PolicyApplicability): boolean {
  return Object.entries(policy).every(([key, value]) => selected[key] === value);
}

function topicalScore(row: { title: string; sourceReference: string }, question: string): number {
  const terms = new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !TOPIC_STOPWORDS.has(term)));
  const haystack = `${row.title} ${row.sourceReference}`.toLowerCase();
  return [...terms].filter((term) => haystack.includes(term)).length;
}

export async function answerPolicyQuestion(
  organizationId: string,
  userId: string,
  input: unknown,
  selectExtract: (question: string, excerpt: string, sourceContext: string) => Promise<PolicyExtractSelection> = selectApprovedPolicyExtract,
) {
  const body = object(input);
  const question = text(body.question, "question", 2000);
  const appliesOn = dateOnly(body.appliesOn, "appliesOn", true) ?? new Date().toISOString().slice(0, 10);
  const selected = applicability(body.applicability);
  const preflight = await db.transaction(async (tx) => {
    const role = await liveMember(tx, organizationId, userId);
    // Metadata and every access/date predicate are evaluated before text is read.
    const metadata = await tx.select({
      policyId: onbHrPolicyVersions.policyId, version: onbHrPolicyVersions.version,
      title: onbHrPolicyVersions.title, sourceReference: onbHrPolicyVersions.sourceReference,
      audience: onbHrPolicyVersions.audience, applicability: onbHrPolicyVersions.applicability,
      effectiveFrom: onbHrPolicyVersions.effectiveFrom, effectiveUntil: onbHrPolicyVersions.effectiveUntil,
      reviewBy: onbHrPolicyVersions.reviewBy, status: onbHrPolicyVersions.status,
    }).from(onbHrPolicyVersions).where(and(eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.status, "published")));
    const permitted = metadata.filter((row: any) => policyPermitted(row, role, selected));
    const today = new Date().toISOString().slice(0, 10);
    // A past selected date never revives expired or review-overdue material
    // for ordinary assistant advice. Historical use has its own guarded route.
    const currentPeriod = permitted.filter((row: any) => policyCurrent(row, today));
    const timely = currentPeriod.filter((row: any) => policyTimely(row, today, appliesOn));
    const limitation = (code: string, message: string) => ({ answer: null, limitation: { code, message }, citations: [] });
    if (timely.length === 0) {
      if (currentPeriod.some((row: any) => row.reviewBy && row.reviewBy < today) ||
          permitted.some((row: any) => row.reviewBy && row.reviewBy < today)) {
        return limitation("OUTDATED_REVIEW", "The otherwise applicable source is overdue for review.");
      }
      if (permitted.some((row: any) => row.effectiveFrom > today)) return limitation("FUTURE_EFFECTIVE", "The relevant source is not currently effective.");
      if (permitted.some((row: any) => row.effectiveUntil && row.effectiveUntil < appliesOn)) {
        return limitation("OUTDATED_EFFECTIVE", "The relevant source is no longer effective on the requested date.");
      }
      if (permitted.some((row: any) => row.effectiveUntil && row.effectiveUntil < today)) {
        return limitation("OUTDATED_EFFECTIVE", "The relevant source is no longer current.");
      }
      if (currentPeriod.length > 0) return limitation("NOT_EFFECTIVE_ON_SELECTED_DATE", "The current source was not effective on the selected date.");
      return limitation("MISSING_OR_INSUFFICIENT_SOURCE", "No approved, applicable policy source supports an answer.");
    }
    const scored = timely.map((row: any) => ({ row, score: topicalScore(row, question) }));
    const best = Math.max(...scored.map((candidate) => candidate.score));
    if (best === 0) return limitation("MISSING_OR_INSUFFICIENT_SOURCE", "No applicable policy source is topically relevant to this question.");
    if (scored.filter((candidate) => candidate.score > 0).length > 1) {
      return limitation("CONFLICTING_SOURCES", "More than one topically relevant approved policy source applies; request human clarification.");
    }
    const selectedRow = scored.find((candidate) => candidate.score === best)!.row;
    // Lock and read the exact source snapshot before any external AI call.
    // The transaction commits immediately afterwards; post-model validation
    // below detects any intervening lifecycle, membership, or content change.
    const [source] = await tx.select({ text: onbHrPolicyVersions.text }).from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, selectedRow.policyId),
      eq(onbHrPolicyVersions.version, selectedRow.version), eq(onbHrPolicyVersions.status, "published"),
    )).for("update");
    if (!source) return limitation("SOURCE_CHANGED", "The source changed before it could be cited; retry the question.");
    return { selectedRow, sourceText: source.text };
  });
  if ("limitation" in preflight) return preflight;
  const selectedRow = preflight.selectedRow;
  const excerpt = sentenceForQuestion(preflight.sourceText, question);
  if (containsPromptInjection(preflight.sourceText)) {
    return { answer: null, limitation: { code: "UNTRUSTED_SOURCE_CONTENT", message: "The source extract contains instructions or content that cannot safely support an answer." }, citations: [] };
  }
  let selection: PolicyExtractSelection;
  try {
    selection = await selectExtract(question, excerpt, preflight.sourceText);
  } catch (error) {
    if (error instanceof HrPolicyAiUnavailableError) throw new HrPolicyError(error.message, 503, "APPROVED_AI_UNAVAILABLE");
    throw error;
  }
  if (selection.outcome === "injected") return { answer: null, limitation: { code: "UNTRUSTED_SOURCE_CONTENT", message: "The source extract contains instructions or content that cannot safely support an answer." }, citations: [] };
  if (selection.outcome === "conflicting") return { answer: null, limitation: { code: "CONFLICTING_SOURCES", message: "The approved source evidence is conflicting; request human clarification." }, citations: [] };
  if (selection.outcome !== "supported" || selection.excerptId !== "extract-1" || selection.quotedText !== excerpt) {
    return { answer: null, limitation: { code: "INSUFFICIENT_SUPPORT", message: "The approved source does not directly support an answer to this question." }, citations: [] };
  }
  return db.transaction(async (tx) => {
    const role = await liveMember(tx, organizationId, userId);
    const now = new Date().toISOString().slice(0, 10);
    const [current] = await tx.select().from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, selectedRow.policyId),
      eq(onbHrPolicyVersions.version, selectedRow.version), eq(onbHrPolicyVersions.status, "published"),
    )).for("update");
    if (!current || !isAudience(current, role) || !matchesApplicability(current.applicability, selected) ||
        current.effectiveFrom > appliesOn || current.effectiveFrom > now ||
        (current.effectiveUntil && (current.effectiveUntil < appliesOn || current.effectiveUntil < now)) ||
        (current.reviewBy && current.reviewBy < now) || current.text !== preflight.sourceText) {
      return { answer: null, limitation: { code: "SOURCE_CHANGED", message: "The source changed before it could be cited; retry the question." }, citations: [] };
    }
    const excerptId = `extract-${createHash("sha256").update(excerpt).digest("hex").slice(0, 20)}`;
    await tx.insert(onbHrPolicyExcerpts).values({
      organizationId, policyId: current.policyId, version: current.version, excerptId, text: excerpt,
    }).onConflictDoNothing();
    return { answer: excerpt, limitation: null, citations: [{
      policyId: current.policyId, version: current.version, excerptId, text: excerpt,
      sourceReference: current.sourceReference, effectiveFrom: current.effectiveFrom,
    }] };
  });
}

export async function readPolicyExcerpt(organizationId: string, userId: string, policyId: string, version: number, excerptId: string) {
  return db.transaction(async (tx) => {
    const role = await liveMember(tx, organizationId, userId);
    const [row] = await tx.select().from(onbHrPolicyVersions).where(and(
      eq(onbHrPolicyVersions.organizationId, organizationId), eq(onbHrPolicyVersions.policyId, policyId), eq(onbHrPolicyVersions.version, version),
    )).for("update");
    if (!row || !isAudience(row, role)) throw new HrPolicyError("Citation excerpt not found.", 404);
    const today = new Date().toISOString().slice(0, 10);
    const isCurrent = row.status === "published" && row.effectiveFrom <= today &&
      (!row.effectiveUntil || row.effectiveUntil >= today) && (!row.reviewBy || row.reviewBy >= today);
    if (!isCurrent) await verifiedAuthority(tx, organizationId, userId, "hr-policy-historical-review");
    const [excerpt] = await tx.select().from(onbHrPolicyExcerpts).where(and(
      eq(onbHrPolicyExcerpts.organizationId, organizationId), eq(onbHrPolicyExcerpts.policyId, policyId),
      eq(onbHrPolicyExcerpts.version, version), eq(onbHrPolicyExcerpts.excerptId, excerptId),
    ));
    if (!excerpt) throw new HrPolicyError("Citation excerpt not found.", 404);
    return { policyId, version, excerptId, text: excerpt.text, sourceReference: row.sourceReference, effectiveFrom: row.effectiveFrom, isCurrent };
  });
}

export async function listPolicyHandoffs(organizationId: string, userId: string) {
  return db.transaction(async (tx) => {
    await verifiedAuthority(tx, organizationId, userId, "hr-policy-handoff-resolve");
    const rows = await tx.select().from(onbHrPolicyHandoffs).where(eq(onbHrPolicyHandoffs.organizationId, organizationId)).orderBy(desc(onbHrPolicyHandoffs.createdAt));
    return rows.map((row: any) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null }));
  });
}

export async function createPolicyHandoff(organizationId: string, userId: string, input: unknown) {
  const body = object(input);
  const question = text(body.question, "question", 2000);
  const appliesOn = dateOnly(body.appliesOn, "appliesOn", true);
  const selected = applicability(body.applicability);
  const fingerprint = createHash("sha256").update(JSON.stringify({ question: question.toLowerCase().replace(/\s+/g, " "), appliesOn, selected })).digest("hex");
  return db.transaction(async (tx) => {
    await liveMember(tx, organizationId, userId);
    const [handoff] = await tx.insert(onbHrPolicyHandoffs).values({
      organizationId, requesterUserId: userId, fingerprint, question, appliesOn, applicability: selected,
    }).onConflictDoNothing().returning();
    if (handoff) return { handoff, deduplicated: false, externalDispatch: false };
    const [existing] = await tx.select().from(onbHrPolicyHandoffs).where(and(
      eq(onbHrPolicyHandoffs.organizationId, organizationId), eq(onbHrPolicyHandoffs.requesterUserId, userId),
      eq(onbHrPolicyHandoffs.fingerprint, fingerprint),
    ));
    if (!existing) throw new HrPolicyError("Policy handoff changed; retry.", 409);
    return { handoff: existing, deduplicated: true, externalDispatch: false };
  });
}

export async function resolvePolicyHandoff(organizationId: string, userId: string, handoffId: number, input: unknown) {
  const resolution = text(object(input).resolution, "resolution", 4000);
  return db.transaction(async (tx) => {
    const grant = await verifiedAuthority(tx, organizationId, userId, "hr-policy-handoff-resolve");
    const [updated] = await tx.update(onbHrPolicyHandoffs).set({
      status: "resolved", resolvedByUserId: userId, resolverAuthorityAssignmentId: grant.id,
      resolution, resolvedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(onbHrPolicyHandoffs.organizationId, organizationId), eq(onbHrPolicyHandoffs.id, handoffId), eq(onbHrPolicyHandoffs.status, "open"))).returning();
    if (!updated) throw new HrPolicyError("Open policy handoff not found.", 404);
    return { handoff: updated, externalDispatch: false };
  });
}