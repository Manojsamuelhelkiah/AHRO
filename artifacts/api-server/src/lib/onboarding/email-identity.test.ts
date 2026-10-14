import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalStakeholderFromActionIdentity,
  formatAppLink,
  formatEmailIdentityLines,
  identityForRole,
  parseActionIdentityConfig,
  sharedMailboxResponderIdentity,
} from "./email-identity";

test("identity copy never derives a name from the delivery address", () => {
  const lines = formatEmailIdentityLines({
    stakeholder: { name: "", role: "HR approval reviewer" },
    deliveryAddress: "demo-approvals@example.test",
    requestedBy: "approval-agent",
    requestedByKind: "agent",
    deliveryMode: "real",
    actionRequired: "Reply with approve or reject.",
    reference: "AP-7-V1",
  });
  assert.match(lines.join("\n"), /Name not configured — HR approval reviewer/);
  assert.match(lines.join("\n"), /Action identity settings/);
  assert.match(lines.join("\n"), /Actual delivery address: demo-approvals@example.test/);
  assert.doesNotMatch(lines.join("\n"), /demo-approvals as|demo-approvals@example\.test \(/);
});

test("simulated identity copy is explicit and has no delivery claim", () => {
  const lines = formatEmailIdentityLines({
    stakeholder: { name: "Background Verification", role: "BGV provider" },
    deliveryAddress: "provider@example.test",
    requestedBy: "bgv-notifications",
    requestedByKind: "agent",
    deliveryMode: "simulated",
    actionRequired: "Review the simulated case.",
    reference: "BGV-4-cycle",
  }).join("\n");
  assert.match(lines, /Delivery status: NOT SENT — internal request record/);
  assert.match(lines, /Actual delivery address: provider@example.test/);
  assert.match(lines, /App link: https:\/\/hro-agent-nexus\.replit\.app\/approvals/);
});

test("the additive Action Center identity snapshot is parsed without an address", () => {
  const config = parseActionIdentityConfig(JSON.stringify({
    version: 2,
    identities: {
      hr: { name: "People Operations", mailboxType: "shared" },
      recruiter: { name: null, mailboxType: "not-configured" },
    },
  }));
  assert.deepEqual(config.stakeholders.hr, {
    name: "People Operations",
    role: "hr",
  });
  assert.equal(config.stakeholders.recruiter, undefined);
});

test("shared mailbox responders are not presented as named humans", () => {
  assert.equal(
    sharedMailboxResponderIdentity("Demo-Approvals@example.test"),
    "Shared mailbox responder (Demo-Approvals@example.test; exact allowlisted sender)",
  );
});

test("Action Center links are absolute published HTTPS links and preserve approval deep links", () => {
  assert.equal(
    formatAppLink("/approvals?tab=approvals&caseId=44&approvalRef=AP-9-V2"),
    "https://hro-agent-nexus.replit.app/approvals?tab=approvals&caseId=44&approvalRef=AP-9-V2",
  );
  assert.equal(
    formatAppLink("https://hro-agent-nexus.replit.app/approvals?tab=approvals&caseId=44"),
    "https://hro-agent-nexus.replit.app/approvals?tab=approvals&caseId=44",
  );
});

test("unsafe or internal app-link inputs fall back to the published Action Center", () => {
  for (const unsafe of ["//evil.example/approvals", "javascript:alert(1)", "http://localhost:3000/approvals"]) {
    const link = formatAppLink(unsafe);
    assert.match(link, /^https:\/\/hro-agent-nexus\.replit\.app\/approvals$/);
    assert.doesNotMatch(link, /javascript|localhost|evil\.example/);
  }
});

test("identity role keys do not override human-readable role labels", () => {
  assert.deepEqual(
    identityForRole(
      "hr",
      { hr: { name: "People Operations", role: "hr" } },
      null,
      "HR / onboarding",
    ),
    { name: "People Operations", role: "HR / onboarding" },
  );
});

test("approval persona uses configured HR, then approver fallback", () => {
  assert.deepEqual(
    approvalStakeholderFromActionIdentity(JSON.stringify({
      version: 1,
      identities: {
        approver: { name: "Approver Fallback", mailboxType: "shared" },
      },
    })),
    { name: "Approver Fallback", role: "HR approval stakeholder" },
  );
  assert.deepEqual(
    approvalStakeholderFromActionIdentity(JSON.stringify({
      version: 1,
      identities: {
        hr: { name: "HR Persona", mailboxType: "shared" },
        approver: { name: "Unused Approver", mailboxType: "shared" },
      },
    })),
    { name: "HR Persona", role: "HR approval stakeholder" },
  );
});