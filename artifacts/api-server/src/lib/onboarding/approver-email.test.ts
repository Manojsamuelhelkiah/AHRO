import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalRef,
  matchApprovalRef,
  parseApproverDecision,
  senderIsApprover,
  composeApprovalEmail,
} from "./approver-email";

/* ----------------------------- refs ----------------------------- */

test("approvalRef and matchApprovalRef round-trip", () => {
  assert.equal(approvalRef(42), "AP-42");
  assert.equal(matchApprovalRef("Re: [AP-42] Approval needed"), 42);
  assert.equal(matchApprovalRef("regarding ap-7, I approve"), 7);
});

test("matchApprovalRef ignores text without a ref", () => {
  assert.equal(matchApprovalRef("I approve this"), null);
  assert.equal(matchApprovalRef("case #42 looks fine"), null);
  assert.equal(matchApprovalRef("MAP-42 is a codename"), null); // word boundary
});

/* --------------------------- decisions --------------------------- */

test("parseApproverDecision recognises approvals", () => {
  assert.equal(parseApproverDecision("Approve"), "approved");
  assert.equal(parseApproverDecision("approved, go ahead"), "approved");
  assert.equal(parseApproverDecision("Yes, approve this one"), "approved");
});

test("parseApproverDecision recognises rejections", () => {
  assert.equal(parseApproverDecision("Reject"), "rejected");
  assert.equal(parseApproverDecision("This should be rejected."), "rejected");
  assert.equal(parseApproverDecision("Do not approve"), "rejected");
  assert.equal(parseApproverDecision("don't approve"), "rejected");
});

test("ambiguous or unrelated replies decide nothing", () => {
  assert.equal(parseApproverDecision("approve? or reject? not sure"), null);
  assert.equal(parseApproverDecision("thanks, will look tomorrow"), null);
  assert.equal(parseApproverDecision(""), null);
});

/* --------------------------- allowlist --------------------------- */

test("senderIsApprover: exact address only, case-insensitive", () => {
  assert.equal(senderIsApprover("Alice@Example.com", "alice@example.com"), true);
  assert.equal(senderIsApprover(" alice@example.com ", "alice@example.com"), true);
  assert.equal(senderIsApprover("mallory@example.com", "alice@example.com"), false);
  assert.equal(senderIsApprover("alice@example.com.evil.com", "alice@example.com"), false);
});

test("senderIsApprover: nobody is trusted when no approver is configured", () => {
  assert.equal(senderIsApprover("alice@example.com", null), false);
  assert.equal(senderIsApprover("", null), false);
});

/* ----------------------- delivery authorization ------------------ */

import { addressAllowed, setDemoAllowlist } from "./channels";

test("approver address is only deliverable once explicitly allowlisted", () => {
  setDemoAllowlist([]);
  // Unauthorized: an address not saved in Settings never receives live mail.
  assert.equal(addressAllowed("approver@example.com"), false);
  // Saving the approver in Settings adds it to the allowlist (initDemoAllowlist).
  setDemoAllowlist(["approver@example.com"]);
  assert.equal(addressAllowed("Approver@Example.com"), true);
  // Clearing the setting revokes authorization again.
  setDemoAllowlist([]);
  assert.equal(addressAllowed("approver@example.com"), false);
});

/* ---------------------------- compose ---------------------------- */

test("composeApprovalEmail includes the ref, recommendation and reply instructions", () => {
  const { subject, body } = composeApprovalEmail({
    approvalId: 9,
    workerName: "Priya Sharma",
    caseId: 3,
    agent: "bgv",
    hitlPattern: "approve-before-act",
    recommendation: "Proceed with conditional clearance",
    rationale: "Minor date mismatch on a previous employer letter",
  });
  assert.ok(subject.includes("[AP-9]"));
  assert.ok(subject.includes("Priya Sharma"));
  assert.ok(body.includes("Proceed with conditional clearance"));
  assert.ok(body.includes("Minor date mismatch"));
  assert.ok(/reply .*"approve" or "reject"/i.test(body));
  // The reply must be matchable: the ref appears in the body too.
  assert.equal(matchApprovalRef(body), 9);
});

test("composeApprovalEmail flags hard-blocks", () => {
  const { subject } = composeApprovalEmail({
    approvalId: 1,
    workerName: "W",
    caseId: 1,
    agent: "bgv",
    hitlPattern: "hard-block",
    recommendation: "r",
    rationale: "x",
  });
  assert.ok(subject.includes("HARD-BLOCK"));
});
