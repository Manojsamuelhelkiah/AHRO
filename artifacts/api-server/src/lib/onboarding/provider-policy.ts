import { AsyncLocalStorage } from "node:async_hooks";

type ProviderPolicy = { denyExternalProviders: boolean };

const providerPolicy = new AsyncLocalStorage<ProviderPolicy>();
export type DemoControllerLiveContext = {
  organizationId: string;
  caseId: number;
  channel: "email" | "call";
  recipient: string;
  /**
   * Optional run/request identity.  The controller supplies these for live
   * demo calls so a provider boundary can re-check the exact operation rather
   * than treating a case-level allow as a blanket exception.
   */
  runId?: string;
  requestId?: string;
  /**
   * The controller owns the authoritative volunteer/run lookup.  It is
   * intentionally optional for the legacy synchronous policy tests and for
   * ordinary (non-demo) callers.
   */
  revalidate?: () => boolean | Promise<boolean>;
};
const demoControllerLivePolicy = new AsyncLocalStorage<DemoControllerLiveContext>();

/** Execute a bounded operation while prohibiting all external delivery. */
export function runWithProviderDeny<T>(operation: () => T): T {
  return providerPolicy.run({ denyExternalProviders: true }, operation);
}

/** Checked immediately before an email, WhatsApp, or voice provider dispatch. */
export function externalProviderDispatchDenied(): boolean {
  return providerPolicy.getStore()?.denyExternalProviders === true;
}

/**
 * Narrow exception for an explicitly confirmed demo-controller contact.
 * This does not change process/global provider policy and cannot be created
 * from a request header. The caller must pin and revalidate the recipient
 * immediately before entering this context.
 */
export function runWithDemoControllerLive<T>(
  context: DemoControllerLiveContext,
  operation: () => T,
): T {
  return demoControllerLivePolicy.run(context, operation);
}

export function demoControllerLiveAllowed(
  organizationId: string,
  caseId: number,
  channel: "email" | "call",
  recipient: string,
): boolean {
  // An inner demo scope must never reopen an ancestor deny scope.  Keeping
  // this check here (rather than relying on each provider implementation)
  // makes the policy monotonic at every actual dispatch boundary.
  if (externalProviderDispatchDenied()) return false;
  const current = demoControllerLivePolicy.getStore();
  return !!current &&
    current.organizationId === organizationId &&
    current.caseId === caseId &&
    current.channel === channel &&
    current.recipient.trim().toLowerCase() === recipient.trim().toLowerCase();
}

/**
 * Re-check a demo exception immediately before crossing a provider
 * boundary.  The synchronous recipient comparison prevents an operation
 * from being redirected to a different case/address; the optional callback
 * lets DemoController re-read the selected volunteer and run while holding
 * its own durable lock.  A failed callback is fail-closed.
 */
export async function demoControllerLiveContextValid(
  organizationId: string,
  caseId: number,
  channel: "email" | "call",
  recipient: string,
): Promise<boolean> {
  if (!demoControllerLiveAllowed(organizationId, caseId, channel, recipient)) {
    return false;
  }
  const current = demoControllerLivePolicy.getStore();
  if (!current?.revalidate) return true;
  try {
    return (await current.revalidate()) === true;
  } catch {
    return false;
  }
}

export function demoControllerLiveCaseAllowed(
  organizationId: string,
  caseId: number,
): boolean {
  if (externalProviderDispatchDenied()) return false;
  const current = demoControllerLivePolicy.getStore();
  return !!current &&
    current.organizationId === organizationId &&
    current.caseId === caseId &&
    // This helper is used by the case dispatch guard.  It must not turn an
    // email exception into WhatsApp/HRIS/payroll authority.
    (current.channel === "email" || current.channel === "call");
}