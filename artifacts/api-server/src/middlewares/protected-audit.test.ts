import assert from "node:assert/strict";
import test from "node:test";
import { createProtectedAuditCapture, objectForPath, requestAction } from "./protected-audit";

test("protected audit pre-attempt actions use static templates, never path data", () => {
  const request = {
    method: "PATCH",
    path: "/onboarding/cases/case-with-a-person-provided-slug/documents/42",
  };
  assert.equal(requestAction(request), "control-tower.case-document.patch");
  assert.ok(!requestAction(request).includes("person-provided"));
});

test("protected audit target identifies nested document and case subjects", () => {
  assert.deepEqual(
    objectForPath("/onboarding/cases/17/documents/42"),
    { objectType: "documents", objectId: "42", caseReference: "case:17" },
  );
});

test("action-center mutations retain safe exact work-item/request/case targets", () => {
  assert.equal(
    requestAction({ method: "POST", path: "/onboarding/action-center/actions/reassign" }),
    "control-tower.action-center-reassign.post",
  );
  assert.deepEqual(
    objectForPath("/onboarding/action-center/actions/reassign", {
      caseId: 17, requestId: "request-1", workItemId: "work-2",
    }),
    {
      objectType: "action-center-work-item",
      objectId: "work-2",
      caseReference: "case:17",
    },
  );
});

test("high-risk route templates retain distinct operation semantics", () => {
  const routes: Array<[string, string]> = [
    ["/onboarding/cases/1/offer-acceptance", "offer-acceptance"],
    ["/onboarding/cases/1/contact", "case-contact"],
    ["/onboarding/cases/1/evidence/9/decision", "evidence-decision"],
    ["/onboarding/cases/1/evidence/9/retry-malware-scan", "evidence-malware-retry"],
    ["/onboarding/cases/1/offer-package-request", "offer-package-email-request"],
    ["/onboarding/cases/1/operational-requests/8/actions", "operational-request-action"],
    ["/onboarding/cases/1/checklist/7", "checklist-decision"],
    ["/onboarding/action-center/actions/assign", "action-center-assign"],
    ["/onboarding/action-center/actions/escalate", "action-center-escalate"],
    ["/onboarding/action-center/actions/reassign", "action-center-reassign"],
    ["/onboarding/action-center/actions/resolve", "action-center-resolve"],
  ];
  for (const [path, operation] of routes) {
    assert.equal(requestAction({ method: "POST", path }), `control-tower.${operation}.post`);
  }
  assert.deepEqual(
    objectForPath("/onboarding/cases/1/operational-requests/8/actions"),
    { objectType: "operational-requests", objectId: "8", caseReference: "case:1" },
  );
  assert.deepEqual(
    objectForPath("/onboarding/cases/1/evidence/9/decision"),
    { objectType: "evidence", objectId: "9", caseReference: "case:1" },
  );
});

function auditRequest() {
  return {
    organizationId: "tenant-a",
    authUserId: "user-a",
    method: "POST",
    path: "/onboarding/cases/41/offer-acceptance",
    body: {},
    header: () => undefined,
  } as any;
}

function auditResponse() {
  const response: any = {
    statusCode: 200,
    endCalls: 0,
    jsonBody: undefined,
    end() {
      response.endCalls += 1;
      return response;
    },
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(value: unknown) {
      response.jsonBody = value;
      return response.end();
    },
  };
  return response;
}

test("post-commit outcome failure preserves non-idempotent mutation response and runs once", async () => {
  const calls: any[] = [];
  let counter = 0;
  let logged = 0;
  const middleware = createProtectedAuditCapture({
    authority: async () => "admin",
    reconcile: async () => 0,
    append: async (entry: any) => {
      calls.push(entry);
      if (entry.outcome !== "attempted") throw new Error("outcome store unavailable");
      return { id: 88 };
    },
    logOutcomeFailure: () => { logged += 1; },
  } as any);
  const req = auditRequest();
  const res = auditResponse();
  await middleware(req, res, () => {
    counter += 1; // Represents a committed non-idempotent mutation.
    res.statusCode = 201;
    res.end();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(counter, 1);
  assert.equal(res.statusCode, 201);
  assert.equal(res.endCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(logged, 1);
});

test("end captures a single successful outcome for 204 responses", async () => {
  const calls: any[] = [];
  const middleware = createProtectedAuditCapture({
    authority: async () => "admin",
    reconcile: async () => 0,
    append: async (entry: any) => {
      calls.push(entry);
      return { id: calls.length };
    },
    logOutcomeFailure: () => assert.fail("outcome should persist"),
  } as any);
  const res = auditResponse();
  await middleware(auditRequest(), res, () => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.endCalls, 1);
  assert.equal(calls[1].outcome, "success");
  assert.equal(calls[1].payload.httpStatus, 204);
});

test("send delegating to end emits one outcome, not a send/end duplicate", async () => {
  const calls: any[] = [];
  const middleware = createProtectedAuditCapture({
    authority: async () => "admin",
    reconcile: async () => 0,
    append: async (entry: any) => {
      calls.push(entry);
      return { id: calls.length };
    },
    logOutcomeFailure: () => assert.fail("outcome should persist"),
  } as any);
  const res = auditResponse();
  res.send = () => res.end();
  await middleware(auditRequest(), res, () => {
    res.statusCode = 200;
    res.send({ accepted: true });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.endCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].outcome, "success");
});

test("pre-attempt failure blocks the handler before mutation begins", async () => {
  let handlerRan = false;
  const middleware = createProtectedAuditCapture({
    authority: async () => "admin",
    reconcile: async () => 0,
    append: async () => { throw new Error("audit unavailable"); },
    logOutcomeFailure: () => assert.fail("no outcome should be attempted"),
  } as any);
  const res = auditResponse();
  await middleware(auditRequest(), res, () => { handlerRan = true; });
  assert.equal(handlerRan, false);
  assert.equal(res.statusCode, 503);
  assert.match(res.jsonBody.message, /not started/);
});