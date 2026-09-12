import assert from "node:assert/strict";
import test from "node:test";
import {
  lockActiveBootstrapMembership,
  lockGovernanceMutation,
} from "./approve-authority-governance-guards.mjs";

function fakeClient({ markerRows = 0, memberRows = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("onb_governance_dispatch_markers")) {
        return { rowCount: markerRows, rows: [] };
      }
      if (text.includes("organization_memberships")) {
        return {
          rowCount: memberRows,
          rows: memberRows ? [{ id: 1, role: "member" }] : [],
        };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

test("CLI grant fence orders removal fence, governance fence, and active membership read", async () => {
  const client = fakeClient();
  await lockGovernanceMutation(client, "cli-ordering-org");
  await lockActiveBootstrapMembership(client, "cli-ordering-org", "active-user");

  assert.equal(client.calls.length, 4);
  assert.deepEqual(client.calls.slice(0, 2).map(({ values }) => values), [
    ["cli-ordering-org"],
    ["governance-dispatch-mutation:cli-ordering-org"],
  ]);
  assert.match(client.calls[2].text, /status IN \('dispatching', 'ambiguous'\)/);
  assert.match(client.calls[3].text, /revoked_at IS NULL/);
  assert.match(client.calls[3].text, /FOR UPDATE/);
});

test("CLI grant is blocked by an active or ambiguous dispatch marker", async () => {
  const client = fakeClient({ markerRows: 1 });
  await assert.rejects(
    lockGovernanceMutation(client, "cli-dispatch-blocked-org"),
    (error) => error?.code === "GOVERNANCE_DISPATCH_IN_FLIGHT",
  );
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls.some(({ text }) => text.includes("organization_memberships")), false);
});

test("CLI grant refuses a revoked membership", async () => {
  const client = fakeClient({ memberRows: 0 });
  await lockGovernanceMutation(client, "cli-revoked-org");
  await assert.rejects(
    lockActiveBootstrapMembership(client, "cli-revoked-org", "revoked-user"),
    (error) => error?.code === "ORGANIZATION_MEMBERSHIP_REVOKED",
  );
  assert.match(client.calls.at(-1).text, /revoked_at IS NULL/);
});