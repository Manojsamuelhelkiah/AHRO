import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrganizationRequestScope,
  customFetch,
  pinOrganizationIdForPage,
} from "@workspace/api-client-react";

test("an open Onboarding form keeps its workspace when another tab switches", async (t) => {
  const sharedSelector = { organizationId: "workspace-a" };
  const onboardingTab = createOrganizationRequestScope(
    sharedSelector.organizationId,
  );
  const costExplorerTab = createOrganizationRequestScope(
    sharedSelector.organizationId,
  );

  sharedSelector.organizationId = "workspace-b";
  costExplorerTab.pinOrganizationId(sharedSelector.organizationId);
  assert.equal(onboardingTab.getOrganizationId(), "workspace-a");
  assert.equal(costExplorerTab.getOrganizationId(), "workspace-b");

  const originalFetch = globalThis.fetch;
  let dispatchedOrganization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    dispatchedOrganization = new Headers(init?.headers).get(
      "x-organization-id",
    );
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    pinOrganizationIdForPage(null);
  });

  pinOrganizationIdForPage(onboardingTab.getOrganizationId());
  await customFetch("/api/onboarding/cases", {
    method: "POST",
    body: JSON.stringify({ workerName: "Workspace A hire" }),
  });
  assert.equal(dispatchedOrganization, "workspace-a");
});

test("a failed target validation cannot repin the old tab", async (t) => {
  const onboardingTab = createOrganizationRequestScope("workspace-a");
  const targetTab = createOrganizationRequestScope("workspace-a");
  const originalFetch = globalThis.fetch;
  let requests = 0;

  globalThis.fetch = async (_input, init) => {
    requests += 1;
    assert.equal(
      new Headers(init?.headers).get("x-organization-id"),
      requests === 1 ? "workspace-b" : "workspace-a",
    );
    return new Response(
      JSON.stringify({
        needsSetup: false,
        activeOrganizationId: null,
        memberships: [{ organizationId: "workspace-a" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    pinOrganizationIdForPage(null);
  });

  // The switch validation request is explicitly targeted, while the mounted
  // page continues to dispatch through its original immutable scope.
  targetTab.pinOrganizationId("workspace-b");
  await customFetch("/api/organizations/current", {
    headers: { "x-organization-id": targetTab.getOrganizationId()! },
    responseType: "json",
  }).catch(() => undefined);
  pinOrganizationIdForPage(onboardingTab.getOrganizationId());
  await customFetch("/api/onboarding/cases", {
    method: "POST",
    body: JSON.stringify({ workerName: "Workspace A hire" }),
  });

  assert.equal(requests, 2);
  assert.equal(onboardingTab.getOrganizationId(), "workspace-a");
});