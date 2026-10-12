import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  onbGovernanceAuthorityAssignments,
  onbGovernanceDecisionReviews,
  onbGovernanceDecisions,
  onbGovernanceHistory,
  onbGovernanceReminders,
  onbGovernanceRequirements,
  organizationMembershipsTable,
  type GovernanceDecisionStatus,
} from "@workspace/db";
import {
  GOVERNANCE_DECISIONS,
  GOVERNANCE_REQUIREMENTS,
} from "./governance-catalog";
import { canonicalAuthorityRoleId } from "./workforce-policies";
import { makeSharedTick } from "./shared-tick";
import {
  assertGovernanceMutationAllowed,
  finalizeAmbiguousGovernanceDispatch,
  GovernanceDispatchBlockedError,
} from "./governance-dispatch";

export type GovernanceActor = {
  userId: string;
  organizationRole?: "owner" | "admin" | "member";
};

export type SensitiveLifecycleAuthorityContext = {
  authorityStatus: "verified" | "nominated" | "revoked" | "expired" | "missing";
  reviewer: {
    assignmentId: number;
    role: "privacy" | "legal";
    memberId: string;
    memberDisplay: string;
    expiresAt: string | null;
  } | null;
  nomination: {
    assignmentId: number;
    role: "privacy" | "legal";
    memberId: string;
    memberDisplay: string;
  } | null;
};

export class GovernanceNotFoundError extends Error {}
export class GovernancePermissionError extends Error {}
export class GovernanceConflictError extends Error {}
export class GovernanceValidationError extends Error {}

const CUSTOM_RUNTIME_WORKFLOWS = new Set([
  "worker-record-documents", "background-verification", "it-identity-access",
  "assets-workplace", "payroll-benefits", "frontline-deployment",
  "candidate-communications", "candidate-voice", "candidate-portal",
]);

/**
 * Custom decisions remain planning-only unless they opt into the persisted,
 * typed runtime scope. Labels from the editable register are deliberately not
 * interpreted as executable scope.
 */
function validateCustomRuntimeScope(proposedValue: unknown, impactedWorkflows: readonly string[]): void {
  if (!proposedValue || typeof proposedValue !== "object" || Array.isArray(proposedValue)) return;
  const runtime = (proposedValue as { governanceRuntime?: unknown }).governanceRuntime;
  if (runtime === undefined) return;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new GovernanceValidationError("governanceRuntime must be an object.");
  }
  const scope = runtime as { domain?: unknown; impactedWorkflows?: unknown };
  if (
    (scope.domain !== "legal" && scope.domain !== "privacy" && scope.domain !== "safety") ||
    !Array.isArray(scope.impactedWorkflows) ||
    scope.impactedWorkflows.length === 0 ||
    scope.impactedWorkflows.some((value) => typeof value !== "string" || !CUSTOM_RUNTIME_WORKFLOWS.has(value)) ||
    [...new Set(scope.impactedWorkflows)].sort().join("|") !== [...new Set(impactedWorkflows)].sort().join("|")
  ) {
    throw new GovernanceValidationError(
      "governanceRuntime requires a legal, privacy, or safety domain and matching canonical impactedWorkflows.",
    );
  }
}

const MAX_TEXT = 4_000;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;

function cleanText(value: unknown, name: string, required = true): string | null {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return null;
    throw new GovernanceValidationError(`${name} must be a string.`);
  }
  const cleaned = value.trim();
  if (!cleaned && required) throw new GovernanceValidationError(`${name} is required.`);
  if (cleaned.length > MAX_TEXT) throw new GovernanceValidationError(`${name} is too long.`);
  return cleaned || null;
}

export function governanceKey(value: unknown): string {
  const key = cleanText(value, "key")!;
  if (!KEY_PATTERN.test(key)) {
    throw new GovernanceValidationError("key must use letters, numbers, and hyphens.");
  }
  return key;
}

export function governanceRole(value: unknown): string {
  const role = typeof value === "string" ? canonicalAuthorityRoleId(value) : null;
  if (!role) throw new GovernanceValidationError("A valid accountable specialist role is required.");
  return role;
}

function cleanStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GovernanceValidationError(`${name} must be an array of strings.`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

function dueDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new GovernanceValidationError("reviewDueAt must be an ISO timestamp.");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GovernanceValidationError("reviewDueAt must be an ISO timestamp.");
  return date;
}

function requireEditor(actor: GovernanceActor): void {
  if (actor.organizationRole !== "owner" && actor.organizationRole !== "admin") {
    throw new GovernancePermissionError("Organization owner or admin role required to draft governance records.");
  }
}

/**
 * A server-managed allow-list is the bootstrap trust root. There is
 * intentionally no owner/admin fallback: a tenant role can never be used to
 * self-declare legal, privacy, safety, or other specialist authority.
 */
