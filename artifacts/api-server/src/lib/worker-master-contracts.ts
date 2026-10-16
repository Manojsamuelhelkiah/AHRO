import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Reviewed definition contracts, not executors. No adapter, persistence, permission
 * or case-status mutation is registered here. A passing assessment is not a
 * completed business transaction.
 */
export const WORKER_MASTER_CONTRACT_VERSION = "worker-master-evidence-v1";
export const WORKER_MASTER_APPROVAL_REFERENCE = "worker-master-definition-approval-2026-10-16";
export const WORKER_MASTER_KEYS = [
  "collect-worker-profile", "create-worker-record",
  "resolve-duplicate-worker", "amend-prestart-employment-details",
] as const;
export type WorkerMasterKey = typeof WORKER_MASTER_KEYS[number];
export function isWorkerMasterKey(key: string): key is WorkerMasterKey {
  return (WORKER_MASTER_KEYS as readonly string[]).includes(key);
}

const ref = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const objectRef = z.object({ id: ref, version: ref }).strict();
const source = z.object({
  systemId: ref, connectionId: ref, environment: z.enum(["sandbox", "production"]),
  objectType: ref,
}).strict();
const common = {
  organizationId: ref, requestReference: ref, subjectReference: ref,
  contractVersion: z.literal(WORKER_MASTER_CONTRACT_VERSION),
  source, policyRevision: ref,
};
const identity = z.enum(["confirmed", "ambiguous", "unknown"]);
const profileInputs = z.object({
  profile: objectRef, requiredFieldSchemaVersion: ref, profileValuesDigest: digest,
  identityStatus: identity,
}).strict();
const creationInputs = z.object({
  profile: objectRef, personReference: ref, employmentReference: ref,
  approvedValuesDigest: digest, effectiveDate: date, identityStatus: identity,
  duplicateStatus: z.enum(["clear", "unresolved"]), hrDecisionReference: ref,
}).strict();
const duplicateInputs = z.object({
  candidates: z.array(objectRef).min(2).max(100), comparisonEvidenceReference: ref,
  disposition: z.enum(["merge", "keep-separate"]), survivorId: ref.nullable(),
  identityStatus: identity, hrDecisionReference: ref,
}).strict();
const amendmentInputs = z.object({
  target: objectRef, personReference: ref, changesDigest: digest,
  changedFields: z.array(ref).min(1).max(100), effectiveDate: date,
  actualStartStatus: z.enum(["not-started", "started", "unknown"]),
  payrollImpact: z.boolean(), hrDecisionReference: ref,
  payrollDecisionReference: ref.optional(),
}).strict();
export const WorkerMasterRequestSchema = z.discriminatedUnion("outcome", [
  z.object({ ...common, outcome: z.literal("collect-worker-profile"), inputs: profileInputs }).strict(),
  z.object({ ...common, outcome: z.literal("create-worker-record"), inputs: creationInputs }).strict(),
  z.object({ ...common, outcome: z.literal("resolve-duplicate-worker"), inputs: duplicateInputs }).strict(),
  z.object({ ...common, outcome: z.literal("amend-prestart-employment-details"), inputs: amendmentInputs }).strict(),
]);
export type WorkerMasterRequest = z.infer<typeof WorkerMasterRequestSchema>;

export const WorkerMasterEvidenceSchema = z.object({
  receiptReference: ref,
  observedAt: z.string().datetime(),
  state: z.enum(["applied", "queued", "failed", "ambiguous"]),
  // A future source adapter must independently verify every snapshot field,
  // current source binding/policy and actual postcondition, not echo this input.
  inputSnapshot: WorkerMasterRequestSchema,
  record: objectRef,
  previousVersion: ref.optional(),
  validatedSchemaVersion: ref.optional(),
  requiredFieldsComplete: z.boolean().optional(),
  candidateResults: z.array(z.object({
    id: ref, version: ref, status: z.enum(["active", "superseded"]),
  }).strict()).max(100).optional(),
}).strict();
export type WorkerMasterEvidence = z.infer<typeof WorkerMasterEvidenceSchema>;

/**
 * Server-owned future integration ports, never supplied by request JSON.
 * verifySource must authenticate a current source read-back/attestation, including
 * complete snapshot/value digests, object versions, identity, effective date,
 * latest actual-start state, approved field mapping/schema and current policy.
 * verifyHumanDecision must check current ordinary case decision permissions and
 * explicit decisions bound to this exact request/input version, not a role label.
 * Neither callback may write to a provider.
 */
