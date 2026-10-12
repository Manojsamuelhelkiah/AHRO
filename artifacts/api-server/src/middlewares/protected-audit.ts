import type { NextFunction, Request, Response } from "express";
import {
  appendProtectedAudit,
  reconcileAbandonedProtectedAuditAttempts,
  verifiedAuditAuthority,
  type AuditOutcome,
} from "../lib/onboarding/protected-audit";

const SENSITIVE_READ_PATHS = [
  /^\/onboarding\/cases\/[^/]+\/(documents|evidence|records|communications)$/,
  /^\/onboarding\/cases\/[^/]+\/portal$/,
  /^\/onboarding\/approvals\/[^/]+\/history$/,
  /^\/onboarding\/action-center(?:\/.*)?$/,
];

function isSensitiveRequest(req: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method) ||
    SENSITIVE_READ_PATHS.some((pattern) => pattern.test(req.path));
}

function scalarBodyId(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? String(value)
    : null;
}

export function objectForPath(
  path: string,
  body?: unknown,
): { objectType: string; objectId: string | null; caseReference: string | null } {
  const parts = path.split("/").filter(Boolean);
  const cases = parts.indexOf("cases");
  if (cases >= 0 && parts[cases + 1]) {
    const resource = parts[cases + 2];
    const resourceId = parts[cases + 3];
    const objectType = resourceId && ["documents", "evidence", "communications", "operational-requests", "checklist"]
      .includes(resource) ? resource : "case";
    return {
      objectType,
      objectId: objectType === "case" ? parts[cases + 1] : resourceId,
      caseReference: `case:${parts[cases + 1]}`,
    };
  }
  const types = ["approvals", "connectors", "checklist-profiles", "settings", "guardrails", "systems"];
  const typeIndex = parts.findIndex((part) => types.includes(part));
  if (parts[1] === "action-center") {
    const caseId = scalarBodyId(body, "caseId");
    const workItemId = scalarBodyId(body, "workItemId");
    const requestId = scalarBodyId(body, "requestId");
    return {
      objectType: workItemId ? "action-center-work-item" : requestId ? "operational-request" : "case",
      objectId: workItemId ?? requestId ?? caseId,
      caseReference: caseId ? `case:${caseId}` : null,
    };
  }
  return typeIndex < 0
    ? { objectType: "onboarding", objectId: null, caseReference: null }
    : { objectType: parts[typeIndex].replace(/s$/, ""), objectId: parts[typeIndex + 1] ?? null, caseReference: null };
}

export function requestAction(req: Pick<Request, "path" | "method">): string {
  // `req.route` is unavailable before the handler runs, so this pre-attempt
  // mapper must use static templates. Never interpolate a path segment: slugs
  // and IDs can be person-provided data.
  const path = req.path;
  const templates: ReadonlyArray<readonly [RegExp, string]> = [
    [/^\/onboarding\/cases\/[^/]+\/offer-acceptance$/, "offer-acceptance"],
    [/^\/onboarding\/cases\/[^/]+\/contact-options$/, "contact-options"],
    [/^\/onboarding\/cases\/[^/]+\/contact$/, "case-contact"],
    [/^\/onboarding\/cases\/[^/]+\/checklist\/[^/]+$/, "checklist-decision"],
    [/^\/onboarding\/cases\/[^/]+\/checklist-profile$/, "case-checklist-profile"],
    [/^\/onboarding\/cases\/[^/]+\/operational-requests\/[^/]+\/actions$/, "operational-request-action"],
    [/^\/onboarding\/cases\/[^/]+\/operational-requests(?:\/|$)/, "operational-request"],
    [/^\/onboarding\/cases\/[^/]+\/evidence\/[^/]+\/decision$/, "evidence-decision"],
    [/^\/onboarding\/cases\/[^/]+\/evidence\/[^/]+\/retry-malware-scan$/, "evidence-malware-retry"],
    [/^\/onboarding\/cases\/[^/]+\/evidence(?:\/|$)/, "case-evidence"],
    [/^\/onboarding\/cases\/[^/]+\/documents(?:\/|$)/, "case-document"],
    [/^\/onboarding\/cases\/[^/]+\/communications\/[^/]+\/retry$/, "communication-retry"],
    [/^\/onboarding\/cases\/[^/]+\/offer-package-request$/, "offer-package-email-request"],
    [/^\/onboarding\/cases\/[^/]+\/communications(?:\/|$)/, "case-communication"],
    [/^\/onboarding\/cases\/[^/]+\/bgv-notifications\/reconcile$/, "bgv-reconciliation"],
    [/^\/onboarding\/cases\/[^/]+\/bgv-notifications$/, "bgv-notification"],
    [/^\/onboarding\/cases\/[^/]+\/inbound$/, "inbound-contact"],
    [/^\/onboarding\/cases\/[^/]+\/portal(?:\/|$)/, "candidate-portal"],
    [/^\/onboarding\/cases\/[^/]+\/voice-call$/, "voice-call"],
    [/^\/onboarding\/cases(?:\/|$)/, "case"],
    [/^\/onboarding\/approvals(?:\/|$)/, "approval"],
    [/^\/onboarding\/checklist-profiles(?:\/|$)/, "checklist-policy"],
    [/^\/onboarding\/settings(?:\/|$)/, "tenant-policy"],
    [/^\/onboarding\/connectors(?:\/|$)/, "connector"],
    [/^\/onboarding\/audit(?:\/|$)/, "protected-audit"],
    [/^\/onboarding\/action-center\/actions\/assign$/, "action-center-assign"],
    [/^\/onboarding\/action-center\/actions\/escalate$/, "action-center-escalate"],
    [/^\/onboarding\/action-center\/actions\/reassign$/, "action-center-reassign"],
    [/^\/onboarding\/action-center\/actions\/resolve$/, "action-center-resolve"],
    [/^\/onboarding\/action-center\/actions\/manual-call-outcome$/, "action-center-manual-call-outcome"],
    [/^\/onboarding\/action-center\/actions\/remind-document$/, "action-center-remind-document"],
    [/^\/onboarding\/action-center\/identities$/, "action-center-identities"],
    [/^\/onboarding\/action-center(?:\/|$)/, "action-center"],
  ];
  const operation = templates.find(([pattern]) => pattern.test(path))?.[1] ?? "onboarding-operation";
  return `control-tower.${operation}.${req.method.toLowerCase()}`;
}

