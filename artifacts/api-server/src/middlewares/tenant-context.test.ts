import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createTenantContextMiddleware } from "./tenant-context";

function run(
  userId: string | undefined,
  requestedOrganizationId?: string,
) {
  const req = {
    authUserId: userId,
    header: () => requestedOrganizationId,
  } as unknown as Request;
  let statusCode: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  let nextValue: unknown = "not-called";
  const middleware = createTenantContextMiddleware(async (clerkUserId, requested) => {
    if (clerkUserId !== "user_member") return null;
    if (requested && requested !== "org_acme") return null;
    return {
      organizationId: "org_acme",
      organizationName: "Acme",
      role: "admin",
    };
  });
  return middleware(req, res, (value?: unknown) => {
    nextValue = value;
  }).then(() => ({ req, statusCode, body, nextValue }));
}

test("tenant context rejects a signed-out request", async () => {
  const result = await run(undefined);
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextValue, "not-called");
});

test("tenant context asks a new user to complete setup", async () => {
  const result = await run("user_new");
  assert.equal(result.statusCode, 409);
  assert.deepEqual(result.body, {
    message: "Organization setup required",
    code: "ORGANIZATION_SETUP_REQUIRED",
  });
});

test("tenant context fails closed when membership lookup is ambiguous", async () => {
  let requestedValue: string | undefined = "not-called";
  const req = {
    authUserId: "user_multi",
    header: () => undefined,
  } as unknown as Request;
  let body: unknown;
  const res = {
    status() { return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  const middleware = createTenantContextMiddleware(async (_userId, requested) => {
    requestedValue = requested;
    return "ambiguous";
  });

  await middleware(req, res, () => assert.fail("next must not be called"));
  assert.equal(requestedValue, undefined);
  assert.deepEqual(body, {
    message: "Select an organization before accessing tenant data",
    code: "ORGANIZATION_SELECTION_REQUIRED",
  });
});

test("tenant context rejects a cross-organization selector", async () => {
  const result = await run("user_member", "org_other");
  assert.equal(result.statusCode, 403);
  assert.equal(result.nextValue, "not-called");
});

test("tenant context attaches the verified organization and role", async () => {
  const result = await run("user_member", "org_acme");
  assert.equal(result.statusCode, undefined);
  assert.equal(result.nextValue, undefined);
  assert.equal(result.req.organizationId, "org_acme");
  assert.equal(result.req.organizationRole, "admin");
});