export interface WorkerMasterVerificationPorts {
  now: () => Date;
  maxEvidenceAgeMs: number;
  verifySource: (request: WorkerMasterRequest, evidence: WorkerMasterEvidence) => Promise<boolean>;
  verifyHumanDecision: (request: WorkerMasterRequest, decisionReference: string, purpose: "hr" | "payroll") => Promise<boolean>;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const objectTypes: Record<WorkerMasterKey, string> = {
  "collect-worker-profile": "worker-profile", "create-worker-record": "worker",
  "resolve-duplicate-worker": "worker-identity-resolution",
  "amend-prestart-employment-details": "employment",
};
export const WORKER_MASTER_REQUIRED_CONTEXT: Record<WorkerMasterKey, string[]> = {
  "collect-worker-profile": ["profile", "requiredFieldSchemaVersion", "profileValuesDigest", "identityStatus"],
  "create-worker-record": ["profile", "personReference", "employmentReference", "approvedValuesDigest", "effectiveDate", "identityStatus", "duplicateStatus", "hrDecisionReference"],
  "resolve-duplicate-worker": ["candidates", "comparisonEvidenceReference", "disposition", "survivorId", "identityStatus", "hrDecisionReference"],
  "amend-prestart-employment-details": ["target", "personReference", "changesDigest", "changedFields", "effectiveDate", "actualStartStatus", "payrollImpact", "hrDecisionReference", "payrollDecisionReference (when payrollImpact is true)"],
};

const pending = (reason: string) => ({
  status: "pending-human-review" as const, reason, executionAvailable: false as const,
});

/**
 * Read-only contract assessment. There are deliberately no default verifiers:
 * missing integrations, uncertain evidence and errors stay pending human review.
 * The returned frozen receipt candidate is NOT a durable immutable receipt store.
 */
export async function assessWorkerMasterEvidence(
  rawRequest: unknown, rawEvidence: unknown, ports?: WorkerMasterVerificationPorts,
) {
  const parsedRequest = WorkerMasterRequestSchema.safeParse(rawRequest);
  const parsedEvidence = WorkerMasterEvidenceSchema.safeParse(rawEvidence);
  if (!parsedRequest.success || !parsedEvidence.success) return pending("Malformed or incomplete outcome-specific inputs/evidence.");
  const request = freeze(parsedRequest.data), evidence = freeze(parsedEvidence.data);
  if (!ports || !Number.isFinite(ports.maxEvidenceAgeMs) || ports.maxEvidenceAgeMs <= 0
      || typeof ports.now !== "function" || typeof ports.verifySource !== "function"
      || typeof ports.verifyHumanDecision !== "function") return pending("Independent verification is unavailable.");
  if (hash(request) !== hash(evidence.inputSnapshot)) return pending("Evidence does not match the exact request, scope, source and input version.");
  if (request.source.objectType !== objectTypes[request.outcome] || evidence.state !== "applied") {
    return pending("The authoritative outcome is not confirmed applied to the required source object.");
  }
  try {
    const age = ports.now().getTime() - Date.parse(evidence.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > ports.maxEvidenceAgeMs) return pending("Source evidence is stale or its time is invalid.");
    if ("identityStatus" in request.inputs && request.inputs.identityStatus !== "confirmed") return pending("Identity remains unresolved.");
    switch (request.outcome) {
      case "collect-worker-profile":
        if (evidence.record.id !== request.inputs.profile.id
            || evidence.record.version !== request.inputs.profile.version
            || evidence.validatedSchemaVersion !== request.inputs.requiredFieldSchemaVersion
            || evidence.requiredFieldsComplete !== true) return pending("The exact profile version has not passed its approved required-field schema.");
        break;
      case "create-worker-record":
        if (request.inputs.duplicateStatus !== "clear") return pending("Duplicate-worker review remains unresolved.");
        break;
      case "resolve-duplicate-worker": {
        const { candidates, disposition, survivorId } = request.inputs;
        const ids = new Set(candidates.map(row => row.id));
        const results = evidence.candidateResults ?? [];
        if (ids.size !== candidates.length || new Set(results.map(row => row.id)).size !== candidates.length
            || results.length !== candidates.length || results.some(row => !ids.has(row.id))) return pending("Candidate identity coverage is incomplete or ambiguous.");
        if (disposition === "merge") {
          if (!survivorId || !ids.has(survivorId) || evidence.record.id !== survivorId
              || results.some(row => row.status !== (row.id === survivorId ? "active" : "superseded"))
              || results.find(row => row.id === survivorId)?.version !== evidence.record.version) return pending("The approved surviving and superseded records are not confirmed.");
        } else if (survivorId !== null || results.some(row => row.status !== "active")) {
          return pending("The approved keep-separate disposition is not confirmed.");
        }
        break;
      }
      case "amend-prestart-employment-details":
        if (request.inputs.actualStartStatus !== "not-started"
            || evidence.record.id !== request.inputs.target.id
            || evidence.record.version === request.inputs.target.version
            || evidence.previousVersion !== request.inputs.target.version
            || new Set(request.inputs.changedFields).size !== request.inputs.changedFields.length) return pending("Employment version, changed fields or pre-start state requires review.");
        if (request.inputs.payrollImpact && !request.inputs.payrollDecisionReference) return pending("The applicable payroll decision is missing.");
        break;
    }
    if (!await ports.verifySource(request, evidence)) return pending("Independent source verification did not confirm the complete postcondition.");
    if ("hrDecisionReference" in request.inputs
        && !await ports.verifyHumanDecision(request, request.inputs.hrDecisionReference, "hr")) return pending("The exact HR decision is not verified.");
    if (request.outcome === "amend-prestart-employment-details" && request.inputs.payrollImpact
        && !await ports.verifyHumanDecision(request, request.inputs.payrollDecisionReference!, "payroll")) return pending("The exact payroll decision is not verified.");
    const finalAge = ports.now().getTime() - Date.parse(evidence.observedAt);
    if (!Number.isFinite(finalAge) || finalAge < 0 || finalAge > ports.maxEvidenceAgeMs) return pending("Source evidence expired during verification.");
    return freeze({
      status: "evidence-satisfies-contract" as const, executionAvailable: false as const,
      receiptCandidate: {
        contractVersion: WORKER_MASTER_CONTRACT_VERSION,
        definitionApprovalReference: WORKER_MASTER_APPROVAL_REFERENCE,
        organizationId: request.organizationId, requestReference: request.requestReference,
        outcome: request.outcome, sourceReceiptReference: evidence.receiptReference,
        inputDigest: hash(request), evidenceDigest: hash(evidence),
        receiptDigest: hash({ request, evidence, contractVersion: WORKER_MASTER_CONTRACT_VERSION }),
      },
    });
  } catch {
    return pending("Independent verification is unavailable or inconclusive.");
  }
}
