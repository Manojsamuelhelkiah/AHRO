import { randomUUID } from "node:crypto";
import { denyRetiredCaseCapability } from "./retired-case-capabilities";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, onbSettings, organizationMembershipsTable, onbGovernanceAuthorityAssignments } from "@workspace/db";
import { assertGovernanceMutationAllowed } from "./onboarding/governance-dispatch";
import { appendProtectedAuditInTransaction } from "./onboarding/protected-audit";
import { currentHroContext } from "./hro-context/core";
import { withHroContext } from "./hro-context/manager";
import { POLICY_SELECTION_IDENTITY, selectApprovedPolicyExtract, type PolicyExtractSelection, type PolicySelectionReceipt } from "./hr-policy-ai";
import { FAIRNESS_CATALOG_VERSION, FAIRNESS_LIMITATIONS, FAIRNESS_PAIRS, FAIRNESS_SCOPE, compareFairnessPair, fairnessDigest, type FairnessOutcome } from "./fairness-catalog";

const KEY = "hro-fairness-programme-v1";
const catalogDigest = () => fairnessDigest({ version: FAIRNESS_CATALOG_VERSION, scope: FAIRNESS_SCOPE, pairs: FAIRNESS_PAIRS });
const identityDigest = () => fairnessDigest(POLICY_SELECTION_IDENTITY);
type FairnessSelector = (question: string, excerpt: string, context: string,
  onReceipt?: (receipt: PolicySelectionReceipt) => void) => Promise<PolicyExtractSelection>;
const selectFairnessExtract: FairnessSelector = (question, excerpt, context, onReceipt) =>
  selectApprovedPolicyExtract(question, excerpt, context, undefined, receipt => onReceipt?.({
    requestedModel: POLICY_SELECTION_IDENTITY.model, resolvedModel: receipt.resolvedModel,
    providerResponseId: receipt.responseId, systemFingerprint: receipt.systemFingerprint,
  }));
const roles = ["business", "hr-compliance", "legal"] as const;
type ReviewRole = typeof roles[number];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const text = z.string().trim().min(10).max(1000);
const version = z.number().int().nonnegative();
export const fairnessActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("define-scope"), expectedVersion: version, decisionType: z.literal("policy-extract-recommendation"), pairIds: z.array(z.enum(["pronouns-supported", "names-supported", "pronouns-insufficient", "names-conflicting"])).min(1).max(4), note: text }).strict(),
  z.object({ kind: z.literal("review-scope"), expectedVersion: version, role: z.enum(roles), approved: z.boolean(), note: text }).strict(),
  z.object({ kind: z.literal("set-criteria"), expectedVersion: version, criteria: z.array(z.object({ pairId: z.string(), expected: z.enum(["supported", "insufficient", "conflicting", "injected"]), rationale: text }).strict()).min(1).max(4) }).strict(),
  z.object({ kind: z.literal("review-criteria"), expectedVersion: version, role: z.enum(roles), approved: z.boolean(), note: text }).strict(),
  z.object({ kind: z.literal("run"), expectedVersion: version }).strict(),
  z.object({ kind: z.literal("recover"), expectedVersion: version }).strict(),
  z.object({ kind: z.literal("investigate"), expectedVersion: version, runId: z.string().uuid(), pairId: z.string(), disposition: z.enum(["open", "remediation-required", "explained"]), note: text }).strict(),
]);
export type FairnessAction = z.infer<typeof fairnessActionSchema>;
type Receipt = { userId: string; role: ReviewRole; assignmentId: number | null; membershipRevision: number;
  stage: "scope" | "criteria"; revision: number; bindingDigest: string; at: string; approved: boolean; note: string };
