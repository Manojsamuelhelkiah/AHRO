import { resolveOrganizationSwitch, type OrganizationBootstrapResponse } from "./organization-bootstrap";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Validate the exact tenant, then reset the page realm and all old-tenant URLs. */
export async function enterClientWorkspace(organizationId: string): Promise<void> {
  const response = await fetch(`${basePath}/api/organizations/current`, {
    credentials: "include",
    cache: "no-store",
    headers: { "x-organization-id": organizationId },
  });
  const body = await response.json();
  if (!response.ok || resolveOrganizationSwitch(body as OrganizationBootstrapResponse, organizationId).kind !== "ready") {
    throw new Error(body.message || "Could not verify access to this client workspace.");
  }
  const previous = window.localStorage.getItem("activeOrganizationId");
  try {
    window.localStorage.setItem("activeOrganizationId", organizationId);
    // Do not retain a Demo scenarioId or change only SPA state: both would
    // leave the next page using an old-tenant plan or request scope.
    window.location.assign(`${basePath}/`);
  } catch (error) {
    if (previous) window.localStorage.setItem("activeOrganizationId", previous);
    else window.localStorage.removeItem("activeOrganizationId");
    throw error;
  }
}