function reviewedRevision(req: Request): number | null {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return null;
  for (const key of ["expectedVersion", "expectedChecklistVersion", "expectedPolicyVersion"]) {
    const value = body[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Creates an immutable attempted entry before the business handler runs. If
 * the process dies during the handler, the attempt remains unresolved rather
 * than being silently lost. A second linked entry records the observed HTTP
 * outcome. Neither request nor response body is inspected.
 */
type ProtectedAuditCaptureDependencies = {
  append: typeof appendProtectedAudit;
  reconcile: typeof reconcileAbandonedProtectedAuditAttempts;
  authority: typeof verifiedAuditAuthority;
  logOutcomeFailure: () => void;
};

const defaultDependencies: ProtectedAuditCaptureDependencies = {
  append: appendProtectedAudit,
  reconcile: reconcileAbandonedProtectedAuditAttempts,
  authority: verifiedAuditAuthority,
  logOutcomeFailure: () => console.error("[protected-audit] outcome observation persistence failed; recovery reconciliation required"),
};

export function createProtectedAuditCapture(
  dependencies: ProtectedAuditCaptureDependencies = defaultDependencies,
) {
return async function protectedAuditCapture(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.organizationId || !isSensitiveRequest(req)) {
    next();
    return;
  }
  let authority = "tenant-membership:unverified";
  if (req.authUserId) {
    const verifiedRole = await dependencies.authority(req.organizationId, req.authUserId);
    authority = `tenant-membership:${verifiedRole ?? "unverified"}`;
  }
  const target = objectForPath(req.path, req.body);
  const action = requestAction(req);
  const correlationId = req.header("x-request-id") ?? req.header("x-correlation-id");
  let attempt;
  try {
    // Recovery is durable and explicit: an old pre-attempt without any
    // observed outcome becomes a linked `recovery-required` record rather
    // than staying permanently unresolved after a worker/process crash.
    await dependencies.reconcile(req.organizationId);
    attempt = await dependencies.append({
      organizationId: req.organizationId,
      actorId: req.authUserId ?? null,
      actorKind: req.authUserId ? "authenticated" : "system",
      actorAuthority: authority,
      action: `${action}.attempted`,
      outcome: "attempted",
      ...target,
      reviewedRevision: reviewedRevision(req),
      source: "http",
      correlationId,
      payload: { method: req.method },
    });
  } catch {
    res.status(503).json({ message: "Protected audit persistence unavailable; sensitive action was not started." });
    return;
  }
  const originalEnd = res.end.bind(res);
  let captured = false;
  res.end = ((...args: any[]): Response => {
    // send/json/download paths all end the response. Intercept the single
    // completion boundary so a send->end chain records one outcome and 204 or
    // streamed responses are covered too.
    if (!captured) {
    captured = true;
    const outcome: AuditOutcome = res.statusCode >= 500
      ? "failure"
      : res.statusCode >= 400 ? "denied" : "success";
    void dependencies.append({
      organizationId: req.organizationId!,
      actorId: req.authUserId ?? null,
      actorKind: req.authUserId ? "authenticated" : "system",
      actorAuthority: authority,
      action: `${action}.outcome`,
      outcome,
      ...target,
      reviewedRevision: reviewedRevision(req),
      source: "http",
      correlationId,
      payload: { httpStatus: res.statusCode, method: req.method },
      correctionOfId: attempt.id,
    }).catch(dependencies.logOutcomeFailure);
    }
    // An already committed mutation must retain its actual response. Changing
    // it to 503 would encourage an unsafe retry; pre-attempt failure remains
    // fail-closed and the durable attempt is reconciled if post-commit capture
    // is unavailable.
    return originalEnd(...args);
  }) as Response["end"];
  next();
};
}

export const protectedAuditCapture = createProtectedAuditCapture();