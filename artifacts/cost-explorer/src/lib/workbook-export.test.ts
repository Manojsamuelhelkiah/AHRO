import test from "node:test";
import assert from "node:assert/strict";
import { fetchScenarioWorkbook } from "./workbook-export";

test("workbook export explicitly sends the selected second organization", async () => {
  let requestInit: RequestInit | undefined;
  const workbook = new Blob(["workbook"]);
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestInit = init;
    return new Response(workbook, { status: 200 });
  };

  const result = await fetchScenarioWorkbook(
    {} as never,
    "org_second",
    fetcher as typeof fetch,
  );

  assert.equal(result.size, workbook.size);
  assert.equal(new Headers(requestInit?.headers).get("x-organization-id"), "org_second");
  assert.equal(requestInit?.credentials, "include");
});