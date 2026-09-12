import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  readConfirmedProviderSource,
  StandardProviderSourceReadError,
} from "./standard-provider-source-read";

describe("tenant-pinned provider source reads", () => {
  test("records only a server-read source that matches the tenant case identity", async () => {
    const result = await readConfirmedProviderSource({
      providerKey: "servicenow",
      organizationId: "org-a",
      caseId: 17,
      expectedCaseIdentity: "worker@example.test",
      expectedCaseStartDate: "2026-01-01",
      settings: {
        providerKey: "servicenow",
        organizationId: "org-a",
        baseUrl: "https://snow.example.test",
        bearerToken: "fixture-secret-not-sent-to-client",
        requestTable: "sc_req_item",
        catalogItemSysId: "catalog-1",
      },
      fieldMappings: {
        requestId: "number",
        requestSysId: "sys_id",
        requestState: "state",
        requestedFor: "requested_for.email",
        caseIdentity: "requested_for.email",
        submittedStates: "requested",
        inProgressStates: "work_in_progress",
        fulfilledStates: "closed_complete",
        failedStates: "closed_incomplete",
      },
      source: { requestSysId: "source-sys-id" },
      transport: {
        async request(request) {
          assert.match(request.url, /sc_req_item\/source-sys-id$/);
          assert.equal(request.headers.Authorization, undefined);
          return {
            status: 200,
            body: {
              result: {
                number: "RITM001",
                sys_id: "source-sys-id",
                state: "closed_complete",
                requested_for: { email: "worker@example.test" },
              },
            },
          };
        },
      },
    });
    assert.equal(result.sourceRecordId, "RITM001");
    assert.equal(result.normalizedState, "request-fulfilled");
    assert.match(result.evidenceReference, /^provider-read:servicenow:[a-f0-9]{64}$/);
  });

  test("rejects deployment tenant mismatch before source transport", async () => {
    await assert.rejects(readConfirmedProviderSource({
      providerKey: "oracle-hcm",
      organizationId: "org-a",
      caseId: 17,
      expectedCaseIdentity: "worker@example.test",
      expectedCaseStartDate: "2026-01-01",
      settings: {
        providerKey: "oracle-hcm",
        organizationId: "org-b",
        baseUrl: "https://oracle.example.test",
        bearerToken: "fixture-secret",
        resourceVersion: "latest",
      },
      fieldMappings: {},
      source: { workersUniqId: "worker-1", periodOfServiceId: "relationship-1" },
      transport: { async request() { throw new Error("transport must not be called"); } },
    }), StandardProviderSourceReadError);
  });
});