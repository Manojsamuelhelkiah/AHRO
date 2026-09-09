import {
  customFetch,
  type ScenarioInputs,
} from "@workspace/api-client-react";

type WorkbookRequester = (
  input: RequestInfo | URL,
  options: Parameters<typeof customFetch>[1],
) => Promise<Blob>;

export async function fetchScenarioWorkbook(
  inputs: ScenarioInputs,
  requester: WorkbookRequester = (input, options) =>
    customFetch<Blob>(input, options),
): Promise<Blob> {
  return requester("/api/workbook/export", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs }),
    responseType: "blob",
  });
}