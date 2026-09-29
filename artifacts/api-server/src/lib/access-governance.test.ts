import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCESS_GOVERNANCE_CATALOG,
  isActiveDistinctOwnerApprovalValid,
  isAccessAllowedForPrincipal,
  isIndependentOwnerApprovalValid,
  isSensitivePolicyOwner,
  membershipNeedsIndependentApproval,
  isReviewedAccessKey,
} from "./access-governance";

test("catalog contains reviewed high-sensitivity fields and case flow keys", () => {
  assert.ok(ACCESS_GOVERNANCE_CATALOG.fields.includes("data.identity.read"));
  assert.ok(ACCESS_GOVERNANCE_CATALOG.fields.includes("data.medical.edit"));
  assert.ok(ACCESS_GOVERNANCE_CATALOG.fields.includes("data.payroll.read"));
  assert.ok(ACCESS_GOVERNANCE_CATALOG.fields.includes("data.bgv.edit"));
  assert.ok(ACCESS_GOVERNANCE_CATALOG.flows.includes("flow.case.read"));
  assert.ok(ACCESS_GOVERNANCE_CATALOG.tools.includes("tool.approval.decide"));
});

test("catalog and principal checks reject wildcards and unknown capabilities", () => {
  assert.equal(isReviewedAccessKey("data.identity.read"), true);
  assert.equal(isReviewedAccessKey("*"), false);
  assert.equal(isReviewedAccessKey("data.identity.*"), false);
  assert.equal(isAccessAllowedForPrincipal({
    principalType: "human",
    key: "*",
    principalAllows: true,
  }), false);
});

test("agents require both their own and initiator access and cannot approve", () => {
  assert.equal(isAccessAllowedForPrincipal({
    principalType: "agent",
    key: "flow.case.read",
    principalAllows: true,
    initiatorAllows: true,
  }), true);
  assert.equal(isAccessAllowedForPrincipal({
    principalType: "agent",
    key: "flow.case.read",
    principalAllows: true,
    initiatorAllows: false,
  }), false);
  assert.equal(isAccessAllowedForPrincipal({
    principalType: "agent",
    key: "flow.case.read",
    principalAllows: true,
  }), false);
  assert.equal(isAccessAllowedForPrincipal({
    principalType: "agent",
    key: "tool.approval.decide",
    principalAllows: true,
    initiatorAllows: true,
  }), false);
});

test("sensitive attachments need approval by an active owner distinct from attacher", () => {
  const approved = {
    status: "active",
    ownerUserId: "owner",
    attachedByUserId: "operator",
    approvedByUserId: "owner",
    approvedAt: new Date("2026-01-01T00:00:00.000Z"),
    approvedPolicyVersion: 3,
    currentPolicyVersion: 3,
    ownerIsActiveMember: true,
  };
  assert.equal(isIndependentOwnerApprovalValid(approved), true);
  assert.equal(isIndependentOwnerApprovalValid({ ...approved, status: "pending" }), false);
  assert.equal(isIndependentOwnerApprovalValid({ ...approved, approvedByUserId: "operator" }), false);
  assert.equal(isIndependentOwnerApprovalValid({ ...approved, ownerIsActiveMember: false }), false);
  assert.equal(isIndependentOwnerApprovalValid({ ...approved, approvedAt: null }), false);
  assert.equal(isIndependentOwnerApprovalValid({ ...approved, approvedPolicyVersion: 2 }), false);
  assert.equal(isIndependentOwnerApprovalValid({
    ...approved,
    approvedPolicyVersion: 8,
    currentPolicyVersion: 9,
  }), false);
});

test("group membership approval is admission-scoped, while each policy link has its own version", () => {
  const memberAdmission = {
    status: "active",
    ownerUserId: "user-group-owner",
    attachedByUserId: "membership-operator",
    approvedByUserId: "user-group-owner",
    approvedAt: new Date("2026-01-01T00:00:00.000Z"),
    ownerIsActiveMember: true,
  };
  assert.equal(isActiveDistinctOwnerApprovalValid(memberAdmission), true);
  assert.equal(isIndependentOwnerApprovalValid({
    ...memberAdmission,
    ownerUserId: "security-owner-a",
    approvedByUserId: "security-owner-a",
    attachedByUserId: "link-operator-a",
    approvedPolicyVersion: 3,
    currentPolicyVersion: 3,
  }), true);
  assert.equal(isIndependentOwnerApprovalValid({
    ...memberAdmission,
    ownerUserId: "security-owner-b",
    approvedByUserId: "security-owner-b",
    attachedByUserId: "link-operator-b",
    approvedPolicyVersion: 11,
    currentPolicyVersion: 11,
  }), true);
});

test("all members of a current sensitive policy require owner approval", () => {
  assert.equal(membershipNeedsIndependentApproval({
    requiresApproval: "no",
    hasCurrentSensitivePolicy: true,
  }), true);
  assert.equal(membershipNeedsIndependentApproval({
    requiresApproval: "no",
    hasCurrentSensitivePolicy: false,
  }), false);
  assert.equal(membershipNeedsIndependentApproval({
    requiresApproval: "yes",
    hasCurrentSensitivePolicy: false,
  }), true);
});

test("owners cannot receive their own sensitive group policy", () => {
  assert.equal(isSensitivePolicyOwner({
    principalType: "human",
    principalId: "security-owner",
    securityGroupOwnerUserId: "security-owner",
  }), true);
  assert.equal(isSensitivePolicyOwner({
    principalType: "human",
    principalId: "user-owner",
    securityGroupOwnerUserId: "security-owner",
    userGroupOwnerUserIds: ["user-owner"],
  }), true);
  assert.equal(isSensitivePolicyOwner({
    principalType: "human",
    principalId: "ordinary-member",
    securityGroupOwnerUserId: "security-owner",
    userGroupOwnerUserIds: ["user-owner"],
  }), false);
});