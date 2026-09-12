import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertRemoteDispatchActivation,
  canonicalProviderPayloadFingerprint,
  executeJournaledRemoteWrite,
  executeJournaledRemoteWriteForTest,
  readOracleHcmWorkRelationship,
  readServiceNowRequest,
  StandardProviderAdapterError,
  type EffectJournalBoundary,
  type ProviderHttpRequest,
  type ProviderHttpTransport,
} from "./standard-provider-adapters";

function transport(response: unknown, seen: ProviderHttpRequest[] = []): ProviderHttpTransport {
  return {
    async request(request) {
      seen.push(request);
      return response as { status: number; body: unknown };
    },
  };
}

const BASE_ACTIVATION = {
  configurationState: "operator-approved" as const,
  sandboxEvidenceReference: "sandbox-receipt",
  operatorApprovalReference: "operator-approval",
  currentAuthorityApproved: true,
  protectedAuditHealthy: true,
  privacyPolicyApproved: true,
  workflowApprovalCurrent: true,
};

function currentAuthorityFence(overrides: Partial<typeof BASE_ACTIVATION & { payloadFingerprint: string }> = {}) {
  return async <T>(
    input: { payloadFingerprint: string },
    action: (activation: typeof BASE_ACTIVATION & { payloadFingerprint: string }) => Promise<T>,
  ) => action({ ...BASE_ACTIVATION, payloadFingerprint: input.payloadFingerprint, ...overrides });
}

function journal(claimKind: "claimed" | "reuse_confirmed" | "manual_repair_required" = "claimed") {
  const calls: string[] = [];
  const boundary: EffectJournalBoundary = {
    ensure: async () => ({ fencingToken: 7 }),
    claim: async (input) => claimKind === "claimed"
      ? { kind: "claimed", fencingToken: 8, providerIdempotencyKey: input.logicalOperationKey }
      : claimKind === "reuse_confirmed"
        ? { kind: "reuse_confirmed", externalEffectId: "prior-request" }
        : { kind: "manual_repair_required" },
    confirm: async () => { calls.push("confirm"); return true; },
    rejectBeforeWrite: async () => { calls.push("reject"); return true; },
    markAmbiguous: async () => { calls.push("ambiguous"); return true; },
  };
  return { boundary, calls };
}

function identityFor(body: Record<string, unknown> = {}, overrides: Partial<{
  logicalOperationKey: string;
  toolName: string;
  providerIdempotency: boolean;
}> = {}) {
  return {
  logicalOperationKey: "tenant-1:case-1:servicenow:catalog-request",
  organizationId: "tenant-1",
  tenantId: "tenant-1",
  caseId: 1,
  toolName: "servicenow.catalog-request",
  argumentsHash: canonicalProviderPayloadFingerprint(body),
  providerIdempotency: false,
  ...overrides,
  };
}

