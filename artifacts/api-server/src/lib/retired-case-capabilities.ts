import type { RequestHandler } from "express";

export const RETIRED_CASE_CAPABILITY_CODE = "CASE_TEST_CAPABILITY_RETIRED";
export const RETIRED_CASE_CAPABILITY_MESSAGE =
  "This capability has been retired. Existing history is read-only and non-operational.";

export class RetiredCaseCapabilityError extends Error {
  readonly status = 410;
  readonly statusCode = 410;
  readonly code = RETIRED_CASE_CAPABILITY_CODE;
  constructor() {
    super(RETIRED_CASE_CAPABILITY_MESSAGE);
    this.name = "RetiredCaseCapabilityError";
  }
}

/** Unconditional: no environment, tenant, demo role, or CLI escape hatch. */
export function denyRetiredCaseCapability(): void {
  throw new RetiredCaseCapabilityError();
}

export function retiredCaseCapabilitiesEnabled(): boolean {
  return false;
}

export const retiredCaseCapabilityResponse: RequestHandler = (_req, res) => {
  res.status(410).json({
    code: RETIRED_CASE_CAPABILITY_CODE,
    message: RETIRED_CASE_CAPABILITY_MESSAGE,
  });
};

export function isRetiredCaseCapabilityRequest(method: string, path: string): boolean {
  path = path.replace(/\/+$/, "");
  if (/^\/onboarding\/(?:scenarios(?:\/.*)?|synthetic-reset|demo\/full-coverage)\/?$/.test(path)) return true;
  if (/^\/onboarding\/cases\/[^/]+\/simulation(?:\/.*)?\/?$/.test(path)) return method !== "GET" && method !== "HEAD";
  if (/^\/onboarding\/uat\/runs\/[^/]+\/fixture-pack\/?$/.test(path)) return true;
  if (path === "/onboarding/uat/runs") return method === "POST";
  if (/^\/onboarding\/uat\/runs\/[^/]+\/actions\/?$/.test(path)) return method !== "GET" && method !== "HEAD";
  if (/^\/onboarding\/uat\/fairness\/actions\/?$/.test(path)) return method !== "GET" && method !== "HEAD";
  if (/^\/onboarding\/systems\/email-watch\/simulate\/?$/.test(path)) return true;
  if (/^\/policies\/evaluation\/(?:runs|review|drift)\/?$/.test(path)) return method !== "GET" && method !== "HEAD";
  return false;
}