export function isVerifiedGovernanceOperator(userId: string): boolean {
  return new Set(
    (process.env.GOVERNANCE_VERIFIED_OPERATOR_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ).has(userId);
}

function requireVerifiedOperator(actor: GovernanceActor): void {
  if (!isVerifiedGovernanceOperator(actor.userId)) {
    throw new GovernancePermissionError(
      "A server-verified governance operator is required; tenant administration alone cannot assign specialist authority.",
    );
  }
}

function decisionPublic(
  row: typeof onbGovernanceDecisions.$inferSelect,
  approvedRevision: number | null = row.approvedAt ? row.revision : null,
) {
  return {
    key: row.key,
    revision: row.revision,
    title: row.title,
    proposedValue: row.proposedValue,
    rationale: row.rationale,
    risk: row.risk,
    accountableRole: row.accountableRole,
    status: row.status,
    reviewDueAt: row.reviewDueAt?.toISOString() ?? null,
    impactedWorkflows: row.impactedWorkflows,
    sourceReference: row.sourceReference,
    isProvisional: row.isProvisional,
    isCurrent: row.isCurrent,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requirementPublic(row: typeof onbGovernanceRequirements.$inferSelect) {
  return {
    key: row.key,
    title: row.title,
    sourceReference: row.sourceReference,
    reviewOwnerRole: row.reviewOwnerRole,
    relatedDecisionKeys: row.relatedDecisionKeys,
    coverageState: row.coverageState,
    coverage: {
      implemented: row.implemented,
      tested: row.tested,
      configured: row.configured,
      approvedForLive: row.approvedForLive,
    },
    relatedImplementation: row.relatedImplementation,
    evidenceReference: row.evidenceReference,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assignmentPublic(row: typeof onbGovernanceAuthorityAssignments.$inferSelect) {
  return {
    id: row.id,
    role: row.authorityRole,
    assigneeUserId: row.assigneeUserId,
    verificationStatus: row.verificationStatus,
    verifiedByUserId: row.verifiedByUserId,
    verificationReference: row.verificationReference,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function safeMemberDisplay(userId: string): string {
  const trimmed = userId.trim();
  if (trimmed.length <= 8) return `Organization member · ${trimmed}`;
  return `Organization member · ${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * Return only the current privacy/legal authority projection needed by
 * Sensitive lifecycle administration. It contains no email, profile, or unrelated
 * tenant membership data. A nomination is visible as a route to verification,
 * never as approval authority.
 */
async function sensitiveLifecycleAuthorityContextFrom(
  executor: Pick<typeof db, "select">,
  organizationId: string,
): Promise<SensitiveLifecycleAuthorityContext> {
  const now = new Date();
  const rows = await executor.select({
    assignment: onbGovernanceAuthorityAssignments,
    memberId: organizationMembershipsTable.clerkUserId,
  }).from(onbGovernanceAuthorityAssignments).innerJoin(
    organizationMembershipsTable,
    and(
      eq(organizationMembershipsTable.organizationId, onbGovernanceAuthorityAssignments.organizationId),
      eq(organizationMembershipsTable.clerkUserId, onbGovernanceAuthorityAssignments.assigneeUserId),
      isNull(organizationMembershipsTable.revokedAt),
    ),
  ).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    inArray(onbGovernanceAuthorityAssignments.authorityRole, ["privacy", "legal"]),
  )).orderBy(desc(onbGovernanceAuthorityAssignments.createdAt));

  const active = rows.find(({ assignment }) =>
    assignment.verificationStatus === "verified" &&
    assignment.revokedAt === null &&
    (assignment.expiresAt === null || assignment.expiresAt > now),
  );
  if (active) {
    return {
      authorityStatus: "verified",
      reviewer: {
        assignmentId: active.assignment.id,
        role: active.assignment.authorityRole as "privacy" | "legal",
        memberId: active.memberId,
        memberDisplay: safeMemberDisplay(active.memberId),
        expiresAt: active.assignment.expiresAt?.toISOString() ?? null,
      },
      nomination: null,
    };
  }

  const nomination = rows.find(({ assignment }) =>
    assignment.verificationStatus === "pending" && assignment.revokedAt === null,
  );
  if (nomination) {
    return {
      authorityStatus: "nominated",
      reviewer: null,
      nomination: {
        assignmentId: nomination.assignment.id,
        role: nomination.assignment.authorityRole as "privacy" | "legal",
        memberId: nomination.memberId,
        memberDisplay: safeMemberDisplay(nomination.memberId),
      },
    };
  }

  const previous = rows.find(({ assignment }) => assignment.verificationStatus === "verified");
  return {
    authorityStatus: previous
      ? previous.assignment.revokedAt !== null ? "revoked" : "expired"
      : "missing",
    reviewer: null,
    nomination: null,
  };
}

export async function getSensitiveLifecycleAuthorityContext(
  organizationId: string,
): Promise<SensitiveLifecycleAuthorityContext> {
  return sensitiveLifecycleAuthorityContextFrom(db, organizationId);
}

export async function getSensitiveLifecycleAuthorityContextInTransaction(
  tx: Pick<typeof db, "select">,
  organizationId: string,
): Promise<SensitiveLifecycleAuthorityContext> {
  return sensitiveLifecycleAuthorityContextFrom(tx, organizationId);
}

async function recordHistory(
  organizationId: string,
  entityType: string,
  entityKey: string,
  eventType: string,
  actorUserId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(onbGovernanceHistory).values({
    organizationId,
    entityType,
    entityKey,
    eventType,
    actorUserId,
    detail,
  });
}

async function scheduleDecisionReminder(
  organizationId: string,
  key: string,
  revision: number,
  reviewDueAt: Date | null,
): Promise<void> {
  if (!reviewDueAt) return;
  await db.insert(onbGovernanceReminders).values({
    organizationId,
    decisionKey: key,
    decisionRevision: revision,
    dueAt: reviewDueAt,
  }).onConflictDoNothing();
}

/** Insert catalog defaults only for missing tenant keys; no tenant record is updated. */
export async function ensureGovernanceSeeded(organizationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Lazy seeding is a GET-side convenience, not a reason to defeat a live
    // fence. Leave missing catalog rows alone until dispatch is finalized.
    try {
      await assertGovernanceMutationAllowed(tx, organizationId);
    } catch (error) {
      if (error instanceof GovernanceDispatchBlockedError) return;
      throw error;
    }
    for (const entry of GOVERNANCE_DECISIONS) {
    const key = governanceKey(entry.id);
    const role = governanceRole(entry.accountableReviewRole);
    const reviewDueAt = dueDate(entry.reviewDueDate);
    await tx.insert(onbGovernanceDecisions).values({
      organizationId,
      key,
      revision: 1,
      title: cleanText(entry.title, "catalog decision title")!,
      proposedValue: entry.proposedValue ?? null,
      rationale: cleanText(entry.rationale, "catalog decision rationale")!,
      risk: cleanText(entry.risks.join("; "), "catalog decision risk")!,
      accountableRole: role,
      // Catalog is a working baseline; it cannot introduce a live approval.
      status: "provisional",
      reviewDueAt,
      impactedWorkflows: cleanStringArray(entry.impactedWorkflows, "catalog impacted workflows"),
      sourceReference: cleanText(entry.sourceRefs.join("; "), "catalog source reference", false),
      isProvisional: true,
      isCurrent: true,
      createdByUserId: "system:governance-catalog",
    }).onConflictDoNothing();
    if (reviewDueAt) {
      await tx.insert(onbGovernanceReminders).values({
        organizationId, decisionKey: key, decisionRevision: 1, dueAt: reviewDueAt,
      }).onConflictDoNothing();
    }
    }
    for (const entry of GOVERNANCE_REQUIREMENTS) {
    await tx.insert(onbGovernanceRequirements).values({
      organizationId,
      key: governanceKey(entry.id),
      title: cleanText(entry.title, "catalog requirement title")!,
      sourceReference: cleanText(entry.sourceRefs.join("; "), "catalog source reference")!,
      reviewOwnerRole: governanceRole(entry.reviewOwner),
      relatedDecisionKeys: [],
      coverageState: entry.coverage,
      // Existing source/test references are provenance, not a claim that a
      // tenant has configured or approved the requirement for live use.
      relatedImplementation: entry.implementationRefs.join("; ") || null,
      evidenceReference: entry.evidenceRefs.join("; ") || null,
    }).onConflictDoNothing();
    }
  });
}

export async function listGovernanceDecisions(organizationId: string) {
  await ensureGovernanceSeeded(organizationId);
  const [rows, revisions] = await Promise.all([
    db.select().from(onbGovernanceDecisions).where(and(
    eq(onbGovernanceDecisions.organizationId, organizationId),
    eq(onbGovernanceDecisions.isCurrent, true),
    )).orderBy(asc(onbGovernanceDecisions.key)),
    db.select({
      key: onbGovernanceDecisions.key,
      revision: onbGovernanceDecisions.revision,
      approvedAt: onbGovernanceDecisions.approvedAt,
    }).from(onbGovernanceDecisions).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      sql`${onbGovernanceDecisions.approvedAt} is not null`,
    )),
  ]);
  const approvedByKey = new Map<string, number>();
  for (const row of revisions) {
    approvedByKey.set(row.key, Math.max(approvedByKey.get(row.key) ?? 0, row.revision));
  }
  return rows.map((row) => decisionPublic(row, approvedByKey.get(row.key) ?? null));
}

export async function createGovernanceDecision(
  organizationId: string,
  actor: GovernanceActor,
  input: {
    key?: unknown; title?: unknown; proposedValue?: unknown; rationale?: unknown; risk?: unknown;
    accountableRole?: unknown; reviewDueAt?: unknown; impactedWorkflows?: unknown; sourceReference?: unknown;
  },
) {
  requireEditor(actor);
  // Reserve catalog keys and their authority/workflow mappings before a tenant
  // editor can create a custom decision. This prevents a pre-seed key
  // collision from replacing a governed seed with a self-routed record.
  await ensureGovernanceSeeded(organizationId);
  const key = governanceKey(input.key);
  const reviewDueAt = dueDate(input.reviewDueAt);
  const impactedWorkflows = cleanStringArray(input.impactedWorkflows, "impactedWorkflows");
  validateCustomRuntimeScope(input.proposedValue, impactedWorkflows);
  const created = await db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, organizationId);
    const [decision] = await tx.insert(onbGovernanceDecisions).values({
      organizationId, key, revision: 1,
      title: cleanText(input.title, "title")!,
      proposedValue: input.proposedValue ?? null,
      rationale: cleanText(input.rationale, "rationale")!,
      risk: cleanText(input.risk, "risk")!,
      accountableRole: governanceRole(input.accountableRole),
      status: "draft",
      reviewDueAt,
      impactedWorkflows,
      sourceReference: cleanText(input.sourceReference, "sourceReference", false),
      isProvisional: true,
      isCurrent: true,
      createdByUserId: actor.userId,
    }).returning();
    if (!decision) throw new GovernanceConflictError("Decision already exists.");
    if (reviewDueAt) {
      await tx.insert(onbGovernanceReminders).values({
        organizationId, decisionKey: key, decisionRevision: 1, dueAt: reviewDueAt,
      }).onConflictDoNothing();
    }
    await tx.insert(onbGovernanceHistory).values({
      organizationId, entityType: "decision", entityKey: key, eventType: "created",
      actorUserId: actor.userId, detail: { revision: 1, status: "draft" },
    });
    return decision;
  });
  return decisionPublic(created);
}

export async function reviseGovernanceDecision(
  organizationId: string,
  actor: GovernanceActor,
  keyInput: unknown,
  input: {
    expectedRevision?: unknown; title?: unknown; proposedValue?: unknown; rationale?: unknown; risk?: unknown;
    accountableRole?: unknown; reviewDueAt?: unknown; impactedWorkflows?: unknown; sourceReference?: unknown;
  },
) {
  requireEditor(actor);
  const key = governanceKey(keyInput);
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new GovernanceValidationError("expectedRevision must be a positive integer.");
  }
  const nextRole = input.accountableRole === undefined
    ? undefined
    : governanceRole(input.accountableRole);
  const nextWorkflows = input.impactedWorkflows === undefined
    ? undefined
    : cleanStringArray(input.impactedWorkflows, "impactedWorkflows");
  const created = await db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, organizationId);
    const [current] = await tx.select().from(onbGovernanceDecisions).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      eq(onbGovernanceDecisions.key, key),
      eq(onbGovernanceDecisions.isCurrent, true),
    )).for("update");
    if (!current) throw new GovernanceNotFoundError("Decision not found.");
    if (current.revision !== expectedRevision) {
      throw new GovernanceConflictError(`Decision changed since revision ${expectedRevision}; reload before retrying.`);
    }
    if (input.proposedValue !== undefined) {
      validateCustomRuntimeScope(input.proposedValue, nextWorkflows ?? current.impactedWorkflows);
    }
    // An ordinary tenant editor may revise rationale/value, but cannot redirect
    // a governed review to a friendlier authority or narrow its live impact.
    // A server-verified operator is the only path for such a mapping change.
    if (
      (nextRole !== undefined && nextRole !== current.accountableRole) ||
      (nextWorkflows !== undefined &&
        JSON.stringify(nextWorkflows) !== JSON.stringify(current.impactedWorkflows))
    ) {
      requireVerifiedOperator(actor);
    }
    const revision = current.revision + 1;
    const reviewDueAt = input.reviewDueAt === undefined ? current.reviewDueAt : dueDate(input.reviewDueAt);
    await tx.update(onbGovernanceDecisions).set({
      status: "superseded", isCurrent: false, updatedAt: new Date(),
    }).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      eq(onbGovernanceDecisions.key, key),
      eq(onbGovernanceDecisions.revision, current.revision),
    ));
    await tx.update(onbGovernanceReminders).set({ status: "cancelled" }).where(and(
      eq(onbGovernanceReminders.organizationId, organizationId),
      eq(onbGovernanceReminders.decisionKey, key),
      eq(onbGovernanceReminders.decisionRevision, current.revision),
      eq(onbGovernanceReminders.status, "pending"),
    ));
    const [next] = await tx.insert(onbGovernanceDecisions).values({
      organizationId, key, revision,
      title: input.title === undefined ? current.title : cleanText(input.title, "title")!,
      proposedValue: input.proposedValue === undefined ? current.proposedValue : input.proposedValue ?? null,
      rationale: input.rationale === undefined ? current.rationale : cleanText(input.rationale, "rationale")!,
      risk: input.risk === undefined ? current.risk : cleanText(input.risk, "risk")!,
      accountableRole: nextRole ?? current.accountableRole,
      status: "draft", reviewDueAt,
      impactedWorkflows: nextWorkflows ?? current.impactedWorkflows,
      sourceReference: input.sourceReference === undefined ? current.sourceReference : cleanText(input.sourceReference, "sourceReference", false),
      isProvisional: true, isCurrent: true, createdByUserId: actor.userId,
    }).returning();
    if (!next) throw new Error("Decision revision was not persisted.");
    if (reviewDueAt) {
      await tx.insert(onbGovernanceReminders).values({
        organizationId, decisionKey: key, decisionRevision: revision, dueAt: reviewDueAt,
      }).onConflictDoNothing();
    }
    await tx.insert(onbGovernanceHistory).values({
      organizationId, entityType: "decision", entityKey: key, eventType: "revised",
      actorUserId: actor.userId, detail: { fromRevision: current.revision, revision },
    });
    return next;
  });
  return decisionPublic(created);
}

async function activeAuthorityInTransaction(
  // Drizzle keeps transaction's concrete generic private; this is restricted
  // to its select/query surface so authority and state transition share a lock.
  tx: any,
  organizationId: string,
  userId: string,
  authorityRole: string,
) {
  const now = new Date();
  const [assignment] = await tx.select().from(onbGovernanceAuthorityAssignments).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.assigneeUserId, userId),
    eq(onbGovernanceAuthorityAssignments.authorityRole, authorityRole),
    eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
    isNull(onbGovernanceAuthorityAssignments.revokedAt),
    or(
      isNull(onbGovernanceAuthorityAssignments.expiresAt),
      gt(onbGovernanceAuthorityAssignments.expiresAt, now),
    ),
  )).orderBy(desc(onbGovernanceAuthorityAssignments.createdAt)).limit(1).for("update");
  return assignment ?? null;
}

export async function reviewGovernanceDecision(
  organizationId: string,
  actor: GovernanceActor,
  keyInput: unknown,
  input: { revision?: unknown; outcome?: unknown; reason?: unknown; verificationReference?: unknown },
) {
  const key = governanceKey(keyInput);
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new GovernanceValidationError("revision must be a positive integer.");
  const outcome = input.outcome === "approved" || input.outcome === "rejected" ? input.outcome : null;
  if (!outcome) throw new GovernanceValidationError("outcome must be approved or rejected.");
  const result = await db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, organizationId);
    const [decision] = await tx.select().from(onbGovernanceDecisions).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      eq(onbGovernanceDecisions.key, key),
      eq(onbGovernanceDecisions.revision, revision),
      eq(onbGovernanceDecisions.isCurrent, true),
    )).for("update");
    if (!decision) throw new GovernanceConflictError("Decision is no longer the current revision; reload before reviewing.");
    if (!["draft", "provisional"].includes(decision.status)) {
      throw new GovernanceConflictError("This decision revision has already been reviewed.");
    }
    const authority = await activeAuthorityInTransaction(tx, organizationId, actor.userId, decision.accountableRole);
    if (!authority) throw new GovernancePermissionError("Verified active specialist authority is required for this review.");
    const reason = cleanText(input.reason, "reason")!;
    const verificationReference = cleanText(input.verificationReference, "verificationReference")!;
    const [review] = await tx.insert(onbGovernanceDecisionReviews).values({
      organizationId, decisionKey: key, decisionRevision: revision, outcome, reason,
      authorityAssignmentId: authority.id, reviewedByUserId: actor.userId, verificationReference,
    }).returning();
    const [updated] = await tx.update(onbGovernanceDecisions).set({
      status: outcome, approvedByUserId: outcome === "approved" ? actor.userId : null,
      approvedAt: outcome === "approved" ? new Date() : null, updatedAt: new Date(),
    }).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId),
      eq(onbGovernanceDecisions.key, key),
      eq(onbGovernanceDecisions.revision, revision),
    )).returning();
    await tx.update(onbGovernanceReminders).set({ status: "cancelled" }).where(and(
      eq(onbGovernanceReminders.organizationId, organizationId),
      eq(onbGovernanceReminders.decisionKey, key),
      eq(onbGovernanceReminders.decisionRevision, revision),
      eq(onbGovernanceReminders.status, "pending"),
    ));
    await tx.insert(onbGovernanceHistory).values({
      organizationId, entityType: "decision", entityKey: key, eventType: `review-${outcome}`,
      actorUserId: actor.userId, detail: { revision, authorityAssignmentId: authority.id },
    });
    return { decision: updated!, review: review! };
  });
  return {
    decision: decisionPublic(result.decision),
    review: {
      id: result.review.id, revision: result.review.decisionRevision, outcome: result.review.outcome,
      reason: result.review.reason, reviewedByUserId: result.review.reviewedByUserId,
      verificationReference: result.review.verificationReference,
      createdAt: result.review.createdAt.toISOString(),
    },
  };
}

export async function getGovernanceDecisionHistory(organizationId: string, keyInput: unknown) {
  const key = governanceKey(keyInput);
  const [revisions, reviews] = await Promise.all([
    db.select().from(onbGovernanceDecisions).where(and(
      eq(onbGovernanceDecisions.organizationId, organizationId), eq(onbGovernanceDecisions.key, key),
    )).orderBy(desc(onbGovernanceDecisions.revision)),
    db.select().from(onbGovernanceDecisionReviews).where(and(
      eq(onbGovernanceDecisionReviews.organizationId, organizationId), eq(onbGovernanceDecisionReviews.decisionKey, key),
    )).orderBy(desc(onbGovernanceDecisionReviews.createdAt)),
  ]);
  if (!revisions.length) throw new GovernanceNotFoundError("Decision not found.");
  const approvedRevision = revisions.reduce<number | null>(
    (latest, row) => row.approvedAt && (latest === null || row.revision > latest) ? row.revision : latest,
    null,
  );
  return {
    revisions: revisions.map((row) => decisionPublic(row, approvedRevision)),
    reviews: reviews.map((row) => ({
      id: row.id, revision: row.decisionRevision, outcome: row.outcome, reason: row.reason,
      authorityAssignmentId: row.authorityAssignmentId, reviewedByUserId: row.reviewedByUserId,
      verificationReference: row.verificationReference, createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function listGovernanceRequirements(organizationId: string) {
  await ensureGovernanceSeeded(organizationId);
  const rows = await db.select().from(onbGovernanceRequirements).where(
    eq(onbGovernanceRequirements.organizationId, organizationId),
  ).orderBy(asc(onbGovernanceRequirements.key));
  return rows.map(requirementPublic);
}

export async function updateGovernanceRequirementCoverage(
  organizationId: string,
  actor: GovernanceActor,
  keyInput: unknown,
  input: {
    expectedVersion?: unknown; implemented?: unknown; tested?: unknown; configured?: unknown;
    approvedForLive?: unknown; coverageState?: unknown; relatedImplementation?: unknown; evidenceReference?: unknown;
  },
) {
  const key = governanceKey(keyInput);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new GovernanceValidationError("expectedVersion must be a positive integer.");
  }
  const updated = await db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, organizationId);
    const [requirement] = await tx.select().from(onbGovernanceRequirements).where(and(
      eq(onbGovernanceRequirements.organizationId, organizationId), eq(onbGovernanceRequirements.key, key),
    )).for("update");
    if (!requirement) throw new GovernanceNotFoundError("Requirement not found.");
    if (requirement.version !== expectedVersion) {
      throw new GovernanceConflictError(`Requirement changed since version ${expectedVersion}; reload before retrying.`);
    }
    const authority = await activeAuthorityInTransaction(tx, organizationId, actor.userId, requirement.reviewOwnerRole);
    if (!authority) throw new GovernancePermissionError("Verified active specialist authority is required to attest requirement coverage.");
    const bool = (value: unknown, current: boolean, field: string) => {
      if (value === undefined) return current;
      if (typeof value !== "boolean") throw new GovernanceValidationError(`${field} must be boolean.`);
      return value;
    };
    const coverageState = input.coverageState === undefined
      ? requirement.coverageState
      : input.coverageState === "gap" || input.coverageState === "partial" || input.coverageState === "covered"
        ? input.coverageState
        : (() => { throw new GovernanceValidationError("coverageState must be gap, partial, or covered."); })();
    const [next] = await tx.update(onbGovernanceRequirements).set({
      implemented: bool(input.implemented, requirement.implemented, "implemented"),
      tested: bool(input.tested, requirement.tested, "tested"),
      configured: bool(input.configured, requirement.configured, "configured"),
      approvedForLive: bool(input.approvedForLive, requirement.approvedForLive, "approvedForLive"),
      coverageState,
      relatedImplementation: input.relatedImplementation === undefined
        ? requirement.relatedImplementation : cleanText(input.relatedImplementation, "relatedImplementation", false),
      evidenceReference: input.evidenceReference === undefined
        ? requirement.evidenceReference : cleanText(input.evidenceReference, "evidenceReference", false),
      version: requirement.version + 1, updatedByUserId: actor.userId, updatedAt: new Date(),
    }).where(and(
      eq(onbGovernanceRequirements.organizationId, organizationId),
      eq(onbGovernanceRequirements.key, key),
      eq(onbGovernanceRequirements.version, expectedVersion),
    )).returning();
    if (!next) throw new GovernanceConflictError("Requirement changed; reload before retrying.");
    await tx.insert(onbGovernanceHistory).values({
      organizationId, entityType: "requirement", entityKey: key, eventType: "coverage-updated",
      actorUserId: actor.userId, detail: { version: next.version, authorityAssignmentId: authority.id },
    });
    return next;
  });
  return requirementPublic(updated);
}

export async function assignGovernanceAuthority(
  organizationId: string,
  actor: GovernanceActor,
  input: { role?: unknown; assigneeUserId?: unknown; verificationReference?: unknown; expiresAt?: unknown },
) {
  requireVerifiedOperator(actor);
  const assigneeUserId = cleanText(input.assigneeUserId, "assigneeUserId")!;
  const assignment = await db.transaction(async (tx) => {
  await assertGovernanceMutationAllowed(tx, organizationId);
  const [member] = await tx.select({ userId: organizationMembershipsTable.clerkUserId })
    .from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, assigneeUserId),
      isNull(organizationMembershipsTable.revokedAt),
    )).limit(1);
  if (!member) throw new GovernanceValidationError("Assignee must be an active member of this organization.");
  const [assignment] = await tx.insert(onbGovernanceAuthorityAssignments).values({
    organizationId, authorityRole: governanceRole(input.role), assigneeUserId,
    verificationStatus: "verified",
    verifiedByUserId: actor.userId,
    verificationReference: cleanText(input.verificationReference, "verificationReference")!,
    expiresAt: dueDate(input.expiresAt),
  }).returning();
  if (!assignment) throw new Error("Authority assignment was not persisted.");
  await tx.insert(onbGovernanceHistory).values({
    organizationId, entityType: "authority-assignment", entityKey: String(assignment.id),
    eventType: "verified-assigned", actorUserId: actor.userId,
    detail: { role: assignment.authorityRole, assigneeUserId },
  });
  return assignment;
  });
  return assignmentPublic(assignment);
}

/**
 * Owners/admins may nominate a reviewer, but this produces no authority. A
 * server-verified operator must later verify the pending nomination before it
 * can approve a decision or attest coverage.
 */
export async function requestGovernanceAuthority(
  organizationId: string,
  actor: GovernanceActor,
  input: { role?: unknown; assigneeUserId?: unknown; assignmentReason?: unknown },
) {
  requireEditor(actor);
  const assigneeUserId = cleanText(input.assigneeUserId, "assigneeUserId")!;
  const assignment = await db.transaction(async (tx) => {
  await assertGovernanceMutationAllowed(tx, organizationId);
  const [member] = await tx.select({ userId: organizationMembershipsTable.clerkUserId })
    .from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, assigneeUserId),
      isNull(organizationMembershipsTable.revokedAt),
    )).limit(1);
  if (!member) throw new GovernanceValidationError("Assignee must be an active member of this organization.");
  const [assignment] = await tx.insert(onbGovernanceAuthorityAssignments).values({
    organizationId,
    authorityRole: governanceRole(input.role),
    assigneeUserId,
    verificationStatus: "pending",
    verifiedByUserId: `pending:${actor.userId}`,
    verificationReference: `Pending owner nomination: ${cleanText(input.assignmentReason, "assignmentReason")!}`,
  }).returning();
  if (!assignment) throw new Error("Authority nomination was not persisted.");
  await tx.insert(onbGovernanceHistory).values({
    organizationId, entityType: "authority-assignment", entityKey: String(assignment.id),
    eventType: "nominated", actorUserId: actor.userId,
    detail: { role: assignment.authorityRole, assigneeUserId },
  });
  return assignment;
  });
  return assignmentPublic(assignment);
}

export async function verifyGovernanceAuthority(
  organizationId: string,
  actor: GovernanceActor,
  assignmentId: unknown,
  verificationReference: unknown,
) {
  requireVerifiedOperator(actor);
  const id = Number(assignmentId);
  if (!Number.isInteger(id) || id < 1) throw new GovernanceValidationError("A valid assignment id is required.");
  const assignment = await db.transaction(async (tx) => {
  await assertGovernanceMutationAllowed(tx, organizationId);
  const [assignment] = await tx.update(onbGovernanceAuthorityAssignments).set({
    verificationStatus: "verified",
    verifiedByUserId: actor.userId,
    verificationReference: cleanText(verificationReference, "verificationReference")!,
  }).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.id, id),
    eq(onbGovernanceAuthorityAssignments.verificationStatus, "pending"),
    isNull(onbGovernanceAuthorityAssignments.revokedAt),
  )).returning();
  if (!assignment) throw new GovernanceConflictError("Authority nomination is missing, revoked, or already verified.");
  await tx.insert(onbGovernanceHistory).values({
    organizationId, entityType: "authority-assignment", entityKey: String(id),
    eventType: "verified", actorUserId: actor.userId,
    detail: { role: assignment.authorityRole, assigneeUserId: assignment.assigneeUserId },
  });
  return assignment;
  });
  return assignmentPublic(assignment);
}

export async function revokeGovernanceAuthority(
  organizationId: string,
  actor: GovernanceActor,
  assignmentId: unknown,
) {
  requireVerifiedOperator(actor);
  const id = Number(assignmentId);
  if (!Number.isInteger(id) || id < 1) throw new GovernanceValidationError("A valid assignment id is required.");
  const assignment = await db.transaction(async (tx) => {
    await assertGovernanceMutationAllowed(tx, organizationId);
    // This row lock serializes a revoke against an in-flight review's active
    // authority lock. Exactly one operation is first in the serial order.
    const [current] = await tx.select().from(onbGovernanceAuthorityAssignments).where(and(
      eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
      eq(onbGovernanceAuthorityAssignments.id, id),
    )).for("update");
    if (!current || current.revokedAt) {
      throw new GovernanceConflictError("Authority assignment is missing or already revoked.");
    }
    const [revoked] = await tx.update(onbGovernanceAuthorityAssignments).set({
      revokedAt: new Date(), revokedByUserId: actor.userId,
    }).where(eq(onbGovernanceAuthorityAssignments.id, id)).returning();
    if (!revoked) throw new Error("Authority revocation was not persisted.");
    await tx.insert(onbGovernanceHistory).values({
      organizationId, entityType: "authority-assignment", entityKey: String(id),
      eventType: "revoked", actorUserId: actor.userId, detail: {},
    });
    return revoked;
  });
  return assignmentPublic(assignment);
}

export async function listGovernanceAssignments(organizationId: string) {
  const rows = await db.select().from(onbGovernanceAuthorityAssignments).where(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
  ).orderBy(desc(onbGovernanceAuthorityAssignments.createdAt));
  return rows.map(assignmentPublic);
}

export async function listGovernanceHistory(organizationId: string, limit = 100) {
  const rows = await db.select().from(onbGovernanceHistory).where(
    eq(onbGovernanceHistory.organizationId, organizationId),
  ).orderBy(desc(onbGovernanceHistory.createdAt), desc(onbGovernanceHistory.id)).limit(Math.min(Math.max(limit, 1), 250));
  return rows.map((row) => ({
    id: row.id, entityType: row.entityType, entityKey: row.entityKey, eventType: row.eventType,
    actorUserId: row.actorUserId, detail: row.detail, createdAt: row.createdAt.toISOString(),
  }));
}

export async function reconcileGovernanceDispatch(
  organizationId: string,
  actor: GovernanceActor,
  dispatchId: unknown,
  reconciliationReference: unknown,
) {
  requireVerifiedOperator(actor);
  const id = cleanText(dispatchId, "dispatchId")!;
  const reference = cleanText(reconciliationReference, "reconciliationReference")!;
  if (!await finalizeAmbiguousGovernanceDispatch(organizationId, id, reference)) {
    throw new GovernanceConflictError("Ambiguous governance dispatch is missing or already finalized.");
  }
  await recordHistory(organizationId, "governance-dispatch", id, "reconciled", actor.userId, { reference });
  return { dispatchId: id, status: "finalized" as const };
}

/**
 * Durable reminder sweep. It records an in-app review reminder only; it does
 * not send email or trigger a provider. Each row can transition once, so an
 * autoscale retry cannot duplicate a reminder.
 */
export async function dispatchDueGovernanceReminders(organizationId: string, now = new Date()) {
  const due = await db.select().from(onbGovernanceReminders).where(and(
    eq(onbGovernanceReminders.organizationId, organizationId),
    eq(onbGovernanceReminders.status, "pending"),
    lte(onbGovernanceReminders.dueAt, now),
  )).orderBy(asc(onbGovernanceReminders.dueAt)).limit(100);
  let dispatched = 0;
  for (const candidate of due) {
    const claimed = await db.transaction(async (tx) => {
      await assertGovernanceMutationAllowed(tx, organizationId);
      const [reminder] = await tx.select().from(onbGovernanceReminders).where(and(
        eq(onbGovernanceReminders.organizationId, organizationId),
        eq(onbGovernanceReminders.decisionKey, candidate.decisionKey),
        eq(onbGovernanceReminders.decisionRevision, candidate.decisionRevision),
        eq(onbGovernanceReminders.status, "pending"),
        lte(onbGovernanceReminders.dueAt, now),
      )).for("update");
      if (!reminder) return false;
      await tx.update(onbGovernanceReminders).set({
        status: "dispatched",
        dispatchedAt: now,
        dispatchCount: sql`${onbGovernanceReminders.dispatchCount} + 1`,
      }).where(and(
        eq(onbGovernanceReminders.organizationId, organizationId),
        eq(onbGovernanceReminders.decisionKey, reminder.decisionKey),
        eq(onbGovernanceReminders.decisionRevision, reminder.decisionRevision),
      ));
      // The state transition and audit receipt must commit together. A crash
      // therefore leaves either a retryable pending row or a visible history.
      await tx.insert(onbGovernanceHistory).values({
        organizationId,
        entityType: "decision",
        entityKey: reminder.decisionKey,
        eventType: "review-reminder-due",
        actorUserId: null,
        detail: { revision: reminder.decisionRevision, dueAt: reminder.dueAt.toISOString() },
      });
      return true;
    });
    if (claimed) dispatched += 1;
  }
  return { dispatched, checkedAt: now.toISOString() };
}

/**
 * The existing externally driven watcher invokes this shared tick. Rows are
 * tenant-scoped and atomically claimed, so parallel autoscale processes may
 * safely sweep the same due reminder without duplicate history entries.
 */
export const runGovernanceReminderTick = makeSharedTick(async () => {
  const organizations = await db.selectDistinct({
    organizationId: onbGovernanceReminders.organizationId,
  }).from(onbGovernanceReminders).where(eq(onbGovernanceReminders.status, "pending"));
  await Promise.all(organizations.map(({ organizationId }) =>
    dispatchDueGovernanceReminders(organizationId),
  ));
});