describe("standard provider transport adapters", () => {
  test("reads the Oracle documented work-relationship resource with configured fields", async () => {
    const seen: ProviderHttpRequest[] = [];
    const result = await readOracleHcmWorkRelationship(transport({
      status: 200,
      body: { PersonId: "100", PersonNumber: "E-1", WorkEmail: "worker@example.test", StartDate: "2026-01-01", PeriodOfServiceId: "200", AssignmentStatusType: "ACTIVE", ObjectVersionNumber: "42" },
    }, seen), {
      baseUrl: "https://oracle.example.test",
      resourceVersion: "latest",
      fieldMappings: {
        workerId: "PersonId", employeeNumber: "PersonNumber",
        workRelationshipId: "PeriodOfServiceId", employmentStatus: "AssignmentStatusType", caseIdentity: "WorkEmail", employmentStartDate: "StartDate", sourceRevision: "ObjectVersionNumber",
      },
      activeStatusValues: ["ACTIVE"],
    }, {
      workersUniqId: "100", periodOfServiceId: "200",
      expectedCaseIdentity: "worker@example.test",
      expectedCaseStartDate: "2026-01-01",
      sourceObservedAt: new Date("2026-01-01T00:00:00.000Z"), evidenceReference: "oracle-read-receipt",
    });
    assert.equal(result.normalizedState, "work-relationship-active");
    assert.equal(result.employmentStartDate, "2026-01-01");
    assert.equal(result.verifiedCaseIdentity, "worker@example.test");
    assert.equal(result.sourceEvidenceRevision, "42");
    assert.match(seen[0]!.url, /workers\/100\/child\/workRelationships\/200$/);
  });

  test("reads ServiceNow Table API state and rejects unmapped states", async () => {
    const result = await readServiceNowRequest(transport({
      status: 200,
      body: { result: { number: "RITM1", sys_id: "sys-1", state: "closed_complete", requested_for: { email: "worker@example.test" } } },
    }), {
      baseUrl: "https://snow.example.test",
      requestTable: "sc_req_item",
      catalogItemSysId: "catalog-1",
      fieldMappings: {
        requestId: "number", requestSysId: "sys_id", requestState: "state", requestedFor: "requested_for", caseIdentity: "requested_for.email",
      },
      submittedStates: ["requested"], inProgressStates: ["work_in_progress"],
      fulfilledStates: ["closed_complete"], failedStates: ["closed_incomplete"],
    }, {
      requestSysId: "sys-1", sourceObservedAt: new Date("2026-01-01T00:00:00.000Z"),
      evidenceReference: "snow-read-receipt", expectedCaseIdentity: "worker@example.test",
    });
    assert.equal(result.normalizedState, "request-fulfilled");
  });

  test("fails closed before transport when any activation prerequisite is absent", async () => {
    const seen: ProviderHttpRequest[] = [];
    await assert.rejects(
      executeJournaledRemoteWriteForTest({
        identity: identityFor(), owner: "test-owner", transport: transport({ status: 200, body: {} }, seen),
        request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
        externalEffectId: () => "provider-id", journal: journal().boundary,
        withCurrentAuthorityFence: currentAuthorityFence({ privacyPolicyApproved: false }),
      }),
      (error) => error instanceof StandardProviderAdapterError && error.code === "remote-dispatch-blocked",
    );
    assert.equal(seen.length, 0);
    assert.throws(() => assertRemoteDispatchActivation({
      ...BASE_ACTIVATION,
      currentAuthorityApproved: false,
      payloadFingerprint: canonicalProviderPayloadFingerprint({}),
    }));
  });

  test("hard-disables production remote writes pending a database-backed authority boundary", async () => {
    const seen: ProviderHttpRequest[] = [];
    await assert.rejects(executeJournaledRemoteWrite({
      identity: identityFor(), owner: "test-owner", transport: transport({ status: 201, body: {} }, seen),
      request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
      externalEffectId: () => "provider-id",
      withCurrentAuthorityFence: currentAuthorityFence(),
    }), (error) => error instanceof StandardProviderAdapterError &&
      error.code === "remote-dispatch-blocked");
    assert.equal(seen.length, 0);
  });

  test("sends a stable effect key, confirms a successful ServiceNow write, and reuses a confirmed effect", async () => {
    const seen: ProviderHttpRequest[] = [];
    const first = journal();
    const serviceBody = { variables: { requested_for: "worker-1" } };
    const serviceIdentity = identityFor(serviceBody);
    const submitted = await executeJournaledRemoteWriteForTest({
      identity: serviceIdentity, owner: "test-owner",
      transport: transport({ status: 201, body: { result: { request_id: "REQ001" } } }, seen),
      journal: first.boundary,
      withCurrentAuthorityFence: currentAuthorityFence(),
      request: { method: "POST", url: "https://snow.example.test/api/sn_sc/servicecatalog/items/catalog-1/order_now", headers: {}, body: serviceBody },
      externalEffectId: (response) => (response.body as { result: { request_id: string } }).result.request_id,
    });
    assert.equal(submitted.externalEffectId, "REQ001");
    assert.equal(first.calls.join(","), "confirm");
    assert.equal(seen[0]!.headers["Idempotency-Key"], serviceIdentity.logicalOperationKey);
    assert.match(seen[0]!.url, /\/api\/sn_sc\/servicecatalog\/items\/catalog-1\/order_now$/);

    const replay = await executeJournaledRemoteWriteForTest({
      identity: identityFor(), owner: "test-owner",
      transport: transport({ status: 201, body: {} }, seen),
      request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
      externalEffectId: () => "provider-id", journal: journal("reuse_confirmed").boundary,
      withCurrentAuthorityFence: currentAuthorityFence(),
    });
    assert.deepEqual(replay, { externalEffectId: "prior-request", reusedConfirmed: true });
  });

  test("sends Oracle worker creation through the same journal fence", async () => {
    const seen: ProviderHttpRequest[] = [];
    const oracleJournal = journal();
    const workerPayload = { PersonNumber: "tenant-controlled-worker-reference" };
    const oracleIdentity = identityFor(workerPayload, { toolName: "oracle-hcm.create-worker" });
    const result = await executeJournaledRemoteWriteForTest({
      identity: oracleIdentity,
      owner: "test-owner",
      transport: transport({ status: 201, body: { PersonId: "oracle-person-100" } }, seen),
      journal: oracleJournal.boundary,
      withCurrentAuthorityFence: currentAuthorityFence(),
      request: { method: "POST", url: "https://oracle.example.test/hcmRestApi/resources/latest/workers", headers: {}, body: workerPayload },
      externalEffectId: (response) => (response.body as { PersonId: string }).PersonId,
    });
    assert.equal(result.externalEffectId, "oracle-person-100");
    assert.equal(oracleJournal.calls.join(","), "confirm");
    assert.match(seen[0]!.url, /\/hcmRestApi\/resources\/latest\/workers$/);
    assert.equal(seen[0]!.headers["X-Onboarding-Operation-Key"], oracleIdentity.logicalOperationKey);
  });

  test("known provider rejection is retryable while ambiguous transport failure is manual repair", async () => {
    const rejected = journal();
    await assert.rejects(executeJournaledRemoteWriteForTest({
      identity: identityFor(), owner: "test-owner",
      transport: transport({ status: 422, body: {} }),
      request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
      externalEffectId: () => "provider-id", journal: rejected.boundary,
      withCurrentAuthorityFence: currentAuthorityFence(),
      providerResponseProvesNoEffect: (response) => response.status === 422,
    }), /HTTP 422/);
    assert.deepEqual(rejected.calls, ["reject"]);

    const ambiguous = journal();
    await assert.rejects(executeJournaledRemoteWriteForTest({
      identity: identityFor(), owner: "test-owner",
      transport: { request: async () => { throw new Error("socket closed after write"); } },
      request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
      externalEffectId: () => "provider-id", journal: ambiguous.boundary,
      withCurrentAuthorityFence: currentAuthorityFence(),
    }), /socket closed/);
    assert.deepEqual(ambiguous.calls, ["ambiguous"]);
  });

  test("marks an offline or timed-out request ambiguous before manual repair", async () => {
    const attempted = journal();
    await assert.rejects(executeJournaledRemoteWriteForTest({
      identity: identityFor(), owner: "test-owner",
      transport: { request: async () => { throw new Error("provider request timed out"); } },
      request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
      externalEffectId: () => "provider-id", journal: attempted.boundary,
      withCurrentAuthorityFence: currentAuthorityFence(),
    }), (error) => error instanceof StandardProviderAdapterError &&
      error.code === "manual-repair-required" && /timed out/.test(error.message));
    assert.deepEqual(attempted.calls, ["ambiguous"]);
  });

  test("treats 500 and conflict responses as ambiguous unless the vendor contract proves no effect", async () => {
    for (const status of [500, 409]) {
      const attempted = journal();
      await assert.rejects(executeJournaledRemoteWriteForTest({
        identity: identityFor(), owner: "test-owner",
        transport: transport({ status, body: {} }),
        request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
        externalEffectId: () => "provider-id", journal: attempted.boundary,
        withCurrentAuthorityFence: currentAuthorityFence(),
      }), (error) => error instanceof StandardProviderAdapterError && error.code === "manual-repair-required");
      assert.deepEqual(attempted.calls, ["ambiguous"]);
    }
  });

  test("requires a provider external ID before journal confirmation", async () => {
    const attempted = journal();
    await assert.rejects(executeJournaledRemoteWriteForTest({
      identity: identityFor(), owner: "test-owner",
      transport: transport({ status: 201, body: { result: {} } }),
      request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
      externalEffectId: () => undefined, journal: attempted.boundary,
      withCurrentAuthorityFence: currentAuthorityFence(),
    }), (error) => error instanceof StandardProviderAdapterError && error.code === "manual-repair-required");
    assert.deepEqual(attempted.calls, ["ambiguous"]);
  });

  test("binds a canonical cloned payload to the journal and rejects stale authority", async () => {
    const original = { variables: { z: "last", a: "first" } };
    const reordered = { variables: { a: "first", z: "last" } };
    assert.equal(
      canonicalProviderPayloadFingerprint(original),
      canonicalProviderPayloadFingerprint(reordered),
    );
    const seen: ProviderHttpRequest[] = [];
    const identity = identityFor(original);
    await executeJournaledRemoteWriteForTest({
      identity, owner: "test-owner",
      transport: transport({ status: 201, body: { id: "provider-id" } }, seen),
      request: { method: "POST", url: "https://snow.example.test/write", headers: {}, body: original },
      externalEffectId: () => "provider-id", journal: journal().boundary,
      withCurrentAuthorityFence: async (fence, action) => {
        original.variables.a = "mutated-after-fingerprint";
        return action({ ...BASE_ACTIVATION, payloadFingerprint: fence.payloadFingerprint });
      },
    });
    assert.deepEqual(seen[0]!.body, reordered);

    const staleSeen: ProviderHttpRequest[] = [];
    await assert.rejects(executeJournaledRemoteWriteForTest({
      identity: identityFor(), owner: "test-owner",
      transport: transport({ status: 201, body: { id: "provider-id" } }, staleSeen),
      request: { method: "POST", url: "https://snow.example.test/write", headers: {} },
      externalEffectId: () => "provider-id", journal: journal().boundary,
      withCurrentAuthorityFence: currentAuthorityFence({
        payloadFingerprint: canonicalProviderPayloadFingerprint({ stale: true }),
      }),
    }), (error) => error instanceof StandardProviderAdapterError && error.code === "remote-dispatch-blocked");
    assert.equal(staleSeen.length, 0);
  });
});