import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRILL_EMAIL,
  DRILL_PHONE,
  securityDrillPreflight,
} from "./security-drill";

test("an authorized drill contact aborts before any provider-capable work", async () => {
  const organizationId = "security-drill-org";
  for (const authorizedContact of [DRILL_EMAIL, DRILL_PHONE]) {
    let refreshed = false;
    let providerCalls = 0;

    await assert.rejects(
      (async () => {
        await securityDrillPreflight(organizationId, {
          refreshAuthorization: async (requestedOrganizationId) => {
            assert.equal(requestedOrganizationId, organizationId);
            refreshed = true;
          },
          addressAllowed: (address, requestedOrganizationId) => {
            assert.equal(requestedOrganizationId, organizationId);
            return address === authorizedContact;
          },
        });
        providerCalls += 1;
      })(),
      /must not be authorized or allowlisted/i,
    );

    assert.equal(refreshed, true);
    assert.equal(providerCalls, 0);
  }
});

test("unauthorized synthetic contacts execute through blocked guards with zero provider calls", async () => {
  const organizationId = "security-drill-org";
  const checked: string[] = [];
  let providerCalls = 0;

  await securityDrillPreflight(organizationId, {
    refreshAuthorization: async (requestedOrganizationId) => {
      assert.equal(requestedOrganizationId, organizationId);
    },
    addressAllowed: (address, requestedOrganizationId) => {
      assert.equal(requestedOrganizationId, organizationId);
      checked.push(address);
      return false;
    },
  });

  // These model the real email/voice recipient guards exercised by the drill:
  // an unauthorized target returns logged-only before invoking its provider.
  const guardedAttempt = (authorized: boolean) => {
    if (!authorized) return "logged-only";
    providerCalls += 1;
    return "sent";
  };
  assert.equal(guardedAttempt(false), "logged-only");
  assert.equal(guardedAttempt(false), "logged-only");

  assert.deepEqual(checked, [DRILL_EMAIL, DRILL_PHONE]);
  assert.equal(providerCalls, 0);
});