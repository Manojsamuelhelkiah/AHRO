import assert from "node:assert/strict";
import { test } from "node:test";
import { sendEmail } from "./channels";
import {
  DRILL_EMAIL,
  DRILL_PHONE,
  securityDrillPreflight,
} from "./security-drill";
import {
  demoControllerLiveAllowed,
  demoControllerLiveContextValid,
  externalProviderDispatchDenied,
  runWithDemoControllerLive,
  runWithProviderDeny,
} from "./provider-policy";

test("provider-deny context spans awaits and blocks the actual email dispatch boundary", async () => {
  const result = await runWithProviderDeny(async () => {
    await Promise.resolve();
    assert.equal(externalProviderDispatchDenied(), true);
    return sendEmail("authorized@example.com", "Safety test", "must not dispatch");
  });
  assert.equal(result.status, "logged-only");
  assert.match(result.failureReason ?? "", /execution safety policy/i);
});

test("normal executions retain provider dispatch eligibility", () => {
  assert.equal(externalProviderDispatchDenied(), false);
});

test("an ancestor deny cannot be reopened by a nested demo scope", async () => {
  let revalidated = false;
  const allowed = await runWithProviderDeny(() => runWithDemoControllerLive({
    organizationId: "demo",
    caseId: 42,
    channel: "email",
    recipient: "approved@example.com",
    revalidate: () => {
      revalidated = true;
      return true;
    },
  }, async () => {
    assert.equal(demoControllerLiveAllowed("demo", 42, "email", "approved@example.com"), false);
    return demoControllerLiveContextValid("demo", 42, "email", "approved@example.com");
  }));
  assert.equal(allowed, false);
  assert.equal(revalidated, false, "a deny fence must short-circuit before the run lookup");
});

test("authorization granted after drill preflight cannot reopen the deny fence", async () => {
  const organizationId = "drill-toctou-org";
  let authorized = false;
  await securityDrillPreflight(organizationId, {
    refreshAuthorization: async () => undefined,
    addressAllowed: () => authorized,
  });

  // Simulate a concurrent volunteer authorization update between preflight
  // and the delivery phase. The execution-scoped fence remains authoritative.
  authorized = true;
  let providerCalls = 0;
  const result = await runWithProviderDeny(async () => {
    if (authorized) {
      const email = await sendEmail(DRILL_EMAIL, "Safety test", "must not dispatch");
      if (email.status === "sent") providerCalls += 1;
      return email;
    }
    return sendEmail(DRILL_PHONE, "Safety test", "must not dispatch");
  });
  assert.equal(result.status, "logged-only");
  assert.equal(providerCalls, 0);
});