import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrganizationRequestScope,
  customFetch,
  pinOrganizationIdForPage,
} from "@workspace/api-client-react";

test("an open Cost Explorer form keeps its workspace when another tab switches", async (t) => {
  const sharedSelector = { organizationId: "workspace-a" };
  const costExplorerTab = createOrganizationRequestScope(
    sharedSelector.organizationId,
  );
  const onboardingTab = createOrganizationRequestScope(
    sharedSelector.organizationId,
  );

  sharedSelector.organizationId = "workspace-b";
  onboardingTab.pinOrganizationId(sharedSelector.organizationId);
  assert.equal(costExplorerTab.getOrganizationId(), "workspace-a");
  assert.equal(onboardingTab.getOrganizationId(), "workspace-b");

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

  pinOrganizationIdForPage(costExplorerTab.getOrganizationId());
  await customFetch("/api/scenarios", {
    method: "POST",
    body: JSON.stringify({ name: "Workspace A scenario" }),
  });
  assert.equal(dispatchedOrganization, "workspace-a");
});