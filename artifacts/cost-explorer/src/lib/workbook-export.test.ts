import test from "node:test";
import assert from "node:assert/strict";
import { pinOrganizationIdForPage } from "@workspace/api-client-react";
import { fetchScenarioWorkbook } from "./workbook-export";

test("workbook export uses the organization pinned to the mounted page", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  const workbook = new Blob(["workbook"]);
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestInit = init;
    return new Response(workbook, { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    pinOrganizationIdForPage(null);
  });

  pinOrganizationIdForPage("workspace-a");
  const result = await fetchScenarioWorkbook({} as never);

  assert.equal(result.size, workbook.size);
  assert.equal(
    new Headers(requestInit?.headers).get("x-organization-id"),
    "workspace-a",
  );
  assert.equal(requestInit?.credentials, "include");
});