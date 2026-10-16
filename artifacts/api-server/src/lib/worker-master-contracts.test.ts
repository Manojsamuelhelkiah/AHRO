import test from "node:test";
import assert from "node:assert/strict";
import master from "../../../../research/hro-master-intent-taxonomy.json";
import { buildIntentCatalog } from "./intent-catalog";
import {
  assessWorkerMasterEvidence, WORKER_MASTER_KEYS, WORKER_MASTER_CONTRACT_VERSION,
  WORKER_MASTER_APPROVAL_REFERENCE, WorkerMasterRequestSchema,
  type WorkerMasterKey, type WorkerMasterVerificationPorts, type WorkerMasterEvidence,
} from "./worker-master-contracts";

const now = new Date("2026-10-16T08:00:00Z");
const digest = "a".repeat(64);
const profile = { id: "profile-1", version: "profile-v1" };
const sourceTypes = ["worker-profile", "worker", "worker-identity-resolution", "employment"];
function fixture(key: WorkerMasterKey) {
  const inputs = key === "collect-worker-profile"
    ? { profile, requiredFieldSchemaVersion: "profile-schema-v1", profileValuesDigest: digest, identityStatus: "confirmed" }
    : key === "create-worker-record"
      ? { profile, personReference: "person-1", employmentReference: "employment-1", approvedValuesDigest: digest, effectiveDate: "2026-11-01", identityStatus: "confirmed", duplicateStatus: "clear", hrDecisionReference: "hr-decision-1" }
      : key === "resolve-duplicate-worker"
        ? { candidates: [{ id: "worker-1", version: "v1" }, { id: "worker-2", version: "v2" }], comparisonEvidenceReference: "comparison-1", disposition: "merge", survivorId: "worker-1", identityStatus: "confirmed", hrDecisionReference: "hr-decision-1" }
        : { target: { id: "employment-1", version: "v1" }, personReference: "person-1", changesDigest: digest, changedFields: ["location"], effectiveDate: "2026-11-01", actualStartStatus: "not-started", payrollImpact: false, hrDecisionReference: "hr-decision-1" };
  const request = WorkerMasterRequestSchema.parse({
    organizationId: "org-1", requestReference: "request-1", subjectReference: "subject-1",
    contractVersion: WORKER_MASTER_CONTRACT_VERSION,
    source: { systemId: "client-hris", connectionId: "connection-1", environment: "sandbox", objectType: sourceTypes[WORKER_MASTER_KEYS.indexOf(key)] },
    policyRevision: "policy-v1", outcome: key, inputs,
  });
  const evidence: WorkerMasterEvidence = {
    receiptReference: "source-receipt-1", observedAt: now.toISOString(), state: "applied",
    inputSnapshot: structuredClone(request),
    record: key === "collect-worker-profile" ? { ...profile }
      : key === "amend-prestart-employment-details" ? { id: "employment-1", version: "v2" }
        : { id: "worker-1", version: "v3" },
    ...(key === "collect-worker-profile" ? { validatedSchemaVersion: "profile-schema-v1", requiredFieldsComplete: true } : {}),
    ...(key === "amend-prestart-employment-details" ? { previousVersion: "v1" } : {}),
    ...(key === "resolve-duplicate-worker" ? { candidateResults: [
      { id: "worker-1", version: "v3", status: "active" as const },
      { id: "worker-2", version: "v4", status: "superseded" as const },
    ] } : {}),
  };
  return { request, evidence };
}
function ports(overrides: Partial<WorkerMasterVerificationPorts> = {}): WorkerMasterVerificationPorts {
  return { now: () => now, maxEvidenceAgeMs: 60_000,
    verifySource: async () => true, verifyHumanDecision: async () => true, ...overrides };
}
function change<T>(value: T, path: string, next: unknown): T {
  const copy = structuredClone(value);
  const segments = path.split(".");
  let target = copy as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) target = target[segment] as Record<string, unknown>;
  target[segments.at(-1)!] = next;
  return copy;
}
async function isPending(request: unknown, evidence: unknown, verification = ports()) {
  const result = await assessWorkerMasterEvidence(request, evidence, verification);
  assert.equal(result.status, "pending-human-review");
  assert.equal(result.executionAvailable, false);
  assert.ok(!("receiptCandidate" in result));
}

