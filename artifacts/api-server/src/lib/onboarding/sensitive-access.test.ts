import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_SENSITIVE_ACCESS,
  SENSITIVE_ACCESS_KEY_BY_CLASS,
  classifySensitiveText,
  hasOpaqueNarrativeAccess,
  hasSensitiveAccess,
  redactCaseWorkforceContext,
  redactOperationalItems,
  redactSensitiveText,
  restrictedDocumentView,
  sensitiveClassForDocument,
  trustedSensitiveClassForDocument,
} from "./sensitive-access";

test("classifies medical, payroll, BGV, and identity records from server metadata", () => {
  assert.deepEqual(classifySensitiveText("Occupational health medical clearance"), ["medical"]);
  assert.deepEqual(classifySensitiveText("Bank account and tax withholding"), ["payroll"]);
  assert.deepEqual(classifySensitiveText("Background verification discrepancy"), ["bgv"]);
  assert.deepEqual(sensitiveClassForDocument({
    key: "custom-attachment", label: "Additional attachment", category: "custom",
  }), ["identity", "medical", "payroll", "bgv"]);
  assert.equal(trustedSensitiveClassForDocument({
    key: "id-proof", label: "Government photo ID (passport / national ID)", category: "identity",
  }), "identity");
});

test("custom document metadata is opaque even when it contains a recognizable class keyword", () => {
  const identityOnly = { ...NO_SENSITIVE_ACCESS, identity: true };
  const medicalOnly = { ...NO_SENSITIVE_ACCESS, medical: true };
  const allClasses = { identity: true, medical: true, payroll: true, bgv: true };
  const custom = {
    id: 7, caseId: 1, key: "custom-medical-bank", label: "Medical bank clearance attachment",
    category: "identity", status: "received", required: true,
  };

  assert.deepEqual(sensitiveClassForDocument(custom), ["identity", "medical", "payroll", "bgv"]);
  for (const access of [identityOnly, medicalOnly]) {
    const restricted = restrictedDocumentView(custom, access);
    assert.equal(restricted.restricted, true);
    assert.equal(restricted.key, "restricted");
    assert.doesNotMatch(JSON.stringify(restricted), /medical|bank|clearance/i);
  }
  const full = restrictedDocumentView(custom, allClasses);
  assert.equal(full.restricted, undefined);
  assert.equal(full.label, "Medical bank clearance attachment");

  const canonical = restrictedDocumentView({
    ...custom,
    key: "id-proof",
    label: "Government photo ID (passport / national ID)",
  }, identityOnly);
  assert.equal(canonical.restricted, undefined);
  assert.equal(canonical.label, "Government photo ID (passport / national ID)");
});

test("membership-shaped access cannot unlock a sensitive record", () => {
  const memberLikeAccess = { ...NO_SENSITIVE_ACCESS };
  assert.equal(hasSensitiveAccess(memberLikeAccess, ["medical"]), false);
  assert.equal(hasSensitiveAccess(memberLikeAccess, ["payroll"]), false);
  assert.equal(hasSensitiveAccess(memberLikeAccess, ["bgv"]), false);
});

test("sensitive read and write decisions are separate exact field permissions", () => {
  const readOnly = {
    ...NO_SENSITIVE_ACCESS,
    identity: true,
    edit: { ...NO_SENSITIVE_ACCESS.edit!, identity: false },
  };
  const readAndEdit = {
    ...readOnly,
    edit: { ...readOnly.edit, identity: true },
  };

  assert.equal(SENSITIVE_ACCESS_KEY_BY_CLASS.identity.read, "data.identity.read");
  assert.equal(SENSITIVE_ACCESS_KEY_BY_CLASS.identity.edit, "data.identity.edit");
  assert.equal(hasSensitiveAccess(readOnly, ["identity"]), true);
  assert.equal(hasSensitiveAccess(readOnly, ["identity"], "edit"), false);
  assert.equal(hasSensitiveAccess(readAndEdit, ["identity"], "edit"), true);
  assert.equal(hasSensitiveAccess(readAndEdit, ["medical"], "edit"), false);
});

test("redacts restricted document metadata and accessibility context", () => {
  const document = restrictedDocumentView({
    id: 1,
    caseId: 1,
    key: "bank-details",
    label: "Bank account details for salary",
    category: "statutory",
    status: "received",
    required: true,
    note: "Account ending 1234 was supplied",
  }, NO_SENSITIVE_ACCESS);
  assert.equal(document.restricted, true);
  assert.equal(document.key, "restricted");
  assert.equal(document.status, "received");
  assert.doesNotMatch(document.note ?? "", /1234/);

  const context = redactCaseWorkforceContext({
    workEnvironment: "office",
    accessibilityNeeds: "Requires medical accommodation",
  }, NO_SENSITIVE_ACCESS);
  assert.deepEqual(context, { workEnvironment: "office" });
  assert.equal(
    redactSensitiveText("Free-form reviewer text without a classifier keyword", NO_SENSITIVE_ACCESS),
    "Restricted confidential onboarding record.",
  );
});

test("opaque narratives require every scoped specialist class, regardless of keywords", () => {
  const identityOnly = { ...NO_SENSITIVE_ACCESS, identity: true };
  const medicalOnly = { ...NO_SENSITIVE_ACCESS, medical: true };
  const allClasses = { identity: true, medical: true, payroll: true, bgv: true };
  const incidentalFinding = "Candidate disclosed an unrecognized treatment and bank routing details.";

  assert.equal(hasOpaqueNarrativeAccess(identityOnly), false);
  assert.equal(hasOpaqueNarrativeAccess(medicalOnly), false);
  assert.equal(redactSensitiveText(incidentalFinding, identityOnly), "Restricted confidential onboarding record.");
  assert.equal(redactSensitiveText(incidentalFinding, medicalOnly), "Restricted confidential onboarding record.");
  assert.equal(redactSensitiveText(incidentalFinding, allClasses), incidentalFinding);
  assert.deepEqual(redactCaseWorkforceContext({
    workEnvironment: "office",
    sourceContext: "Unrecognized treatment and bank routing detail",
  }, medicalOnly), { workEnvironment: "office" });

  const [identityProjection] = redactOperationalItems([{
    key: "custom-clearance", label: "Unrecognized medical and bank finding",
    note: incidentalFinding, status: "pending", mandatory: true,
    enforcementStage: "before-workstreams",
  }], identityOnly);
  assert.equal(identityProjection.key, "restricted");
  assert.equal(identityProjection.label, "Restricted confidential operational item");
  assert.equal(identityProjection.status, "pending");
  assert.doesNotMatch(JSON.stringify(identityProjection), /bank|treatment/i);
});