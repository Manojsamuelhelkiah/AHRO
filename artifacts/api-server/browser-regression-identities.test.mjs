import assert from "node:assert/strict";
import { test } from "node:test";
import { installBrowserIdentityReader } from "./browser-regression-identities.mjs";

test("owned test identities avoid the provider without asserting verification or admin eligibility", async () => {
  let providerCalls = 0;
  const original = async () => { providerCalls++; throw new Error("External provider denied"); };
  const client = { users: { getUser: original } };
  const identities = new Map([["owned", { firstName: "Test", lastName: "Reviewer", email: "test@example.invalid" }]]);
  const restore = installBrowserIdentityReader(client, identities, { NODE_ENV: "test", ONBOARDING_E2E_TEST: "true" });
  const user = await client.users.getUser("owned");
  assert.equal(user.id, "owned");
  assert.equal(user.twoFactorEnabled, false);
  assert.equal(user.emailAddresses[0].verification.status, "unverified");
  assert.deepEqual(user.privateMetadata, {});
  await assert.rejects(client.users.getUser("unowned"), /outside the owned browser fixture/);
  assert.equal(providerCalls, 0);
  identities.set("another-owned", { firstName: "Test", lastName: "Operator", email: "operator@example.invalid" });
  assert.equal((await client.users.getUser("another-owned")).id, "another-owned");
  restore();
  assert.equal(client.users.getUser, original);
});

test("identity overrides cannot be installed in normal development, production or incompletely guarded test runs", () => {
  for (const environment of [
    { NODE_ENV: "production", ONBOARDING_E2E_TEST: "true" },
    { NODE_ENV: "development", ONBOARDING_E2E_TEST: "true" },
    { NODE_ENV: "test" },
  ]) {
    const original = async () => null;
    const client = { users: { getUser: original } };
    assert.throws(() => installBrowserIdentityReader(client, new Map(), environment), /isolated test environment/);
    assert.equal(client.users.getUser, original);
  }
});