for (const key of WORKER_MASTER_KEYS) {
  test(`${key}: independently verified outcome evidence satisfies only the reviewed contract`, async () => {
    const { request, evidence } = fixture(key);
    const result = await assessWorkerMasterEvidence(request, evidence, ports());
    assert.equal(result.status, "evidence-satisfies-contract");
    assert.equal(result.executionAvailable, false);
    assert.equal(result.receiptCandidate?.definitionApprovalReference, WORKER_MASTER_APPROVAL_REFERENCE);
    assert.equal(result.receiptCandidate?.outcome, key);
    assert.ok(Object.isFrozen(result.receiptCandidate));
  });
  test(`${key}: local/audit/model records and unconfirmed dispatch never prove completion`, async () => {
    const { request, evidence } = fixture(key);
    for (const record of [{ status: "completed" }, { auditId: "event-1" }, { answer: "done" }, { verified: true }]) await isPending(request, record);
    for (const state of ["queued", "failed", "ambiguous"]) await isPending(request, { ...evidence, state });
    await isPending(request, evidence, ports({ verifySource: async () => false }));
    await isPending(request, evidence, ports({ verifySource: async () => { throw Error("source unavailable"); } }));
    const unavailable = await assessWorkerMasterEvidence(request, evidence);
    assert.equal(unavailable.status, "pending-human-review");
  });
}

test("source, scope, policy, contract and profile-version mismatches stay pending", async () => {
  const { request, evidence } = fixture("collect-worker-profile");
  for (const path of ["organizationId", "requestReference", "subjectReference", "policyRevision",
    "source.systemId", "source.connectionId", "source.objectType", "inputs.profile.id",
    "inputs.profile.version", "inputs.requiredFieldSchemaVersion", "contractVersion"]) {
    await isPending(request, change(evidence, `inputSnapshot.${path}`, "different"));
  }
  await isPending(request, change(evidence, "inputSnapshot.source.environment", "production"));
  await isPending(request, change(evidence, "inputSnapshot.outcome", "create-worker-record"));
  await isPending({ ...request, organizationId: undefined }, evidence);
  await isPending(request, { ...evidence, verified: true });
  await isPending(request, { ...evidence, observedAt: "2026-10-16T07:58:59Z" });
  await isPending(request, { ...evidence, observedAt: "2026-10-16T08:00:01Z" });
  await isPending(request, evidence, ports({ maxEvidenceAgeMs: NaN }));
});

test("profile completeness is schema/version-specific and not worker creation or authenticity", async () => {
  const { request, evidence } = fixture("collect-worker-profile");
  for (const bad of [{ ...evidence, requiredFieldsComplete: false },
    { ...evidence, validatedSchemaVersion: "old-schema" },
    { ...evidence, record: { id: profile.id, version: "old-version" } }]) await isPending(request, bad);
  for (const identityStatus of ["ambiguous", "unknown"]) {
    const unresolved = change(request, "inputs.identityStatus", identityStatus);
    await isPending(unresolved, { ...evidence, inputSnapshot: unresolved });
  }
  await isPending(fixture("create-worker-record").request, evidence);
  const result = await assessWorkerMasterEvidence(request, evidence, ports());
  assert.ok(!JSON.stringify(result).includes("authenticityConfirmed"));
});

test("creation requires clear duplicate/identity review and exact authorized HR decision", async () => {
  const { request, evidence } = fixture("create-worker-record");
  for (const [path, value] of [["inputs.duplicateStatus", "unresolved"], ["inputs.identityStatus", "ambiguous"],
    ["inputs.identityStatus", "unknown"], ["inputs.hrDecisionReference", ""], ["inputs.effectiveDate", "2026-02-30"]]) {
    const changed = change(request, path, value);
    await isPending(changed, { ...evidence, inputSnapshot: changed });
  }
  await isPending(request, evidence, ports({ verifyHumanDecision: async () => false }));
  await isPending(request, change(evidence, "inputSnapshot.inputs.personReference", "wrong-person"));
  await isPending(request, change(evidence, "inputSnapshot.inputs.approvedValuesDigest", "b".repeat(64)));
});

test("duplicate resolution requires exact candidates, survivor, disposition and current human decision", async () => {
  const { request, evidence } = fixture("resolve-duplicate-worker");
  await isPending(request, { ...evidence, candidateResults: undefined });
  await isPending(request, change(evidence, "record.id", "wrong-survivor"));
  await isPending(request, change(evidence, "candidateResults.1.status", "active"));
  await isPending(request, change(evidence, "candidateResults.1.id", "worker-1"));
  await isPending(request, change(evidence, "inputSnapshot.inputs.candidates.1.version", "older"));
  await isPending(request, evidence, ports({ verifyHumanDecision: async () => false }));
  const repeated = change(request, "inputs.candidates.1.id", "worker-1");
  await isPending(repeated, { ...evidence, inputSnapshot: repeated });
  const separate = change(change(request, "inputs.disposition", "keep-separate"), "inputs.survivorId", null);
  await isPending(separate, { ...evidence, inputSnapshot: separate });
  const separateEvidence = { ...evidence, inputSnapshot: separate,
    candidateResults: evidence.candidateResults!.map(row => ({ ...row, status: "active" as const })) };
  assert.equal((await assessWorkerMasterEvidence(separate, separateEvidence, ports())).status, "evidence-satisfies-contract");
});

