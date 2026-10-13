import assert from "node:assert/strict";
import test from "node:test";
import { enrichMemberIdentities, isInternalAccount } from "./member-identities";
import { INTERNAL_SMOKE_USER_ID } from "../middlewares/require-auth";

test("directory enrichment only queries supplied tenant records and ignores unsolicited users", async () => {
  const queried: string[][] = [];
  const rows = [{ clerkUserId: "user_tenant_a", role: "member" }];
  const result = await enrichMemberIdentities(rows, async (ids) => {
    queried.push(ids);
    return [
      { id: "user_tenant_a", name: "Alex", email: "alex@example.test" },
      { id: "user_other_tenant", name: "Private", email: "private@example.test" },
    ];
  });
  assert.deepEqual(queried, [["user_tenant_a"]]);
  assert.deepEqual(result, [{
    ...rows[0], name: "Alex", email: "alex@example.test", accountKind: "human", identityResolution: "resolved",
  }]);
  const otherTenant = await enrichMemberIdentities([{ clerkUserId: "user_tenant_a" }], async () => []);
  assert.equal(otherTenant[0].name, null, "no cross-request or tenant profile cache");
  assert.equal(otherTenant[0].identityResolution, "missing");
  assert.deepEqual(rows, [{ clerkUserId: "user_tenant_a", role: "member" }]);
});

test("large lists retain partial results, missing profiles, immutable lifecycle fields and retry after outage", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({
    clerkUserId: `user_${i}`, revokedAt: "2026-01-01T00:00:00.000Z", revision: i, role: "member",
  }));
  const batches: string[][] = [];
  const result = await enrichMemberIdentities(rows, async (ids) => {
    batches.push(ids);
    if (batches.length === 2) throw new Error("Directory down");
    return ids.slice(0, -1).map((id) => ({ id, name: "Duplicate name", email: `${id}@example.test` }));
  });
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
  assert.equal(result.length, 205);
  assert.equal(result[0].identityResolution, "resolved");
  assert.equal(result[99].identityResolution, "missing");
  assert.equal(result[100].identityResolution, "unavailable");
  assert.equal(result[200].identityResolution, "resolved");
  for (let i = 0; i < rows.length; i++) {
    assert.equal(result[i].clerkUserId, rows[i].clerkUserId);
    assert.equal(result[i].revision, rows[i].revision);
    assert.equal(result[i].revokedAt, rows[i].revokedAt);
  }
  const outage = await enrichMemberIdentities(rows, async () => { throw new Error("Directory down"); });
  assert.ok(outage.every((row) => row.identityResolution === "unavailable" && row.name === null));
  const retry = await enrichMemberIdentities(rows, async (ids) => ids.map((id) => ({ id, name: "Recovered", email: null })));
  assert.ok(retry.every((row) => row.identityResolution === "resolved"));
});

test("only the configured smoke identity is internal and it never enters directory queries", async () => {
  assert.equal(isInternalAccount(INTERNAL_SMOKE_USER_ID), true);
  assert.equal(isInternalAccount(`user_${INTERNAL_SMOKE_USER_ID}`), false);
  assert.equal(isInternalAccount(`${INTERNAL_SMOKE_USER_ID}_other`), false);
  const queried: string[][] = [];
  const result = await enrichMemberIdentities([
    { clerkUserId: INTERNAL_SMOKE_USER_ID }, { clerkUserId: "user_real_person" },
  ], async (ids) => { queried.push(ids); return []; });
  assert.deepEqual(queried, [["user_real_person"]]);
  assert.equal(result[0].accountKind, "internal");
  assert.equal(result[0].identityResolution, "internal");
  assert.equal(result[1].accountKind, "human");
});
