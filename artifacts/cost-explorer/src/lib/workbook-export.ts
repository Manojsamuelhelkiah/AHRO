import type { ScenarioInputs } from "@workspace/api-client-react";

export async function fetchScenarioWorkbook(
  inputs: ScenarioInputs,
  organizationId: string,
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  if (!organizationId) {
    throw new Error("Select an organization before exporting a workbook.");
  }

  const response = await fetcher("/api/workbook/export", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-organization-id": organizationId,
    },
    body: JSON.stringify({ inputs }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message || "Could not export the workbook.");
  }
  return response.blob();
}