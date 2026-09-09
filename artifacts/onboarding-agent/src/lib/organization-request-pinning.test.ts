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