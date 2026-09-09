import test from "node:test";
import assert from "node:assert/strict";
import { resolveOrganizationBootstrap } from "./organization-bootstrap";

test("organization bootstrap sends users without memberships to setup", () => {
  assert.deepEqual(
    resolveOrganizationBootstrap(
      { needsSetup: true, activeOrganizationId: null, memberships: [] },
      null,
    ),
    { kind: "setup" },
  );
});

test("organization bootstrap replaces a stale stored selector", () => {
  assert.deepEqual(
    resolveOrganizationBootstrap(
      {
        needsSetup: false,
        activeOrganizationId: null,
        memberships: [{ organizationId: "org_second" }],
      },
      "org_stale",
    ),
    { kind: "ready", organizationId: "org_second", selectorChanged: true },
  );
});

test("organization bootstrap preserves an existing private-workspace selector", () => {
  assert.deepEqual(
    resolveOrganizationBootstrap(
      {
        needsSetup: false,
        activeOrganizationId: "legacy-private-owner",
        memberships: [
          { organizationId: "legacy-private-owner" },
          { organizationId: "demo" },
        ],
      },
      "legacy-private-owner",
    ),
    {
      kind: "ready",
      organizationId: "legacy-private-owner",
      selectorChanged: false,
    },
  );
});