import type { FutureIntentInstanceContract } from "./intent-catalog-types";

/** Design contract only. No table, event subscription, dispatcher or instance creation. */
export const FUTURE_INSTANCE_CONTRACT: FutureIntentInstanceContract = {
  version: "intent-instance-proposal-v1",
  implemented: false,
  fields: [
    "tenantId + instanceId: immutable tenant-scoped identity; opaque globally unique instance id.",
    "definitionKey + definitionVersion: pinned immutable definition revision; changes never rewrite prior instances.",
    "initiator: human or AI principal id; authenticated human sponsor required for AI; initiation records do not grant authority.",
    "rootInstanceId + parentInstanceId: immutable runtime lineage; root points to self, root parent is null; never stored as fixed definition ownership.",
    "caseScope + subjectReference: optional case id within same tenant; private evidence remains in authorized case storage.",
    "correlationId + sourceRequestId + idempotencyKey: stable request correlation and scoped duplicate prevention.",
    "compositionEdgeKey + compositionVersion + invocationSlot: pin the selected approved conditional rule and repeatable logical child slot.",
    "state + stateVersion + attempt + timestamps + cancellationReason: optimistic concurrency, lifecycle audit and retries.",
    "inputSnapshotReference + policyRevision + completionEvidenceReference: opaque authorized references, not copied confidential case data.",
  ],
  lifecycle: [
    "proposed -> accepted -> waiting-for-input / waiting-for-approval -> ready -> running -> completed",
    "running -> failed / uncertain; retry only a proven safe failed attempt, never replay an ambiguous external effect.",
    "nonterminal -> cancellation-requested -> cancelled only after acknowledged safe stop; reconcile dispatched effects before closure.",
    "completed is immutable; corrections create linked superseding work, never overwrite authoritative history.",
    "Parent completion evaluates only approved applicable dependencies. Optional/untriggered children never block completion.",
  ],
  safeguards: [
    "Admission must independently check tenant, case scope, initiator and human sponsor, approved policy, evidence and live effect permissions at every boundary.",
    "Create child atomically with unique (tenantId,parentInstanceId,compositionVersion,edgeKey,invocationSlot,idempotencyKey); same key plus different input fingerprint is conflict, not a new child.",
    "Root retry uses unique (tenantId,initiatorId,sourceRequestId,idempotencyKey); retries reuse identity and lineage, with a separate attempt journal.",
    "Reject cross-tenant/cross-root parent links, cycles and ancestor repeats unless an explicitly approved bounded iteration contract exists.",
    "Proposed defaults: depth <= 8, children per parent <= 50, total descendants <= 500; transactional reservations include concurrently proposed children.",
    "Cancellation propagates only through the approved dependency contract; shared/independent work is not blindly cancelled. Record skipped, failed and uncertain children distinctly.",
    "External operations use the existing durable effect journal and idempotency fences; catalog metadata never releases an effect.",
  ],
  maximumDepth: 8, maximumChildren: 50, maximumTreeSize: 500,
};