type Criterion = { pairId: string; expected: FairnessOutcome; rationale: string };
type Observation = {
  pairId: string; expected: FairnessOutcome; rationale: string;
  outputs: (PolicyExtractSelection | null)[]; errors: (string | null)[];
  status: "blocked" | "investigate" | "observed-match"; differences: string[];
  policyDigest: string; inputDigests: string[];
  policyVersion: string; modelReceipts: (PolicySelectionReceipt | null)[];
  investigation: { disposition: "open" | "remediation-required" | "explained"; note: string; reviewedBy: string; at: string } | null;
};
export type FairnessRun = {
  id: string; status: "running" | "completed" | "blocked"; at: string; finishedAt: string | null; actor: string;
  programmeVersion: number; scopeRevision: number; criteriaRevision: number;
  provenance: "synthetic-model-observation"; catalogVersion: string;
  model: string; promptVersion: string; promptDigest: string; outputContractVersion: string;
  approvals: Receipt[]; criteria: Criterion[]; observations: Observation[]; limitation: string | null;
  fixtures: typeof FAIRNESS_PAIRS;
};
export type FairnessProgramme = {
  version: number; scopeRevision: number; criteriaRevision: number;
  scope: { decisionType: string; pairIds: string[]; note: string; definedBy: string; catalogVersion: string; catalogDigest: string } | null;
  criteriaIdentityDigest: string | null;
  scopeReviews: Receipt[]; criteria: Criterion[]; criteriaReviews: Receipt[];
  runs: FairnessRun[];
  evidence: { at: string; actor: string; kind: string; version: number; provenance: "manual-evidence" | "synthetic-model-observation"; note: string; details?: unknown }[];
};
export class FairnessError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
function empty(): FairnessProgramme {
  return { version: 0, scopeRevision: 0, criteriaRevision: 0, scope: null, criteriaIdentityDigest: null, scopeReviews: [], criteria: [], criteriaReviews: [], runs: [], evidence: [] };
}
async function member(tx: Tx, organizationId: string, userId: string) {
  const [row] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, userId), isNull(organizationMembershipsTable.revokedAt),
  )).for("update");
  if (!row) throw new FairnessError("Current tenant membership is required.", 403);
  return row;
}
async function authority(tx: Tx, organizationId: string, userId: string, role: ReviewRole): Promise<Receipt["assignmentId"]> {
  const membership = await member(tx, organizationId, userId);
  if (role === "business") {
    if (!["owner", "admin"].includes(membership.role)) throw new FairnessError("Business scope review requires an organization owner or admin.", 403);
    return null;
  }
  const [grant] = await tx.select().from(onbGovernanceAuthorityAssignments).where(and(
    eq(onbGovernanceAuthorityAssignments.organizationId, organizationId),
    eq(onbGovernanceAuthorityAssignments.assigneeUserId, userId),
    eq(onbGovernanceAuthorityAssignments.authorityRole, role),
    eq(onbGovernanceAuthorityAssignments.verificationStatus, "verified"),
    isNull(onbGovernanceAuthorityAssignments.revokedAt),
    or(isNull(onbGovernanceAuthorityAssignments.expiresAt), gt(onbGovernanceAuthorityAssignments.expiresAt, new Date())),
  )).orderBy(desc(onbGovernanceAuthorityAssignments.createdAt)).limit(1).for("update");
  if (!grant) throw new FairnessError(`Current verified ${role} authority is required; membership alone is not specialist authority.`, 403);
  return grant.id;
}
export function validateReviewSet(reviews: Receipt[]) {
  if (roles.some(role => !reviews.some(r => r.role === role && r.approved)) ||
      new Set(reviews.filter(r => r.approved).map(r => r.userId)).size !== 3) {
    throw new FairnessError("Three distinct business, HR-compliance and legal reviewers must approve this revision.");
  }
}
async function liveReviews(tx: Tx, organizationId: string, reviews: Receipt[]) {
  validateReviewSet(reviews);
  // Consistent identity order avoids review/read lock inversions.
  for (const receipt of [...reviews].sort((a, b) => a.userId.localeCompare(b.userId))) {
    if (await authority(tx, organizationId, receipt.userId, receipt.role) !== receipt.assignmentId) {
      throw new FairnessError("A reviewer authority changed. Obtain fresh reviews.");
    }
    if ((await member(tx, organizationId, receipt.userId)).membershipRevision !== receipt.membershipRevision) {
      throw new FairnessError("A reviewer membership lifecycle changed. Obtain fresh reviews.");
    }
  }
}
function currentScope(state: FairnessProgramme) {
  if (!state.scope || state.scope.catalogDigest !== catalogDigest()) throw new FairnessError("Scope fixtures or synthetic policy version changed. Define and review scope again.");
}
function currentCriteria(state: FairnessProgramme) {
  currentScope(state);
  if (state.criteriaIdentityDigest !== identityDigest()) throw new FairnessError("Model, prompt or output contract changed. Save and review criteria again.");
}
async function load(tx: Tx, organizationId: string) {
  const [row] = await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, KEY))).for("update");
  return row ? JSON.parse(row.value) as FairnessProgramme : empty();
}
async function save(tx: Tx, organizationId: string, state: FairnessProgramme) {
  await tx.insert(onbSettings).values({ organizationId, key: KEY, value: JSON.stringify(state) })
    .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(state), updatedAt: new Date() } });
}
async function locked<T>(organizationId: string, action: (tx: Tx) => Promise<T>) {
  return db.transaction(async tx => {
    // Same authority fence used by grant/revoke and provider-boundary dispatch.
    await assertGovernanceMutationAllowed(tx, organizationId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fairness:${organizationId}`}))`);
    return action(tx);
  });
}
function evidence(state: FairnessProgramme, userId: string, kind: string, note: string, model = false, details?: unknown) {
  state.version++;
  state.evidence.push({ at: new Date().toISOString(), actor: userId, kind, version: state.version,
    provenance: model ? "synthetic-model-observation" : "manual-evidence", note, details });
}
async function audit(tx: Tx, organizationId: string, userId: string, action: string, state: FairnessProgramme) {
  await appendProtectedAuditInTransaction(tx, { organizationId, actorKind: "authenticated", actorId: userId, outcome: "success",
    actorAuthority: "fairness-governed-review", action: `fairness.${action}`, objectType: "fairness-programme",
    objectId: KEY, source: "uat-fairness", reviewedRevision: state.version,
    payload: { evidenceDigest: fairnessDigest(state) } });
}
export async function getFairnessProgramme(organizationId: string, userId: string) {
  return locked(organizationId, async tx => {
    const membership = await member(tx, organizationId, userId);
    const state = await load(tx, organizationId);
    const reviewerRoles: ReviewRole[] = [];
    for (const role of roles) {
      try { await authority(tx, organizationId, userId, role); reviewerRoles.push(role); }
      catch (error) { if (!(error instanceof FairnessError)) throw error; }
    }
    let scopeApproved = false, criteriaApproved = false;
    try { currentScope(state); await liveReviews(tx, organizationId, state.scopeReviews); scopeApproved = !!state.scope; } catch (error) { if (!(error instanceof FairnessError)) throw error; }
    try { currentCriteria(state); await liveReviews(tx, organizationId, state.criteriaReviews); criteriaApproved = scopeApproved && !!state.criteria.length; } catch (error) { if (!(error instanceof FairnessError)) throw error; }
    return { programme: state, catalog: { version: FAIRNESS_CATALOG_VERSION, scope: "Historical evidence only", pairs: [], limitations: FAIRNESS_LIMITATIONS, identity: POLICY_SELECTION_IDENTITY },
      capabilities: { canDefine: false, reviewerRoles: [], scopeApproved: false, criteriaApproved: false } };
  });
}
export function validateCriteria(pairIds: string[], criteria: Criterion[]) {
  if (criteria.length !== pairIds.length || new Set(criteria.map(c => c.pairId)).size !== pairIds.length ||
      criteria.some(c => !pairIds.includes(c.pairId))) throw new FairnessError("Every scoped pair needs exactly one human-defined acceptance criterion.");
}
export async function applyFairnessAction(organizationId: string, userId: string, input: unknown,
  dependencies?: { selector: FairnessSelector }) {
  denyRetiredCaseCapability();
  const parsed = fairnessActionSchema.safeParse(input);
  if (!parsed.success) throw new FairnessError("Invalid fairness action. Only fixed synthetic fixtures are accepted; real-data and tool inputs are forbidden.", 400);
  const action = parsed.data;
  let claimed: FairnessRun | null = null;
  await locked(organizationId, async tx => {
    await member(tx, organizationId, userId);
    const state = await load(tx, organizationId);
    if (state.version !== action.expectedVersion) throw new FairnessError("Programme changed. Reload before applying this action.");
    const running = state.runs.find(r => r.status === "running");
    if (running && action.kind !== "recover") throw new FairnessError("A paired run is in progress. Revisions and parallel runs are blocked.");
    if (action.kind === "define-scope") {
      await authority(tx, organizationId, userId, "business");
      if (new Set(action.pairIds).size !== action.pairIds.length) throw new FairnessError("Duplicate pairs are not allowed.", 400);
      state.scope = { decisionType: action.decisionType, pairIds: action.pairIds, note: action.note, definedBy: userId,
        catalogVersion: FAIRNESS_CATALOG_VERSION, catalogDigest: catalogDigest() };
      state.scopeRevision++; state.criteriaRevision++;
      state.scopeReviews = []; state.criteria = []; state.criteriaReviews = []; state.criteriaIdentityDigest = null;
    } else if (action.kind === "review-scope" || action.kind === "review-criteria") {
      if (!state.scope) throw new FairnessError("Define the decision scope first.");
      currentScope(state);
      if (action.kind === "review-criteria") {
        currentCriteria(state);
        await liveReviews(tx, organizationId, state.scopeReviews);
        validateCriteria(state.scope.pairIds, state.criteria);
      }
      const assignmentId = await authority(tx, organizationId, userId, action.role);
      const target = action.kind === "review-scope" ? state.scopeReviews : state.criteriaReviews;
      if (target.some(r => r.role !== action.role && r.userId === userId)) throw new FairnessError("Each review role requires a different authenticated person.");
      const receipt: Receipt = { userId, role: action.role, assignmentId,
        membershipRevision: (await member(tx, organizationId, userId)).membershipRevision,
        stage: action.kind === "review-scope" ? "scope" : "criteria",
        revision: action.kind === "review-scope" ? state.scopeRevision : state.criteriaRevision,
        bindingDigest: action.kind === "review-scope" ? state.scope.catalogDigest : state.criteriaIdentityDigest!,
        at: new Date().toISOString(), approved: action.approved, note: action.note };
      const updated = [...target.filter(r => r.role !== action.role), receipt];
      if (action.kind === "review-scope") { state.scopeReviews = updated; state.criteriaReviews = []; }
      else state.criteriaReviews = updated;
    } else if (action.kind === "set-criteria") {
      await authority(tx, organizationId, userId, "business");
      currentScope(state);
      await liveReviews(tx, organizationId, state.scopeReviews);
      if (!state.scope) throw new FairnessError("Define scope first.");
      validateCriteria(state.scope.pairIds, action.criteria);
      state.criteria = action.criteria; state.criteriaRevision++; state.criteriaReviews = []; state.criteriaIdentityDigest = identityDigest();
    } else if (action.kind === "run") {
      await authority(tx, organizationId, userId, "business");
      currentCriteria(state);
      await liveReviews(tx, organizationId, state.scopeReviews);
      await liveReviews(tx, organizationId, state.criteriaReviews);
      if (!state.scope) throw new FairnessError("Define scope first.");
      validateCriteria(state.scope.pairIds, state.criteria);
      if (state.runs.length >= 100) throw new FairnessError("Programme evidence limit reached. Retained history must not be silently discarded.");
      claimed = { id: randomUUID(), status: "running", at: new Date().toISOString(), finishedAt: null, actor: userId,
        programmeVersion: state.version, scopeRevision: state.scopeRevision, criteriaRevision: state.criteriaRevision,
        provenance: "synthetic-model-observation", catalogVersion: FAIRNESS_CATALOG_VERSION, ...POLICY_SELECTION_IDENTITY,
        approvals: [...state.scopeReviews, ...state.criteriaReviews], criteria: state.criteria, observations: [], limitation: null,
        fixtures: FAIRNESS_PAIRS.filter(pair => state.scope!.pairIds.includes(pair.id)) };
      state.runs.unshift(claimed);
    } else if (action.kind === "recover") {
      await authority(tx, organizationId, userId, "business");
      if (!running || Date.now() - new Date(running.at).getTime() < 10 * 60_000) throw new FairnessError("Only an interrupted run older than ten minutes can be closed.");
      running.status = "blocked"; running.finishedAt = new Date().toISOString();
      running.limitation = "Interrupted run: observations are incomplete; no success or fairness conclusion. A new explicit run is required.";
    } else if (action.kind === "investigate") {
      await authority(tx, organizationId, userId, "hr-compliance");
      const run = state.runs.find(r => r.id === action.runId);
      const observation = run?.observations.find(o => o.pairId === action.pairId);
      if (!observation || observation.status === "observed-match") throw new FairnessError("Select a blocked or discrepant pair for investigation.");
      observation.investigation = { disposition: action.disposition, note: action.note, reviewedBy: userId, at: new Date().toISOString() };
      // Original status, outputs and differences are never rewritten by a disposition.
    }
    evidence(state, userId, action.kind, "note" in action ? action.note : action.kind, false,
      { action, scopeRevision: state.scopeRevision, criteriaRevision: state.criteriaRevision,
        scopeReviews: state.scopeReviews, criteriaReviews: state.criteriaReviews });
    await save(tx, organizationId, state);
    await audit(tx, organizationId, userId, action.kind, state);
  });
  if (claimed) await executeFairnessRun(organizationId, userId, claimed, dependencies?.selector);
  return getFairnessProgramme(organizationId, userId);
}

