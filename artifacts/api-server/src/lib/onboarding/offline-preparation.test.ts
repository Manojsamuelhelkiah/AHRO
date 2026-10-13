import assert from "node:assert/strict";
import { test } from "node:test";
import { onbCases } from "@workspace/db";
import { canonicalIntakeHash, findHroTemplate } from "./hro-batch-templates";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { actualRunOwnsCase, preparationInputIssues, preparationSource, validStoredPreparation } from "./offline-preparation";
import { jurisdictionForCaseDerivedEnvelope } from "./sensitive-lifecycle";
import { isHistoricalTestRecord } from "./historical-test-record";
import { isSyntheticOfflineCase, sampleCandidateEmailEligible } from "./synthetic-offline";
import type { OnboardingDbTransaction } from "./settings";

type CaseRow = typeof onbCases.$inferSelect;
const rowFor = (index = 0): CaseRow => ({
  ...CURATED_OFFLINE_EXAMPLES[index]!.values,
  id: index + 1, organizationId: "demo", checklistProfileId: "default",
  operationalPreparation: null, workforceContext: {},
} as unknown as CaseRow);
const storedFor = (row: CaseRow) => {
  const source = preparationSource(row)!;
  const template = findHroTemplate(source.values.processPolicySnapshot.batchIntake.templateId)!;
  return {
    schema: "offline-case-preparation/v1" as const,
    organizationId: row.organizationId, caseId: row.id,
    sourceKey: source.key, sourceFingerprint: canonicalIntakeHash(source.values),
    revision: 1, templateId: template.id, templateVersion: template.version,
    data: { work_country: "IN" }, updatedByUserId: "named-fixture",
    updatedAt: "2026-10-13T00:00:00Z",
  };
};

test("all twelve curated families have exact preparation sources and incomplete editable request contracts", () => {
  const families = new Set<string>();
  for (let index = 0; index < CURATED_OFFLINE_EXAMPLES.length; index++) {
    const row = rowFor(index);
    const source = preparationSource(row)!;
    assert.equal(source.key, row.scenarioKey);
    families.add(source.family);
    const issues = preparationInputIssues(source.values.processPolicySnapshot.batchIntake.templateId, {});
    assert.ok(issues.length > 0);
    assert.ok(issues.every(issue => issue.message.endsWith(" is required.")));
  }
  assert.equal(families.size, 12);
});

test("preparation cannot be inferred from names, notes, mutable keys, real contacts or controller history", () => {
  const original = rowFor();
  for (const mutation of [
    { organizationId: "client" }, { scenarioKey: "UAT-unverified" }, { syntheticProvenance: null },
    { workerName: "Unknown source" }, { workerEmail: "worker@provider.com" },
    { workerPhone: "+919876543210" }, { candidateEmailAuthorizedAt: new Date() },
    { candidateEmailAuthorizedBy: "demo-controller" }, { checklistProfileId: "demo-controller" },
    { orchestrationCheckpoint: "demo-controller:initial" }, { notes: "[demo-controller-run:old]" },
  ]) assert.equal(preparationSource({ ...original, ...mutation } as CaseRow), null);
  assert.ok(preparationSource({ ...original, notes: "Mutable unrelated text" }));
});

test("actual UAT ownership and malformed ledgers independently deny an exact reserved example", async () => {
  const row = rowFor();
  const mock = (values: string[]) => ({
    select: () => ({ from: () => ({ where: async () => values.map(value => ({ value })) }) }),
  } as unknown as OnboardingDbTransaction);
  assert.equal(await actualRunOwnsCase(mock([]), row), false);
  assert.equal(await actualRunOwnsCase(mock([JSON.stringify({ runId: "actual", linkedCaseIds: [row.id] })]), row), true);
  assert.equal(await actualRunOwnsCase(mock([JSON.stringify({ runId: "other", linkedCaseIds: [row.id + 1] })]), row), false);
  for (const value of ["bad-json", "null", "{}", JSON.stringify({ runId: "actual", linkedCaseIds: ["1"] })])
    assert.equal(await actualRunOwnsCase(mock([value]), row), true);
});

test("draft validation rejects unexpected fields, formula values, invalid dates and client template control", () => {
  const payroll = CURATED_OFFLINE_EXAMPLES.find(source => source.family === "Payroll")!;
  const templateId = payroll.values.processPolicySnapshot.batchIntake.templateId;
  const invalidData: Record<string, string>[] = [
    { unrelated_field: "private narrative" }, { request_summary: "=HYPERLINK()" },
    { effective_date: "2026-02-30" }, { worker_email: "not-an-address" },
    { work_country: "India" }, { template_id: "payroll-bank-change" },
  ];
  for (const data of invalidData)
    assert.ok(preparationInputIssues(templateId, data).some(issue => !issue.message.endsWith(" is required.")));
});

test("stored preparation is tenant, case, source fingerprint and revision bound", () => {
  const row = rowFor();
  const draft = storedFor(row);
  assert.equal(validStoredPreparation({ ...row, operationalPreparation: draft }), draft);
  for (const mutation of [
    { organizationId: "client" }, { caseId: row.id + 1 }, { sourceKey: "unknown" },
    { sourceFingerprint: "unverified" }, { revision: 0 }, { revision: 1.5 },
    { templateId: "unknown-template" },
  ]) assert.equal(validStoredPreparation({ ...row, operationalPreparation: { ...draft, ...mutation } }), null);
});

test("preparation retains every old execution fence and never turns draft inputs into live identity or effects", () => {
  const row = rowFor();
  const prepared = { ...row, operationalPreparation: storedFor(row) };
  assert.equal(isHistoricalTestRecord(prepared), true);
  assert.equal(isSyntheticOfflineCase(prepared), true);
  assert.equal(sampleCandidateEmailEligible(prepared), false);
  assert.equal(prepared.workerEmail, row.workerEmail);
  assert.equal(prepared.orchestrationCheckpoint, "synthetic-offline");
  assert.equal(prepared.offerAcceptanceComplete, false);
});

test("draft personal information has its own explicit retention jurisdiction; conflicts fail closed", () => {
  const row = rowFor();
  assert.equal(jurisdictionForCaseDerivedEnvelope(row), null);
  const prepared = { ...row, operationalPreparation: storedFor(row) };
  assert.equal(jurisdictionForCaseDerivedEnvelope(prepared), "IN");
  assert.equal(jurisdictionForCaseDerivedEnvelope({ ...prepared, workforceContext: { workCountry: "IN", workState: "MH" } }), "IN-MH");
  assert.equal(jurisdictionForCaseDerivedEnvelope({ ...prepared, workforceContext: { workCountry: "GB" } }), null);
  assert.equal(jurisdictionForCaseDerivedEnvelope({ ...prepared, organizationId: "client" }), null);
});