test("pre-start amendments require matching object, versions, effective date, start state and payroll decision", async () => {
  const { request, evidence } = fixture("amend-prestart-employment-details");
  for (const bad of [change(evidence, "record.id", "wrong-employment"),
    change(evidence, "record.version", "v1"), change(evidence, "previousVersion", "old-version"),
    change(evidence, "inputSnapshot.inputs.effectiveDate", "2026-12-01"),
    change(evidence, "inputSnapshot.inputs.changesDigest", "b".repeat(64))]) await isPending(request, bad);
  for (const state of ["started", "unknown"]) {
    const changed = change(request, "inputs.actualStartStatus", state);
    await isPending(changed, { ...evidence, inputSnapshot: changed });
  }
  const payroll = change(request, "inputs.payrollImpact", true);
  await isPending(payroll, { ...evidence, inputSnapshot: payroll });
  const approved = change(payroll, "inputs.payrollDecisionReference", "payroll-decision-1");
  await isPending(approved, { ...evidence, inputSnapshot: approved }, ports({
    verifyHumanDecision: async (_request, _reference, purpose) => purpose !== "payroll",
  }));
  assert.equal((await assessWorkerMasterEvidence(approved, { ...evidence, inputSnapshot: approved }, ports())).status, "evidence-satisfies-contract");
  await isPending(request, evidence, ports({ verifyHumanDecision: async () => { throw Error("decision check unavailable"); } }));
});

test("verification snapshots and receipt candidates cannot be mutated or reused for different evidence", async () => {
  const { request, evidence } = fixture("collect-worker-profile");
  const original = await assessWorkerMasterEvidence(request, evidence, ports({
    verifySource: async (snapshot, proof) => {
      assert.equal(Reflect.set(snapshot.source, "connectionId", "other"), false);
      assert.equal(Reflect.set(proof.record, "version", "other"), false);
      return true;
    },
  }));
  assert.equal(original.status, "evidence-satisfies-contract");
  assert.equal(Reflect.set(original.receiptCandidate!, "receiptDigest", "other"), false);
  const newer = change(request, "inputs.profile.version", "profile-v2");
  const newerEvidence = { ...evidence, inputSnapshot: newer, record: { id: profile.id, version: "profile-v2" } };
  await isPending(newer, evidence);
  const updated = await assessWorkerMasterEvidence(newer, newerEvidence, ports());
  assert.equal(updated.status, "evidence-satisfies-contract");
  assert.notEqual(original.receiptCandidate?.receiptDigest, updated.receiptCandidate?.receiptDigest);
});

test("evidence expiring during asynchronous verification stays pending", async () => {
  const { request, evidence } = fixture("create-worker-record");
  let clock = now;
  await isPending(request, evidence, ports({
    now: () => clock,
    verifyHumanDecision: async () => {
      clock = new Date(now.getTime() + 60_001);
      return true;
    },
  }));
});

test("only four definition revisions change; source and catalog reconcile without promoting execution", () => {
  const catalog = buildIntentCatalog();
  for (const key of WORKER_MASTER_KEYS) {
    const definition = catalog.definitions.find(row => row.key === key)!;
    const source = master.subIntents.find(row => row.key === key)!;
    assert.equal(definition.version, "hro-operational-v1:2");
    assert.equal(definition.reviewStatus, "reviewed");
    assert.equal(definition.initiation.reviewStatus, "proposed");
    assert.equal(definition.coverage, "catalogued");
    assert.equal(source.currentRuntimeStatus, "unsupported");
    assert.equal(source.completionContractVersion, WORKER_MASTER_CONTRACT_VERSION);
    assert.equal(source.completionContractApprovalReference, WORKER_MASTER_APPROVAL_REFERENCE);
    assert.deepEqual(definition.evidence, source.completionEvidence);
    assert.ok(definition.provenance.includes(WORKER_MASTER_APPROVAL_REFERENCE));
    assert.ok(definition.invocationConstraints.some(row => row.includes("no worker-master executor")));
    assert.ok(catalog.mappings.some(row => row.sourceKey === key && row.sourceVersion.endsWith(WORKER_MASTER_CONTRACT_VERSION)));
  }
  assert.equal(catalog.definitions.filter(row => row.version === "hro-operational-v1:2").length, 4);
  assert.deepEqual([catalog.counts.masterAtomicOutcomes, catalog.counts.canonicalAtomicDefinitions, catalog.counts.compositeDefinitions], [320, 319, 1]);
});