async function executeFairnessRun(organizationId: string, userId: string, run: FairnessRun,
  selector: FairnessSelector = selectFairnessExtract) {
  const observe = async () => {
    const observations: Observation[] = [];
    let limitation: string | null = null;
    for (const criterion of run.criteria) {
      const fixture = run.fixtures.find(p => p.id === criterion.pairId)!;
      const outputs: (PolicyExtractSelection | null)[] = [], errors: (string | null)[] = [];
      const modelReceipts: (PolicySelectionReceipt | null)[] = [];
      for (const variant of fixture.variants) {
        let receipt: PolicySelectionReceipt | null = null;
        try {
          // No employee/case evidence or agent tool is available in this runner.
          // AI inherits the authenticated UAT context and the production budget boundary.
          await locked(organizationId, async tx => {
            await authority(tx, organizationId, userId, "business");
            const state = await load(tx, organizationId);
            if (state.runs.find(r => r.id === run.id)?.status !== "running") throw new FairnessError("Run no longer active.");
            currentCriteria(state);
            await liveReviews(tx, organizationId, state.scopeReviews);
            await liveReviews(tx, organizationId, state.criteriaReviews);
          });
          outputs.push(await selector(variant.question, fixture.excerpt, fixture.sourceContext, value => { receipt = value; }));
          errors.push(null);
        } catch (error) {
          outputs.push(null);
          errors.push(error instanceof FairnessError ? "authorization-or-review-unavailable" : "model-unavailable-or-invalid");
        }
        modelReceipts.push(receipt);
      }
      observations.push({ pairId: fixture.id, expected: criterion.expected, rationale: criterion.rationale,
        outputs, errors, ...compareFairnessPair(criterion.expected, outputs),
        policyDigest: fairnessDigest({ excerpt: fixture.excerpt, context: fixture.sourceContext }),
        inputDigests: fixture.variants.map(v => fairnessDigest(v.question)), investigation: null,
        policyVersion: run.catalogVersion, modelReceipts });
    }
    await locked(organizationId, async tx => {
      const state = await load(tx, organizationId);
      const stored = state.runs.find(r => r.id === run.id);
      if (!stored || stored.status !== "running") return; // recovered attempts cannot finalize late
      try {
        await authority(tx, organizationId, userId, "business");
        currentCriteria(state);
        await liveReviews(tx, organizationId, state.scopeReviews);
        await liveReviews(tx, organizationId, state.criteriaReviews);
      } catch (error) {
        if (!(error instanceof FairnessError)) throw error;
        limitation = "Authorization or reviewer authority changed during the run; observations withheld and run blocked.";
      }
      stored.observations = limitation ? [] : observations;
      stored.status = limitation || observations.some(o => o.status === "blocked") ? "blocked" : "completed";
      stored.limitation = limitation;
      stored.finishedAt = new Date().toISOString();
      evidence(state, userId, "run-finished", stored.status, true);
      await save(tx, organizationId, state);
      await audit(tx, organizationId, userId, "run-finished", state);
    });
  };
  if (currentHroContext()) await observe();
  else await withHroContext({ organizationId, workflow: "uat", subjectType: "tenant", subjectId: organizationId, initiatingUserId: userId }, observe);
}

export function fairnessReport(state: FairnessProgramme) {
  return {
    schemaVersion: "fairness-evidence-1", generatedAt: new Date().toISOString(),
    scope: state.scope, catalogueVersion: FAIRNESS_CATALOG_VERSION,
    fixtures: FAIRNESS_PAIRS,
    coverage: { scopedPairs: state.scope?.pairIds.length ?? 0, availablePairs: FAIRNESS_PAIRS.length,
      testedDecisionTypes: state.runs.some(r => r.observations.length) ? [FAIRNESS_SCOPE.id] : [],
      attemptedPairs: [...new Set(state.runs.flatMap(r => r.criteria.map(c => c.pairId)))],
      observedPairs: [...new Set(state.runs.flatMap(r => r.observations.filter(o => o.outputs.every(Boolean) && o.outputs.length === 2).map(o => o.pairId)))],
      unresolvedDifferences: state.runs.flatMap(r => r.observations.filter(o => o.status !== "observed-match" && o.investigation?.disposition !== "explained").map(o => ({ runId: r.id, pairId: o.pairId, status: o.status }))),
      blockedRuns: state.runs.filter(r => r.status === "blocked").map(r => r.id) },
    limitations: FAIRNESS_LIMITATIONS, programme: state,
  };
}
