import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalRef,
  matchApprovalRef,
  matchApprovalVersionRef,
  parseApproverDecision,
  senderIsApprover,
  composeApprovalEmail,
  emailDecisionDisabledReceipt,
  emailDecisionRecordedReceipt,
} from "./approver-email";
import { composeApprovalRequestNotificationCopy } from "./approval-decisions";
import { approvalStakeholderFromActionIdentity } from "./email-identity";

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

test("versioned references fail closed when an email mixes cycles", () => {
  assert.deepEqual(matchApprovalVersionRef("Re: [AP-42-V2]"), {
    approvalId: 42,
    version: 2,
    legacy: false,
  });
  assert.deepEqual(matchApprovalVersionRef("Re: [AP-42]"), {
    approvalId: 42,
    version: 1,
    legacy: true,
  });
  assert.equal(matchApprovalVersionRef("AP-42-V2 AP-42-V3"), null);
  assert.equal(matchApprovalVersionRef("AP-42-V2 AP-42"), null);
  assert.equal(matchApprovalVersionRef("AP-42 AP-43"), null);
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
  const organizationId = "approver-test-org";
  setDemoAllowlist(organizationId, []);
  // Unauthorized: an address not saved in Settings never receives live mail.
  assert.equal(addressAllowed("approver@example.com", organizationId), false);
  // Saving the approver in Settings adds it to the allowlist (initDemoAllowlist).
  setDemoAllowlist(organizationId, ["approver@example.com"]);
  assert.equal(addressAllowed("Approver@Example.com", organizationId), true);
  assert.equal(addressAllowed("Approver@Example.com", "another-org"), false);
  // Clearing the setting revokes authorization again.
  setDemoAllowlist(organizationId, []);
  assert.equal(addressAllowed("approver@example.com", organizationId), false);
});

/* ---------------------------- compose ---------------------------- */

test("composeApprovalEmail includes authenticated app-only decision instructions", () => {
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
  assert.match(body, /sign in to the same organization/i);
  assert.match(body, /Action Center → Approvals/);
  assert.match(body, /Email replies .* do not approve, reject, or change/i);
  assert.match(body, /Employee: Priya Sharma/);
  assert.match(body, /Intended stakeholder: Name not configured — HR approval stakeholder/);
  assert.match(body, /Requested by: bgv \(agent\)/);
  assert.match(body, /Delivery status: REAL PATH/);
  assert.match(body, /App navigation: Sign in to the same organization, open Action Center → Approvals, and locate AP-9-V1/);
  assert.doesNotMatch(body, /App link: https?:\/\//);
  // The reference still lets a signed-in user locate the exact review.
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

test("email-enabled approval copy describes verified authority rather than a persona", () => {
  const { body } = composeApprovalEmail({
    approvalId: 15, version: 2, workerName: "W", caseId: 1, agent: "bgv",
    hitlPattern: "approve-before-act", recommendation: "r", rationale: "x",
    // composeApprovalEmail is the compatibility wrapper; the current
    // notification path supplies this only after a live scoped grant lookup.
    emailResponderAuthorized: true,
  });
  assert.match(body, /exact governance-authorized Clerk-verified member address/);
  assert.match(body, /no stakeholder persona or mailbox label grants authority/i);
});

test("approval copy keeps named stakeholder separate from the shared mailbox address", () => {
  const { body } = composeApprovalEmail({
    approvalId: 12,
    version: 2,
    workerName: "Case Employee",
    caseId: 88,
    agent: "intake",
    hitlPattern: "approve-before-act",
    recommendation: "Proceed",
    rationale: "Evidence is ready",
    stakeholderName: "People Operations",
    stakeholderRole: "HR approval reviewer",
    deliveryAddress: "demo-approvals@example.test",
  });
  assert.match(body, /Intended stakeholder: People Operations — HR approval reviewer/);
  assert.match(body, /Actual delivery address: demo-approvals@example.test/);
  assert.match(body, /Reference: AP-12-V2/);
  assert.match(body, /App navigation: Sign in to the same organization, open Action Center → Approvals, and locate AP-12-V2/);
  assert.match(body, /Email replies are notification receipts only/);
});

test("email reply receipt is explicit, app-only, and deduplicated by provider message", () => {
  const first = emailDecisionDisabledReceipt({
    approvalId: 12,
    version: 2,
    sourceMessageId: "gmail-message-123",
  });
  const retry = emailDecisionDisabledReceipt({
    approvalId: 12,
    version: 2,
    sourceMessageId: "gmail-message-123",
  });
  assert.match(first.subject, /Email reply received — no decision applied/);
  assert.match(first.body, /No decision was applied/);
  assert.match(first.body, /did not pass the current authority checks/);
  assert.match(first.body, /Sign in to the same organization and open Action Center → Approvals/);
  assert.equal(first.idempotencyKey, "approval-email-receipt:gmail-message-123");
  assert.deepEqual(retry, first);
});

test("authorized email decision receipt is truthful and provider-message deduplicated", () => {
  const receipt = emailDecisionRecordedReceipt({
    approvalId: 12, version: 2, sourceMessageId: "gmail-message-accepted", decision: "approved",
  });
  assert.match(receipt.subject, /Email decision recorded — approved/);
  assert.match(receipt.body, /approved decision .* recorded after current authority verification/i);
  assert.match(receipt.body, /verified member account, not to a mailbox persona/i);
  assert.equal(receipt.idempotencyKey, "approval-email-receipt:gmail-message-accepted");
});

test("the approval outbox template caller resolves the configured HR persona", () => {
  const stakeholder = approvalStakeholderFromActionIdentity(JSON.stringify({
    version: 2,
    identities: {
      hr: { name: "Amina Patel", mailboxType: "shared" },
    },
  }));
  const { body } = composeApprovalRequestNotificationCopy(
    {
      approval: {
        id: 21,
        version: 3,
        caseId: 144,
        agent: "bgv",
        hitlPattern: "approve-before-act",
        recommendation: "Review",
        rationale: "Human review required",
      },
      workerName: "Jordan Lee",
      stakeholderName: stakeholder.name,
      stakeholderRole: stakeholder.role,
      deliveryAddress: "demo-approvals@example.test",
    },
  );
  assert.match(body, /Employee: Jordan Lee/);
  assert.match(body, /Case: #144/);
  assert.match(body, /Intended stakeholder: Amina Patel — HR approval stakeholder/);
  assert.match(body, /Actual delivery address: demo-approvals@example.test/);
  assert.match(body, /Reference: AP-21-V3/);

  // The outbox stores this rendered body; changing Action Center identities
  // for a later attempt must not mutate the already-rendered snapshot.
  const renamed = composeApprovalRequestNotificationCopy({
    approval: {
      id: 21,
      version: 3,
      caseId: 144,
      agent: "bgv",
      hitlPattern: "approve-before-act",
      recommendation: "Review",
      rationale: "Human review required",
    },
    workerName: "Jordan Lee",
    stakeholderName: "Beatrice Chen",
    stakeholderRole: "HR approval stakeholder",
    deliveryAddress: "demo-approvals@example.test",
  });
  assert.doesNotMatch(body, /Beatrice Chen/);
  assert.match(renamed.body, /Beatrice Chen/);
  assert.doesNotMatch(body, /reply with exactly|shared approver mailbox address are honored/i);
});
